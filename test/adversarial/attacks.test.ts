/**
 * Adversarial test suite (CLAUDE.md §15: "actively try to break the MVP").
 *
 * Every test drives the REAL system: Express API → TaskService → EscrowClient → MachineTaskEscrow
 * deployed on Hardhat's in-process network (test/helpers/system.ts). Fault-injection tests use the
 * same TaskService with an EscrowClient subclass that simulates RPC failures.
 *
 * Conventions
 *   it(...)                    the attack is DEFENDED; the test asserts the defence.
 *   it.skip(...) + "// BUG:"   the attack SUCCEEDS today (reproduced). The test asserts the CORRECT
 *                              behaviour: remove `.skip` to reproduce; it must pass once fixed.
 *   "FIXED (was ...)"          an attack this suite found that has since been fixed; kept as a regression test.
 *   "(known limitation)"       a trust-model boundary that is deliberately out of MVP scope; the test
 *                              documents current behaviour so nobody mistakes it for a guarantee.
 */
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { Signature, Wallet, ZeroAddress, ZeroHash, concat, parseEther, toBeHex, type Signer } from "ethers";
import { ethers, network } from "hardhat";
import { startServer } from "../../src/bootstrap";
import { ChainError, EscrowClient, deployEscrow, type TxResult } from "../../src/chain/escrow";
import { HARDHAT_DEV_KEYS, type AppConfig } from "../../src/config";
import { computeProofHash, signProof, signProofHash } from "../../src/proof";
import { ExternalRobotAdapter } from "../../src/robot/adapter";
import { generateMockProof, type MockOutcome, type MockTaskSpec } from "../../src/robot/mockProof";
import { HttpError, TaskService, type TaskServiceConfig } from "../../src/tasks/service";
import type { TaskView } from "../../src/tasks/types";
import { REWARD, startTestSystem, type TestSystem } from "../helpers/system";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;
interface Submission {
  proof: Json;
  signature: string;
  proof_hash: string;
}
interface RawResponse {
  status: number;
  text: string;
  body: any;
}

// Hardhat's PUBLIC dev keys — development only. robotWallet is the same identity as signers.robot (account #2).
const robotWallet = new Wallet(HARDHAT_DEV_KEYS.robot);
const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const DUMMY_SIGNATURE = "0x" + "11".repeat(65); // well-formed but meaningless

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const balance = (address: string): Promise<bigint> => ethers.provider.getBalance(address);

/** A realistic mock-simulator proof for `task` (optionally overridden), signed by `signer` (default: the robot). */
async function signed(
  task: MockTaskSpec,
  outcome: MockOutcome = "success",
  overrides: Json = {},
  signer: Signer = robotWallet,
): Promise<Submission> {
  const proof: Json = { ...generateMockProof(task, outcome), ...overrides };
  return { proof, ...(await signProof(proof, signer)) };
}

/** High-s twin of a valid signature (same signer, s' = n - s, flipped v) — classic ECDSA malleability. */
function malleate(signature: string): string {
  const sig = Signature.from(signature);
  return concat([sig.r, toBeHex(SECP256K1_N - BigInt(sig.s), 32), new Uint8Array([sig.v === 27 ? 28 : 27])]);
}

/** Replaces the recovery byte. */
function withV(signature: string, v: number): string {
  return signature.slice(0, 130) + v.toString(16).padStart(2, "0");
}

/**
 * Serializes `value` as the SAME JSON value with a hostile spelling: reversed key order, every key and
 * string fully \u-escaped, exotic number spellings (1 → 1.000E+0, 0 → -0.0e0) and odd whitespace.
 */
function exoticJson(value: unknown, indent = ""): string {
  const inner = indent + "\t";
  if (value === null) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return exoticNumber(value);
  if (typeof value === "string") return escapeEverything(value);
  if (Array.isArray(value)) return `[\r\n${value.map((v) => inner + exoticJson(v, inner)).join(" ,\n")}\n${indent}]`;
  const entries = Object.entries(value as Json).reverse();
  return `{\n${entries.map(([k, v]) => `${inner}${escapeEverything(k)} :\t${exoticJson(v, inner)}`).join(",\n")}\n${indent}}`;
}
function exoticNumber(n: number): string {
  if (n === 0) return "-0.0e0"; // parses to -0, canonicalizes to "0"
  const s = String(n);
  if (s.includes("e")) return s.toUpperCase(); // 1e-7 -> 1E-7
  return s.includes(".") ? `${s}000e0` : `${s}.000E+0`; // 1.5 -> 1.5000e0, 1 -> 1.000E+0
}
function escapeEverything(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) out += "\\u" + s.charCodeAt(i).toString(16).padStart(4, "0");
  return out + '"';
}

const failedChecks = (body: any): string[] =>
  ((body?.details?.checks ?? []) as Array<{ name: string; ok: boolean }>).filter((c) => !c.ok).map((c) => c.name);

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

/** EscrowClient that can simulate RPC failures before a tx is sent, or after it was mined (lost receipt). */
type EscrowOp = "fundTask" | "commitProof" | "settle" | "refund";
type FaultMode = "before_send" | "after_mined";
class FaultyEscrow extends EscrowClient {
  private readonly faults = new Map<EscrowOp, FaultMode>();

  failNext(op: EscrowOp, mode: FaultMode): void {
    this.faults.set(op, mode);
  }

  private async withFault(op: EscrowOp, call: () => Promise<TxResult>): Promise<TxResult> {
    const mode = this.faults.get(op);
    this.faults.delete(op);
    if (mode === "before_send") throw new ChainError(`${op} failed: socket hang up (injected)`);
    const result = await call();
    if (mode === "after_mined") throw new ChainError(`${op} failed: timeout waiting for receipt (injected; tx was mined)`);
    return result;
  }

  override fundTask(taskId: string, robot: string, payee: string, amountWei: bigint): Promise<TxResult> {
    return this.withFault("fundTask", () => super.fundTask(taskId, robot, payee, amountWei));
  }
  override commitProof(taskId: string, proofHash: string, passed: boolean, robotSignature: string): Promise<TxResult> {
    return this.withFault("commitProof", () => super.commitProof(taskId, proofHash, passed, robotSignature));
  }
  override settle(taskId: string): Promise<TxResult> {
    return this.withFault("settle", () => super.settle(taskId));
  }
  override refund(taskId: string): Promise<TxResult> {
    return this.withFault("refund", () => super.refund(taskId));
  }
}

/** TaskService (no HTTP) on a fresh escrow deployment, wired to a FaultyEscrow. */
async function startFaultySystem() {
  const [verifier, requester, robot, payee, stranger] = await ethers.getSigners();
  const contract = await deployEscrow(verifier, verifier.address);
  const escrow = new FaultyEscrow(await contract.getAddress(), verifier, requester);
  const config: TaskServiceConfig = {
    robots: { robot_001: robot.address },
    defaultRobotId: "robot_001",
    payeeAddress: payee.address,
    defaultTolerance: 0.05,
    defaultRewardWei: REWARD,
  };
  const newService = () => new TaskService({ config, escrow, robot: new ExternalRobotAdapter() });
  const service = newService();
  const fundedTask = async (svc = service) => {
    const task = svc.createTask({});
    await svc.fundTask(task.task_id);
    return task;
  };
  return { contract, escrow, service, newService, fundedTask, signers: { verifier, requester, robot, payee, stranger } };
}

