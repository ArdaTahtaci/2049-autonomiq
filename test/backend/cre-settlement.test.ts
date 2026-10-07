/**
 * Backend in settlement mode "cre": proofs are pre-screened, then handed to the Chainlink CRE workflow,
 * which settles on-chain through the forwarder; the backend adopts the outcome from the escrow.
 * The workflow's on-chain write is played by `deliverCreReport` (MockKeystoneForwarder.report, exactly
 * what `cre workflow simulate --broadcast` sends); the workflow itself is tested in cre/.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { computeTaskSpecHash, signProof } from "../../src/proof";
import { generateMockProof, type MockOutcome } from "../../src/robot/mockProof";
import type { TaskView } from "../../src/tasks/types";
import { REWARD, startTestSystem, type TestSystem } from "../helpers/system";

describe("Backend — Chainlink CRE settlement mode", () => {
  let sys: TestSystem;

  before(async () => {
    sys = await startTestSystem({ robot: "external", settlement: "cre" });
  });
  after(async () => {
    sys.service.stopCreWatcher();
    await sys.close();
  });
  beforeEach(() => {
    sys.creTrigger.onTrigger = undefined;
  });

  async function signedProof(task: TaskView, outcome: MockOutcome = "success") {
    const proof = generateMockProof(task, outcome);
    return { proof, ...(await signProof(proof, sys.signers.robot)) };
  }

  async function handedToCre(outcome: MockOutcome = "success") {
    const task = await sys.fundedTask();
    const submission = await signedProof(task, outcome);
    const res = await sys.api("POST", `/tasks/${task.task_id}/proof`, submission);
    return { task, submission, res };
  }

  it("anchors the task spec hash on-chain when funding", async () => {
    const task = await sys.fundedTask();
    expect(task.settlement_mode).to.equal("cre");
    expect(task.spec_hash).to.equal(computeTaskSpecHash(task));
    expect(await sys.contract.taskSpecHash(task.onchain_task_id)).to.equal(task.spec_hash);
  });

  it("pre-screens a valid proof and hands it to CRE without settling it itself (202)", async () => {
    const before = sys.creTrigger.calls.length;
    const { task, submission, res } = await handedToCre();
    expect(res.status).to.equal(202);
    expect(res.body.status).to.equal("PROOF_RECEIVED");
    expect(res.body.cre).to.deep.include({ status: "TRIGGERED", proof_hash: submission.proof_hash, attempts: 1 });
    expect(sys.creTrigger.calls.slice(before)).to.deep.equal([{ task_id: task.task_id, proof_hash: submission.proof_hash }]);
    expect(res.body.transactions.commit).to.equal(undefined);
    expect((await sys.escrow.getTask(task.task_id)).status).to.equal("Funded"); // the backend did not touch settlement
    expect(res.body.events.map((e) => e.type)).to.include("CRE_TRIGGERED");
  });

  it("serves the workflow the exact evidence: raw signed proof + task spec that hashes to the on-chain anchor", async () => {
    const { task, submission } = await handedToCre();
    const { status, body } = await sys.api<ReturnType<TestSystem["service"]["getCreEvidence"]>>("GET", `/cre/tasks/${task.task_id}/evidence`);
    expect(status).to.equal(200);
    expect(body.submission).to.deep.equal({ proof: submission.proof, signature: submission.signature, proof_hash: submission.proof_hash });
    expect(computeTaskSpecHash(body.task)).to.equal(await sys.contract.taskSpecHash(task.onchain_task_id));
    expect(body.task.onchain_task_id).to.equal(ethers.keccak256(ethers.toUtf8Bytes(task.task_id)));

    const fresh = await sys.fundedTask();
    expect((await sys.api("GET", `/cre/tasks/${fresh.task_id}/evidence`)).status).to.equal(404);
    expect((await sys.api("GET", `/cre/tasks/nope/evidence`)).status).to.equal(404);
  });

  it("adopts a CRE settlement from the chain: SETTLED, tx hashes, forwarder/transmitter/workflow id, paid once", async () => {
    const { task } = await handedToCre("success");
    const payeeBefore = await ethers.provider.getBalance(task.payee);
    const receipt = await sys.deliverCreReport(task.task_id, true);

    const { body } = await sys.api("GET", `/tasks/${task.task_id}`);
    expect(body.status).to.equal("SETTLED");
    expect(body.transactions.commit).to.equal(receipt!.hash);
    expect(body.transactions.settle).to.equal(receipt!.hash); // commit + payout in one forwarder transaction
    expect(body.cre).to.deep.include({
      status: "SETTLED_ONCHAIN",
      report_tx: receipt!.hash,
      forwarder: await sys.forwarder!.getAddress(),
      transmitter: sys.signers.transmitter.address,
      workflow_id: ethers.id("machineproof-settlement"),
    });
    const settledEvent = body.events.find((e) => e.type === "SETTLEMENT_RELEASED");
    expect(settledEvent?.data).to.include({ settled_by: "chainlink-cre" });
    expect(body.onchain).to.deep.include({ status: "Settled" });
    expect((await ethers.provider.getBalance(task.payee)) - payeeBefore).to.equal(REWARD);

    // Settled is terminal: no new proof, no re-trigger.
    expect((await sys.api("POST", `/tasks/${task.task_id}/settle`)).status).to.equal(409);
    expect((await sys.api("POST", `/tasks/${task.task_id}/proof`, await signedProof(task))).status).to.equal(409);
  });

  it("adopts a CRE refund: FAILED, refund tx, requester refunded, payee unpaid", async () => {
    const { task } = await handedToCre("false_success");
    const payeeBefore = await ethers.provider.getBalance(task.payee);
    const requesterBefore = await ethers.provider.getBalance(sys.signers.requester.address);
    const receipt = await sys.deliverCreReport(task.task_id, false);

    const { body } = await sys.api("GET", `/tasks/${task.task_id}`);
    expect(body.status).to.equal("FAILED");
    expect(body.transactions.refund).to.equal(receipt!.hash);
    expect(body.cre?.status).to.equal("REFUNDED_ONCHAIN");
    expect(body.events.map((e) => e.type)).to.include.members(["TASK_FAILED", "ESCROW_REFUNDED"]);
    expect(await ethers.provider.getBalance(task.payee)).to.equal(payeeBefore);
    expect((await ethers.provider.getBalance(sys.signers.requester.address)) - requesterBefore).to.equal(REWARD);
  });

  it("the background watcher adopts settlements without any read", async () => {
    const { task } = await handedToCre();
    sys.service.startCreWatcher(25);
    try {
      await sys.deliverCreReport(task.task_id, true);
      const deadline = Date.now() + 5_000;
      while (sys.service.getTask(task.task_id).status !== "SETTLED" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      expect(sys.service.getTask(task.task_id).status).to.equal("SETTLED");
    } finally {
      sys.service.stopCreWatcher();
    }
  });

  it("invalid proofs are rejected by the backend pre-screen and never reach CRE", async () => {
    const task = await sys.fundedTask();
    const before = sys.creTrigger.calls.length;
    const genuine = await signedProof(task);
    const tampered = { ...genuine, proof: { ...genuine.proof, final_object_position: { x: 1, y: 0, z: 0 } } };
    expect((await sys.api("POST", `/tasks/${task.task_id}/proof`, tampered)).status).to.equal(422);
    expect((await sys.api("POST", `/tasks/${task.task_id}/proof`, { proof: {}, signature: "0x" })).status).to.equal(422);
    expect(sys.creTrigger.calls.length).to.equal(before);
    expect((await sys.api("GET", `/tasks/${task.task_id}`)).body.status).to.equal("FUNDED");
  });

  it("a duplicate proof while CRE is settling is refused", async () => {
    const { task, submission } = await handedToCre();
    expect((await sys.api("POST", `/tasks/${task.task_id}/proof`, submission)).status).to.equal(409);
  });

  it("an unreachable CRE trigger keeps the proof and can be retried with /settle", async () => {
    const task = await sys.fundedTask();
    sys.creTrigger.onTrigger = () => {
      throw new Error("connection refused");
    };
    const failed = await sys.api("POST", `/tasks/${task.task_id}/proof`, await signedProof(task));
    expect(failed.status).to.equal(502);
    let view = (await sys.api("GET", `/tasks/${task.task_id}`)).body;
    expect(view.status).to.equal("PROOF_RECEIVED");
    expect(view.cre?.status).to.equal("TRIGGER_FAILED");

    sys.creTrigger.onTrigger = undefined;
    const retried = await sys.api("POST", `/tasks/${task.task_id}/settle`);
    expect(retried.status).to.equal(200);
    expect(retried.body.cre).to.deep.include({ status: "TRIGGERED", attempts: 2 });
    await sys.deliverCreReport(task.task_id, true);
    view = (await sys.api("GET", `/tasks/${task.task_id}`)).body;
    expect(view.status).to.equal("SETTLED");
  });

  it("records the workflow's result (informational); a CRE rejection of the pending proof lets the robot resubmit", async () => {
    const { task, submission } = await handedToCre();
    const reject = await sys.api("POST", `/cre/tasks/${task.task_id}/result`, {
      decision: "REJECTED",
      proof_hash: submission.proof_hash,
      passed: null,
      reasons: ["signature does not recover to the on-chain robot"],
      checks: [{ name: "signature", ok: false, detail: "mismatch" }],
      workflow: "machineproof-settlement",
    });
    expect(reject.status).to.equal(200);
    let view = (await sys.api("GET", `/tasks/${task.task_id}`)).body;
    expect(view.cre?.status).to.equal("TRIGGERED"); // a callback never changes settlement state
    expect(view.cre?.workflow_result).to.deep.include({ decision: "REJECTED" });
    expect(view.events.map((e) => e.type)).to.include("CRE_WORKFLOW_RESULT");
    expect((await sys.escrow.getTask(task.task_id)).status).to.equal("Funded");

    const resubmitted = await sys.api("POST", `/tasks/${task.task_id}/proof`, await signedProof(task));
    expect(resubmitted.status).to.equal(202);
    expect(resubmitted.body.cre).to.deep.include({ status: "TRIGGERED", attempts: 2 });
    await sys.deliverCreReport(task.task_id, true);
    view = (await sys.api("GET", `/tasks/${task.task_id}`)).body;
    expect(view.status).to.equal("SETTLED");
  });

  it("validates workflow result callbacks", async () => {
    const { task } = await handedToCre();
    expect((await sys.api("POST", `/cre/tasks/${task.task_id}/result`, { decision: "PAY_ME" })).status).to.equal(400);
    expect((await sys.api("POST", `/cre/tasks/${task.task_id}/result`, { decision: "SETTLED", reasons: "x" })).status).to.equal(400);
    expect((await sys.api("POST", `/cre/tasks/nope/result`, { decision: "SETTLED" })).status).to.equal(404);
    const notHanded = await sys.fundedTask();
    expect((await sys.api("POST", `/cre/tasks/${notHanded.task_id}/result`, { decision: "SETTLED" })).status).to.equal(409);
    const otherProof = { decision: "REJECTED", proof_hash: ethers.ZeroHash, reasons: [] };
    expect((await sys.api("POST", `/cre/tasks/${task.task_id}/result`, otherProof)).status).to.equal(409);
  });

  it("a spoofed SETTLED callback cannot mark a task settled: state only follows the chain", async () => {
    const { task } = await handedToCre();
    await sys.api("POST", `/cre/tasks/${task.task_id}/result`, { decision: "SETTLED", tx_hash: ethers.ZeroHash, reasons: [] });
    const view = (await sys.api("GET", `/tasks/${task.task_id}`)).body;
    expect(view.status).to.equal("PROOF_RECEIVED");
    expect(view.onchain).to.deep.include({ status: "Funded" });
  });
});
