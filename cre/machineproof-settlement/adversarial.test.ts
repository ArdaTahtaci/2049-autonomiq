/**
 * Adversarial tests for the CRE settlement workflow: evidence a (malicious or buggy) backend could serve,
 * hostile JSON, parity edge cases with the backend verifier, and on-chain races around the report write.
 * Backend/contract-side CRE attacks live in test/adversarial/cre-attacks.test.ts (repo root).
 *
 * Conventions: test(...) = defended; test.skip(...) + "// BUG (severity)" = reproduced issue, the test asserts
 * the CORRECT behaviour; "(known limitation)" = current behaviour pinned, must be documented.
 */
import { test as bunTest, describe, expect } from "bun:test";
import { type HTTPPayload, bytesToHex } from "@chainlink/cre-sdk";
import { EvmMock, HttpActionsMock, REPORT_METADATA_HEADER_LENGTH, addContractMock, newTestRuntime, test as creTest } from "@chainlink/cre-sdk/test";
import type { Hex } from "viem";
import { verifyProofSubmission } from "../../src/proof/verify";
import { ESCROW_ABI, type SettlementReport, decodeSettlementReport } from "./abi";
import configJson from "./config.local.json";
import { type OnchainTask, type SettlementInput, computeProofHash, evaluateSettlement, parseIsoMillis } from "./policy";
import {
  IMPOSTOR_KEY,
  ROBOT_ADDRESS,
  SPEC,
  type Submission,
  type TaskSpec,
  clone,
  fundedOnchain,
  makeEvidence,
  makeSubmission,
  onchainTaskIdOf,
  signRaw,
} from "./test-fixtures";
import { type Config, configSchema, onSettlementTrigger } from "./workflow";

const CONFIG: Config = configSchema.parse(configJson);
const POLICY = { proofClockSkewSeconds: 300, requireSpecAnchor: true };
const ANVIL_SELECTOR = 7759470850252068959n;
const TX_HASH = `0x${"7e".repeat(32)}`;
const EVIDENCE_URL = `${CONFIG.backendUrl}/cre/tasks/${SPEC.task_id}/evidence`;
const RESULT_URL = `${CONFIG.backendUrl}/cre/tasks/${SPEC.task_id}/result`;
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const hexToB64 = (h: string) => Buffer.from(h.slice(2), "hex").toString("base64");

const failed = (r: ReturnType<typeof evaluateSettlement>) => r.checks.filter((c) => !c.ok).map((c) => c.name);
const input = (sub: Submission, overrides: Partial<SettlementInput> = {}): SettlementInput => ({
  trigger: { task_id: SPEC.task_id, proof_hash: sub.proof_hash },
  evidence: makeEvidence(sub),
  onchain: fundedOnchain(),
  config: POLICY,
  ...overrides,
});
const backendCtx = (spec: TaskSpec = SPEC) => ({
  task_id: spec.task_id,
  robot_id: spec.robot_id,
  robot_address: ROBOT_ADDRESS,
  start_position: spec.start_position,
  target_position: spec.target_position,
  tolerance: spec.tolerance,
  // what TaskService passes: created_at minus the 300 s clock skew
  not_before: new Date(Date.parse(spec.created_at) - 300_000).toISOString(),
});
/** What Express does: JSON.parse the robot's body, later res.json() the stored raw proof as evidence. */
const viaExpress = <T>(value: unknown): T => JSON.parse(JSON.stringify(value)) as T;

// ─── Hostile JSON in the proof / evidence ────────────────────────────────────────────────────────

