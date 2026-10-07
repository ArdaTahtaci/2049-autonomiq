import { describe, expect, test } from "bun:test";
import { Signature, Wallet, getBytes, keccak256 as ethersKeccak, toUtf8Bytes } from "ethers";
// The backend's own verifier, signer and hashing: the workflow must agree with them exactly.
import { computeProofHash as backendProofHash } from "../../src/proof/hash";
import { recoverProofSigner as backendRecover } from "../../src/proof/signature";
import { computeTaskSpecHash as backendSpecHash } from "../../src/proof/taskSpec";
import { verifyProofSubmission } from "../../src/proof/verify";
import { MOCK_OUTCOMES, type MockOutcome } from "../../src/robot/mockProof";
import {
  type SettlementInput,
  computeProofHash,
  computeTaskSpecHash,
  evaluateSettlement,
  onchainTaskIdOf,
  parseIsoMillis,
  recoverProofSigner,
} from "./policy";
import {
  IMPOSTOR_KEY,
  ROBOT_ADDRESS,
  ROBOT_KEY,
  SPEC,
  type Submission,
  ZERO_HASH,
  clone,
  fundedOnchain,
  makeEvidence,
  makeSubmission,
  signRaw,
} from "./test-fixtures";

const CONFIG = { proofClockSkewSeconds: 300, requireSpecAnchor: true };

function input(sub: Submission, overrides: Partial<SettlementInput> = {}): SettlementInput {
  return {
    trigger: { task_id: SPEC.task_id, proof_hash: sub.proof_hash },
    evidence: makeEvidence(sub),
    onchain: fundedOnchain(),
    config: CONFIG,
    ...overrides,
  };
}

const failed = (r: ReturnType<typeof evaluateSettlement>) => r.checks.filter((c) => !c.ok).map((c) => c.name);

const backendCtx = {
  task_id: SPEC.task_id,
  robot_id: SPEC.robot_id,
  robot_address: ROBOT_ADDRESS,
  start_position: SPEC.start_position,
  target_position: SPEC.target_position,
  tolerance: SPEC.tolerance,
  not_before: SPEC.created_at,
};

// ─── Parity with the backend verifier ────────────────────────────────────────────────────────

