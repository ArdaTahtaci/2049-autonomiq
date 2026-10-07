import { expect } from "chai";
import { Wallet, keccak256, toUtf8Bytes } from "ethers";
import { ethers } from "hardhat";
import { signProof } from "../../src/proof";
import { generateMockProof, type MockOutcome } from "../../src/robot/mockProof";
import type { TaskView } from "../../src/tasks/types";
import { REWARD, startTestSystem, type TestSystem } from "../helpers/system";

describe("Backend API (Express + escrow on Hardhat network)", () => {
  let sys: TestSystem;

  before(async () => {
    sys = await startTestSystem({ robot: "external" });
  });
  after(async () => {
    await sys.close();
  });

  async function signedProof(task: TaskView, outcome: MockOutcome = "success", signer = sys.signers.robot) {
    const proof = generateMockProof(task, outcome);
    return { proof, ...(await signProof(proof, signer)) };
  }

  describe("task creation", () => {
    it("creates a task with defaults", async () => {
      const { status, body } = await sys.api("POST", "/tasks", {});
      expect(status).to.equal(201);
      expect(body.status).to.equal("CREATED");
      expect(body.task_id).to.match(/^task_[0-9a-f]{8}$/);
      expect(body.onchain_task_id).to.equal(keccak256(toUtf8Bytes(body.task_id)));
      expect(body.robot_id).to.equal("robot_001");
      expect(body.robot_address).to.equal(sys.signers.robot.address);
      expect(body.reward_wei).to.equal(REWARD.toString());
      expect(body.tolerance).to.equal(0.05);
      expect(body.target_position).to.deep.equal({ x: 1, y: 0, z: 0 });
      expect(body.events.map((e) => e.type)).to.deep.equal(["TASK_CREATED"]);
    });

    it("creates a task with custom parameters and retrieves it", async () => {
      const { body } = await sys.api("POST", "/tasks", {
        task_id: "custom_task-1",
        start_position: { x: 0.2, y: 0.3, z: 0 },
        target_position: { x: -0.5, y: 1.5, z: 0.1 },
        tolerance: 0.02,
        reward_eth: "0.25",
      });
      expect(body.task_id).to.equal("custom_task-1");
      const { status, body: got } = await sys.api("GET", "/tasks/custom_task-1");
      expect(status).to.equal(200);
      expect(got.reward_wei).to.equal(ethers.parseEther("0.25").toString());
      expect(got.onchain).to.deep.include({ status: "None" });
      const list = await sys.api<TaskView[]>("GET", "/tasks");
      expect(list.body.map((t) => t.task_id)).to.include("custom_task-1");
    });

    it("rejects invalid task input", async () => {
      const bad = [
        { target_position: { x: 1, y: 0 } },
        { target_position: { x: "1", y: 0, z: 0 } },
        { tolerance: -1 },
        { reward_eth: "abc" },
        { reward_eth: "0" },
        { robot_id: "robot_999" },
        { task_id: "has spaces" },
        { unexpected: true },
        { payee: "0x123" },
      ];
      for (const body of bad) {
        const res = await sys.api("POST", "/tasks", body);
        expect(res.status, JSON.stringify(body)).to.equal(400);
        expect(res.body.error).to.be.a("string");
      }
    });

    it("rejects a duplicate task_id and unknown tasks", async () => {
      await sys.api("POST", "/tasks", { task_id: "dup_task" });
      expect((await sys.api("POST", "/tasks", { task_id: "dup_task" })).status).to.equal(409);
      expect((await sys.api("GET", "/tasks/nope")).status).to.equal(404);
      expect((await sys.api("POST", "/tasks/nope/fund")).status).to.equal(404);
      expect((await sys.api("GET", "/no-such-route")).status).to.equal(404);
    });
  });

  describe("funding & lifecycle guards", () => {
    it("funds the escrow on-chain", async () => {
      const task = await sys.fundedTask();
      expect(task.status).to.equal("FUNDED");
      expect(task.transactions.fund).to.match(/^0x[0-9a-f]{64}$/);
      const onchain = await sys.escrow.getTask(task.task_id);
      expect(onchain).to.deep.include({
        status: "Funded",
        amount_wei: REWARD.toString(),
        requester: sys.signers.requester.address,
        robot: sys.signers.robot.address,
        payee: sys.signers.payee.address,
      });
      expect((await sys.api("POST", `/tasks/${task.task_id}/fund`)).status).to.equal(409);
    });

    it("refuses start/proof/settle before funding", async () => {
      const { body: task } = await sys.api("POST", "/tasks", {});
      expect((await sys.api("POST", `/tasks/${task.task_id}/start`)).status).to.equal(409);
      expect((await sys.api("POST", `/tasks/${task.task_id}/proof`, await signedProof(task))).status).to.equal(409);
      expect((await sys.api("POST", `/tasks/${task.task_id}/settle`)).status).to.equal(409);
    });

    it("surfaces on-chain conflicts (task id squatted by someone else) as 409", async () => {
      const { body: task } = await sys.api("POST", "/tasks", { task_id: "squatted_task" });
      await sys.escrow.contract
        .connect(sys.signers.stranger)
        .fundTask(task.onchain_task_id, sys.signers.stranger.address, sys.signers.stranger.address, { value: 1n });
      const res = await sys.api("POST", `/tasks/${task.task_id}/fund`);
      expect(res.status).to.equal(409);
      expect(res.body.error).to.contain("TaskAlreadyExists");
      expect((await sys.api("GET", `/tasks/${task.task_id}`)).body.status).to.equal("CREATED");
    });

    it("rejects invalid start options", async () => {
      const task = await sys.fundedTask();
      expect((await sys.api("POST", `/tasks/${task.task_id}/start`, { mock_outcome: "explode" })).status).to.equal(400);
    });
  });

  describe("proof ingestion → verification → chain", () => {
    it("accepts a valid proof, commits it on-chain and settles", async () => {
      const task = await sys.fundedTask();
      await sys.api("POST", `/tasks/${task.task_id}/start`);
      const payeeBefore = await ethers.provider.getBalance(task.payee);

      const submission = await signedProof(task, "success");
      const res = await sys.api("POST", `/tasks/${task.task_id}/proof`, submission);

      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(res.body.status).to.equal("SETTLED");
      expect(res.body.proof?.proof_hash).to.equal(submission.proof_hash);
      expect(res.body.proof?.signer).to.equal(sys.signers.robot.address);
      expect(res.body.verification?.passed).to.equal(true);
      expect(res.body.transactions.commit).to.match(/^0x[0-9a-f]{64}$/);
      expect(res.body.transactions.settle).to.match(/^0x[0-9a-f]{64}$/);
      expect(res.body.events.map((e) => e.type)).to.deep.equal([
        "TASK_CREATED",
        "ESCROW_FUNDED",
        "ROBOT_EXECUTION_STARTED",
        "PROOF_RECEIVED",
        "PROOF_VERIFIED",
        "PROOF_COMMITTED",
        "SETTLEMENT_RELEASED",
      ]);

      const { body: view } = await sys.api("GET", `/tasks/${task.task_id}`);
      expect(view.onchain).to.deep.include({ status: "Settled", proof_hash: submission.proof_hash });
      expect((await ethers.provider.getBalance(task.payee)) - payeeBefore).to.equal(REWARD);
    });

    it("rejects malformed JSON and malformed submissions without changing state", async () => {
      const task = await sys.fundedTask();
      const raw = await sys.api("POST", `/tasks/${task.task_id}/proof`, undefined, "{not json");
      expect(raw.status).to.equal(400);
      expect(raw.body.error).to.equal("Malformed JSON body");

      const good = await signedProof(task);
      const { success: _s, ...missingSuccess } = good.proof;
      const malformed: unknown[] = [
        {},
        { proof: good.proof },
        { proof: good.proof, signature: "0x1234" },
        { proof: "not-an-object", signature: good.signature },
        { proof: { ...good.proof, timestamp: "yesterday" }, signature: good.signature },
        { proof: { ...good.proof, final_object_position: { x: "1", y: 0, z: 0 } }, signature: good.signature },
        { proof: missingSuccess, signature: good.signature },
        [1, 2, 3],
      ];
      for (const body of malformed) {
        const res = await sys.api("POST", `/tasks/${task.task_id}/proof`, body);
        expect(res.status, JSON.stringify(body).slice(0, 80)).to.equal(422);
        expect(res.body.details?.reasons).to.be.an("array").that.is.not.empty;
      }
      const { body: after } = await sys.api("GET", `/tasks/${task.task_id}`);
      expect(after.status).to.equal("FUNDED");
      expect(after.rejected_proofs).to.equal(malformed.length);
      expect(after.onchain).to.deep.include({ status: "Funded" });
    });

    it("rejects a proof modified after signing, then still accepts the genuine proof", async () => {
      const task = await sys.fundedTask();
      const genuine = await signedProof(task, "success");
      const tampered = { ...genuine, proof: { ...genuine.proof, final_object_position: { x: 1, y: 0, z: 0 } } };
      const res = await sys.api("POST", `/tasks/${task.task_id}/proof`, tampered);
      expect(res.status).to.equal(422);
      expect(res.body.details?.reasons?.join(" ")).to.match(/hash|tamper|modified/i);

      const ok = await sys.api("POST", `/tasks/${task.task_id}/proof`, genuine);
      expect(ok.status).to.equal(200);
      expect(ok.body.status).to.equal("SETTLED");
    });

    it("rejects wrong task_id, wrong robot_id, wrong signer and mismatched target", async () => {
      const task = await sys.fundedTask();
      const cases = [
        await signedProof({ ...task, task_id: "some_other_task" }),
        await signedProof({ ...task, robot_id: "robot_002" }),
        await signedProof(task, "success", Wallet.createRandom() as unknown as typeof sys.signers.robot),
        await signedProof({ ...task, target_position: { x: 3, y: 3, z: 0 } }),
      ];
      for (const submission of cases) {
        expect((await sys.api("POST", `/tasks/${task.task_id}/proof`, submission)).status).to.equal(422);
      }
      expect((await sys.api("GET", `/tasks/${task.task_id}`)).body.status).to.equal("FUNDED");
    });

    for (const outcome of ["false_success", "failure"] as const) {
      it(`commits a ${outcome} proof as failed, refunds the requester and pays nothing`, async () => {
        const task = await sys.fundedTask();
        const payeeBefore = await ethers.provider.getBalance(task.payee);
        const requesterBefore = await ethers.provider.getBalance(sys.signers.requester.address);

        const res = await sys.api("POST", `/tasks/${task.task_id}/proof`, await signedProof(task, outcome));
        expect(res.status).to.equal(200);
        expect(res.body.status).to.equal("FAILED");
        expect(res.body.verification?.passed).to.equal(false);
        expect(res.body.transactions.settle).to.equal(undefined);
        expect(res.body.transactions.refund).to.match(/^0x[0-9a-f]{64}$/);

        const onchain = await sys.escrow.getTask(task.task_id);
        expect(onchain.status).to.equal("Refunded");
        expect(await ethers.provider.getBalance(task.payee)).to.equal(payeeBefore);
        expect((await ethers.provider.getBalance(sys.signers.requester.address)) - requesterBefore).to.equal(REWARD);
        expect((await sys.api("POST", `/tasks/${task.task_id}/settle`)).status).to.equal(409);
      });
    }

    it("rejects a duplicate proof and duplicate settlement", async () => {
      const task = await sys.fundedTask();
      const submission = await signedProof(task);
      expect((await sys.api("POST", `/tasks/${task.task_id}/proof`, submission)).status).to.equal(200);
      expect((await sys.api("POST", `/tasks/${task.task_id}/proof`, submission)).status).to.equal(409);
      expect((await sys.api("POST", `/tasks/${task.task_id}/settle`)).status).to.equal(409);
      const settled = await sys.escrow.contract.queryFilter(sys.escrow.contract.filters.TaskSettled(task.onchain_task_id));
      expect(settled).to.have.length(1);
    });

    it("processes exactly one of two concurrent proof submissions", async () => {
      const task = await sys.fundedTask();
      const payeeBefore = await ethers.provider.getBalance(task.payee);
      const [a, b] = await Promise.all([
        sys.api("POST", `/tasks/${task.task_id}/proof`, await signedProof(task)),
        sys.api("POST", `/tasks/${task.task_id}/proof`, await signedProof(task)),
      ]);
      expect([a.status, b.status].sort()).to.deep.equal([200, 409]);
      expect((await ethers.provider.getBalance(task.payee)) - payeeBefore).to.equal(REWARD);
    });

    it("a proof for another task cannot be replayed (task_id binding)", async () => {
      const first = await sys.fundedTask();
      const second = await sys.fundedTask();
      const submission = await signedProof(first);
      expect((await sys.api("POST", `/tasks/${first.task_id}/proof`, submission)).status).to.equal(200);
      expect((await sys.api("POST", `/tasks/${second.task_id}/proof`, submission)).status).to.equal(422);
    });
  });

  describe("mock robot adapter", () => {
    let mockSys: TestSystem;
    before(async () => {
      mockSys = await startTestSystem({ robot: "mock", mockDelayMs: 20 });
    });
    after(async () => {
      await mockSys.close();
    });

    it("start → mock robot proof → SETTLED", async () => {
      const task = await mockSys.fundedTask();
      const started = await mockSys.api("POST", `/tasks/${task.task_id}/start`, { mock_outcome: "success" });
      expect(started.status).to.equal(202);
      expect(started.body.status).to.equal("RUNNING");
      const final = await mockSys.waitForStatus(task.task_id, ["SETTLED", "FAILED"]);
      expect(final.status).to.equal("SETTLED");
      expect(final.onchain).to.deep.include({ status: "Settled" });
    });

    it("start with mock failure → FAILED and refunded", async () => {
      const task = await mockSys.fundedTask();
      await mockSys.api("POST", `/tasks/${task.task_id}/start`, { mock_outcome: "failure" });
      const final = await mockSys.waitForStatus(task.task_id, ["SETTLED", "FAILED"]);
      expect(final.status).to.equal("FAILED");
      expect(final.onchain).to.deep.include({ status: "Refunded" });
    });

    it("exposes health information", async () => {
      const { status, body } = await mockSys.api<{ ok: boolean; robot_adapter: string }>("GET", "/health");
      expect(status).to.equal(200);
      expect(body).to.deep.include({ ok: true, robot_adapter: "mock" });
    });
  });
});