describe("hostile JSON: prototype keys, duplicate keys, extreme numbers", () => {
  bunTest("a proof with own `__proto__` / `constructor` keys: backend and workflow hash it identically and both accept", async () => {
    const base = (await makeSubmission("success")).proof;
    // JSON.parse creates OWN properties named __proto__ (an object literal would set the prototype instead).
    const proof = JSON.parse(
      JSON.stringify(base).slice(0, -1) + ',"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}',
    ) as Record<string, unknown>;
    expect(Object.hasOwn(proof, "__proto__")).toBe(true);
    const sub = await signRaw(proof);
    const raw = JSON.parse(JSON.stringify({ proof: sub.proof, signature: sub.signature })) as { proof: Record<string, unknown> };
    const backend = verifyProofSubmission(raw, backendCtx());
    expect(backend.outcome).toBe("accepted");
    const evidence = viaExpress<Record<string, unknown>>(makeEvidence({ ...sub, proof: raw.proof }));
    const verdict = evaluateSettlement(input(sub, { evidence }));
    expect(verdict.decision).toBe("ACCEPT");
    expect(verdict.passed).toBe(true);
    if (backend.outcome === "accepted") expect(verdict.proofHash).toBe(backend.proof_hash as Hex);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  bunTest("evidence with duplicate keys: a trailing override of a signed value is REJECTed, a leading decoy is harmless (last key wins)", async () => {
    const sub = await makeSubmission("false_success");
    const evidenceText = JSON.stringify(makeEvidence(sub));
    // Malicious backend appends a second final_object_position (on target) after the signed one.
    const proofJson = JSON.stringify(sub.proof);
    const overridden = evidenceText.replace(proofJson, `${proofJson.slice(0, -1)},"final_object_position":{"x":1,"y":0,"z":0}}`);
    expect(overridden).not.toBe(evidenceText);
    const bad = evaluateSettlement(input(sub, { evidence: JSON.parse(overridden) }));
    expect(bad.decision).toBe("REJECT");
    expect(failed(bad)).toEqual(expect.arrayContaining(["trigger_binding", "signature"]));
    // Decoy first, signed value last → the signed values are what gets verified (and it is a failed placement).
    const decoyFirst = evidenceText.replace(proofJson, `{"final_object_position":{"x":1,"y":0,"z":0},${proofJson.slice(1)}`);
    const ok = evaluateSettlement(input(sub, { evidence: JSON.parse(decoyFirst) }));
    expect(ok.decision).toBe("ACCEPT");
    expect(ok.passed).toBe(false);
  });

  bunTest("numbers beyond float range (1e400 → Infinity) / NaN-like values are REJECTed by schema, never thrown", async () => {
    const sub = await makeSubmission("success");
    const text = JSON.stringify(makeEvidence(sub)).replace(/"final_object_position":\{"x":[^,]+,/, '"final_object_position":{"x":1e400,');
    const evidence = JSON.parse(text) as { submission: { proof: { final_object_position: { x: number } } } };
    expect(evidence.submission.proof.final_object_position.x).toBe(Number.POSITIVE_INFINITY);
    const verdict = evaluateSettlement(input(sub, { evidence }));
    expect(verdict.decision).toBe("REJECT");
    expect(failed(verdict)).toContain("proof_schema");
    // tolerance 1e-400 parses to 0 → no longer the anchored spec
    const tol = JSON.parse(JSON.stringify(makeEvidence(sub)).replace('"tolerance":0.05', '"tolerance":1e-400'));
    expect(failed(evaluateSettlement(input(sub, { evidence: tol })))).toEqual(["spec_anchor"]);
  });

  bunTest("-0 and exotic number spellings in the robot's JSON: same canonical hash on both sides, ACCEPT", async () => {
    const base = (await makeSubmission("success")).proof as Record<string, any>;
    const proofText = JSON.stringify({ ...base, extra: { a: 0, b: 1e21, c: 1e-7, d: 0.1 + 0.2, e: 2 ** 53 + 2 } })
      .replace('"a":0', '"a":-0.0e0')
      .replace('"b":1e+21', '"b":1000000000000000000000.000')
      .replace('"c":1e-7', '"c":0.0000001');
    const proof = JSON.parse(proofText) as Record<string, unknown>;
    expect(Object.is((proof.extra as { a: number }).a, -0)).toBe(true);
    const sub = await signRaw(proof);
    const backend = verifyProofSubmission(JSON.parse(`{"proof":${proofText},"signature":"${sub.signature}"}`), backendCtx());
    expect(backend.outcome).toBe("accepted");
    const verdict = evaluateSettlement(input(sub, { evidence: viaExpress(makeEvidence(sub)) }));
    expect(verdict.decision).toBe("ACCEPT");
    if (backend.outcome === "accepted") expect(verdict.proofHash).toBe(backend.proof_hash as Hex);
  });

  bunTest("huge evidence (20k-point trajectory, ~1 MB) is evaluated deterministically", async () => {
    const base = (await makeSubmission("success")).proof as Record<string, any>;
    const trajectory = Array.from({ length: 20_000 }, (_, i) => ({ t_ms: i, x: i / 20_000, y: 0, z: 0.15, gripper: "closed" }));
    const sub = await signRaw({ ...base, trajectory });
    const evidence = viaExpress(makeEvidence(sub));
    expect(JSON.stringify(evidence).length).toBeGreaterThan(900_000);
    const a = evaluateSettlement(input(sub, { evidence }));
    expect(a.decision).toBe("ACCEPT");
    expect(evaluateSettlement(input(sub, { evidence: viaExpress(evidence) }))).toEqual(a);
  });
});

// ─── What a malicious backend could serve ────────────────────────────────────────────────────────

describe("malicious backend evidence", () => {
  bunTest("a robot_address claim in the evidence is ignored: an impostor-signed proof is REJECTed against the ON-CHAIN robot", async () => {
    const sub = await makeSubmission("success", { key: IMPOSTOR_KEY });
    const evidence = makeEvidence(sub) as Record<string, any>;
    evidence.task.robot_address = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"; // impostor's address
    expect(failed(evaluateSettlement(input(sub, { evidence })))).toEqual(["signature"]);
  });

  bunTest("swapping in another task's spec and proof for this trigger (cross-task evidence) is REJECTed", async () => {
    const other: TaskSpec = { ...SPEC, task_id: "task_other" };
    const sub = await makeSubmission("success", { spec: other });
    const verdict = evaluateSettlement(input(sub, { evidence: makeEvidence(sub, other) }));
    expect(verdict.decision).toBe("REJECT");
    expect(failed(verdict)).toEqual(expect.arrayContaining(["task_binding", "proof_task_match", "spec_anchor"]));
  });

  bunTest("homoglyph task_id in the proof (Cyrillic 'а') is REJECTed", async () => {
    const homoglyph: TaskSpec = { ...SPEC, task_id: SPEC.task_id.replace("a", "а") };
    expect(homoglyph.task_id).not.toBe(SPEC.task_id);
    const sub = await makeSubmission("success", { spec: homoglyph });
    expect(failed(evaluateSettlement(input(sub)))).toContain("proof_task_match");
  });

  bunTest("type confusion in the served task spec (strings for numbers, arrays for objects) is REJECTed, never thrown", async () => {
    const sub = await makeSubmission("success");
    const variants: Array<(e: Record<string, any>) => void> = [
      (e) => (e.task.tolerance = "0.05"),
      (e) => (e.task.target_position = [1, 0, 0]),
      (e) => (e.task.created_at = 1791374400000),
      (e) => (e.submission.proof = [e.submission.proof]),
      (e) => (e.submission.signature = { r: "0x", s: "0x" }),
      (e) => (e.task = null),
    ];
    for (const mutate of variants) {
      const evidence = clone(makeEvidence(sub)) as Record<string, any>;
      mutate(evidence);
      expect(evaluateSettlement(input(sub, { evidence })).decision).toBe("REJECT");
    }
  });

  bunTest("an equivalent created_at spelling (+02:00 instead of Z) is REJECTed by the spec anchor (exact string is anchored)", async () => {
    const sub = await makeSubmission("success");
    const evidence = makeEvidence(sub) as Record<string, any>;
    evidence.task.created_at = "2026-10-07T11:24:46.123+02:00"; // same instant as SPEC.created_at
    expect(parseIsoMillis(evidence.task.created_at)).toBe(parseIsoMillis(SPEC.created_at));
    expect(failed(evaluateSettlement(input(sub, { evidence })))).toEqual(["spec_anchor"]);
  });

  bunTest("(known limitation) with requireSpecAnchor=false a backend may loosen the tolerance and turn a failed placement into a payout", async () => {
    const sub = await makeSubmission("false_success");
    const loose: TaskSpec = { ...SPEC, tolerance: 10 };
    const unanchored = { ...fundedOnchain(), specHash: `0x${"0".repeat(64)}` };
    const verdict = evaluateSettlement(input(sub, { evidence: makeEvidence(sub, loose), onchain: unanchored, config: { ...POLICY, requireSpecAnchor: false } }));
    expect(verdict.decision).toBe("ACCEPT");
    expect(verdict.passed).toBe(true);
  });
});

// ─── Parity with the backend verifier on timestamps ──────────────────────────────────────────────

describe("timestamp parity with the backend (zod iso.datetime + Date.parse)", () => {
  const cases = [
    "2026-10-07T09:25:30Z",
    "2026-10-07T09:25:30.5Z",
    "2026-10-07T09:25:30.123456789Z",
    "2026-10-07T09:25:30+00:00",
    "2026-10-07T09:25:30-00:00",
    "2026-10-07T23:25:30+14:00",
    "2026-10-06T22:55:30-10:30",
    "2026-10-07T15:10:30+05:45",
    // around the freshness boundary: created_at 09:24:46.123Z minus 300 s = 09:19:46.123Z
    "2026-10-07T09:19:46.123Z",
    "2026-10-07T09:19:46.1229999Z",
    "2026-10-07T11:19:46.123+02:00",
    "2026-10-07T11:19:46.122+02:00",
    // invalid / out-of-grammar
    "2026-10-07T09:25Z",
    "2026-10-07T09:25:60Z",
    "2026-10-07T24:00:00Z",
    "2026-10-07t09:25:30z",
    "2026-10-07 09:25:30Z",
    "2026-10-07T09:25:30+0200",
    "2026-10-07T09:25:30",
    "2026-02-29T09:25:30Z",
    "2028-02-29T09:25:30Z",
    "0050-10-07T09:25:30Z",
    "9999-12-31T23:59:59Z",
    "+002026-10-07T09:25:30Z",
  ];
  bunTest.each(cases)("%s → same accept/reject verdict on both sides", async (timestamp) => {
    const base = (await makeSubmission("success")).proof;
    const sub = await signRaw({ ...base, timestamp });
    const backend = verifyProofSubmission({ proof: sub.proof, signature: sub.signature }, backendCtx());
    const workflow = evaluateSettlement(input(sub));
    expect(workflow.decision === "ACCEPT").toBe(backend.outcome === "accepted");
    if (backend.outcome === "accepted") expect(workflow.passed).toBe(backend.passed);
  });

  // BUG (info): parseIsoMillis uses Date.UTC(year, …), which maps years 0-99 to 1900-1999, so
  // "0050-…" parses as 1950 instead of year 50 (policy.ts parseIsoMillis). Verdicts still agree (both are
  // stale against a 2026 task), so no money impact; fix with `const d = new Date(0); d.setUTCFullYear(y, mo, day)`.
  bunTest.skip("parseIsoMillis matches Date.parse for years 0000-0099", () => {
    expect(parseIsoMillis("0050-10-07T09:25:30Z")).toBe(Date.parse("0050-10-07T09:25:30Z"));
  });
});

// ─── Handler-level races around the on-chain write ───────────────────────────────────────────────

interface Bench {
  chain: { task: OnchainTask; specHash: string };
  writes: SettlementReport[];
  callbacks: Array<Record<string, unknown>>;
}

/** Minimal capability mocks; `onWrite` lets a test play what happens on-chain during the write. */
function bench(opts: {
  evidenceText: string;
  onWrite?: (b: Bench, report: SettlementReport) => { receiverReverted?: boolean } | undefined;
}): Bench {
  const b: Bench = { chain: fundedOnchain(), writes: [], callbacks: [] };
  const http = HttpActionsMock.testInstance();
  http.sendRequest = (req) => {
    if (req.method === "GET" && req.url === EVIDENCE_URL) return { statusCode: 200, body: b64(opts.evidenceText) };
    if (req.method === "POST" && req.url === RESULT_URL) {
      b.callbacks.push(JSON.parse(new TextDecoder().decode(req.body)));
      return { statusCode: 200, body: b64("{}") };
    }
    throw new Error(`unexpected HTTP ${req.method} ${req.url}`);
  };
  const evm = EvmMock.testInstance(ANVIL_SELECTOR);
  const escrow = addContractMock(evm, { address: CONFIG.escrowAddress as Hex, abi: ESCROW_ABI });
  escrow.getTask = () => b.chain.task;
  escrow.taskSpecHash = () => b.chain.specHash;
  escrow.proofHashUsed = () => false;
  escrow.writeReport = (req) => {
    const report = decodeSettlementReport(bytesToHex(req.report.rawReport.slice(REPORT_METADATA_HEADER_LENGTH)));
    b.writes.push(report);
    const { receiverReverted } = opts.onWrite?.(b, report) ?? {};
    return {
      txStatus: "TX_STATUS_SUCCESS",
      txHash: hexToB64(TX_HASH),
      ...(receiverReverted ? { receiverContractExecutionStatus: "RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED" as const } : {}),
    };
  };
  return b;
}

const trigger = (taskId: string, proofHash: string): HTTPPayload =>
  ({ input: new TextEncoder().encode(JSON.stringify({ task_id: taskId, proof_hash: proofHash })) }) as unknown as HTTPPayload;
const runHandler = (payload: HTTPPayload) => onSettlementTrigger(newTestRuntime<Config>(null, {}, CONFIG), payload);

describe("onSettlementTrigger — races and unauthenticated triggers", () => {
  creTest("uppercase-hex proof_hash in the trigger is the same proof: SETTLED (no false REJECT)", async () => {
    const sub = await makeSubmission("success");
    const b = bench({ evidenceText: JSON.stringify(makeEvidence(sub)), onWrite: (x, r) => void (x.chain = { ...x.chain, task: { ...x.chain.task, status: 4, proofHash: r.proofHash } }) });
    const result = runHandler(trigger(SPEC.task_id, `0x${sub.proof_hash.slice(2).toUpperCase()}`));
    expect(result.decision).toBe("SETTLED");
    expect(b.writes[0].proofHash).toBe(sub.proof_hash as Hex);
  });

  creTest("an outsider fires the (unauthenticated, simulation-only) trigger with a wrong proof hash: REJECTED, the callback carries THAT hash (the backend ignores it), nothing written", async () => {
    const sub = await makeSubmission("success");
    const wrong = `0x${"ab".repeat(32)}`;
    const b = bench({ evidenceText: JSON.stringify(makeEvidence(sub)) });
    const result = runHandler(trigger(SPEC.task_id, wrong));
    expect(result.decision).toBe("REJECTED");
    expect(b.writes).toHaveLength(0);
    expect(b.callbacks[0]).toMatchObject({ decision: "REJECTED", proof_hash: wrong });
  });

  creTest("an attacker settles the OPPOSITE verdict between the workflow's read and its write: the workflow throws (no false SETTLED callback)", async () => {
    const sub = await makeSubmission("success");
    const b = bench({
      evidenceText: JSON.stringify(makeEvidence(sub)),
      // front-run: refunded with the same proof hash; our report then reverts inside onReport (swallowed)
      onWrite: (x) => void (x.chain = { ...x.chain, task: { ...x.chain.task, status: 5, proofHash: sub.proof_hash } }),
    });
    expect(() => runHandler(trigger(SPEC.task_id, sub.proof_hash))).toThrow(/escrow shows status Refunded/);
    expect(b.callbacks).toHaveLength(0);
  });

  creTest("(known limitation) an attacker settles the SAME verdict first: the workflow reports SETTLED with ITS OWN tx hash although its onReport reverted (unless the reply flags the receiver revert)", async () => {
    const sub = await makeSubmission("success");
    const frontRun = (x: Bench) => void (x.chain = { ...x.chain, task: { ...x.chain.task, status: 4, proofHash: sub.proof_hash } });
    const b = bench({ evidenceText: JSON.stringify(makeEvidence(sub)), onWrite: (x) => frontRun(x) });
    const result = runHandler(trigger(SPEC.task_id, sub.proof_hash));
    expect(result.decision).toBe("SETTLED");
    expect(result.tx_hash).toBe(TX_HASH); // not the transaction that actually settled
    expect(b.callbacks[0]).toMatchObject({ decision: "SETTLED", tx_hash: TX_HASH });

    // When the write reply carries receiver_contract_execution_status=REVERTED the workflow refuses instead.
    bench({ evidenceText: JSON.stringify(makeEvidence(sub)), onWrite: (x) => (frontRun(x), { receiverReverted: true }) });
    expect(() => runHandler(trigger(SPEC.task_id, sub.proof_hash))).toThrow(/receiver reverted/);
  });

  creTest("evidence with own `__proto__` keys served as raw JSON text: SETTLED with the robot-signed hash", async () => {
    const base = (await makeSubmission("success")).proof;
    const proof = JSON.parse(JSON.stringify(base).slice(0, -1) + ',"__proto__":{"success":false}}') as Record<string, unknown>;
    const sub = await signRaw(proof);
    const b = bench({
      evidenceText: JSON.stringify(makeEvidence(sub)),
      onWrite: (x, r) => void (x.chain = { ...x.chain, task: { ...x.chain.task, status: r.passed ? 4 : 5, proofHash: r.proofHash } }),
    });
    const result = runHandler(trigger(SPEC.task_id, sub.proof_hash));
    expect(result.decision).toBe("SETTLED");
    expect(b.writes[0]).toMatchObject({ proofHash: computeProofHash(proof), passed: true, taskId: onchainTaskIdOf(SPEC.task_id) });
  });
});
