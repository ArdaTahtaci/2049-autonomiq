/**
 * Adversarial suite for the Chainlink CRE settlement path (SETTLEMENT_MODE=cre).
 *
 * Drives the REAL pieces: Express API → TaskService (cre mode) → MachineTaskEscrow and the real
 * MockKeystoneForwarder bytecode that `cre workflow simulate --broadcast` writes through, on Hardhat's
 * in-process network. The workflow's own policy is attacked in cre/machineproof-settlement/adversarial.test.ts.
 *
 * Conventions (same as attacks.test.ts)
 *   it(...)                    the attack is DEFENDED; the test asserts the defence.
 *   it.skip(...) + "// BUG:"   the attack SUCCEEDS today (reproduced). The test asserts the CORRECT
 *                              behaviour: remove `.skip` to reproduce; it must pass once fixed.
 *   "(known limitation)"       a trust-model boundary of the current design; the test pins today's
 *                              behaviour so nobody mistakes it for a guarantee (README must state it).
 */
import { expect } from "chai";
import {
  Signature,
  Wallet,
  ZeroAddress,
  ZeroHash,
  concat,
  getBytes,
  hexlify,
  id,
  keccak256,
  parseEther,
  toBeHex,
  toUtf8Bytes,
  zeroPadValue,
  type Contract,
  type Signer,
} from "ethers";
import { ethers } from "hardhat";
import { EscrowClient, deployEscrow } from "../../src/chain/escrow";
import { HARDHAT_DEV_KEYS } from "../../src/config";
import { buildRawReport, deployMockForwarder, encodeSettlementReport, type ReportMetadata } from "../../src/cre/forwarder";
import { computeTaskSpecHash, signProof } from "../../src/proof";
import { ExternalRobotAdapter } from "../../src/robot/adapter";
import { generateMockProof, type MockOutcome } from "../../src/robot/mockProof";
import { HttpError, TaskService, type TaskServiceConfig } from "../../src/tasks/service";
import type { Task, TaskView } from "../../src/tasks/types";
import type { ReentrantPayee } from "../../typechain-types";
import { REWARD, RecordingCreTrigger, startTestSystem, type TestSystem } from "../helpers/system";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

const AMOUNT = parseEther("0.1");
const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const robotWallet = new Wallet(HARDHAT_DEV_KEYS.robot); // same identity as signers.robot (account #2)
const balance = (address: string): Promise<bigint> => ethers.provider.getBalance(address);
const taskKey = (taskId: string): string => keccak256(toUtf8Bytes(taskId));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** High-s twin of a valid signature (same signer): s' = n - s, flipped v. */
function malleate(signature: string): string {
  const sig = Signature.from(signature);
  return concat([sig.r, toBeHex(SECP256K1_N - BigInt(sig.s), 32), new Uint8Array([sig.v === 27 ? 28 : 27])]);
}
const withV = (signature: string, v: number): string => signature.slice(0, 130) + v.toString(16).padStart(2, "0");

function forgedReport(
  r: { key: string; proofHash: string; passed: boolean; signature: string },
  meta: ReportMetadata = { workflowId: id("machineproof-settlement") },
): string {
  return buildRawReport(
    encodeSettlementReport({ onchainTaskId: r.key, proofHash: r.proofHash, passed: r.passed, robotSignature: r.signature }),
    meta,
  );
}

/** Sends forwarder.report(receiver, raw) from `from`; returns the forwarder's ReportProcessed.result. */
async function viaForwarder(forwarder: Contract, from: Signer, receiver: string, raw: string): Promise<{ routed: boolean; txHash: string }> {
  const tx = await (forwarder.connect(from) as Contract).getFunction("report")(receiver, raw, "0x", []);
  const receipt = await tx.wait();
  for (const log of receipt.logs as Array<{ topics: string[]; data: string }>) {
    try {
      const parsed = forwarder.interface.parseLog(log);
      if (parsed?.name === "ReportProcessed") return { routed: Boolean(parsed.args.result), txHash: receipt.hash };
    } catch {
      /* not a forwarder log */
    }
  }
  throw new Error("forwarder emitted no ReportProcessed");
}

async function expectHttpError(promise: Promise<unknown>, status: number, message?: RegExp): Promise<HttpError> {
  try {
    await promise;
  } catch (err) {
    expect(err, String(err)).to.be.instanceOf(HttpError);
    expect((err as HttpError).status, (err as Error).message).to.equal(status);
    if (message) expect((err as Error).message).to.match(message);
    return err as HttpError;
  }
  return expect.fail(`expected an HttpError ${status}`);
}

/** A fresh escrow + real MockKeystoneForwarder (no backend). One deployment per test: no snapshot games. */
async function freshEscrow() {
  const [verifier, requester, robot, payee, stranger, transmitter] = await ethers.getSigners();
  const escrow = await deployEscrow(verifier, verifier.address);
  const forwarder = (await deployMockForwarder(verifier)) as Contract;
  await (await escrow.setCreForwarder(await forwarder.getAddress())).wait();
  const escrowAddress = await escrow.getAddress();
  const proofHash = (label: string) => keccak256(toUtf8Bytes(`{"proof":"${label}"}`));
  const sign = (hash: string, signer: Signer = robot) => signer.signMessage(getBytes(hash));
  const fund = async (label: string, opts: { robot?: string; payee?: string; spec?: string | null } = {}) => {
    const key = taskKey(label);
    const c = escrow.connect(requester);
    const robotAddr = opts.robot ?? robot.address;
    const payeeAddr = opts.payee ?? payee.address;
    const tx =
      opts.spec === null
        ? await c.fundTask(key, robotAddr, payeeAddr, { value: AMOUNT })
        : await c.fundTaskWithSpec(key, robotAddr, payeeAddr, opts.spec ?? id(`spec:${label}`), { value: AMOUNT });
    await tx.wait();
    return key;
  };
  const deliver = (raw: string, from: Signer = stranger) => viaForwarder(forwarder, from, escrowAddress, raw);
  const status = async (key: string) => Number((await escrow.getTask(key)).status);
  return { escrow, forwarder, escrowAddress, verifier, requester, robot, payee, stranger, transmitter, proofHash, sign, fund, deliver, status };
}

const S = { None: 0, Funded: 1, Verified: 2, Failed: 3, Settled: 4, Refunded: 5 } as const;