describe("parity with the backend verifier (src/proof/verify.ts)", () => {
  const cases: Array<[MockOutcome, number]> = [];
  for (const outcome of MOCK_OUTCOMES) for (const seed of [1, 7, 42, 1337]) cases.push([outcome, seed]);

  test.each(cases)("%s (seed %d): same proof hash and same passed verdict", async (outcome, seed) => {
    const sub = await makeSubmission(outcome, { seed });
    const backend = verifyProofSubmission(sub, backendCtx);
    const workflow = evaluateSettlement(input(sub));

    expect(backend.outcome).toBe("accepted");
    expect(workflow.decision).toBe("ACCEPT");
    if (backend.outcome !== "accepted") throw new Error("unreachable");
    expect(workflow.proofHash).toBe(backend.proof_hash as `0x${string}`);
    expect(workflow.passed).toBe(backend.passed);
    expect(workflow.passed).toBe(outcome === "success");
    expect(workflow.signer).toBe(backend.signer);
    expect(workflow.distance).toBeCloseTo(backend.placement.distance, 12);
  });

  test("tampered proof (final position moved after signing) -> both reject", async () => {
    const sub = await makeSubmission("false_success");
    const tampered = clone(sub);
    tampered.proof.final_object_position = { ...SPEC.target_position };
    expect(verifyProofSubmission(tampered, backendCtx).outcome).toBe("rejected");
    const w = evaluateSettlement(input(tampered, { trigger: { task_id: SPEC.task_id, proof_hash: sub.proof_hash } }));
    expect(w.decision).toBe("REJECT");
    expect(failed(w)).toContain("trigger_binding");
    expect(failed(w)).toContain("signature");
  });

  test("tampered proof with recomputed proof_hash (attacker re-hashes) -> both reject on the signature", async () => {
    const sub = await makeSubmission("false_success");
    const tampered = clone(sub);
    tampered.proof.final_object_position = { ...SPEC.target_position };
    tampered.proof_hash = backendProofHash(tampered.proof);
    const backend = verifyProofSubmission(tampered, backendCtx);
    expect(backend.outcome).toBe("rejected");
    expect(backend.checks.find((c) => c.name === "signature")?.ok).toBe(false);
    const w = evaluateSettlement(input(tampered));
    expect(w.decision).toBe("REJECT");
    expect(failed(w)).toEqual(["signature"]);
  });

  test("proof signed by a key that is not the registered robot -> both reject", async () => {
    const sub = await makeSubmission("success", { key: IMPOSTOR_KEY });
    expect(verifyProofSubmission(sub, backendCtx).outcome).toBe("rejected");
    const w = evaluateSettlement(input(sub));
    expect(w.decision).toBe("REJECT");
    expect(failed(w)).toEqual(["signature"]);
  });

  test("proof hash: same bytes as the backend for proofs with extra fields, unicode and key order", () => {
    const proof = {
      success: true,
      z_extra: { nested: [3, 2, 1], "ü-key": "日本語 ✓", e: 1e21, small: 1e-7, neg0: -0 },
      task_id: "t",
      a: [{ b: 1, a: 2 }],
    };
    expect(computeProofHash(proof)).toBe(backendProofHash(proof) as `0x${string}`);
    const reordered = { a: [{ a: 2, b: 1 }], task_id: "t", z_extra: proof.z_extra, success: true };
    expect(computeProofHash(reordered)).toBe(computeProofHash(proof));
  });

  test("task spec hash: same as the backend's anchored hash (extra vector fields ignored)", () => {
    expect(computeTaskSpecHash(SPEC)).toBe(backendSpecHash(SPEC) as `0x${string}`);
    const withExtras = { ...SPEC, target_position: { ...SPEC.target_position, w: 9 }, spec_hash: "x", onchain_task_id: "y" };
    expect(computeTaskSpecHash(withExtras)).toBe(backendSpecHash(SPEC) as `0x${string}`);
  });

  test("on-chain task id = keccak256(utf8(task_id)), as the backend's escrow client computes it", () => {
    expect(onchainTaskIdOf(SPEC.task_id)).toBe(ethersKeccak(toUtf8Bytes(SPEC.task_id)) as `0x${string}`);
  });
});

// ─── Signature recovery (as strict as OpenZeppelin ECDSA) ───────────────────────────────────

describe("recoverProofSigner", () => {
  const hash = computeProofHash({ hello: "world" });

  test("recovers the same signer as the backend (ethers) for many signatures", async () => {
    const wallet = new Wallet(ROBOT_KEY);
    for (let i = 0; i < 20; i++) {
      const h = computeProofHash({ i });
      const sig = await wallet.signMessage(getBytes(h));
      expect(recoverProofSigner(h, sig)).toBe(ROBOT_ADDRESS);
      expect(recoverProofSigner(h, sig)).toBe(backendRecover(h, sig));
    }
  });

  test("rejects high-s (malleable) signatures, like OpenZeppelin and the backend", async () => {
    const sig = Signature.from(await new Wallet(ROBOT_KEY).signMessage(getBytes(hash)));
    const n = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
    const highS = `0x${(n - BigInt(sig.s)).toString(16).padStart(64, "0")}`;
    const malleable = `${sig.r}${highS.slice(2)}${(sig.v === 27 ? 28 : 27).toString(16)}`;
    expect(() => backendRecover(hash, malleable)).toThrow();
    expect(() => recoverProofSigner(hash, malleable)).toThrow(/high\) s/);
  });

  test("rejects v not in {27, 28}, wrong length, r = 0", async () => {
    const sig = await new Wallet(ROBOT_KEY).signMessage(getBytes(hash));
    const v01 = `${sig.slice(0, 130)}${sig.endsWith("1b") ? "00" : "01"}`;
    expect(() => recoverProofSigner(hash, v01)).toThrow(/v must be 27 or 28/);
    expect(() => backendRecover(hash, v01)).toThrow();
    expect(() => recoverProofSigner(hash, sig.slice(0, 128))).toThrow(/65-byte/);
    expect(() => recoverProofSigner(hash, `0x${"0".repeat(64)}${sig.slice(66)}`)).toThrow(/r out of range/);
  });
});