describe("Adversarial: attempts to break MachineProof (CLAUDE.md §15)", () => {
  let sys: TestSystem;
  /** Every raw response body this suite receives; scanned for leaked secrets at the end. */
  const seenBodies: string[] = [];

  before(async () => {
    sys = await startTestSystem({ robot: "external" });
    expect(robotWallet.address).to.equal(sys.signers.robot.address);
  });
  after(async () => {
    await sys.close();
  });

  async function http(method: string, route: string, body?: string, contentType: string | null = "application/json"): Promise<RawResponse> {
    const res = await fetch(sys.url + route, {
      method,
      headers: contentType === null ? {} : { "content-type": contentType },
      body,
    });
    const text = await res.text();
    seenBodies.push(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { status: res.status, text, body: parsed };
  }

  const postProof = (taskId: string, submission: unknown): Promise<RawResponse> =>
    http("POST", `/tasks/${taskId}/proof`, JSON.stringify(submission));

  async function view(taskId: string): Promise<any> {
    return (await sys.api<any>("GET", `/tasks/${taskId}`)).body;
  }

  /** 422 "Proof rejected", optionally with a specific failed verification check. */
  async function expectRejected(taskId: string, submission: unknown, check?: string): Promise<RawResponse> {
    const res = typeof submission === "string" ? await http("POST", `/tasks/${taskId}/proof`, submission) : await postProof(taskId, submission);
    expect(res.status, res.text.slice(0, 400)).to.equal(422);
    expect(res.body.error).to.equal("Proof rejected");
    expect(res.body.details.reasons).to.be.an("array").that.is.not.empty;
    if (check) expect(failedChecks(res.body), JSON.stringify(res.body.details.reasons).slice(0, 400)).to.include(check);
    return res;
  }

  /** The task's off-chain and on-chain state were not changed by an attack. */
  async function expectUntouched(taskId: string, status = "FUNDED", onchainStatus = "Funded"): Promise<void> {
    const t = await view(taskId);
    expect(t.status).to.equal(status);
    expect(t.proof).to.equal(undefined);
    expect(t.verification).to.equal(undefined);
    expect(t.onchain).to.deep.include({ status: onchainStatus, proof_hash: ZeroHash });
  }

  /* ───────────────────────────────────────────────────────────────────────────────────────────── */
  describe("1. proof modified after signing", () => {
    let task: TaskView;
    let genuine: Submission;

    before(async () => {
      task = await sys.fundedTask();
      genuine = await signed(task);
    });

    const tamperings: Array<[string, (p: Json) => void]> = [
      ["final_object_position.x", (p) => (p.final_object_position.x += 0.0001)],
      ["final_object_position.z", (p) => (p.final_object_position.z -= 0.0001)],
      ["success flag", (p) => (p.success = false)],
      ["timestamp", (p) => (p.timestamp = new Date(Date.parse(p.timestamp) + 1000).toISOString())],
      ["nested extra field trajectory[3].x", (p) => (p.trajectory[3].x += 0.0001)],
      ["extra field events (event appended)", (p) => p.events.push({ t_ms: p.duration_ms, type: "PLACE" })],
      ["extra field events (order reversed)", (p) => p.events.reverse()],
      ["nested extra field simulator.version", (p) => (p.simulator.version = "9.9.9")],
      ["number turned into a string (duration_ms)", (p) => (p.duration_ms = String(p.duration_ms))],
      ["new field added", (p) => (p.operator_override = true)],
      ["optional field removed (trajectory)", (p) => delete p.trajectory],
      ["extra key inside final_object_position", (p) => (p.final_object_position.frame = "world")],
    ];

    for (const [field, mutate] of tamperings) {
      it(`rejects proof modified after signing (${field})`, async () => {
        const proof = clone(genuine.proof);
        mutate(proof);
        // a) no claimed hash: the recomputed hash no longer matches the robot's signature
        await expectRejected(task.task_id, { proof, signature: genuine.signature }, "signature");
        // b) attacker keeps the original claimed hash: hash mismatch AND signature mismatch
        const b = await expectRejected(task.task_id, { proof, signature: genuine.signature, proof_hash: genuine.proof_hash }, "proof_hash");
        expect(failedChecks(b.body)).to.include("signature");
        // c) attacker updates the claimed hash too: the signature still does not cover it
        await expectRejected(task.task_id, { proof, signature: genuine.signature, proof_hash: computeProofHash(proof) }, "signature");
      });
    }

    it("none of the tampered proofs touched the task, and the genuine proof still settles exactly once", async () => {
      await expectUntouched(task.task_id);
      expect((await view(task.task_id)).rejected_proofs).to.equal(tamperings.length * 3);
      const payeeBefore = await balance(task.payee);
      const res = await postProof(task.task_id, genuine);
      expect(res.status, res.text.slice(0, 300)).to.equal(200);
      expect(res.body.status).to.equal("SETTLED");
      expect((await balance(task.payee)) - payeeBefore).to.equal(REWARD);
    });
  });

  /* ───────────────────────────────────────────────────────────────────────────────────────────── */
  describe("2. canonicalization: logically identical proofs are accepted, different bytes are not", () => {
    it("accepts reordered keys, \\u-escaped keys/strings, exotic numbers (1.000E+0, -0.0e0) and odd whitespace", async () => {
      const task = await sys.fundedTask();
      const sub = await signed(task);
      const raw = exoticJson(sub);
      expect(raw).to.not.include('"task_id"'); // sanity: keys really are escaped
      expect(raw).to.include("E+0");
      const res = await http("POST", `/tasks/${task.task_id}/proof`, raw);
      expect(res.status, res.text.slice(0, 300)).to.equal(200);
      expect(res.body.status).to.equal("SETTLED");
      expect(res.body.proof.proof_hash).to.equal(sub.proof_hash);
    });

    it("accepts the same 65 signature bytes written in uppercase hex", async () => {
      const task = await sys.fundedTask();
      const sub = await signed(task);
      const res = await postProof(task.task_id, { ...sub, signature: "0x" + sub.signature.slice(2).toUpperCase() });
      expect(res.status, res.text.slice(0, 300)).to.equal(200);
      expect(res.body.status).to.equal("SETTLED");
    });

    it("duplicate JSON keys: earlier decoy values are discarded (last wins), so only the signed values are verified", async () => {
      const task = await sys.fundedTask();
      const sub = await signed(task);
      const decoyFirst = '{"success":false,"final_object_position":{"x":42,"y":42,"z":42},' + JSON.stringify(sub.proof).slice(1);
      const raw = `{"signature":"${sub.signature}","proof":${decoyFirst},"proof_hash":"${sub.proof_hash}"}`;
      const res = await http("POST", `/tasks/${task.task_id}/proof`, raw);
      expect(res.status, res.text.slice(0, 300)).to.equal(200);
      expect(res.body.status).to.equal("SETTLED");
      expect(res.body.proof.raw.success).to.equal(true);
      expect(res.body.proof.raw.final_object_position).to.deep.equal(sub.proof.final_object_position);
    });

    it("duplicate JSON keys: a trailing override of a signed value is rejected", async () => {
      const task = await sys.fundedTask();
      const sub = await signed(task);
      const overridden = JSON.stringify(sub.proof).slice(0, -1) + ',"final_object_position":{"x":1,"y":0,"z":0}}';
      await expectRejected(task.task_id, `{"signature":"${sub.signature}","proof":${overridden}}`, "signature");
      await expectUntouched(task.task_id);
    });

    it("rejects a Unicode-normalization variant (NFC vs NFD): the hash binds exact code points", async () => {
      const task = await sys.fundedTask();
      const sub = await signed(task, "success", { operator: "Zoë Ångström" });
      const nfd = { ...sub.proof, operator: (sub.proof.operator as string).normalize("NFD") };
      expect(nfd.operator).to.not.equal(sub.proof.operator);
      await expectRejected(task.task_id, { ...sub, proof: nfd }, "proof_hash");
      await expectUntouched(task.task_id);
    });
  });

  /* ───────────────────────────────────────────────────────────────────────────────────────────── */
  describe("3. identity and signature attacks", () => {
    let task: TaskView;
    let genuine: Submission;
    let attempts = 0;

    before(async () => {
      task = await sys.fundedTask();
      genuine = await signed(task);
    });

    async function reject(submission: unknown, check: string): Promise<RawResponse> {
      attempts += 1;
      return expectRejected(task.task_id, submission, check);
    }

    it("rejects a robot-signed proof for another task_id", async () => {
      await reject(await signed({ ...task, task_id: "some_other_task" }), "task_id_match");
    });

    it("rejects a robot-signed proof with the wrong robot_id", async () => {
      await reject(await signed({ ...task, robot_id: "robot_002" }), "robot_id_match");
    });

    const impostors: Array<[string, () => Signer]> = [
      ["a random key", () => Wallet.createRandom()],
      ["the verifier/oracle key", () => new Wallet(HARDHAT_DEV_KEYS.verifier)],
      ["the requester key", () => new Wallet(HARDHAT_DEV_KEYS.requester)],
      ["the payee key", () => new Wallet(HARDHAT_DEV_KEYS.payee)],
    ];
    for (const [who, signer] of impostors) {
      it(`rejects a proof signed by ${who} instead of the registered robot`, async () => {
        const res = await reject(await signed(task, "success", {}, signer()), "signature");
        expect(res.body.details.reasons.join(" ")).to.include(robotWallet.address);
      });
    }

    it("rejects a valid robot signature that belongs to a different proof of the same task", async () => {
      const other = await signed(task, "success", { timestamp: "2026-10-07T12:34:56Z" });
      expect(other.proof_hash).to.not.equal(genuine.proof_hash);
      await reject({ proof: genuine.proof, signature: other.signature }, "signature");
    });

    it("rejects a robot signature over the hash's hex STRING instead of its 32 raw bytes", async () => {
      await reject({ proof: genuine.proof, signature: await robotWallet.signMessage(genuine.proof_hash) }, "signature");
    });

    it("rejects a raw secp256k1 signature without the EIP-191 prefix", async () => {
      await reject({ proof: genuine.proof, signature: robotWallet.signingKey.sign(genuine.proof_hash).serialized }, "signature");
    });

    it("rejects the high-s (malleated) twin of the genuine signature, matching the contract's ECDSA rules", async () => {
      const res = await reject({ proof: genuine.proof, signature: malleate(genuine.signature) }, "signature");
      expect(res.body.details.reasons.join(" ")).to.match(/high\) s|non-canonical/);
    });

    // v=0/1 is how many non-Ethereum signers encode the recovery id; ethers would accept one of them,
    // OpenZeppelin's ECDSA (on-chain) would not — so the backend must not either.
    for (const v of [0, 1, 29, 37]) {
      it(`rejects the genuine signature re-encoded with recovery byte v=${v}`, async () => {
        const res = await reject({ proof: genuine.proof, signature: withV(genuine.signature, v) }, "signature");
        expect(res.body.details.reasons.join(" ")).to.match(/v must be 27 or 28/);
      });
    }

    it("rejects a claimed proof_hash that does not match the proof, even with a genuine signature", async () => {
      const other = await signed(task, "success", { timestamp: "2026-10-07T00:00:00Z" });
      await reject({ ...genuine, proof_hash: other.proof_hash }, "proof_hash");
    });

    const malformedEnvelopes: Array<[string, (s: Submission) => unknown]> = [
      ["ERC-2098 compact 64-byte signature", (s) => ({ proof: s.proof, signature: Signature.from(s.signature).compactSerialized })],
      ["66-byte signature (extra byte)", (s) => ({ proof: s.proof, signature: s.signature + "00" })],
      ["signature without 0x prefix", (s) => ({ proof: s.proof, signature: s.signature.slice(2) })],
      ["signature with 0X prefix", (s) => ({ proof: s.proof, signature: "0X" + s.signature.slice(2) })],
      ["non-hex signature", (s) => ({ proof: s.proof, signature: "0x" + "g".repeat(130) })],
      ["numeric signature", (s) => ({ proof: s.proof, signature: 1234 })],
      ["null signature", (s) => ({ proof: s.proof, signature: null })],
      ["signature as an array", (s) => ({ proof: s.proof, signature: [s.signature] })],
      ["missing signature", (s) => ({ proof: s.proof })],
      ["claimed proof_hash too short", (s) => ({ ...s, proof_hash: s.proof_hash.slice(0, 40) })],
      ["claimed proof_hash not hex", (s) => ({ ...s, proof_hash: "0x" + "z".repeat(64) })],
    ];
    for (const [label, make] of malformedEnvelopes) {
      it(`rejects a malformed submission envelope (${label})`, async () => {
        await reject(make(genuine), "submission_schema");
      });
    }

    it("none of the above changed the task, and the genuine proof still settles", async () => {
      await expectUntouched(task.task_id);
      expect((await view(task.task_id)).rejected_proofs).to.equal(attempts);
      const res = await postProof(task.task_id, genuine);
      expect(res.status, res.text.slice(0, 300)).to.equal(200);
      expect(res.body.status).to.equal("SETTLED");
    });
  });

  /* ───────────────────────────────────────────────────────────────────────────────────────────── */
  describe("4. physical verification is computed from coordinates, not from the success flag", () => {
    /** Funds a task (A=(0,0,0) → B=(1,0,0), ±0.05 m unless overridden), submits a robot-signed proof. */
    async function placeAt(final: Json, success = true, taskBody: Json = {}) {
      const task = await sys.fundedTask(taskBody);
      const payeeBefore = await balance(task.payee);
      const requesterBefore = await balance(sys.signers.requester.address);
      const res = await postProof(task.task_id, await signed(task, "success", { final_object_position: final, success }));
      expect(res.status, res.text.slice(0, 300)).to.equal(200);
      return {
        task,
        res,
        paid: (await balance(task.payee)) - payeeBefore,
        refunded: (await balance(sys.signers.requester.address)) - requesterBefore,
      };
    }

    it("false success flag (object 0.2 m from target, success=true) → FAILED, refunded, payee gets nothing", async () => {
      const { res, paid, refunded, task } = await placeAt({ x: 1.2, y: 0, z: 0 });
      expect(res.body.status).to.equal("FAILED");
      expect(res.body.verification.passed).to.equal(false);
      expect(res.body.verification.reasons.join(" ")).to.match(/claimed success/);
      expect(paid).to.equal(0n);
      expect(refunded).to.equal(REWARD);
      expect((await view(task.task_id)).onchain.status).to.equal("Refunded");
    });

    it("object just outside tolerance (0.0501 m) → FAILED", async () => {
      const { res, paid } = await placeAt({ x: 1.0501, y: 0, z: 0 });
      expect(res.body.status).to.equal("FAILED");
      expect(paid).to.equal(0n);
    });

    it("object just inside tolerance (0.0499 m) → SETTLED", async () => {
      const { res, paid } = await placeAt({ x: 1.0499, y: 0, z: 0 });
      expect(res.body.status).to.equal("SETTLED");
      expect(paid).to.equal(REWARD);
    });

    it("exact boundary (distance == tolerance, exactly representable floats) counts as success", async () => {
      const { res, paid } = await placeAt({ x: 1.5, y: 0, z: 0 }, true, { tolerance: 0.5 });
      expect(res.body.verification.placement).to.deep.include({ distance: 0.5, tolerance: 0.5, within_tolerance: true });
      expect(res.body.status).to.equal("SETTLED");
      expect(paid).to.equal(REWARD);
    });

    // FIXED (was low): |1.05 - 1| is 0.050000000000000044 in binary floating point and used to FAIL a 0.05 m
    // tolerance; checkPlacement now compares with a 1 nm epsilon (src/proof/physical.ts).
    it("decimal boundary placement (final x=1.05, target x=1, tolerance 0.05) counts as success", async () => {
      const { res } = await placeAt({ x: 1.05, y: 0, z: 0 });
      expect(res.body.status).to.equal("SETTLED");
    });

    it("uses the full 3D Euclidean distance: per-axis offsets of 0.03 m (|d| = 0.052 m) fail a 0.05 m tolerance", async () => {
      const { res, paid } = await placeAt({ x: 1.03, y: 0.03, z: 0.03 });
      expect(res.body.status).to.equal("FAILED");
      expect(res.body.verification.placement.distance).to.be.closeTo(0.052, 0.001);
      expect(paid).to.equal(0n);
    });

    it("object stacked 6 cm above the target (z offset only) → FAILED", async () => {
      const { res } = await placeAt({ x: 1, y: 0, z: 0.06 });
      expect(res.body.status).to.equal("FAILED");
    });

    it("robot honestly reports failure while the placement looks perfect → FAILED (no payment on a self-reported failure)", async () => {
      const { res, paid, refunded } = await placeAt({ x: 1, y: 0, z: 0 }, false);
      expect(res.body.status).to.equal("FAILED");
      expect(paid).to.equal(0n);
      expect(refunded).to.equal(REWARD);
    });

    it("extreme but finite coordinates (±1.7e308, distance overflows to Infinity) → FAILED, no crash", async () => {
      const { res, task } = await placeAt({ x: -1.7e308, y: 1.7e308, z: 0 });
      expect(res.body.status).to.equal("FAILED");
      expect((await view(task.task_id)).onchain.status).to.equal("Refunded");
    });

    it("rejects a robot that redefines target_position to wherever it dropped the object", async () => {
      const task = await sys.fundedTask();
      const dropped = { x: 0.4, y: 0, z: 0 };
      await expectRejected(task.task_id, await signed(task, "success", { target_position: dropped, final_object_position: dropped }), "task_geometry");
      await expectUntouched(task.task_id);
    });

    it("rejects a robot that redefines start_position", async () => {
      const task = await sys.fundedTask();
      await expectRejected(task.task_id, await signed(task, "success", { start_position: { x: 0.9, y: 0, z: 0 } }), "task_geometry");
      await expectUntouched(task.task_id);
    });

    it("rejects a coordinate beyond float range in raw JSON (1e400 → Infinity) at the schema", async () => {
      const task = await sys.fundedTask();
      const sub = await signed(task, "success", { final_object_position: { x: "__INF__", y: 0, z: 0 } });
      await expectRejected(task.task_id, JSON.stringify(sub).replace('"__INF__"', "1e400"), "proof_schema");
      await expectUntouched(task.task_id);
    });

    it("rejects Infinity hidden in an extra field (cannot be canonicalized)", async () => {
      const task = await sys.fundedTask();
      const sub = await signed(task);
      sub.proof.trajectory[1].x = "__INF__";
      const res = await expectRejected(task.task_id, JSON.stringify(sub).replace('"__INF__"', "-1e999"), "proof_hash");
      expect(res.body.details.reasons.join(" ")).to.match(/canonicaliz/);
    });

    const typeConfusions: Array<[string, Json]> = [
      ['success: "true"', { success: "true" }],
      ["success: 1", { success: 1 }],
      ["success: null", { success: null }],
      ['coordinate as string "1.0"', { final_object_position: { x: "1.0", y: 0, z: 0 } }],
      ["coordinate null", { final_object_position: { x: null, y: 0, z: 0 } }],
      ["coordinate boolean", { final_object_position: { x: true, y: 0, z: 0 } }],
      ["position as array", { final_object_position: [1, 0, 0] }],
      ["position missing z", { final_object_position: { x: 1, y: 0 } }],
      ["timestamp not ISO-8601", { timestamp: "07/10/2026 12:00" }],
      ["empty task_id", { task_id: "" }],
    ];
    for (const [label, override] of typeConfusions) {
      it(`rejects a type-confused proof (${label}) at the schema`, async () => {
        const task = await sys.fundedTask();
        await expectRejected(task.task_id, await signed(task, "success", override), "proof_schema");
      });
    }
  });

  /* ───────────────────────────────────────────────────────────────────────────────────────────── */
  describe("5. malformed and hostile payloads never crash the server", () => {
    let task: TaskView;
    before(async () => {
      task = await sys.fundedTask();
    });

    const malformedJson = ["{not json", '{"proof":', "}{", "{'single':'quotes'}", '{"a":1,}', '{"a":NaN}', '{"a":Infinity}', '{"a":0x10}', '{"a":01}', '{"a":.5}'];
    for (const raw of malformedJson) {
      it(`rejects malformed JSON ${JSON.stringify(raw)} with 400`, async () => {
        const res = await http("POST", `/tasks/${task.task_id}/proof`, raw);
        expect(res.status).to.equal(400);
        expect(res.body).to.deep.equal({ error: "Malformed JSON body" });
      });
    }

    for (const raw of ['"a string"', "123", "null", "true"]) {
      it(`rejects a top-level JSON scalar ${raw} with 400 (strict JSON parser)`, async () => {
        expect((await http("POST", `/tasks/${task.task_id}/proof`, raw)).status).to.equal(400);
      });
    }

    it("rejects an empty body, a top-level array and a body sent as text/plain with 422", async () => {
      await expectRejected(task.task_id, "", "submission_schema");
      await expectRejected(task.task_id, "[]", "submission_schema");
      const genuineButWrongType = await http("POST", `/tasks/${task.task_id}/proof`, JSON.stringify(await signed(task)), "text/plain");
      expect(genuineButWrongType.status).to.equal(422);
      await expectUntouched(task.task_id);
    });

    it("rejects a body declared as UTF-16 and a payload over 1 MB without crashing", async () => {
      expect((await http("POST", `/tasks/${task.task_id}/proof`, "{}", "application/json; charset=utf-16")).status).to.be.within(400, 499);
      const huge = await postProof(task.task_id, { proof: { pad: "x".repeat(1_100_000) }, signature: DUMMY_SIGNATURE });
      expect(huge.status).to.equal(413);
      expect((await http("GET", "/health")).status).to.equal(200);
    });

    for (const proof of [[1, 2, 3], null, "proof", 42, true]) {
      it(`rejects a non-object proof (${JSON.stringify(proof)})`, async () => {
        await expectRejected(task.task_id, { proof, signature: DUMMY_SIGNATURE }, "submission_schema");
      });
    }

    for (const field of ["task_id", "robot_id", "timestamp", "start_position", "target_position", "final_object_position", "success"]) {
      it(`rejects a proof missing required field "${field}" (even if correctly signed)`, async () => {
        const proof = generateMockProof(task, "success") as Json;
        delete proof[field];
        const res = await expectRejected(task.task_id, { proof, ...(await signProof(proof, robotWallet)) }, "proof_schema");
        expect(res.body.details.reasons.join(" ")).to.include(field);
      });
    }

    it("rejects 300 000 levels of nesting inside the proof with 422 (not a 500 / stack overflow crash)", async () => {
      const deep = "[".repeat(300_000) + "]".repeat(300_000);
      const raw = `{"signature":"${DUMMY_SIGNATURE}","proof":${JSON.stringify(generateMockProof(task, "success")).slice(0, -1)},"deep":${deep}}}`;
      const res = await expectRejected(task.task_id, raw, "proof_hash");
      expect(res.body.details.reasons.join(" ")).to.match(/canonicaliz/);
      expect((await http("GET", "/health")).status).to.equal(200);
      await expectUntouched(task.task_id);
    });

    it("handles a very wide proof (50 000 extra keys) quickly", async () => {
      const wide: Json = generateMockProof(task, "success");
      for (let i = 0; i < 50_000; i++) wide[`k${i}`] = i;
      const started = Date.now();
      await expectRejected(task.task_id, { proof: wide, signature: DUMMY_SIGNATURE }, "signature");
      expect(Date.now() - started).to.be.below(5_000);
    });

    it("ignores deeply nested junk in the envelope outside the signed proof", async () => {
      const t = await sys.fundedTask();
      const sub = await signed(t);
      const deep = "[".repeat(200_000) + "]".repeat(200_000);
      const res = await http("POST", `/tasks/${t.task_id}/proof`, JSON.stringify(sub).slice(0, -1) + `,"junk":${deep}}`);
      expect(res.status, res.text.slice(0, 300)).to.equal(200);
      expect(res.body.status).to.equal("SETTLED");
    });

    it("rejects a lone UTF-16 surrogate in an extra field (not representable in UTF-8)", async () => {
      const sub = await signed(task);
      sub.proof.note = "__SURROGATE__";
      await expectRejected(task.task_id, JSON.stringify(sub).replace('"__SURROGATE__"', '"\\ud800"'), "proof_hash");
    });

    it("hashes __proto__ / constructor / prototype keys as plain data, accepts the signed proof and pollutes nothing", async () => {
      const t = await sys.fundedTask();
      const base = JSON.stringify(generateMockProof(t, "success")).slice(0, -1);
      const proof = JSON.parse(
        base + ',"__proto__":{"polluted":true,"success":false},"constructor":{"prototype":{"polluted":true}},"prototype":{"polluted":true}}',
      ) as Json;
      expect(Object.keys(proof)).to.include("__proto__");
      const sig = await signProof(proof, robotWallet);
      const raw = `{"signature":"${sig.signature}","proof_hash":"${sig.proof_hash}","proof":${JSON.stringify(proof)}}`;
      expect(raw).to.include('"__proto__":{');
      const res = await http("POST", `/tasks/${t.task_id}/proof`, raw);
      expect(res.status, res.text.slice(0, 300)).to.equal(200);
      expect(res.body.status).to.equal("SETTLED");
      expect(res.body.proof.proof_hash).to.equal(sig.proof_hash);
      expect(({} as Json).polluted).to.equal(undefined);
      expect(({} as Json).success).to.equal(undefined);
      expect(res.text).to.include('"__proto__":{"polluted":true');
    });

    it("__proto__ cannot supply a missing required field (success) or the submission envelope", async () => {
      const proof = generateMockProof(task, "success") as Json;
      delete proof.success;
      const withProtoSuccess = JSON.stringify(proof).slice(0, -1) + ',"__proto__":{"success":true}}';
      await expectRejected(task.task_id, `{"signature":"${DUMMY_SIGNATURE}","proof":${withProtoSuccess}}`, "proof_schema");
      const sub = await signed(task);
      await expectRejected(task.task_id, `{"__proto__":${JSON.stringify(sub)}}`, "submission_schema");
      expect(({} as Json).success).to.equal(undefined);
      await expectUntouched(task.task_id);
    });

    // FIXED (was low, memory DoS): rejection reasons embed attacker-controlled object keys and were stored
    // verbatim in task.events. TaskService now truncates stored reasons and stores at most 20 rejections.
    it("bounds what a rejected proof can store in the task's event log", async () => {
      const t = await sys.fundedTask();
      const key = "k".repeat(400_000);
      const raw = `{"signature":"${DUMMY_SIGNATURE}","proof":${JSON.stringify(generateMockProof(t, "success")).slice(0, -1)},"${key}":1e400}}`;
      await expectRejected(t.task_id, raw, "proof_hash");
      expect(JSON.stringify(sys.service.getTask(t.task_id).events).length).to.be.below(20_000);
    });

    const weirdRoutes: Array<[string, string]> = [
      ["GET", "/tasks/%E0%A4%A"],
      ["POST", "/tasks/%00/proof"],
      ["GET", `/tasks/${"a".repeat(8_000)}`],
      ["GET", "/tasks/..%2F..%2Fpackage.json"],
      ["GET", "/tasks/__proto__"],
      ["POST", "/tasks/constructor/fund"],
      ["POST", "/tasks/hasOwnProperty/proof"],
      ["POST", "/tasks/toString/settle"],
    ];
    for (const [method, route] of weirdRoutes) {
      it(`answers a hostile route ${method} ${route.slice(0, 40)} with a 4xx`, async () => {
        const res = await http(method, route, method === "POST" ? "{}" : undefined);
        expect(res.status, res.text.slice(0, 200)).to.be.within(400, 499);
      });
    }
  });

  /* ───────────────────────────────────────────────────────────────────────────────────────────── */
  describe("6. lifecycle, duplicates, replays and concurrency", () => {
    it("refuses start / proof / settle on an unfunded (CREATED) task", async () => {
      const { body: task } = await sys.api<any>("POST", "/tasks", {});
      expect((await http("POST", `/tasks/${task.task_id}/start`)).status).to.equal(409);
      expect((await postProof(task.task_id, await signed(task))).status).to.equal(409);
      expect((await http("POST", `/tasks/${task.task_id}/settle`)).status).to.equal(409);
      await expectUntouched(task.task_id, "CREATED", "None");
    });

    it("refuses to start twice, and to settle before any proof", async () => {
      const task = await sys.fundedTask();
      expect((await http("POST", `/tasks/${task.task_id}/settle`)).status).to.equal(409);
      expect((await http("POST", `/tasks/${task.task_id}/start`)).status).to.equal(202);
      expect((await http("POST", `/tasks/${task.task_id}/start`)).status).to.equal(409);
      await expectUntouched(task.task_id, "RUNNING");
    });

    it("duplicate proof and duplicate settlement after SETTLED are refused by the API and the contract; paid once", async () => {
      const task = await sys.fundedTask();
      const sub = await signed(task);
      const payeeBefore = await balance(task.payee);
      expect((await postProof(task.task_id, sub)).status).to.equal(200);
      expect((await postProof(task.task_id, sub)).status).to.equal(409);
      expect((await postProof(task.task_id, await signed(task))).status).to.equal(409);
      expect((await http("POST", `/tasks/${task.task_id}/settle`)).status).to.equal(409);
      const { contract } = sys.escrow;
      await expect(contract.settle(task.onchain_task_id)).to.be.revertedWithCustomError(contract, "InvalidStatus");
      await expect(contract.connect(sys.signers.requester).refund(task.onchain_task_id)).to.be.revertedWithCustomError(contract, "InvalidStatus");
      expect((await balance(task.payee)) - payeeBefore).to.equal(REWARD);
      expect(await contract.queryFilter(contract.filters.TaskSettled(task.onchain_task_id))).to.have.length(1);
    });

    it("a FAILED task cannot be settled, re-proven with a passing proof, or refunded twice", async () => {
      const task = await sys.fundedTask();
      const payeeBefore = await balance(task.payee);
      expect((await postProof(task.task_id, await signed(task, "failure"))).body.status).to.equal("FAILED");
      expect((await http("POST", `/tasks/${task.task_id}/settle`)).status).to.equal(409);
      expect((await postProof(task.task_id, await signed(task, "success"))).status).to.equal(409);
      const { contract } = sys.escrow;
      await expect(contract.settle(task.onchain_task_id)).to.be.revertedWithCustomError(contract, "InvalidStatus");
      await expect(contract.refund(task.onchain_task_id)).to.be.revertedWithCustomError(contract, "InvalidStatus");
      expect(await balance(task.payee)).to.equal(payeeBefore);
      expect(await contract.queryFilter(contract.filters.TaskRefunded(task.onchain_task_id))).to.have.length(1);
    });

    it("five concurrent copies of the same valid proof: exactly one is processed, payment released once", async () => {
      const task = await sys.fundedTask();
      const sub = await signed(task);
      const payeeBefore = await balance(task.payee);
      const results = await Promise.all(Array.from({ length: 5 }, () => postProof(task.task_id, sub)));
      expect(results.map((r) => r.status).sort()).to.deep.equal([200, 409, 409, 409, 409]);
      expect((await balance(task.payee)) - payeeBefore).to.equal(REWARD);
      const { contract } = sys.escrow;
      expect(await contract.queryFilter(contract.filters.ProofCommitted(task.onchain_task_id))).to.have.length(1);
      expect(await contract.queryFilter(contract.filters.TaskSettled(task.onchain_task_id))).to.have.length(1);
    });

    it("a passing and a failing proof racing each other: exactly one wins and off-chain state matches the chain", async () => {
      const task = await sys.fundedTask();
      const payeeBefore = await balance(task.payee);
      const [a, b] = await Promise.all([
        postProof(task.task_id, await signed(task, "success")),
        postProof(task.task_id, await signed(task, "failure")),
      ]);
      expect([a.status, b.status].sort()).to.deep.equal([200, 409]);
      const final = await view(task.task_id);
      const paid = (await balance(task.payee)) - payeeBefore;
      if (final.status === "SETTLED") {
        expect(final.onchain.status).to.equal("Settled");
        expect(paid).to.equal(REWARD);
      } else {
        expect(final.status).to.equal("FAILED");
        expect(final.onchain.status).to.equal("Refunded");
        expect(paid).to.equal(0n);
      }
      expect(final.onchain.proof_hash).to.equal(final.proof.proof_hash);
    });

    it("three concurrent fund requests lock the reward exactly once", async () => {
      const { body: task } = await sys.api<any>("POST", "/tasks", {});
      const escrowBefore = await balance(sys.escrow.address);
      const results = await Promise.all([1, 2, 3].map(() => http("POST", `/tasks/${task.task_id}/fund`)));
      expect(results.map((r) => r.status).sort()).to.deep.equal([200, 409, 409]);
      expect((await balance(sys.escrow.address)) - escrowBefore).to.equal(REWARD);
      const { contract } = sys.escrow;
      expect(await contract.queryFilter(contract.filters.TaskFunded(task.onchain_task_id))).to.have.length(1);
    });

    it("a proof racing the funding transaction is refused (409) and funding still succeeds", async () => {
      const { body: task } = await sys.api<any>("POST", "/tasks", {});
      const sub = await signed(task);
      const [fund, proof] = await Promise.all([http("POST", `/tasks/${task.task_id}/fund`), postProof(task.task_id, sub)]);
      expect(fund.status).to.equal(200);
      expect(proof.status).to.equal(409);
      await expectUntouched(task.task_id);
    });

    it("a settled task's proof cannot be replayed on another task, in either direction", async () => {
      const a = await sys.fundedTask();
      const b = await sys.fundedTask();
      const proofA = await signed(a);
      expect((await postProof(a.task_id, proofA)).status).to.equal(200);
      await expectRejected(b.task_id, proofA, "task_id_match");
      await expectRejected(b.task_id, { ...proofA, proof: { ...proofA.proof, task_id: b.task_id } }, "signature");
      const proofB = await signed(b);
      expect((await postProof(a.task_id, proofB)).status).to.equal(409);
      await expectUntouched(b.task_id);
    });

    it("a flood of concurrent invalid proofs never locks the task or crashes the server", async () => {
      const task = await sys.fundedTask();
      const genuine = await signed(task);
      const junk: Array<Promise<RawResponse>> = [];
      for (let i = 0; i < 10; i++) {
        junk.push(postProof(task.task_id, { ...genuine, proof: { ...genuine.proof, final_object_position: { x: 1, y: 0, z: i } } }));
        junk.push(postProof(task.task_id, await signed(task, "success", {}, Wallet.createRandom())));
        junk.push(http("POST", `/tasks/${task.task_id}/proof`, "{broken"));
      }
      const statuses = (await Promise.all(junk)).map((r) => r.status);
      expect(statuses.every((s) => s === 400 || s === 422), JSON.stringify(statuses)).to.equal(true);
      const res = await postProof(task.task_id, genuine);
      expect(res.status).to.equal(200);
      expect(res.body.status).to.equal("SETTLED");
    });

    it("five tasks funded and settled fully in parallel all settle (no nonce races), payee paid 5×", async () => {
      const payeeBefore = await balance(sys.signers.payee.address);
      const tasks = await Promise.all(Array.from({ length: 5 }, () => sys.fundedTask()));
      const subs = await Promise.all(tasks.map((t) => signed(t)));
      const results = await Promise.all(tasks.map((t, i) => postProof(t.task_id, subs[i])));
      expect(results.map((r) => r.body.status)).to.deep.equal(Array(5).fill("SETTLED"));
      expect((await balance(sys.signers.payee.address)) - payeeBefore).to.equal(REWARD * 5n);
    });

    // FIXED (was medium): an old robot-signed proof could be replayed onto a NEW task with the same task_id
    // after a backend restart + escrow redeploy, paying the new task's payee without any robot work.
    // verifyProofSubmission now rejects proofs timestamped before the task's creation (minus a 5 min clock-skew
    // allowance). Residual (documented): within that window, and the signature still covers only the proof hash
    // (no escrow address / chain id).
    it("rejects a stale proof replayed onto a re-created task with the same task_id on a new deployment", async () => {
      const second = await startTestSystem({ robot: "external" }); // fresh escrow + empty memory = "restart"
      try {
        const taskId = `replayed_${Date.now()}`;
        const original = await sys.fundedTask({ task_id: taskId });
        // The original run happened an hour ago (simulated by back-dating the task and the robot's proof).
        const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
        sys.service.getTask(taskId).created_at = anHourAgo;
        const stale = await signed(original, "success", { timestamp: anHourAgo });
        expect((await postProof(taskId, stale)).status).to.equal(200);

        const strangerBefore = await balance(sys.signers.stranger.address);
        await second.fundedTask({ task_id: taskId, payee: sys.signers.stranger.address });
        const replay = await second.api<any>("POST", `/tasks/${taskId}/proof`, stale);
        expect(replay.status).to.equal(422);
        expect(await balance(sys.signers.stranger.address)).to.equal(strangerBefore);
      } finally {
        await second.close();
      }
    });
  });

  /* ───────────────────────────────────────────────────────────────────────────────────────────── */
  describe("7. task creation input", () => {
    const badIds = ["", "../etc/passwd", "a/b", "a b", "tâche", "a".repeat(65), "%2e%2e", "a\u0000b", "a\nb", "<script>", "__proto__/x"];
    for (const id of badIds) {
      it(`rejects task_id ${JSON.stringify(id).slice(0, 30)}`, async () => {
        expect((await http("POST", "/tasks", JSON.stringify({ task_id: id }))).status).to.equal(400);
      });
    }

    // FIXED (was low): "." and ".." were accepted but unaddressable after URL normalization; task ids must now
    // start with a letter or digit.
    it('rejects task_id "." and ".." (unreachable through any normalizing HTTP client)', async () => {
      for (const id of [".", ".."]) {
        expect((await http("POST", "/tasks", JSON.stringify({ task_id: id }))).status, id).to.equal(400);
      }
    });

    // FIXED (was low): inherited Object.prototype members passed the robot registry lookup; it now uses Object.hasOwn.
    it("rejects robot_ids that are Object.prototype member names", async () => {
      for (const robot_id of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
        expect((await http("POST", "/tasks", JSON.stringify({ robot_id }))).status, robot_id).to.equal(400);
      }
    });

    // FIXED (was low): a zero-address payee or a reward above uint256 was accepted at creation and could never
    // be funded; both are now rejected with 400.
    it("rejects a zero-address payee and a reward that does not fit in uint256 at creation", async () => {
      expect((await http("POST", "/tasks", JSON.stringify({ payee: ZeroAddress }))).status).to.equal(400);
      expect((await http("POST", "/tasks", JSON.stringify({ reward_eth: "1" + "0".repeat(80) }))).status).to.equal(400);
    });

    const badBodies: Array<[string, string]> = [
      ["tolerance 0", '{"tolerance":0}'],
      ["negative tolerance", '{"tolerance":-0.01}'],
      ["tolerance above 10 m", '{"tolerance":10.0001}'],
      ["tolerance as string", '{"tolerance":"0.05"}'],
      ["tolerance underflowing to 0 (1e-400)", '{"tolerance":1e-400}'],
      ["target coordinate 1e400 (Infinity)", '{"target_position":{"x":1e400,"y":0,"z":0}}'],
      ["target with an extra axis", '{"target_position":{"x":1,"y":0,"z":0,"w":1}}'],
      ["start as an array", '{"start_position":[0,0,0]}'],
      ["reward_eth with 19 decimals", '{"reward_eth":"0.0000000000000000001"}'],
      ["reward_eth negative", '{"reward_eth":"-1"}'],
      ["reward_eth in scientific notation", '{"reward_eth":"1e18"}'],
      ["reward_eth as a number", '{"reward_eth":0.1}'],
      ["__proto__ key", '{"__proto__":{"tolerance":9}}'],
      ["constructor key", '{"constructor":{"prototype":{"x":1}}}'],
      ["payee with a bad checksum", '{"payee":"0x90F79bf6EB2c4f870365E785982E1f101E93b907"}'],
    ];
    for (const [label, raw] of badBodies) {
      it(`rejects invalid task input (${label}) with 400`, async () => {
        const res = await http("POST", "/tasks", raw);
        expect(res.status, res.text).to.equal(400);
        expect(({} as Json).tolerance).to.equal(undefined);
      });
    }

    it("a reward larger than the requester's balance fails cleanly: no lock left behind, nothing on-chain, retryable", async () => {
      const { body: task } = await sys.api<any>("POST", "/tasks", { reward_eth: "1000000" });
      const requesterBefore = await balance(sys.signers.requester.address);
      for (let i = 0; i < 2; i++) {
        const res = await http("POST", `/tasks/${task.task_id}/fund`);
        expect(res.status).to.equal(502); // not 409 "operation in progress": the lock was released
        expect(res.body.error).to.match(/fundTask failed/);
      }
      await expectUntouched(task.task_id, "CREATED", "None");
      expect(await balance(sys.signers.requester.address)).to.equal(requesterBefore);
      const next = await sys.fundedTask();
      expect(next.status).to.equal("FUNDED");
    });
  });

  /* ───────────────────────────────────────────────────────────────────────────────────────────── */
  describe("8. off-chain state vs chain state under RPC failures (fault injection)", () => {
    let f: Awaited<ReturnType<typeof startFaultySystem>>;
    before(async () => {
      f = await startFaultySystem();
    });

    it("a commit that never reached the chain is rolled back; the same proof can be resubmitted and settles once", async () => {
      const task = await f.fundedTask();
      const sub = await signed(task);
      const payeeBefore = await balance(task.payee);
      f.escrow.failNext("commitProof", "before_send");
      await expectHttpError(f.service.submitProof(task.task_id, sub), 502);
      expect(f.service.getTask(task.task_id).status).to.equal("FUNDED");
      expect(f.service.getTask(task.task_id).proof).to.equal(undefined);
      expect((await f.escrow.getTask(task.task_id)).status).to.equal("Funded");

      expect((await f.service.submitProof(task.task_id, sub)).status).to.equal("SETTLED");
      expect((await balance(task.payee)) - payeeBefore).to.equal(REWARD);
    });

    it("a settlement that never reached the chain leaves VERIFIED; concurrent retries pay exactly once", async () => {
      const task = await f.fundedTask();
      const payeeBefore = await balance(task.payee);
      f.escrow.failNext("settle", "before_send");
      await expectHttpError(f.service.submitProof(task.task_id, await signed(task)), 502);
      expect(f.service.getTask(task.task_id).status).to.equal("VERIFIED");
      expect((await f.escrow.getTask(task.task_id)).status).to.equal("Verified");

      const results = await Promise.allSettled([f.service.settleTask(task.task_id), f.service.settleTask(task.task_id)]);
      expect(results.map((r) => r.status).sort()).to.deep.equal(["fulfilled", "rejected"]);
      expect(f.service.getTask(task.task_id).status).to.equal("SETTLED");
      expect((await balance(task.payee)) - payeeBefore).to.equal(REWARD);
    });

    it("a refund that never reached the chain leaves the escrow recoverable by the requester on-chain", async () => {
      // NOTE (low): the API has no endpoint to retry a refund — the requester must call refund() directly.
      const task = await f.fundedTask();
      f.escrow.failNext("refund", "before_send");
      await expectHttpError(f.service.submitProof(task.task_id, await signed(task, "failure")), 502);
      expect(f.service.getTask(task.task_id).status).to.equal("FAILED");
      expect((await f.escrow.getTask(task.task_id)).status).to.equal("Failed");
      await expect(f.contract.connect(f.signers.requester).refund(task.onchain_task_id)).to.changeEtherBalance(f.signers.requester, REWARD);
    });

    it("after a backend restart, re-creating a still-funded task adopts its escrow instead of funding twice", async () => {
      const task = await f.fundedTask();
      const escrowBefore = await balance(f.escrow.address);
      const restarted = f.newService(); // in-memory state is gone
      expect(() => restarted.getTask(task.task_id)).to.throw(HttpError);
      restarted.createTask({ task_id: task.task_id });
      const adopted = await restarted.fundTask(task.task_id); // reconciled from the TaskFunded event
      expect(adopted.status).to.equal("FUNDED");
      expect(adopted.transactions.fund).to.equal(task.transactions.fund);
      expect(await balance(f.escrow.address)).to.equal(escrowBefore); // no second deposit
      expect((await restarted.submitProof(task.task_id, await signed(task))).status).to.equal("SETTLED");
    });

    it("after a backend restart, a re-created task whose escrow already settled cannot be funded or revived", async () => {
      const task = await f.fundedTask();
      await f.service.submitProof(task.task_id, await signed(task));
      const restarted = f.newService();
      restarted.createTask({ task_id: task.task_id });
      await expectHttpError(restarted.fundTask(task.task_id), 409, /TaskAlreadyExists/);
      expect(restarted.getTask(task.task_id).status).to.equal("CREATED");
    });

    // FIXED (was medium): no reconciliation with the chain after an ambiguous tx failure (mined, receipt lost):
    // the task was rolled back / left behind while the chain had moved on, and every retry failed. TaskService
    // now looks up the escrow event the transaction would have emitted (TaskFunded / ProofCommitted /
    // TaskSettled / TaskRefunded, matched against this task's parameters) and adopts the chain's result.
    it("a commit mined with a lost receipt is reconciled from ProofCommitted and settles exactly once", async () => {
      const task = await f.fundedTask();
      const payeeBefore = await balance(task.payee);
      f.escrow.failNext("commitProof", "after_mined");
      const result = await f.service.submitProof(task.task_id, await signed(task));
      expect(result.status).to.equal("SETTLED");
      expect(result.transactions.commit).to.match(/^0x[0-9a-f]{64}$/);
      expect((await f.escrow.getTask(task.task_id)).status).to.equal("Settled");
      expect((await balance(task.payee)) - payeeBefore).to.equal(REWARD);
    });

    it("a funding tx mined with a lost receipt is reconciled from TaskFunded; the task proceeds normally", async () => {
      const task = f.service.createTask({});
      f.escrow.failNext("fundTask", "after_mined");
      const funded = await f.service.fundTask(task.task_id);
      expect(funded.status).to.equal("FUNDED");
      expect(funded.transactions.fund).to.match(/^0x[0-9a-f]{64}$/);
      expect((await f.service.submitProof(task.task_id, await signed(task))).status).to.equal("SETTLED");
    });

    it("a funding tx by someone else (squatted id) is NOT adopted by reconciliation", async () => {
      const task = f.service.createTask({});
      await f.contract
        .connect(f.signers.stranger)
        .fundTask(task.onchain_task_id, task.robot_address, task.payee, { value: BigInt(task.reward_wei) });
      await expectHttpError(f.service.fundTask(task.task_id), 409, /TaskAlreadyExists/);
      expect(f.service.getTask(task.task_id).status).to.equal("CREATED");
    });

    it("a settlement mined with a lost receipt is reconciled from TaskSettled (paid once, task SETTLED)", async () => {
      const task = await f.fundedTask();
      const payeeBefore = await balance(task.payee);
      f.escrow.failNext("settle", "after_mined");
      const result = await f.service.submitProof(task.task_id, await signed(task));
      expect(result.status).to.equal("SETTLED");
      expect(result.transactions.settle).to.match(/^0x[0-9a-f]{64}$/);
      expect((await balance(task.payee)) - payeeBefore).to.equal(REWARD);
    });

    it("a refund mined with a lost receipt is reconciled from TaskRefunded", async () => {
      const task = await f.fundedTask();
      f.escrow.failNext("refund", "after_mined");
      const result = await f.service.submitProof(task.task_id, await signed(task, "failure"));
      expect(result.status).to.equal("FAILED");
      expect(result.transactions.refund).to.match(/^0x[0-9a-f]{64}$/);
      expect((await f.escrow.getTask(task.task_id)).status).to.equal("Refunded");
    });

    // KNOWN LIMITATION (medium, documented in README; out of MVP scope — changes the contract interface):
    // MachineTaskEscrow has no exit from Funded other than a verifier-committed proof. If the robot
    // never delivers, the simulator crashes, or the backend restarts (all tasks live in memory, so the API can no
    // longer accept a proof for them — see the restart test above), the requester's escrow is locked forever.
    // Fix: store a deadline in fundTask and let the requester reclaim a Funded task after it
    // (e.g. `if (status == Funded && block.timestamp > deadline) → Refunded`).
    it.skip("the requester can reclaim the escrow of a task that never received a proof once a deadline passed", async () => {
      const task = await f.fundedTask();
      await time.increase(30 * 24 * 3600);
      await expect(f.contract.connect(f.signers.requester).refund(task.onchain_task_id)).to.changeEtherBalance(
        f.signers.requester,
        REWARD,
      );
    });

    // FIXED (was medium): a payee contract that cannot receive ETH (e.g. the escrow itself) made settle() revert
    // forever and locked a Verified escrow. Funding now refuses payees with contract code (400).
    it("a payee that cannot receive ETH never leaves the reward locked in escrow", async () => {
      const escrowBefore = await balance(sys.escrow.address);
      const created = await sys.api<any>("POST", "/tasks", { payee: sys.escrow.address });
      if (created.status === 201) {
        const funded = await http("POST", `/tasks/${created.body.task_id}/fund`);
        if (funded.status === 200) await postProof(created.body.task_id, await signed(created.body));
      }
      expect(await balance(sys.escrow.address)).to.equal(escrowBefore);
    });
  });

  /* ───────────────────────────────────────────────────────────────────────────────────────────── */
  describe("9. contract-level sanity: money cannot move twice or to the wrong party", () => {
    it("only the verifier can commit or settle; only requester/verifier can refund", async () => {
      const task = await sys.fundedTask();
      const sub = await signed(task);
      const { contract } = sys.escrow;
      const id = task.onchain_task_id;
      const { requester, payee, stranger, robot } = sys.signers;
      for (const who of [requester, payee, stranger, robot]) {
        await expect(contract.connect(who).commitProof(id, sub.proof_hash, true, sub.signature)).to.be.revertedWithCustomError(contract, "NotVerifier");
      }
      await sys.escrow.commitProof(task.task_id, sub.proof_hash, true, sub.signature);
      for (const who of [requester, payee, stranger, robot]) {
        await expect(contract.connect(who).settle(id)).to.be.revertedWithCustomError(contract, "NotVerifier");
      }
      await expect(contract.connect(stranger).refund(id)).to.be.revertedWithCustomError(contract, "NotAuthorized");
      await expect(contract.connect(requester).refund(id)).to.be.revertedWithCustomError(contract, "InvalidStatus");
      await expect(contract.settle(id)).to.changeEtherBalances([sys.escrow.address, task.payee], [-REWARD, REWARD]);
      await expect(contract.settle(id)).to.be.revertedWithCustomError(contract, "InvalidStatus");
    });

    it("escrow balance always equals the sum of open escrows (settled + refunded + open sequence)", async () => {
      const before = await balance(sys.escrow.address);
      const [ok, bad, open] = await Promise.all([sys.fundedTask(), sys.fundedTask(), sys.fundedTask()]);
      expect((await balance(sys.escrow.address)) - before).to.equal(REWARD * 3n);
      expect((await postProof(ok.task_id, await signed(ok))).body.status).to.equal("SETTLED");
      expect((await postProof(bad.task_id, await signed(bad, "false_success"))).body.status).to.equal("FAILED");
      expect((await view(open.task_id)).onchain.status).to.equal("Funded");
      expect((await balance(sys.escrow.address)) - before).to.equal(REWARD);
    });

    it("a task id squatted on-chain with the real robot and an attacker payee can never be committed by the backend", async () => {
      const { body: task } = await sys.api<any>("POST", "/tasks", { task_id: `squat_${Date.now()}` });
      const { contract } = sys.escrow;
      await contract
        .connect(sys.signers.stranger)
        .fundTask(task.onchain_task_id, robotWallet.address, sys.signers.stranger.address, { value: parseEther("0.001") });
      expect((await http("POST", `/tasks/${task.task_id}/fund`)).status).to.equal(409);
      expect((await postProof(task.task_id, await signed(task))).status).to.equal(409);
      expect((await view(task.task_id)).onchain).to.deep.include({ status: "Funded", proof_hash: ZeroHash });
    });
  });

  /* ───────────────────────────────────────────────────────────────────────────────────────────── */
  describe("10. trust-model boundaries (known limitations, documented — not guarantees)", () => {
    it("(known limitation) coordinates are self-reported: a robot holding its key can fabricate a perfect placement and get paid", async () => {
      const task = await sys.fundedTask();
      const fabricated = await signed(task, "success", { final_object_position: { ...task.target_position }, trajectory: [], events: [] });
      const res = await postProof(task.task_id, fabricated);
      expect(res.body.status).to.equal("SETTLED");
    });

    it("(known limitation) the verifier alone decides `passed`: the contract settles a robot-signed proof the oracle marks as passed, whatever it contains", async () => {
      const id = ethers.id(`oracle_trust_${Date.now()}`);
      const { contract } = sys.escrow;
      await contract.connect(sys.signers.requester).fundTask(id, robotWallet.address, sys.signers.payee.address, { value: REWARD });
      const spec = { task_id: "oracle_trust", robot_id: "robot_001", start_position: { x: 0, y: 0, z: 0 }, target_position: { x: 1, y: 0, z: 0 }, tolerance: 0.05 };
      const hash = computeProofHash(generateMockProof(spec, "false_success")); // object clearly outside tolerance
      await contract.commitProof(id, hash, true, await signProofHash(hash, robotWallet));
      await expect(contract.settle(id)).to.changeEtherBalance(sys.signers.payee, REWARD);
    });

    it("(known limitation) with ROBOT_ADAPTER=mock the backend signs as the robot, so any API caller can route escrow to any payee", async () => {
      const mock = await startTestSystem({ robot: "mock", mockDelayMs: 10 });
      try {
        const attacker = sys.signers.stranger.address;
        const before = await balance(attacker);
        const task = await mock.fundedTask({ payee: attacker, reward_eth: "1" });
        await mock.api("POST", `/tasks/${task.task_id}/start`, { mock_outcome: "success" });
        expect((await mock.waitForStatus(task.task_id, ["SETTLED", "FAILED"])).status).to.equal("SETTLED");
        expect((await balance(attacker)) - before).to.equal(parseEther("1"));
      } finally {
        await mock.close();
      }
    });
  });

  /* ───────────────────────────────────────────────────────────────────────────────────────────── */
  describe("11. information leakage", () => {
    const secrets = Object.values(HARDHAT_DEV_KEYS).flatMap((k) => [k.toLowerCase(), k.slice(2).toLowerCase()]);

    function expectNoLeak(text: string): void {
      const lower = text.toLowerCase();
      for (const secret of secrets) expect(lower.includes(secret), "private key in response").to.equal(false);
      expect(text, "stack trace in response").to.not.match(/\n\s+at\s|\bat [\w.<>]+ \(/);
      expect(text, "server file path in response").to.not.match(/\/Users\/|node_modules|\.ts:\d+/);
    }

    it("error responses never contain private keys, stack traces or server file paths", async () => {
      const task = await sys.fundedTask();
      const { body: unfundable } = await sys.api<any>("POST", "/tasks", { reward_eth: "1000000" });
      await sys.api("POST", "/tasks", { robot_id: "constructor", task_id: "leak_ctor" }); // 201 today (see BUG in §7)
      const battery: Array<[string, string, string | undefined, string | null]> = [
        ["POST", `/tasks/${task.task_id}/proof`, "{oops", "application/json"],
        ["POST", `/tasks/${task.task_id}/proof`, JSON.stringify({ proof: { a: 1 }, signature: DUMMY_SIGNATURE }), "application/json"],
        ["POST", `/tasks/${task.task_id}/proof`, JSON.stringify({ a: "x".repeat(1_100_000) }), "application/json"],
        ["POST", `/tasks/${task.task_id}/proof`, "{}", "application/json; charset=utf-16"],
        ["POST", `/tasks/${task.task_id}/fund`, undefined, null],
        ["POST", `/tasks/${unfundable.task_id}/fund`, undefined, null],
        ["POST", "/tasks/leak_ctor/fund", undefined, null],
        ["GET", "/tasks/%E0%A4%A", undefined, null],
        ["GET", "/nope", undefined, null],
        ["DELETE", `/tasks/${task.task_id}`, undefined, null],
      ];
      for (const [method, route, body, type] of battery) {
        const res = await http(method, route, body, type);
        expect(res.status, `${method} ${route.slice(0, 40)}`).to.be.within(400, 599);
        expectNoLeak(res.text);
      }
      for (const text of seenBodies) expectNoLeak(text);
    });

    // FIXED (was low): /health returned the full RPC_URL, which embeds API keys for hosted RPCs; it now returns
    // only the URL origin.
    it("/health does not expose credentials embedded in RPC_URL", async () => {
      // Minimal JSON-RPC proxy in front of Hardhat's in-process network, reachable at a "keyed" URL.
      const proxy = createServer((req, res) => {
        let raw = "";
        req.on("data", (c: Buffer) => (raw += c.toString()));
        req.on("end", () => {
          const handle = async (p: { id: unknown; method: string; params?: unknown[] }) => {
            try {
              return { jsonrpc: "2.0", id: p.id, result: await network.provider.request({ method: p.method, params: p.params ?? [] }) };
            } catch (e) {
              const err = e as { code?: number; message: string; data?: unknown };
              return { jsonrpc: "2.0", id: p.id, error: { code: err.code ?? -32603, message: err.message, data: err.data } };
            }
          };
          const payload = JSON.parse(raw) as Json | Json[];
          void (Array.isArray(payload) ? Promise.all(payload.map((p) => handle(p as any))) : handle(payload as any)).then((out) => {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(out));
          });
        });
      });
      proxy.listen(0, "127.0.0.1");
      await once(proxy, "listening");
      const apiKey = "SECRET_PROVIDER_API_KEY_0123456789";
      const config: AppConfig = {
        port: 0,
        rpcUrl: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/v2/${apiKey}`,
        escrowAddress: sys.escrow.address,
        verifierPrivateKey: HARDHAT_DEV_KEYS.verifier,
        requesterPrivateKey: HARDHAT_DEV_KEYS.requester,
        robotPrivateKey: HARDHAT_DEV_KEYS.robot,
        robots: { robot_001: robotWallet.address },
        defaultRobotId: "robot_001",
        payeeAddress: sys.signers.payee.address,
        robotAdapter: "external",
        mockRobotDelayMs: 0,
        defaultTolerance: 0.05,
        defaultRewardWei: REWARD,
      };
      const running = await startServer(config, () => {});
      try {
        const res = await fetch(`http://127.0.0.1:${(running.server.address() as AddressInfo).port}/health`);
        const text = await res.text();
        expect(res.status).to.equal(200);
        expect(text).to.not.include(apiKey);
      } finally {
        await running.close();
        await new Promise<void>((r) => proxy.close(() => r()));
      }
    });
  });
});