/** TaskService in cre mode WITHOUT HTTP, so tests can tune the CRE timeout and run two "restarts" on one escrow. */
async function startCreService(opts: { settlementTimeoutMs?: number } = {}) {
  const [verifier, requester, robot, payee, stranger, transmitter] = await ethers.getSigners();
  const contract = await deployEscrow(verifier, verifier.address);
  const forwarder = (await deployMockForwarder(verifier)) as Contract;
  await (await contract.setCreForwarder(await forwarder.getAddress())).wait();
  const escrow = new EscrowClient(await contract.getAddress(), verifier, requester);
  const trigger = new RecordingCreTrigger();
  const config: TaskServiceConfig = {
    robots: { robot_001: robot.address },
    defaultRobotId: "robot_001",
    payeeAddress: payee.address,
    defaultTolerance: 0.05,
    defaultRewardWei: REWARD,
  };
  const newService = () =>
    new TaskService({ config, escrow, robot: new ExternalRobotAdapter(), cre: { trigger, settlementTimeoutMs: opts.settlementTimeoutMs } });
  /** The workflow's on-chain write for `taskId` (what the CRE simulator broadcasts). */
  const workflowWrite = (taskId: string, proofHash: string, signature: string, passed: boolean) =>
    viaForwarder(forwarder, transmitter, escrow.address, forgedReport({ key: taskKey(taskId), proofHash, passed, signature }));
  return { contract, forwarder, escrow, trigger, newService, workflowWrite, signers: { verifier, requester, robot, payee, stranger, transmitter } };
}

async function robotSigned(task: Pick<Task, "task_id" | "robot_id" | "start_position" | "target_position" | "tolerance">, outcome: MockOutcome = "success", now?: Date) {
  const proof = generateMockProof(task, outcome, now ? { now } : {});
  return { proof, ...(await signProof(proof, robotWallet)) };
}

