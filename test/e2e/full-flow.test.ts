/**
 * End-to-end: create task → fund escrow → mock robot executes → proof received → canonicalize
 * → hash → verify signature → verify physical result → commit on-chain → settle → confirm the
 * final state on-chain and that payment happened exactly once.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { ChainError } from "../../src/chain/escrow";
import { canonicalize, computeProofHash, computeTaskSpecHash, recoverProofSigner } from "../../src/proof";
import { REWARD, startTestSystem, type TestSystem } from "../helpers/system";

describe("E2E: machine task → proof → on-chain settlement", () => {
  let sys: TestSystem;

  before(async () => {
    sys = await startTestSystem({ robot: "mock", mockDelayMs: 50 });
  });
  after(async () => {
    await sys.close();
  });

  it("runs the complete flow and settles exactly once", async () => {
    const { payee } = sys.signers;
    const escrowAddress = sys.escrow.address;
    const payeeBefore = await ethers.provider.getBalance(payee.address);

    // 1. create task
    const created = await sys.api("POST", "/tasks", {
      start_position: { x: 0, y: 0, z: 0 },
      target_position: { x: 1, y: 0, z: 0 },
      tolerance: 0.05,
      reward_eth: "0.1",
    });
    expect(created.status).to.equal(201);
    const taskId = created.body.task_id;

    // 2. fund escrow
    const funded = await sys.api("POST", `/tasks/${taskId}/fund`);
    expect(funded.status).to.equal(200);
    expect(funded.body.status).to.equal("FUNDED");
    expect(await ethers.provider.getBalance(escrowAddress)).to.equal(REWARD);

    // 3. trigger mock robot execution
    const started = await sys.api("POST", `/tasks/${taskId}/start`, { mock_outcome: "success" });
    expect(started.status).to.equal(202);
    expect(started.body.status).to.equal("RUNNING");

    // 4-13. robot proof arrives → verified → committed → settled
    const final = await sys.waitForStatus(taskId, ["SETTLED", "FAILED"]);
    expect(final.status, JSON.stringify(final.events)).to.equal("SETTLED");
    expect(final.events.map((e) => e.type)).to.deep.equal([
      "TASK_CREATED",
      "ESCROW_FUNDED",
      "ROBOT_EXECUTION_STARTED",
      "PROOF_RECEIVED",
      "PROOF_VERIFIED",
      "PROOF_COMMITTED",
      "SETTLEMENT_RELEASED",
    ]);

    // Proof pipeline outputs are independently reproducible from the stored off-chain proof.
    const proof = final.proof!;
    expect(proof.canonical_proof).to.equal(canonicalize(proof.raw));
    expect(proof.proof_hash).to.equal(computeProofHash(proof.raw));
    expect(recoverProofSigner(proof.proof_hash, proof.signature)).to.equal(sys.signers.robot.address);
    expect(proof.raw).to.include({ task_id: taskId, robot_id: "robot_001", success: true });

    // Physical success computed from coordinates, not from the success flag.
    const v = final.verification!;
    expect(v.passed).to.equal(true);
    expect(v.placement.within_tolerance).to.equal(true);
    expect(v.placement.distance).to.be.at.most(0.05);
    expect(v.checks.every((c) => c.ok)).to.equal(true);

    // 14. transaction hashes
    for (const key of ["fund", "commit", "settle"] as const) {
      expect(final.transactions[key], key).to.match(/^0x[0-9a-f]{64}$/);
      const receipt = await ethers.provider.getTransactionReceipt(final.transactions[key]!);
      expect(receipt?.status, key).to.equal(1);
    }

    // 15. final on-chain state
    expect(final.onchain).to.deep.equal({
      onchain_task_id: final.onchain_task_id,
      requester: sys.signers.requester.address,
      robot: sys.signers.robot.address,
      payee: payee.address,
      amount_wei: REWARD.toString(),
      proof_hash: proof.proof_hash,
      status: "Settled",
      spec_hash: final.spec_hash,
    });
    expect(final.spec_hash).to.equal(computeTaskSpecHash(final)); // task spec anchored on-chain at funding
    const committed = await sys.escrow.contract.queryFilter(sys.escrow.contract.filters.ProofCommitted(final.onchain_task_id));
    expect(committed).to.have.length(1);
    expect(committed[0].args.proofHash).to.equal(proof.proof_hash);
    expect(committed[0].args.passed).to.equal(true);

    // 16. payment settled exactly once
    expect((await ethers.provider.getBalance(payee.address)) - payeeBefore).to.equal(REWARD);
    expect(await ethers.provider.getBalance(escrowAddress)).to.equal(0n);
    const settledEvents = await sys.escrow.contract.queryFilter(sys.escrow.contract.filters.TaskSettled(final.onchain_task_id));
    expect(settledEvents).to.have.length(1);

    // Re-settlement is refused by both the API and the contract; no extra money moves.
    expect((await sys.api("POST", `/tasks/${taskId}/settle`)).status).to.equal(409);
    expect((await sys.api("POST", `/tasks/${taskId}/proof`, { proof: proof.raw, signature: proof.signature })).status).to.equal(409);
    let chainError: unknown;
    try {
      await sys.escrow.settle(taskId);
    } catch (err) {
      chainError = err;
    }
    expect(chainError).to.be.instanceOf(ChainError);
    expect((chainError as ChainError).revertName).to.equal("InvalidStatus");
    expect((await ethers.provider.getBalance(payee.address)) - payeeBefore).to.equal(REWARD);
  });

  it("a failed robot execution is committed as failed and never pays", async () => {
    const payeeBefore = await ethers.provider.getBalance(sys.signers.payee.address);
    const task = await sys.fundedTask();
    await sys.api("POST", `/tasks/${task.task_id}/start`, { mock_outcome: "false_success" });
    const final = await sys.waitForStatus(task.task_id, ["SETTLED", "FAILED"]);

    expect(final.status).to.equal("FAILED");
    expect(final.verification?.passed).to.equal(false);
    expect((final.proof?.raw as { success: boolean }).success).to.equal(true); // the robot lied
    expect(final.onchain).to.deep.include({ status: "Refunded", proof_hash: final.proof?.proof_hash });
    expect(await ethers.provider.getBalance(sys.signers.payee.address)).to.equal(payeeBefore);
  });
});
