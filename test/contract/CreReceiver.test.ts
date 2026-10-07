/**
 * MachineTaskEscrow as a Chainlink CRE consumer (IReceiver), driven through the real
 * MockKeystoneForwarder bytecode that `cre workflow simulate --broadcast` writes through.
 */
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { id, keccak256, toUtf8Bytes, type Contract } from "ethers";
import { ethers } from "hardhat";
import { buildRawReport, deployMockForwarder, encodeSettlementReport } from "../../src/cre/forwarder";
import type { MachineTaskEscrow } from "../../typechain-types";

const TASK_ID = keccak256(toUtf8Bytes("task_cre_001"));
const TASK_ID_2 = keccak256(toUtf8Bytes("task_cre_002"));
const SPEC_HASH = keccak256(toUtf8Bytes('{"task_id":"task_cre_001"}'));
const PROOF_HASH = keccak256(toUtf8Bytes('{"proof":1}'));
const AMOUNT = ethers.parseEther("0.1");
const WORKFLOW_ID = id("machineproof-settlement");
const enum Status {
  None,
  Funded,
  Verified,
  Failed,
  Settled,
  Refunded,
}

describe("MachineTaskEscrow — CRE receiver (onReport via MockKeystoneForwarder)", () => {
  async function deployFixture() {
    const [verifier, requester, robot, payee, stranger, transmitter] = await ethers.getSigners();
    const escrow = await ethers.deployContract("MachineTaskEscrow", [verifier.address]);
    const forwarder = (await deployMockForwarder(verifier)) as Contract;
    await escrow.setCreForwarder(await forwarder.getAddress());
    await escrow.connect(requester).fundTaskWithSpec(TASK_ID, robot.address, payee.address, SPEC_HASH, { value: AMOUNT });
    const sign = (hash: string, signer = robot) => signer.signMessage(ethers.getBytes(hash));
    const rawReport = async (opts: { taskId?: string; proofHash?: string; passed?: boolean; signature?: string } = {}) => {
      const proofHash = opts.proofHash ?? PROOF_HASH;
      const payload = encodeSettlementReport({
        onchainTaskId: opts.taskId ?? TASK_ID,
        proofHash,
        passed: opts.passed ?? true,
        robotSignature: opts.signature ?? (await sign(proofHash)),
      });
      return buildRawReport(payload, { workflowId: WORKFLOW_ID, workflowName: "mproof", workflowOwner: transmitter.address });
    };
    const deliver = (raw: string) => forwarder.connect(transmitter).getFunction("report")(escrow.target, raw, "0x", []);
    return { escrow, forwarder, verifier, requester, robot, payee, stranger, transmitter, sign, rawReport, deliver };
  }

  it("advertises the IReceiver and IERC165 interfaces (checked by the forwarder via ERC165)", async () => {
    const { escrow } = await loadFixture(deployFixture);
    const iReceiverId = id("onReport(bytes,bytes)").slice(0, 10);
    expect(await escrow.supportsInterface(iReceiverId)).to.equal(true);
    expect(await escrow.supportsInterface("0x01ffc9a7")).to.equal(true);
    expect(await escrow.supportsInterface("0xffffffff")).to.equal(false);
  });

  it("fundTaskWithSpec anchors the task spec hash; plain fundTask leaves it empty", async () => {
    const { escrow, requester, robot, payee } = await loadFixture(deployFixture);
    expect(await escrow.taskSpecHash(TASK_ID)).to.equal(SPEC_HASH);
    await expect(escrow.connect(requester).fundTask(TASK_ID_2, robot.address, payee.address, { value: AMOUNT })).to.not.emit(
      escrow,
      "TaskSpecAnchored",
    );
    expect(await escrow.taskSpecHash(TASK_ID_2)).to.equal(ethers.ZeroHash);
  });

  it("only the verifier can configure the CRE forwarder", async () => {
    const { escrow, stranger } = await loadFixture(deployFixture);
    await expect(escrow.connect(stranger).setCreForwarder(stranger.address)).to.be.revertedWithCustomError(escrow, "NotVerifier");
    await expect(escrow.setCreForwarder(stranger.address)).to.emit(escrow, "CreForwarderUpdated").withArgs(stranger.address);
  });

  it("rejects onReport from anyone but the configured forwarder", async () => {
    const { escrow, stranger, verifier, robot } = await loadFixture(deployFixture);
    const payload = encodeSettlementReport({
      onchainTaskId: TASK_ID,
      proofHash: PROOF_HASH,
      passed: true,
      robotSignature: await robot.signMessage(ethers.getBytes(PROOF_HASH)),
    });
    for (const caller of [stranger, verifier, robot]) {
      await expect(escrow.connect(caller).onReport("0x", payload)).to.be.revertedWithCustomError(escrow, "NotCreForwarder");
    }
  });

  it("passing report: commits the proof and pays the payee atomically in one forwarder transaction", async () => {
    const { escrow, forwarder, payee, transmitter, rawReport, deliver } = await loadFixture(deployFixture);
    const tx = deliver(await rawReport({ passed: true }));
    await expect(tx).to.changeEtherBalances([escrow, payee], [-AMOUNT, AMOUNT]);
    await expect(tx).to.emit(escrow, "ProofCommitted").withArgs(TASK_ID, PROOF_HASH, true);
    await expect(tx).to.emit(escrow, "TaskSettled").withArgs(TASK_ID, payee.address, AMOUNT);
    await expect(tx)
      .to.emit(escrow, "CreReportProcessed")
      .withArgs(TASK_ID, WORKFLOW_ID, transmitter.address, PROOF_HASH, true);
    await expect(tx).to.emit(forwarder, "ReportProcessed");
    const task = await escrow.getTask(TASK_ID);
    expect(task.status).to.equal(Status.Settled);
    expect(task.proofHash).to.equal(PROOF_HASH);
  });

  it("failing report: commits the proof as failed and refunds the requester, payee gets nothing", async () => {
    const { escrow, requester, payee, rawReport, deliver } = await loadFixture(deployFixture);
    const tx = deliver(await rawReport({ passed: false }));
    await expect(tx).to.changeEtherBalances([escrow, requester, payee], [-AMOUNT, AMOUNT, 0n]);
    await expect(tx).to.emit(escrow, "TaskRefunded").withArgs(TASK_ID, requester.address, AMOUNT);
    expect((await escrow.getTask(TASK_ID)).status).to.equal(Status.Refunded);
  });

  describe("reports the receiver refuses (forwarder records result=false, no money moves)", () => {
    async function expectRefused(deliverTx: Promise<unknown>, escrow: MachineTaskEscrow, forwarder: Contract, expectedStatus = Status.Funded) {
      const receipt = await (await (deliverTx as Promise<{ wait(): Promise<{ logs: unknown[] }> }>)).wait();
      const processed = (receipt.logs as Array<{ topics: string[]; data: string }>)
        .map((l) => {
          try {
            return forwarder.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l) => l?.name === "ReportProcessed");
      expect(processed?.args.result, "forwarder ReportProcessed.result").to.equal(false);
      expect((await escrow.getTask(TASK_ID)).status).to.equal(expectedStatus);
    }

    it("robot signature from the wrong key", async () => {
      const { escrow, forwarder, stranger, sign, rawReport, deliver, payee } = await loadFixture(deployFixture);
      const before = await ethers.provider.getBalance(payee.address);
      await expectRefused(deliver(await rawReport({ signature: await sign(PROOF_HASH, stranger) })), escrow, forwarder as Contract);
      expect(await ethers.provider.getBalance(payee.address)).to.equal(before);
    });

    it("signature over a different hash (tampered proof)", async () => {
      const { escrow, forwarder, sign, rawReport, deliver } = await loadFixture(deployFixture);
      const otherHash = keccak256(toUtf8Bytes("tampered"));
      await expectRefused(deliver(await rawReport({ signature: await sign(otherHash) })), escrow, forwarder as Contract);
    });

    it("a replayed report cannot pay twice", async () => {
      const { escrow, forwarder, payee, rawReport, deliver } = await loadFixture(deployFixture);
      const raw = await rawReport({ passed: true });
      await deliver(raw);
      const before = await ethers.provider.getBalance(payee.address);
      await expectRefused(deliver(raw), escrow, forwarder as Contract, Status.Settled);
      expect(await ethers.provider.getBalance(payee.address)).to.equal(before);
      expect(await escrow.queryFilter(escrow.filters.TaskSettled(TASK_ID))).to.have.length(1);
    });

    it("a task that was never funded", async () => {
      const { escrow, rawReport, deliver } = await loadFixture(deployFixture);
      await deliver(await rawReport({ taskId: TASK_ID_2 }));
      expect((await escrow.getTask(TASK_ID_2)).status).to.equal(Status.None);
      expect((await escrow.getTask(TASK_ID)).status).to.equal(Status.Funded);
    });

    it("a proof hash already used by another task", async () => {
      const { escrow, forwarder, requester, robot, payee, rawReport, deliver } = await loadFixture(deployFixture);
      await escrow.connect(requester).fundTaskWithSpec(TASK_ID_2, robot.address, payee.address, SPEC_HASH, { value: AMOUNT });
      await deliver(await rawReport({ taskId: TASK_ID_2 }));
      await expectRefused(deliver(await rawReport()), escrow, forwarder as Contract);
    });

    it("a malformed report payload", async () => {
      const { escrow, forwarder, deliver } = await loadFixture(deployFixture);
      await expectRefused(deliver(buildRawReport("0xdeadbeef")), escrow, forwarder as Contract);
    });

    it("a report delivered by a forwarder that is no longer configured", async () => {
      const { escrow, forwarder, stranger, rawReport, deliver } = await loadFixture(deployFixture);
      await escrow.setCreForwarder(stranger.address);
      await expectRefused(deliver(await rawReport()), escrow, forwarder as Contract);
    });
  });

  describe("workflow pinning (production hardening: only one workflow/owner may settle)", () => {
    it("only the verifier can pin the workflow", async () => {
      const { escrow, stranger } = await loadFixture(deployFixture);
      await expect(escrow.connect(stranger).setCreWorkflow(WORKFLOW_ID, stranger.address)).to.be.revertedWithCustomError(
        escrow,
        "NotVerifier",
      );
    });

    it("accepts reports whose metadata matches the pinned workflow id and owner", async () => {
      const { escrow, transmitter, rawReport, deliver } = await loadFixture(deployFixture);
      await expect(escrow.setCreWorkflow(WORKFLOW_ID, transmitter.address))
        .to.emit(escrow, "CreWorkflowPinned")
        .withArgs(WORKFLOW_ID, transmitter.address);
      await deliver(await rawReport());
      expect((await escrow.getTask(TASK_ID)).status).to.equal(Status.Settled);
    });

    it("refuses reports from another workflow id or owner (forwarder records result=false)", async () => {
      const { escrow, stranger, rawReport, deliver } = await loadFixture(deployFixture);
      await escrow.setCreWorkflow(id("some-other-workflow"), ethers.ZeroAddress);
      await deliver(await rawReport());
      expect((await escrow.getTask(TASK_ID)).status).to.equal(Status.Funded);
      await escrow.setCreWorkflow(ethers.ZeroHash, stranger.address);
      await deliver(await rawReport());
      expect((await escrow.getTask(TASK_ID)).status).to.equal(Status.Funded);
      await escrow.setCreWorkflow(ethers.ZeroHash, ethers.ZeroAddress); // unpinned again
      await deliver(await rawReport());
      expect((await escrow.getTask(TASK_ID)).status).to.equal(Status.Settled);
    });
  });

  it("the verifier fallback path and the CRE path share one state machine (no double settlement across paths)", async () => {
    const { escrow, robot, payee, rawReport, deliver } = await loadFixture(deployFixture);
    const sig = await robot.signMessage(ethers.getBytes(PROOF_HASH));
    await escrow.commitProof(TASK_ID, PROOF_HASH, true, sig);
    await escrow.settle(TASK_ID);
    const before = await ethers.provider.getBalance(payee.address);
    await deliver(await rawReport());
    expect(await ethers.provider.getBalance(payee.address)).to.equal(before);
    expect((await escrow.getTask(TASK_ID)).status).to.equal(Status.Settled);
  });
});