describe("Adversarial: Chainlink CRE settlement path", () => {
  /* ───────────────────────────────────────────────────────────────────────────────────────────── */
  describe("1. MachineTaskEscrow.onReport via the (permissionless) MockKeystoneForwarder", () => {
    it("(known limitation) anyone can call MockKeystoneForwarder.report(): a stranger delivers a robot-signed report and settles", async () => {
      const f = await freshEscrow();
      const key = await f.fund("t1");
      const hash = f.proofHash("t1");
      const payeeBefore = await balance(f.payee.address);
      const { routed } = await f.deliver(forgedReport({ key, proofHash: hash, passed: true, signature: await f.sign(hash) }), f.stranger);
      expect(routed).to.equal(true);
      expect(await f.status(key)).to.equal(S.Settled);
      expect((await balance(f.payee.address)) - payeeBefore).to.equal(AMOUNT);
    });

    it("(known limitation) the mock forwarder's route() is open too: a stranger passes ANY metadata (even empty) straight to onReport", async () => {
      const f = await freshEscrow();
      const route = (key: string, hash: string, sig: string, metadata: string) =>
        (f.forwarder.connect(f.stranger) as Contract)
          .getFunction("route")(id(`tx:${key}:${metadata.length}`), f.stranger.address, f.escrowAddress, metadata, encodeSettlementReport({ onchainTaskId: key, proofHash: hash, passed: true, robotSignature: sig }))
          .then((tx: { wait(): Promise<unknown> }) => tx.wait());

      // Unpinned: empty metadata is accepted (workflowId/owner decode to zero) and the task settles.
      const k1 = await f.fund("route-1");
      const h1 = f.proofHash("route-1");
      await route(k1, h1, await f.sign(h1), "0x");
      expect(await f.status(k1)).to.equal(S.Settled);

      // Pinned: short/empty metadata decodes to zero and is refused (the pins hold against route() as well).
      await (await f.escrow.setCreWorkflow(id("wf"), ZeroAddress)).wait();
      const k2 = await f.fund("route-2");
      const h2 = f.proofHash("route-2");
      await route(k2, h2, await f.sign(h2), "0x");
      expect(await f.status(k2)).to.equal(S.Funded);
      // …but the attacker just supplies the (public) pinned id:
      await route(k2, h2, await f.sign(h2), concat([id("wf"), new Uint8Array(32)]));
      expect(await f.status(k2)).to.equal(S.Settled);
    });

    it("(known limitation) the escrow does not require a spec anchor: a task funded with plain fundTask() is settleable via a report", async () => {
      const f = await freshEscrow();
      const key = await f.fund("nospec", { spec: null });
      expect(await f.escrow.taskSpecHash(key)).to.equal(ZeroHash);
      const hash = f.proofHash("nospec");
      expect((await f.deliver(forgedReport({ key, proofHash: hash, passed: true, signature: await f.sign(hash) }))).routed).to.equal(true);
      expect(await f.status(key)).to.equal(S.Settled);
    });

    it("(known limitation) workflow pins do not stop a forged report through the MOCK forwarder: metadata is caller-supplied and the pins are public storage", async () => {
      const f = await freshEscrow();
      const key = await f.fund("pinned");
      await (await f.escrow.setCreWorkflow(id("the-real-workflow"), f.transmitter.address)).wait();
      // The attacker simply reads the pins and writes them into the metadata header.
      const meta = { workflowId: await f.escrow.expectedWorkflowId(), workflowOwner: await f.escrow.expectedWorkflowOwner() };
      const hash = f.proofHash("pinned");
      const { routed } = await f.deliver(forgedReport({ key, proofHash: hash, passed: true, signature: await f.sign(hash) }, meta), f.stranger);
      expect(routed).to.equal(true);
      expect(await f.status(key)).to.equal(S.Settled);
    });

    it("pins refuse a foreign workflow id / owner, and metadata shorter than 62 bytes (raw EOA forwarder)", async () => {
      const f = await freshEscrow();
      const hash = f.proofHash("short");
      const key = await f.fund("short");
      const sig = await f.sign(hash);
      const payload = encodeSettlementReport({ onchainTaskId: key, proofHash: hash, passed: true, robotSignature: sig });

      // Through the mock forwarder: wrong id, wrong owner → refused.
      await (await f.escrow.setCreWorkflow(id("wf"), f.transmitter.address)).wait();
      expect((await f.deliver(forgedReport({ key, proofHash: hash, passed: true, signature: sig }, { workflowId: id("other"), workflowOwner: f.transmitter.address }))).routed).to.equal(false);
      expect((await f.deliver(forgedReport({ key, proofHash: hash, passed: true, signature: sig }, { workflowId: id("wf"), workflowOwner: f.stranger.address }))).routed).to.equal(false);

      // A forwarder that passes short metadata (here: an EOA configured as forwarder) cannot bypass the pins.
      await (await f.escrow.setCreForwarder(f.stranger.address)).wait();
      const asFwd = f.escrow.connect(f.stranger);
      for (const metadata of ["0x", hexlify(new Uint8Array(61)), concat([id("wf"), new Uint8Array(29)])]) {
        await expect(asFwd.onReport(metadata, payload)).to.be.revertedWithCustomError(f.escrow, "UnexpectedWorkflow");
      }
      // Exactly 62 bytes with the pinned id + owner is accepted.
      const ok62 = concat([id("wf"), new Uint8Array(10), f.transmitter.address]);
      expect(getBytes(ok62).length).to.equal(62);
      await (await asFwd.onReport(ok62, payload)).wait();
      expect(await f.status(key)).to.equal(S.Settled);
    });

    it("(known limitation) an UNPINNED escrow accepts reports carrying any workflow id/owner (and none at all)", async () => {
      const f = await freshEscrow();
      const key = await f.fund("unpinned");
      const hash = f.proofHash("unpinned");
      const meta = { workflowId: id("someone-elses-workflow"), workflowOwner: Wallet.createRandom().address };
      expect((await f.deliver(forgedReport({ key, proofHash: hash, passed: true, signature: await f.sign(hash) }, meta))).routed).to.equal(true);
      expect(await f.status(key)).to.equal(S.Settled);
    });

    describe("a forged report still needs the ON-CHAIN robot's EIP-191 signature over that exact proof hash", () => {
      const variants: Array<[string, (f: Awaited<ReturnType<typeof freshEscrow>>, hash: string) => Promise<string>]> = [
        ["random key", async (_f, h) => Wallet.createRandom().signMessage(getBytes(h))],
        ["stranger key", (f, h) => f.sign(h, f.stranger)],
        ["payee key", (f, h) => f.sign(h, f.payee)],
        ["verifier key", (f, h) => f.sign(h, f.verifier)],
        ["robot over a different hash", (f) => f.sign(keccak256(toUtf8Bytes("other")))],
        ["robot over the hash's hex string", async (_f, h) => robotWallet.signMessage(h)],
        ["robot raw secp256k1 (no EIP-191 prefix)", async (_f, h) => robotWallet.signingKey.sign(h).serialized],
        ["high-s twin", async (f, h) => malleate(await f.sign(h))],
        ["v = 0", async (f, h) => withV(await f.sign(h), 0)],
        ["v = 1", async (f, h) => withV(await f.sign(h), 1)],
        ["ERC-2098 compact 64 bytes", async (f, h) => Signature.from(await f.sign(h)).compactSerialized],
        ["66 bytes", async (f, h) => (await f.sign(h)) + "00"],
        ["empty", async () => "0x"],
        ["all zero 65 bytes", async () => hexlify(new Uint8Array(65))],
      ];
      for (const [label, makeSig] of variants) {
        it(`refused: ${label} (no money moves)`, async () => {
          const f = await freshEscrow();
          const key = await f.fund("sig");
          const hash = f.proofHash("sig");
          const payeeBefore = await balance(f.payee.address);
          const { routed } = await f.deliver(forgedReport({ key, proofHash: hash, passed: true, signature: await makeSig(f, hash) }));
          expect(routed).to.equal(false);
          expect(await f.status(key)).to.equal(S.Funded);
          expect(await balance(f.payee.address)).to.equal(payeeBefore);
        });
      }
    });

    it("(known limitation) the proof hash is not bound to the task on-chain: task A's robot-signed proof settles task B, and A's own report is then refused", async () => {
      const f = await freshEscrow();
      const a = await f.fund("task_A");
      const b = await f.fund("task_B");
      const hashA = f.proofHash("task_A");
      const sigA = await f.sign(hashA);
      // Replay A's (public) robot signature onto B.
      expect((await f.deliver(forgedReport({ key: b, proofHash: hashA, passed: true, signature: sigA }))).routed).to.equal(true);
      expect(await f.status(b)).to.equal(S.Settled);
      expect((await f.escrow.getTask(b)).proofHash).to.equal(hashA);
      // The legitimate workflow write for A now reverts inside onReport (ProofAlreadyUsed), swallowed by the forwarder.
      expect((await f.deliver(forgedReport({ key: a, proofHash: hashA, passed: true, signature: sigA }), f.transmitter)).routed).to.equal(false);
      expect(await f.status(a)).to.equal(S.Funded);
    });

    describe("malformed report payloads are refused without state change", () => {
      const word = (n: bigint | number) => zeroPadValue(toBeHex(n), 32);
      const cases: Array<[string, (valid: string) => string]> = [
        ["empty payload", () => "0x"],
        ["truncated payload (signature bytes cut)", (v) => v.slice(0, v.length - 64)],
        ["bool encoded as 2", (v) => v.slice(0, 2 + 128) + word(2).slice(2) + v.slice(2 + 192)],
        ["signature offset pointing past the end", (v) => v.slice(0, 2 + 192) + word(2n ** 64n).slice(2) + v.slice(2 + 256)],
        ["signature length 2^255", (v) => v.slice(0, 2 + 256) + word(2n ** 255n).slice(2) + v.slice(2 + 320)],
      ];
      for (const [label, mutate] of cases) {
        it(`refused: ${label}`, async () => {
          const f = await freshEscrow();
          const key = await f.fund("mal");
          const hash = f.proofHash("mal");
          const valid = encodeSettlementReport({ onchainTaskId: key, proofHash: hash, passed: true, robotSignature: await f.sign(hash) });
          const { routed } = await f.deliver(buildRawReport(mutate(valid)));
          expect(routed).to.equal(false);
          expect(await f.status(key)).to.equal(S.Funded);
        });
      }

      it("(documented) trailing bytes after a valid payload are ignored by abi.decode: the report is processed as-is", async () => {
        const f = await freshEscrow();
        const key = await f.fund("trail");
        const hash = f.proofHash("trail");
        const valid = encodeSettlementReport({ onchainTaskId: key, proofHash: hash, passed: false, robotSignature: await f.sign(hash) });
        expect((await f.deliver(buildRawReport(concat([valid, "0xdeadbeef"])))).routed).to.equal(true);
        expect(await f.status(key)).to.equal(S.Refunded);
      });

      it("a raw report shorter than the 109-byte metadata header is rejected by the forwarder itself", async () => {
        const f = await freshEscrow();
        let reverted = false;
        try {
          await (await (f.forwarder.connect(f.stranger) as Contract).getFunction("report")(f.escrowAddress, hexlify(new Uint8Array(108)), "0x", [])).wait();
        } catch {
          reverted = true;
        }
        expect(reverted).to.equal(true);
      });
    });

    describe("reentrancy and hostile payees/requesters during onReport", () => {
      it("payee contract re-entering settle()/refund() while being paid: re-entry fails, paid exactly once", async () => {
        const f = await freshEscrow();
        const rp: ReentrantPayee = await ethers.deployContract("ReentrantPayee", [f.escrowAddress]);
        const key = await f.fund("re1", { payee: await rp.getAddress() });
        await (await rp.setTarget(key)).wait();
        const hash = f.proofHash("re1");
        expect((await f.deliver(forgedReport({ key, proofHash: hash, passed: true, signature: await f.sign(hash) }))).routed).to.equal(true);
        expect(await rp.timesPaid()).to.equal(1n);
        expect(await rp.reentrySuccesses()).to.equal(0n);
        expect(await rp.reentryAttempts()).to.equal(2n);
        expect(await balance(await rp.getAddress())).to.equal(AMOUNT);
        expect(await balance(f.escrowAddress)).to.equal(0n);
      });

      it("requester contract re-entering during a CRE refund: re-entry fails, refunded exactly once", async () => {
        const f = await freshEscrow();
        const rp: ReentrantPayee = await ethers.deployContract("ReentrantPayee", [f.escrowAddress]);
        const key = taskKey("re2");
        await (await rp.fund(key, f.robot.address, f.payee.address, { value: AMOUNT })).wait();
        await (await rp.setTarget(key)).wait();
        const hash = f.proofHash("re2");
        expect((await f.deliver(forgedReport({ key, proofHash: hash, passed: false, signature: await f.sign(hash) }))).routed).to.equal(true);
        expect(await f.status(key)).to.equal(S.Refunded);
        expect(await rp.timesPaid()).to.equal(1n);
        expect(await rp.reentrySuccesses()).to.equal(0n);
        expect(await balance(await rp.getAddress())).to.equal(AMOUNT);
      });

      it("(known limitation) a payee contract that rejects ETH makes every passing report revert (task stays Funded); only a failing verdict can release the escrow (refund)", async () => {
        const f = await freshEscrow();
        const rp: ReentrantPayee = await ethers.deployContract("ReentrantPayee", [f.escrowAddress]);
        await (await rp.setRejectPayments(true)).wait();
        const key = await f.fund("reject", { payee: await rp.getAddress() });
        const hash = f.proofHash("reject");
        const sig = await f.sign(hash);
        expect((await f.deliver(forgedReport({ key, proofHash: hash, passed: true, signature: sig }))).routed).to.equal(false);
        expect(await f.status(key)).to.equal(S.Funded);
        expect((await f.deliver(forgedReport({ key, proofHash: hash, passed: false, signature: sig }))).routed).to.equal(true);
        expect(await f.status(key)).to.equal(S.Refunded);
      });
    });

    describe("state machine: reports for tasks that are not Funded never move money", () => {
      it("unfunded, Settled, Refunded, verifier-Verified and verifier-Failed tasks all refuse a report", async () => {
        const f = await freshEscrow();
        const sigFor = async (label: string) => ({ hash: f.proofHash(label), sig: await f.sign(f.proofHash(label)) });

        // unfunded
        const none = taskKey("none");
        const n = await sigFor("none");
        expect((await f.deliver(forgedReport({ key: none, proofHash: n.hash, passed: true, signature: n.sig }))).routed).to.equal(false);

        // already settled by CRE → a second report with a NEW robot-signed hash cannot pay again
        const settled = await f.fund("settled");
        const s1 = await sigFor("settled-1");
        const s2 = await sigFor("settled-2");
        await f.deliver(forgedReport({ key: settled, proofHash: s1.hash, passed: true, signature: s1.sig }));
        const payeeBefore = await balance(f.payee.address);
        expect((await f.deliver(forgedReport({ key: settled, proofHash: s2.hash, passed: true, signature: s2.sig }))).routed).to.equal(false);
        expect(await balance(f.payee.address)).to.equal(payeeBefore);

        // refunded → a later passing report cannot pay the payee
        const refunded = await f.fund("refunded");
        const r1 = await sigFor("refunded-1");
        const r2 = await sigFor("refunded-2");
        await f.deliver(forgedReport({ key: refunded, proofHash: r1.hash, passed: false, signature: r1.sig }));
        expect((await f.deliver(forgedReport({ key: refunded, proofHash: r2.hash, passed: true, signature: r2.sig }))).routed).to.equal(false);
        expect(await f.status(refunded)).to.equal(S.Refunded);

        // verifier path committed (Verified / Failed) but did not settle → CRE cannot interfere
        const verified = await f.fund("verified");
        const v1 = await sigFor("verified-1");
        await (await f.escrow.commitProof(verified, v1.hash, true, v1.sig)).wait();
        const v2 = await sigFor("verified-2");
        expect((await f.deliver(forgedReport({ key: verified, proofHash: v2.hash, passed: false, signature: v2.sig }))).routed).to.equal(false);
        expect(await f.status(verified)).to.equal(S.Verified);
        const failed = await f.fund("failed");
        const x1 = await sigFor("failed-1");
        await (await f.escrow.commitProof(failed, x1.hash, false, x1.sig)).wait();
        const x2 = await sigFor("failed-2");
        expect((await f.deliver(forgedReport({ key: failed, proofHash: x2.hash, passed: true, signature: x2.sig }))).routed).to.equal(false);
        expect(await f.status(failed)).to.equal(S.Failed);
      });

      it("cross-path: after a CRE settlement the verifier key cannot settle or refund again", async () => {
        const f = await freshEscrow();
        const key = await f.fund("cross");
        const hash = f.proofHash("cross");
        await f.deliver(forgedReport({ key, proofHash: hash, passed: true, signature: await f.sign(hash) }));
        await expect(f.escrow.settle(key)).to.be.revertedWithCustomError(f.escrow, "InvalidStatus");
        await expect(f.escrow.refund(key)).to.be.revertedWithCustomError(f.escrow, "InvalidStatus");
        const other = f.proofHash("cross-2");
        await expect(f.escrow.commitProof(key, other, false, await f.sign(other))).to.be.revertedWithCustomError(f.escrow, "InvalidStatus");
        expect(await balance(f.escrowAddress)).to.equal(0n);
      });
    });
  });

  /* ───────────────────────────────────────────────────────────────────────────────────────────── */
  describe("2. backend in cre mode: what an outsider can do with public data + the mock forwarder", () => {
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

    async function handedToCre(outcome: MockOutcome = "success") {
      const task = await sys.fundedTask();
      const submission = await robotSigned(task, outcome);
      const res = await sys.api("POST", `/tasks/${task.task_id}/proof`, submission);
      expect(res.status, JSON.stringify(res.body).slice(0, 300)).to.equal(202);
      return { task, submission };
    }

    it("(known limitation) the robot signature is public as soon as the proof is received (GET /tasks/:id and the evidence endpoint, no auth)", async () => {
      const { task, submission } = await handedToCre();
      const view = (await sys.api("GET", `/tasks/${task.task_id}`)).body;
      expect(view.proof?.signature).to.equal(submission.signature);
      const ev = (await sys.api<any>("GET", `/cre/tasks/${task.task_id}/evidence`)).body;
      expect(ev.submission.signature).to.equal(submission.signature);
      expect(ev.submission.proof_hash).to.equal(submission.proof_hash);
    });

    it("(known limitation) an outsider front-runs the workflow and flips a FAILED proof to passed=true: the payee is paid and the backend adopts SETTLED (labelled chainlink-cre) without any alert", async () => {
      const { task } = await handedToCre("false_success"); // backend pre-screen verdict: failed
      expect((await sys.api("GET", `/tasks/${task.task_id}`)).body.verification?.passed).to.equal(false);
      const ev = (await sys.api<any>("GET", `/cre/tasks/${task.task_id}/evidence`)).body;
      const payeeBefore = await balance(task.payee);
      const { routed } = await viaForwarder(
        sys.forwarder!,
        sys.signers.stranger,
        sys.escrow.address,
        forgedReport({ key: task.onchain_task_id, proofHash: ev.submission.proof_hash, passed: true, signature: ev.submission.signature }),
      );
      expect(routed).to.equal(true);
      expect((await balance(task.payee)) - payeeBefore).to.equal(REWARD);
      const view = (await sys.api("GET", `/tasks/${task.task_id}`)).body;
      expect(view.status).to.equal("SETTLED");
      expect(view.verification?.passed).to.equal(false); // the backend's own verdict, silently overridden
      expect(view.events.find((e) => e.type === "SETTLEMENT_RELEASED")?.data).to.include({ settled_by: "chainlink-cre" });
      expect(view.cre?.transmitter).to.equal(sys.signers.stranger.address);
    });

    it("(known limitation) the requester can do the reverse: flip a PASSING proof to passed=false and take the escrow back", async () => {
      const { task } = await handedToCre("success");
      const ev = (await sys.api<any>("GET", `/cre/tasks/${task.task_id}/evidence`)).body;
      const requesterBefore = await balance(sys.signers.requester.address);
      const payeeBefore = await balance(task.payee);
      // sent by the stranger here so gas does not blur the requester's balance; the requester could send it itself
      await viaForwarder(
        sys.forwarder!,
        sys.signers.stranger,
        sys.escrow.address,
        forgedReport({ key: task.onchain_task_id, proofHash: ev.submission.proof_hash, passed: false, signature: ev.submission.signature }),
      );
      expect((await balance(sys.signers.requester.address)) - requesterBefore).to.equal(REWARD);
      expect(await balance(task.payee)).to.equal(payeeBefore);
      expect((await sys.api("GET", `/tasks/${task.task_id}`)).body.status).to.equal("FAILED");
    });

    // FIXED (was low): when the chain shows a settlement that contradicts the backend's own pre-screen verdict (or was
    // committed with a different proof hash than the one handed to CRE), adoptCreSettlement (src/tasks/service.ts
    // ~L530) adopts it silently. It should at least record an ERROR/alert event so an operator notices a forged
    // or foreign settlement. (The flip itself is the mock-forwarder limitation above.)
    it("the backend flags an on-chain settlement that contradicts its own verdict / proof hash", async () => {
      const { task } = await handedToCre("false_success");
      const ev = (await sys.api<any>("GET", `/cre/tasks/${task.task_id}/evidence`)).body;
      await viaForwarder(
        sys.forwarder!,
        sys.signers.stranger,
        sys.escrow.address,
        forgedReport({ key: task.onchain_task_id, proofHash: ev.submission.proof_hash, passed: true, signature: ev.submission.signature }),
      );
      const view = (await sys.api("GET", `/tasks/${task.task_id}`)).body;
      expect(view.events.some((e) => e.type === "ERROR" && /contradict|mismatch|unexpected/i.test(e.message))).to.equal(true);
    });
  });

  /* ───────────────────────────────────────────────────────────────────────────────────────────── */
  describe("3. backend in cre mode: unauthenticated workflow callbacks (POST /cre/tasks/:id/result)", () => {
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

    async function handedToCre(outcome: MockOutcome = "success") {
      const task = await sys.fundedTask();
      const submission = await robotSigned(task, outcome);
      const res = await sys.api("POST", `/tasks/${task.task_id}/proof`, submission);
      expect(res.status, JSON.stringify(res.body).slice(0, 300)).to.equal(202);
      return { task, submission };
    }
    const spoof = (taskId: string, body: Json) => sys.api<any>("POST", `/cre/tasks/${taskId}/result`, body);

    // FIXED (was medium): POST /cre/tasks/:id/result is unauthenticated, and a REJECTED decision without proof_hash is
    // treated as "same proof" (service.ts recordCreResult: `sameProof = !result.proof_hash || ...`). Anyone can
    // flip cre.status TRIGGERED → REJECTED while the real workflow is still running. Effects: the timeout never
    // fires (only TRIGGERED times out) and POST /tasks/:id/settle answers 409 "no proof awaiting CRE settlement",
    // so an operator cannot retry a lost/dropped trigger; only a new robot submission recovers the task.
    // Fix: authenticate the callback (shared secret / CRE vault secret in a header, or only accept it from the
    // workflow's DON), require proof_hash, and never let a callback alone change settlement-relevant state.
    it("a spoofed REJECTED callback cannot change cre.status or block the /settle retry", async () => {
      const { task } = await handedToCre();
      await spoof(task.task_id, { decision: "REJECTED", reasons: ["spoofed"] }); // no credentials: should be 401/403 or ignored
      const view = (await sys.api("GET", `/tasks/${task.task_id}`)).body;
      expect(view.cre?.status).to.equal("TRIGGERED");
      expect((await sys.api("POST", `/tasks/${task.task_id}/settle`)).status).to.equal(200);
    });

    it("after a spoofed REJECTED the chain still wins: the real workflow's settlement is adopted", async () => {
      const { task } = await handedToCre();
      await spoof(task.task_id, { decision: "REJECTED", reasons: ["spoofed"] });
      expect((await sys.api("GET", `/tasks/${task.task_id}`)).body.cre?.status).to.equal("TRIGGERED"); // callbacks are informational
      await sys.deliverCreReport(task.task_id, true);
      expect((await sys.api("GET", `/tasks/${task.task_id}`)).body.status).to.equal("SETTLED");
    });

    // FIXED (was medium): spoofed REJECTED + any invalid "resubmission" (no robot key needed) makes submitProof's rollback
    // (service.ts ~L263) delete task.proof and reset the task to its pre-proof status (FUNDED). Consequences:
    //   (a) a workflow run that is still in flight now gets 404 from the evidence endpoint → REJECTED, nothing settles;
    //   (b) if the run had already fetched the evidence it settles on-chain, but syncCreSettlement / the watcher only
    //       look at PROOF_RECEIVED tasks, so the backend shows FUNDED forever while the escrow is Settled
    //       (until the robot happens to submit again).
    // Fix: authenticate callbacks (see above); on a failed resubmission restore the previous proof + cre state
    // instead of deleting them; let syncCreSettlement adopt Settled/Refunded for any non-terminal task with task.cre.
    /** The workflow's on-chain write with evidence it fetched earlier (the backend may no longer serve it). */
    const workflowWrite = (task: TaskView, submission: { proof_hash: string; signature: string }, passed = true) =>
      viaForwarder(
        sys.forwarder!,
        sys.signers.transmitter,
        sys.escrow.address,
        forgedReport({ key: task.onchain_task_id, proofHash: submission.proof_hash, passed, signature: submission.signature }),
      );

    it("spoofed REJECTED + garbage resubmission cannot detach the backend from an in-flight CRE settlement", async () => {
      const { task, submission } = await handedToCre();
      await spoof(task.task_id, { decision: "REJECTED", reasons: ["spoofed"] });
      const garbage = { ...submission, proof: { ...submission.proof, final_object_position: { x: 1, y: 0, z: 0 } } };
      expect([409, 422]).to.include((await sys.api("POST", `/tasks/${task.task_id}/proof`, garbage)).status); // refused, state untouched
      // The workflow (which fetched the evidence before the attack) writes its report.
      expect((await workflowWrite(task, submission)).routed).to.equal(true);
      const view = await sys.waitForStatus(task.task_id, ["SETTLED"], 3_000);
      expect(view.status).to.equal("SETTLED");
    });

    it("a spoofed REJECTED for a different proof hash is ignored", async () => {
      const { task } = await handedToCre();
      await spoof(task.task_id, { decision: "REJECTED", proof_hash: ZeroHash, reasons: ["spoofed"] });
      const view = (await sys.api("GET", `/tasks/${task.task_id}`)).body;
      expect(view.cre?.status).to.equal("TRIGGERED");
      expect(view.status).to.equal("PROOF_RECEIVED");
    });

    it("spoofed SETTLED / REFUNDED / SKIPPED callbacks never move task state or money (state follows the chain)", async () => {
      const { task } = await handedToCre();
      for (const decision of ["SETTLED", "REFUNDED", "SKIPPED"]) {
        expect((await spoof(task.task_id, { decision, passed: decision === "SETTLED", tx_hash: ZeroHash })).status).to.equal(200);
        const view = (await sys.api("GET", `/tasks/${task.task_id}`)).body;
        expect(view.status).to.equal("PROOF_RECEIVED");
        expect(view.cre?.status).to.equal("TRIGGERED");
        expect(view.onchain).to.deep.include({ status: "Funded" });
      }
      await sys.deliverCreReport(task.task_id, true);
      expect((await sys.api("GET", `/tasks/${task.task_id}`)).body.status).to.equal("SETTLED");
    });

    it("callbacks for a task in direct mode / unknown task / malformed body are refused", async () => {
      expect((await spoof("does_not_exist", { decision: "REJECTED" })).status).to.equal(404);
      const { task } = await handedToCre();
      for (const body of [{}, { decision: "rejected" }, { decision: "REJECTED", reasons: ["x".repeat(501)] }, { decision: "REJECTED", proof_hash: "0x" + "a".repeat(80) }]) {
        expect((await spoof(task.task_id, body)).status).to.equal(400);
      }
      const malformed = await fetch(`${sys.url}/cre/tasks/${task.task_id}/result`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
      expect(malformed.status).to.equal(400);
    });

    // FIXED (was low): reasons from an unauthenticated callback end up in the task's final TASK_FAILED event
    // (adoptCreSettlement prefers cre.workflow_result.reasons over the backend's own verification reasons).
    // An outsider can write arbitrary text into the audit trail of a refunded task.
    it("the final TASK_FAILED reasons cannot be injected by a spoofed callback", async () => {
      const { task } = await handedToCre("false_success");
      await spoof(task.task_id, { decision: "REFUNDED", passed: false, reasons: ["FORGED: the robot operator committed fraud"] });
      await sys.deliverCreReport(task.task_id, false);
      const view = (await sys.api("GET", `/tasks/${task.task_id}`)).body;
      const failed = view.events.find((e) => e.type === "TASK_FAILED");
      expect(JSON.stringify(failed)).to.not.include("FORGED");
    });

    // FIXED (was low): callbacks are accepted without limit, also after the task is terminal (SETTLED/FAILED); each
    // one appends a CRE_WORKFLOW_RESULT event (up to ~25 kB of reasons) and overwrites cre.workflow_result.
    // Unauthenticated memory growth + a misleading workflow_result on a settled task.
    it("callbacks for a terminal task are refused and cannot grow its event log without bound", async () => {
      const { task } = await handedToCre();
      await sys.deliverCreReport(task.task_id, true);
      const settled = (await sys.api("GET", `/tasks/${task.task_id}`)).body;
      expect(settled.status).to.equal("SETTLED");
      const before = settled.events.length;
      for (let i = 0; i < 25; i++) await spoof(task.task_id, { decision: "REFUNDED", reasons: [`spam ${i}`] });
      const after = (await sys.api("GET", `/tasks/${task.task_id}`)).body;
      expect(after.events.length).to.equal(before);
      expect(after.cre?.workflow_result?.decision).to.not.equal("REFUNDED");
    });

  });

  /* ───────────────────────────────────────────────────────────────────────────────────────────── */
  describe("4. backend in cre mode: triggers, retries, races", () => {
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

    it("re-trigger while the workflow is still running (POST /settle on TRIGGERED): two workflow writes, payee paid exactly once", async () => {
      const task = await sys.fundedTask();
      const submission = await robotSigned(task);
      expect((await sys.api("POST", `/tasks/${task.task_id}/proof`, submission)).status).to.equal(202);
      const retried = await sys.api("POST", `/tasks/${task.task_id}/settle`);
      expect(retried.status).to.equal(200);
      expect(retried.body.cre).to.deep.include({ status: "TRIGGERED", attempts: 2 });
      const payeeBefore = await balance(task.payee);
      await sys.deliverCreReport(task.task_id, true); // run #1
      await sys.deliverCreReport(task.task_id, true); // run #2 (refused by the escrow, swallowed by the forwarder)
      expect((await balance(task.payee)) - payeeBefore).to.equal(REWARD);
      expect(await sys.contract.queryFilter(sys.contract.filters.TaskSettled(task.onchain_task_id))).to.have.length(1);
      expect((await sys.api("GET", `/tasks/${task.task_id}`)).body.status).to.equal("SETTLED");
    });

    it("the workflow's REJECTED callback arriving while the trigger request is still in flight is not clobbered", async () => {
      const task = await sys.fundedTask();
      const submission = await robotSigned(task);
      sys.creTrigger.onTrigger = async (p) => {
        const r = await sys.api<any>("POST", `/cre/tasks/${p.task_id}/result`, { decision: "REJECTED", proof_hash: p.proof_hash, reasons: ["evidence rejected"] });
        expect(r.status).to.equal(200);
      };
      expect((await sys.api("POST", `/tasks/${task.task_id}/proof`, submission)).status).to.equal(202);
      const view = (await sys.api("GET", `/tasks/${task.task_id}`)).body;
      expect(view.cre?.status).to.equal("TRIGGERED"); // informational: settlement state only follows the chain
      expect(view.cre?.workflow_result?.decision).to.equal("REJECTED");
      sys.creTrigger.onTrigger = undefined;
      expect((await sys.api("POST", `/tasks/${task.task_id}/proof`, submission)).status).to.equal(202); // robot may resubmit
    });

    it("a fast workflow that settles on-chain before the trigger request returns is still adopted", async () => {
      const task = await sys.fundedTask();
      const submission = await robotSigned(task);
      sys.creTrigger.onTrigger = async (p) => {
        await sys.deliverCreReport(p.task_id, true, { proofHash: submission.proof_hash, signature: submission.signature });
        // GET during the trigger: the per-task lock is held, so the sync is skipped (not an error)
        expect((await sys.api("GET", `/tasks/${p.task_id}`)).body.status).to.equal("PROOF_RECEIVED");
      };
      expect((await sys.api("POST", `/tasks/${task.task_id}/proof`, submission)).status).to.equal(202);
      expect((await sys.api("GET", `/tasks/${task.task_id}`)).body.status).to.equal("SETTLED");
    });

    it("trigger fails (502) after the workflow already settled: the chain outcome is still adopted", async () => {
      const task = await sys.fundedTask();
      const submission = await robotSigned(task);
      sys.creTrigger.onTrigger = async () => {
        await sys.deliverCreReport(task.task_id, true, { proofHash: submission.proof_hash, signature: submission.signature });
        throw new Error("socket hang up after the run was queued");
      };
      expect((await sys.api("POST", `/tasks/${task.task_id}/proof`, submission)).status).to.equal(502);
      const view = (await sys.api("GET", `/tasks/${task.task_id}`)).body;
      expect(view.status).to.equal("SETTLED");
      expect(view.cre?.status).to.equal("SETTLED_ONCHAIN");
    });

    it("concurrent duplicate proof submissions while the trigger is in flight: exactly one is handed to CRE", async () => {
      const task = await sys.fundedTask();
      const submission = await robotSigned(task);
      const before = sys.creTrigger.calls.length;
      sys.creTrigger.onTrigger = async () => {
        await sleep(100);
      };
      const results = await Promise.all(Array.from({ length: 5 }, () => sys.api("POST", `/tasks/${task.task_id}/proof`, submission)));
      expect(results.map((r) => r.status).sort()).to.deep.equal([202, 409, 409, 409, 409]);
      expect(sys.creTrigger.calls.length - before).to.equal(1);
    });

    it("(known limitation) in cre mode the backend's verifier key keeps full settlement authority: it can commit a failing verdict for a passing proof and refund, bypassing CRE", async () => {
      const task = await sys.fundedTask();
      const submission = await robotSigned(task, "success");
      expect((await sys.api("POST", `/tasks/${task.task_id}/proof`, submission)).status).to.equal(202);
      // The operator (verifier key) acts directly on the escrow:
      await (await sys.contract.commitProof(task.onchain_task_id, submission.proof_hash, false, submission.signature)).wait();
      await (await sys.contract.refund(task.onchain_task_id)).wait();
      const view = (await sys.api("GET", `/tasks/${task.task_id}`)).body;
      expect(view.status).to.equal("FAILED");
      expect(view.events.find((e) => e.type === "ESCROW_REFUNDED")?.data).to.include({ settled_by: "verifier" });
      // It could equally re-point creForwarder at its own EOA and call onReport directly.
      expect(await sys.contract.verifier()).to.equal(sys.signers.verifier.address);
    });

    it("(known limitation) a CRE-mode task the verifier committed as Verified (outside CRE) is never adopted: PROOF_RECEIVED until someone calls settle()", async () => {
      const task = await sys.fundedTask();
      const submission = await robotSigned(task, "success");
      expect((await sys.api("POST", `/tasks/${task.task_id}/proof`, submission)).status).to.equal(202);
      await (await sys.contract.commitProof(task.onchain_task_id, submission.proof_hash, true, submission.signature)).wait();
      let view = (await sys.api("GET", `/tasks/${task.task_id}`)).body;
      expect(view.status).to.equal("PROOF_RECEIVED");
      expect(view.onchain).to.deep.include({ status: "Verified" });
      // POST /settle in cre mode only re-triggers the workflow, which SKIPs a non-Funded task; the backend has no
      // verifier-path settle in cre mode. Settling it requires the verifier key directly:
      await (await sys.contract.settle(task.onchain_task_id)).wait();
      view = (await sys.api("GET", `/tasks/${task.task_id}`)).body;
      expect(view.status).to.equal("SETTLED");
    });
  });

  /* ───────────────────────────────────────────────────────────────────────────────────────────── */
  describe("5. backend in cre mode: timeouts, wedges and restarts", () => {
    it("after a CRE TIMEOUT the robot may submit a fresh proof, and POST /settle can re-trigger it", async () => {
      const env = await startCreService({ settlementTimeoutMs: 30 });
      const service = env.newService();
      const task = service.createTask({});
      await service.fundTask(task.task_id);
      const first = await robotSigned(task);
      await service.submitProof(task.task_id, first);
      await sleep(60);
      await service.syncCreSettlement(task.task_id);
      expect(service.getTask(task.task_id).cre?.status).to.equal("TIMEOUT");
      const fresh = await robotSigned(task, "success", new Date(Date.now() + 1000));
      await service.submitProof(task.task_id, fresh);
      expect(service.getTask(task.task_id).cre).to.deep.include({ status: "TRIGGERED", attempts: 2, proof_hash: fresh.proof_hash });
      await service.settleTask(task.task_id);
      expect(service.getTask(task.task_id).cre).to.deep.include({ status: "TRIGGERED", attempts: 3, proof_hash: fresh.proof_hash });
      expect(first.proof_hash).to.not.equal(fresh.proof_hash);
    });

    // FIXED (was medium, needs the permissionless mock forwarder or any authorized writer): once task A's proof hash has
    // been consumed by another task (cross-task replay, section 1), every workflow write for A reverts in onReport
    // (ProofAlreadyUsed) → the workflow throws, sends no callback → the backend times out → POST /settle re-triggers
    // the SAME proof hash forever, and submitProof refuses a fresh robot proof (only REJECTED allows resubmission).
    // A's escrow stays Funded with no backend path out (the escrow has no expiry/cancel).
    // Fix: allow a fresh robot proof after TIMEOUT / TRIGGER_FAILED (the escrow dedupes, so it is safe); have the
    // workflow read proofHashUsed (and report REJECTED) before writing; on-chain, bind the signature to the task
    // (sign keccak256(abi.encode(escrow, taskId, proofHash))) so a proof cannot be replayed onto another task.
    it("a task whose proof hash was consumed by a cross-task replay can still be settled with a fresh robot proof", async () => {
      const env = await startCreService({ settlementTimeoutMs: 30 });
      const service = env.newService();
      const a = service.createTask({});
      const b = service.createTask({});
      await service.fundTask(a.task_id);
      await service.fundTask(b.task_id);
      const proofA = await robotSigned(a);
      await service.submitProof(a.task_id, proofA);
      // Attacker: replay A's public signature onto B through the mock forwarder.
      expect((await env.workflowWrite(b.task_id, proofA.proof_hash, proofA.signature, true)).routed).to.equal(true);
      // The real workflow's write for A is refused.
      expect((await env.workflowWrite(a.task_id, proofA.proof_hash, proofA.signature, true)).routed).to.equal(false);
      await sleep(60);
      await service.syncCreSettlement(a.task_id);
      // Recovery: the robot signs a fresh proof (new timestamp → new hash).
      const fresh = await robotSigned(a, "success", new Date(Date.now() + 1000));
      await service.submitProof(a.task_id, fresh);
      expect((await env.workflowWrite(a.task_id, fresh.proof_hash, fresh.signature, true)).routed).to.equal(true);
      expect((await service.getTaskView(a.task_id)).status).to.equal("SETTLED");
    });

    // FIXED (was medium): the documented restart recovery ("a backend restart re-adopts a still-funded escrow when the
    // same task is re-created", README) is broken in cre mode. fundTask's reconcile (service.ts ~L190) adopts the
    // existing escrow but sets task.spec_hash from the NEW task's created_at, which differs from the spec hash
    // anchored on-chain at the original funding. The workflow's spec_anchor check therefore REJECTs every proof
    // for that task, forever: the escrow is locked until someone uses the verifier key directly.
    // Fix: in reconcile, read taskSpecHash on-chain and only adopt if it equals computeTaskSpecHash(task) — or let
    // POST /tasks accept created_at (validated against the anchor) so the original spec can be re-created.
    it("after a restart, cre mode refuses to adopt an escrow whose anchored spec no longer matches the re-created task", async () => {
      const env = await startCreService();
      const before = env.newService();
      const original = before.createTask({ task_id: "restart_cre_task" });
      await before.fundTask(original.task_id);
      await sleep(5); // the restart happens later (created_at differs by at least 1 ms)

      const after = env.newService(); // backend restart: in-memory state lost
      const recreated = after.createTask({ task_id: "restart_cre_task" });
      // Adopting would wedge the task (the workflow's spec_anchor check rejects every proof), so it is refused.
      await expectHttpError(after.fundTask(recreated.task_id), 409, /TaskAlreadyExists/);
      expect(after.getTask(recreated.task_id).status).to.equal("CREATED");
      expect((await env.contract.getTask(original.onchain_task_id)).amount).to.equal(REWARD); // no second deposit
    });

    // FIXED (was low): syncCreSettlement (called by every GET /tasks/:id and by the 1 s watcher) takes the same per-task
    // mutex as state-changing operations, and withLock answers 409 instead of waiting. While a read is waiting on
    // the RPC, POST /tasks/:id/settle and a robot's resubmission fail with "another operation in progress".
    // With a remote RPC (100-300 ms) and a polling frontend this is a frequent, confusing 409.
    // Fix: let the read-only sync use its own in-flight flag (or have withLock await the running sync).
    it("a read-only GET (chain sync in flight) does not make POST /settle fail with 409", async () => {
      const env = await startCreService();
      const service = env.newService();
      const task = service.createTask({});
      await service.fundTask(task.task_id);
      await service.submitProof(task.task_id, await robotSigned(task));
      const reading = service.getTaskView(task.task_id); // e.g. a frontend poll
      await service.settleTask(task.task_id);
      await reading;
    });

    it("a stale robot proof from a previous deployment cannot be replayed onto a re-created task id (freshness, skew 300 s)", async () => {
      const env = await startCreService();
      const service = env.newService();
      const task = service.createTask({});
      await service.fundTask(task.task_id);
      const stale = await robotSigned(task, "success", new Date(Date.now() - 3_600_000));
      await expectHttpError(service.submitProof(task.task_id, stale), 422);
      expect(env.trigger.calls.filter((c) => c.task_id === task.task_id)).to.have.length(0);
    });
  });

  /* ───────────────────────────────────────────────────────────────────────────────────────────── */
  describe("6. evidence endpoint", () => {
    let sys: TestSystem;
    before(async () => {
      sys = await startTestSystem({ robot: "external", settlement: "cre" });
    });
    after(async () => {
      sys.service.stopCreWatcher();
      await sys.close();
    });

    it("serves only task spec + signed proof: no keys, no backend verdict that the workflow could be steered by", async () => {
      const task = await sys.fundedTask();
      const submission = await robotSigned(task, "false_success");
      expect((await sys.api("POST", `/tasks/${task.task_id}/proof`, submission)).status).to.equal(202);
      const res = await fetch(`${sys.url}/cre/tasks/${task.task_id}/evidence`);
      const text = await res.text();
      const body = JSON.parse(text) as Json;
      expect(Object.keys(body).sort()).to.deep.equal(["submission", "task"]);
      expect(Object.keys(body.submission).sort()).to.deep.equal(["proof", "proof_hash", "signature"]);
      expect(body.task).to.not.have.property("robot_address"); // the workflow takes the robot from the chain
      expect(text).to.not.match(/passed|verification|reasons/);
      for (const key of Object.values(HARDHAT_DEV_KEYS)) expect(text.toLowerCase()).to.not.include(key.slice(2).toLowerCase());
    });

    it("path tricks on the evidence/result routes do not reach another task", async () => {
      const task = await sys.fundedTask();
      for (const route of [`/cre/tasks/${task.task_id}%2F..%2F..%2Fhealth/evidence`, `/cre/tasks/..%2Ftasks/evidence`, `/cre/tasks/${task.task_id}/evidence/..`]) {
        const res = await fetch(sys.url + route);
        expect([400, 404]).to.include(res.status);
      }
    });
  });
});