// ─── Policy checks ────────────────────────────────────────────────────────────────────────────

describe("evaluateSettlement", () => {
  test("happy path: ACCEPT + passed, all 11 checks green, report fields populated", async () => {
    const sub = await makeSubmission("success");
    const r = evaluateSettlement(input(sub));
    expect(r.decision).toBe("ACCEPT");
    expect(r.passed).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.checks.map((c) => c.name)).toEqual([
      "evidence_schema",
      "trigger_binding",
      "task_binding",
      "proof_schema",
      "proof_task_match",
      "spec_anchor",
      "signature",
      "task_geometry",
      "freshness",
      "physical_placement",
      "success_claim",
    ]);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(r.signature).toBe(sub.signature as `0x${string}`);
    expect(r.onchainTaskId).toBe(onchainTaskIdOf(SPEC.task_id));
    expect(r.specHash).toBe(backendSpecHash(SPEC) as `0x${string}`);
  });

  test("false success claim: ACCEPT but not passed (refund), success_claim mismatch recorded", async () => {
    const r = evaluateSettlement(input(await makeSubmission("false_success")));
    expect(r.decision).toBe("ACCEPT");
    expect(r.passed).toBe(false);
    expect(failed(r)).toEqual(["physical_placement", "success_claim"]);
    expect(r.reasons[0]).toMatch(/robot claimed success but object placed/);
  });

  test("honest failure: ACCEPT, not passed", async () => {
    const r = evaluateSettlement(input(await makeSubmission("failure")));
    expect(r.decision).toBe("ACCEPT");
    expect(r.passed).toBe(false);
    expect(r.reasons).toContain("robot reported failure (success=false)");
  });

  test("placement exactly on the tolerance boundary passes; just outside fails", async () => {
    const base = (await makeSubmission("success")).proof;
    const on = await signRaw({ ...base, final_object_position: { x: 1.05, y: 0, z: 0 } });
    const off = await signRaw({ ...base, final_object_position: { x: 1.0501, y: 0, z: 0 } });
    expect(evaluateSettlement(input(on)).passed).toBe(true);
    const r = evaluateSettlement(input(off));
    expect(r.decision).toBe("ACCEPT");
    expect(r.passed).toBe(false);
  });

  test("robot says failure although placement is within tolerance: not passed (both must agree)", async () => {
    const base = (await makeSubmission("success")).proof;
    const r = evaluateSettlement(input(await signRaw({ ...base, success: false })));
    expect(r.decision).toBe("ACCEPT");
    expect(r.passed).toBe(false);
    expect(failed(r)).toEqual(["success_claim"]);
  });

  test("trigger proof_hash differs from the served proof -> REJECT (trigger_binding)", async () => {
    const sub = await makeSubmission("success");
    const r = evaluateSettlement(input(sub, { trigger: { task_id: SPEC.task_id, proof_hash: `0x${"ab".repeat(32)}` } }));
    expect(r.decision).toBe("REJECT");
    expect(failed(r)).toEqual(["trigger_binding"]);
  });

  test("backend's submission.proof_hash disagrees with the proof -> REJECT", async () => {
    const sub = await makeSubmission("success");
    const ev = makeEvidence(sub);
    ev.submission.proof_hash = `0x${"cd".repeat(32)}`;
    expect(failed(evaluateSettlement(input(sub, { evidence: ev })))).toEqual(["trigger_binding"]);
  });

  test("submission.proof_hash may be absent/null", async () => {
    const sub = await makeSubmission("success");
    const ev = makeEvidence(sub) as { submission: Record<string, unknown> };
    ev.submission.proof_hash = null;
    expect(evaluateSettlement(input(sub, { evidence: ev })).decision).toBe("ACCEPT");
    delete ev.submission.proof_hash;
    expect(evaluateSettlement(input(sub, { evidence: ev })).decision).toBe("ACCEPT");
  });

  test("evidence for another task -> REJECT (task_binding)", async () => {
    const sub = await makeSubmission("success");
    const ev = makeEvidence(sub);
    ev.task.task_id = "task_other";
    expect(failed(evaluateSettlement(input(sub, { evidence: ev })))).toContain("task_binding");
    const ev2 = makeEvidence(sub);
    ev2.task.onchain_task_id = onchainTaskIdOf("task_other");
    expect(failed(evaluateSettlement(input(sub, { evidence: ev2 })))).toEqual(["task_binding"]);
  });

  test("proof for another task (validly signed) -> REJECT (proof_task_match)", async () => {
    const sub = await makeSubmission("success", { spec: { ...SPEC, task_id: "task_old" } });
    const r = evaluateSettlement(input(sub));
    expect(r.decision).toBe("REJECT");
    expect(failed(r)).toEqual(["proof_task_match"]);
  });

  test("proof from another robot_id -> REJECT", async () => {
    const sub = await makeSubmission("success", { spec: { ...SPEC, robot_id: "robot_999" } });
    expect(failed(evaluateSettlement(input(sub)))).toEqual(["proof_task_match"]);
  });

  test("missing / mistyped proof fields -> REJECT (proof_schema); extra fields are fine", async () => {
    const base = (await makeSubmission("success")).proof;
    for (const mutate of [
      (p: Record<string, unknown>) => delete p.final_object_position,
      (p: Record<string, unknown>) => (p.success = "true"),
      (p: Record<string, unknown>) => (p.timestamp = "2026-10-07 09:25:30"),
      (p: Record<string, unknown>) => (p.timestamp = "2026-10-07T09:25:30"), // no timezone
      (p: Record<string, unknown>) => (p.start_position = { x: 0, y: 0 }),
      (p: Record<string, unknown>) => (p.task_id = ""),
    ]) {
      const proof = clone(base);
      mutate(proof);
      const r = evaluateSettlement(input(await signRaw(proof)));
      expect(r.decision).toBe("REJECT");
      expect(failed(r)).toContain("proof_schema");
    }
    const extra = await signRaw({ ...base, sensor: { lidar: [1, 2, 3] }, camera_hash: "0xabc" });
    expect(evaluateSettlement(input(extra)).decision).toBe("ACCEPT");
  });

  test("backend altered the task after funding (target / tolerance) -> REJECT (spec_anchor)", async () => {
    // A failed placement the backend tries to turn into a payout by loosening the tolerance.
    const sub = await makeSubmission("false_success");
    const loosened = makeEvidence(sub, { ...SPEC, tolerance: 5 });
    const r = evaluateSettlement(input(sub, { evidence: loosened }));
    expect(r.decision).toBe("REJECT");
    expect(failed(r)).toEqual(["spec_anchor"]);
    expect(r.checks.find((c) => c.name === "spec_anchor")?.detail).toMatch(/altered after funding/);

    const moved = makeEvidence(sub, { ...SPEC, target_position: { x: 2, y: 0, z: 0 } });
    expect(failed(evaluateSettlement(input(sub, { evidence: moved })))).toContain("spec_anchor");
  });

  test("no on-chain spec anchor: REJECT when required, ACCEPT when not", async () => {
    const sub = await makeSubmission("success");
    const onchain = { ...fundedOnchain(), specHash: ZERO_HASH };
    const strict = evaluateSettlement(input(sub, { onchain }));
    expect(strict.decision).toBe("REJECT");
    expect(strict.reasons).toEqual(["spec_anchor: task spec not anchored on-chain"]);
    const lax = evaluateSettlement(input(sub, { onchain, config: { ...CONFIG, requireSpecAnchor: false } }));
    expect(lax.decision).toBe("ACCEPT");
  });

  test("robot identity comes from the chain: a different on-chain robot -> REJECT", async () => {
    const sub = await makeSubmission("success");
    const onchain = fundedOnchain(SPEC, new Wallet(IMPOSTOR_KEY).address);
    expect(failed(evaluateSettlement(input(sub, { onchain })))).toEqual(["signature"]);
  });

  test("malformed signature -> REJECT (evidence_schema)", async () => {
    const sub = await makeSubmission("success");
    const r = evaluateSettlement(input({ ...sub, signature: "0x1234" }));
    expect(r.decision).toBe("REJECT");
    expect(failed(r)).toEqual(["evidence_schema"]);
  });

  test("robot redefines the target in its signed proof -> REJECT (task_geometry)", async () => {
    const base = (await makeSubmission("success")).proof;
    const sub = await signRaw({ ...base, target_position: { x: 1.02, y: 0, z: 0 } });
    expect(failed(evaluateSettlement(input(sub)))).toEqual(["task_geometry"]);
  });

  test("stale proof (older than task creation minus skew) -> REJECT; within skew -> ACCEPT", async () => {
    const stale = await makeSubmission("success", { now: new Date("2026-10-07T09:10:00.000Z") });
    const r = evaluateSettlement(input(stale));
    expect(r.decision).toBe("REJECT");
    expect(failed(r)).toEqual(["freshness"]);
    const skewed = await makeSubmission("success", { now: new Date("2026-10-07T09:22:00.000Z") });
    expect(evaluateSettlement(input(skewed)).decision).toBe("ACCEPT");
  });

  test("malformed evidence documents -> REJECT (evidence_schema), never throws", async () => {
    const sub = await makeSubmission("success");
    for (const evidence of [null, "x", [], {}, { task: {} }, { task: makeEvidence(sub).task }, { task: makeEvidence(sub).task, submission: { proof: [] } }]) {
      const r = evaluateSettlement(input(sub, { evidence }));
      expect(r.decision).toBe("REJECT");
      expect(failed(r)).toEqual(["evidence_schema"]);
    }
  });

  test("proof that cannot be canonicalized (lone surrogate) -> REJECT, never throws", async () => {
    const sub = await makeSubmission("success");
    const ev = makeEvidence(sub);
    (ev.submission.proof as Record<string, unknown>).note = "\ud800";
    const r = evaluateSettlement(input(sub, { evidence: ev }));
    expect(r.decision).toBe("REJECT");
    expect(failed(r)).toContain("trigger_binding");
  });

  test("deterministic: same input, same verdict", async () => {
    const sub = await makeSubmission("false_success");
    expect(evaluateSettlement(input(sub))).toEqual(evaluateSettlement(input(clone(sub))));
  });
});

describe("parseIsoMillis (engine-independent timestamp parsing)", () => {
  test.each([
    "2026-10-07T12:00:00Z",
    "2026-10-07T12:00:00.123Z",
    "2026-10-07T14:00:00+02:00",
    "2026-10-07T07:30:00.5-04:30",
    "2024-02-29T23:59:59.999Z",
  ])("%s matches Date.parse", (ts) => {
    expect(parseIsoMillis(ts)).toBe(Date.parse(ts));
  });

  test("sub-millisecond digits are truncated", () => {
    expect(parseIsoMillis("2026-10-07T12:00:00.123456+00:00")).toBe(Date.parse("2026-10-07T12:00:00.123Z"));
  });

  test("invalid timestamps -> NaN", () => {
    for (const ts of ["2026-02-30T00:00:00Z", "2026-10-07T12:00Z", "2026-10-07T12:00:00", "yesterday"]) {
      expect(Number.isNaN(parseIsoMillis(ts))).toBe(true);
    }
  });
});
