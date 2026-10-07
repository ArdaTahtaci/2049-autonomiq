/**
 * Drives the real workflow handler through the CRE SDK test runtime: HTTP (evidence + callback),
 * EVM reads (getTask / taskSpecHash), consensus, report signing and writeReport are all mocked
 * at the capability boundary. No network, no login, no WASM.
 */
import { describe, expect } from "bun:test";
import { type HTTPPayload, TxStatus, Value, bytesToHex } from "@chainlink/cre-sdk";
import {
  EvmMock,
  HttpActionsMock,
  REPORT_METADATA_HEADER_LENGTH,
  addContractMock,
  newTestRuntime,
  test,
} from "@chainlink/cre-sdk/test";
import type { Hex } from "viem";
import { ESCROW_ABI, type SettlementReport, decodeSettlementReport } from "./abi";
import configJson from "./config.local.json";
import type { OnchainTask } from "./policy";
import {
  IMPOSTOR_KEY,
  ONE_ETH,
  SPEC,
  type Submission,
  type TaskSpec,
  clone,
  fundedOnchain,
  makeEvidence,
  makeSubmission,
  onchainTaskIdOf,
} from "./test-fixtures";
import { type Config, type WorkflowResult, configSchema, initWorkflow, onSettlementTrigger } from "./workflow";

const CONFIG: Config = configSchema.parse(configJson);
const ANVIL_SELECTOR = 7759470850252068959n;
const TX_HASH = `0x${"7e".repeat(32)}`;
const EVIDENCE_URL = `${CONFIG.backendUrl}/cre/tasks/${SPEC.task_id}/evidence`;
const RESULT_URL = `${CONFIG.backendUrl}/cre/tasks/${SPEC.task_id}/result`;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const hexToB64 = (h: string) => Buffer.from(h.slice(2), "hex").toString("base64");

interface MockOptions {
  evidence?: unknown;
  evidenceStatus?: number;
  onchain?: { task: OnchainTask; specHash: string };
  /** Escrow applies the report on write (false = receiver reverted, swallowed by the forwarder). */
  applyWrite?: boolean;
  writeStatus?: "TX_STATUS_SUCCESS" | "TX_STATUS_REVERTED" | "TX_STATUS_FATAL";
  txHash?: string | null;
  callbackStatus?: number;
  callbackThrows?: boolean;
  /** Proof hashes the escrow reports as already committed (proofHashUsed). */
  usedProofHashes?: string[];
}

interface Recorded {
  evidenceGets: number;
  callbacks: Array<Record<string, unknown>>;
  writes: SettlementReport[];
  gasLimits: bigint[];
  receivers: string[];
  chain: { task: OnchainTask; specHash: string };
}

/** Installs HTTP + EVM mocks; the escrow mock is stateful (writeReport settles/refunds). */
function installMocks(opts: MockOptions): Recorded {
  const rec: Recorded = {
    evidenceGets: 0,
    callbacks: [],
    writes: [],
    gasLimits: [],
    receivers: [],
    chain: opts.onchain ?? fundedOnchain(),
  };

  const http = HttpActionsMock.testInstance();
  http.sendRequest = (req) => {
    if (req.method === "GET" && req.url === EVIDENCE_URL) {
      rec.evidenceGets++;
      const status = opts.evidenceStatus ?? 200;
      const body = status === 200 ? JSON.stringify(opts.evidence) : JSON.stringify({ error: "Task has no proof" });
      return { statusCode: status, body: b64(body) };
    }
    if (req.method === "POST" && req.url === RESULT_URL) {
      expect(req.headers["Content-Type"]).toBe("application/json");
      rec.callbacks.push(JSON.parse(new TextDecoder().decode(req.body)));
      if (opts.callbackThrows) throw new Error("connect ECONNREFUSED 127.0.0.1:3100");
      return { statusCode: opts.callbackStatus ?? 200, body: b64("{}") };
    }
    throw new Error(`unexpected HTTP ${req.method} ${req.url}`);
  };

  const evm = EvmMock.testInstance(ANVIL_SELECTOR);
  const escrow = addContractMock(evm, { address: CONFIG.escrowAddress as Hex, abi: ESCROW_ABI });
  escrow.getTask = (taskId: unknown) => {
    expect(taskId).toBe(onchainTaskIdOf(SPEC.task_id));
    return rec.chain.task;
  };
  escrow.taskSpecHash = () => rec.chain.specHash;
  escrow.proofHashUsed = (hash: unknown) => (opts.usedProofHashes ?? []).includes(String(hash).toLowerCase());
  escrow.writeReport = (input) => {
    const payload = bytesToHex(input.report.rawReport.slice(REPORT_METADATA_HEADER_LENGTH));
    const report = decodeSettlementReport(payload);
    rec.writes.push(report);
    rec.gasLimits.push(input.gasConfig.gasLimit);
    rec.receivers.push(bytesToHex(input.receiver));
    const status = opts.writeStatus ?? "TX_STATUS_SUCCESS";
    if (status === "TX_STATUS_SUCCESS" && (opts.applyWrite ?? true)) {
      rec.chain = {
        ...rec.chain,
        task: { ...rec.chain.task, proofHash: report.proofHash, status: report.passed ? 4 : 5 },
      };
    }
    const txHash = opts.txHash === undefined ? TX_HASH : opts.txHash;
    return {
      txStatus: status,
      ...(txHash ? { txHash: hexToB64(txHash) } : {}),
      ...(status === "TX_STATUS_SUCCESS" ? {} : { errorMessage: "execution reverted" }),
    };
  };
  return rec;
}

const payloadOf = (body: unknown): HTTPPayload =>
  ({ input: new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)) }) as unknown as HTTPPayload;

const triggerFor = (sub: Submission, taskId = SPEC.task_id) => payloadOf({ task_id: taskId, proof_hash: sub.proof_hash });

function run(payload: HTTPPayload) {
  const runtime = newTestRuntime<Config>(null, {}, CONFIG);
  const result = onSettlementTrigger(runtime, payload);
  return { result, logs: runtime.getLogs() };
}

/** CRE wraps the handler result in a protobuf Value: null/undefined anywhere would throw. */
const expectSerializable = (r: WorkflowResult) => expect(() => Value.from(r)).not.toThrow();

describe("onSettlementTrigger — settlement paths", () => {
  test("successful robot task -> SETTLED: report (taskId, proofHash, true, robotSig) written and confirmed", async () => {
    const sub = await makeSubmission("success");
    const rec = installMocks({ evidence: makeEvidence(sub) });
    const { result, logs } = run(triggerFor(sub));

    expect(result.decision).toBe("SETTLED");
    expect(result.passed).toBe(true);
    expect(result.tx_hash).toBe(TX_HASH);
    expect(result.onchain_status).toBe("Settled");
    expect(result.proof_hash).toBe(sub.proof_hash);
    expect(result.checks.every((c) => c.ok)).toBe(true);
    expectSerializable(result);

    expect(rec.writes).toEqual([
      { taskId: onchainTaskIdOf(SPEC.task_id), proofHash: sub.proof_hash as Hex, passed: true, robotSignature: sub.signature as Hex },
    ]);
    expect(rec.gasLimits).toEqual([800000n]);
    expect(rec.receivers).toEqual([CONFIG.escrowAddress.toLowerCase()]);
    expect(rec.chain.task.status).toBe(4);

    expect(rec.callbacks).toHaveLength(1);
    expect(rec.callbacks[0]).toMatchObject({
      decision: "SETTLED",
      proof_hash: sub.proof_hash,
      passed: true,
      tx_hash: TX_HASH,
      onchain_status: "Settled",
      workflow: "machineproof-settlement",
      reasons: [],
    });
    expect((rec.callbacks[0].checks as unknown[]).length).toBe(11);

    for (let i = 1; i <= 8; i++) expect(logs.some((l) => l.startsWith(`[${i}/8]`))).toBe(true);
    expect(logs.join("\n")).toContain("Confirmed on-chain: task Settled");
  });

  test("false success claim -> REFUNDED: report passed=false, requester refunded", async () => {
    const sub = await makeSubmission("false_success");
    const rec = installMocks({ evidence: makeEvidence(sub) });
    const { result, logs } = run(triggerFor(sub));

    expect(result.decision).toBe("REFUNDED");
    expect(result.passed).toBe(false);
    expect(result.onchain_status).toBe("Refunded");
    expect(result.reasons[0]).toMatch(/robot claimed success but object placed/);
    expect(rec.writes).toHaveLength(1);
    expect(rec.writes[0].passed).toBe(false);
    expect(rec.writes[0].proofHash).toBe(sub.proof_hash as Hex);
    expect(rec.callbacks[0]).toMatchObject({ decision: "REFUNDED", passed: false, tx_hash: TX_HASH });
    expect(logs.join("\n")).toContain("task FAILED");
    expectSerializable(result);
  });

  test("honest robot failure -> REFUNDED", async () => {
    const sub = await makeSubmission("failure");
    const rec = installMocks({ evidence: makeEvidence(sub) });
    expect(run(triggerFor(sub)).result.decision).toBe("REFUNDED");
    expect(rec.writes[0].passed).toBe(false);
  });

  test("trigger body wrapped as {input: {...}} (gateway-style) is accepted", async () => {
    const sub = await makeSubmission("success");
    installMocks({ evidence: makeEvidence(sub) });
    const { result } = run(payloadOf({ input: { task_id: SPEC.task_id, proof_hash: sub.proof_hash } }));
    expect(result.decision).toBe("SETTLED");
  });
});

describe("onSettlementTrigger — adversarial evidence is never written on-chain", () => {
  test("tampered proof served by the backend -> REJECTED, writeReport not called", async () => {
    const sub = await makeSubmission("false_success");
    const tampered = clone(sub);
    tampered.proof.final_object_position = { ...SPEC.target_position }; // "fix" the miss after signing
    const rec = installMocks({ evidence: makeEvidence(tampered) });
    const { result, logs } = run(triggerFor(sub));

    expect(result.decision).toBe("REJECTED");
    expect(result.passed).toBe(false);
    expect(result.tx_hash).toBe("");
    expect(rec.writes).toHaveLength(0);
    expect(rec.chain.task.status).toBe(1);
    expect(result.reasons.some((r) => r.startsWith("trigger_binding:"))).toBe(true);
    expect(result.reasons.some((r) => r.startsWith("signature:"))).toBe(true);
    expect(rec.callbacks[0]).toMatchObject({ decision: "REJECTED", passed: null, tx_hash: null, proof_hash: sub.proof_hash });
    expect(logs.join("\n")).toContain("nothing is written on-chain");
    expectSerializable(result);
  });

  test("trigger proof_hash does not match the evidence -> REJECTED", async () => {
    const sub = await makeSubmission("success");
    const rec = installMocks({ evidence: makeEvidence(sub) });
    const { result } = run(payloadOf({ task_id: SPEC.task_id, proof_hash: `0x${"11".repeat(32)}` }));
    expect(result.decision).toBe("REJECTED");
    expect(result.checks.find((c) => c.name === "trigger_binding")?.ok).toBe(false);
    expect(rec.writes).toHaveLength(0);
  });

  test("proof signed by a key that is not the on-chain robot -> REJECTED", async () => {
    const sub = await makeSubmission("success", { key: IMPOSTOR_KEY });
    const rec = installMocks({ evidence: makeEvidence(sub) });
    const { result } = run(triggerFor(sub));
    expect(result.decision).toBe("REJECTED");
    expect(result.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["signature"]);
    expect(rec.writes).toHaveLength(0);
  });

  test("proof hash already committed on-chain (robot signature replayed onto another task) -> REJECTED, no write", async () => {
    const sub = await makeSubmission("success");
    const rec = installMocks({ evidence: makeEvidence(sub), usedProofHashes: [sub.proof_hash.toLowerCase()] });
    const { result } = run(triggerFor(sub));
    expect(result.decision).toBe("REJECTED");
    expect(result.reasons.join(" ")).toMatch(/proof_reuse/);
    expect(rec.writes).toHaveLength(0);
    expect(rec.callbacks[0]).toMatchObject({ decision: "REJECTED", proof_hash: sub.proof_hash });
  });

  test("backend altered the task spec (target_position) after funding -> REJECTED by the on-chain anchor", async () => {
    const sub = await makeSubmission("success");
    const altered: TaskSpec = { ...SPEC, target_position: { x: 3, y: 0, z: 0 } };
    const rec = installMocks({ evidence: makeEvidence(sub, altered) });
    const { result } = run(triggerFor(sub));
    expect(result.decision).toBe("REJECTED");
    expect(result.checks.find((c) => c.name === "spec_anchor")?.ok).toBe(false);
    expect(rec.writes).toHaveLength(0);
  });

  test("backend loosened the tolerance to pay out a failed placement -> REJECTED", async () => {
    const sub = await makeSubmission("false_success");
    const rec = installMocks({ evidence: makeEvidence(sub, { ...SPEC, tolerance: 10 }) });
    const { result } = run(triggerFor(sub));
    expect(result.decision).toBe("REJECTED");
    expect(result.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["spec_anchor"]);
    expect(rec.writes).toHaveLength(0);
  });

  test("evidence unavailable (HTTP 404) -> REJECTED, chain never touched by a write", async () => {
    const sub = await makeSubmission("success");
    const rec = installMocks({ evidenceStatus: 404 });
    const { result } = run(triggerFor(sub));
    expect(result.decision).toBe("REJECTED");
    expect(result.reasons[0]).toMatch(/evidence unavailable: .* HTTP 404/);
    expect(rec.writes).toHaveLength(0);
    expect(rec.callbacks[0]).toMatchObject({ decision: "REJECTED" });
  });

  test("malformed trigger input -> REJECTED without any HTTP or chain call", async () => {
    for (const body of ["not json", { task_id: "../etc/passwd", proof_hash: `0x${"00".repeat(32)}` }, { task_id: SPEC.task_id, proof_hash: "0x1234" }, [1, 2]]) {
      const rec = installMocks({});
      const { result, logs } = run(payloadOf(body));
      expect(result.decision).toBe("REJECTED");
      expect(rec.evidenceGets).toBe(0);
      expect(rec.callbacks).toHaveLength(0);
      expect(rec.writes).toHaveLength(0);
      expect(logs[0]).toMatch(/^\[1\/8\] Trigger rejected/);
      expectSerializable(result);
    }
  });
});

describe("onSettlementTrigger — on-chain state is the source of truth", () => {
  test("task already Settled on-chain (duplicate trigger) -> SKIPPED, no write", async () => {
    const sub = await makeSubmission("success");
    const onchain = fundedOnchain();
    onchain.task = { ...onchain.task, status: 4, proofHash: sub.proof_hash };
    const rec = installMocks({ evidence: makeEvidence(sub), onchain });
    const { result } = run(triggerFor(sub));
    expect(result.decision).toBe("SKIPPED");
    expect(result.onchain_status).toBe("Settled");
    expect(result.reasons[0]).toMatch(/already Settled on-chain — duplicate trigger ignored/);
    expect(rec.writes).toHaveLength(0);
    expect(rec.callbacks[0]).toMatchObject({ decision: "SKIPPED", onchain_status: "Settled", passed: null });
  });

  test("replaying the same trigger twice settles exactly once", async () => {
    const sub = await makeSubmission("success");
    const rec = installMocks({ evidence: makeEvidence(sub) });
    expect(run(triggerFor(sub)).result.decision).toBe("SETTLED");
    expect(run(triggerFor(sub)).result.decision).toBe("SKIPPED");
    expect(rec.writes).toHaveLength(1);
  });

  test("task not funded on-chain (status None) -> SKIPPED", async () => {
    const sub = await makeSubmission("success");
    const onchain = fundedOnchain();
    onchain.task = { ...onchain.task, status: 0, amount: 0n, robot: "0x0000000000000000000000000000000000000000" };
    const rec = installMocks({ evidence: makeEvidence(sub), onchain });
    const { result } = run(triggerFor(sub));
    expect(result.decision).toBe("SKIPPED");
    expect(result.reasons[0]).toMatch(/None on-chain \(expected Funded\)/);
    expect(rec.writes).toHaveLength(0);
  });

  test("write reports SUCCESS but the escrow did not change (receiver reverted inside the forwarder) -> throws", async () => {
    const sub = await makeSubmission("success");
    const rec = installMocks({ evidence: makeEvidence(sub), applyWrite: false });
    expect(() => run(triggerFor(sub))).toThrow(/escrow shows status Funded .*onReport rejected the report/);
    expect(rec.writes).toHaveLength(1);
    expect(rec.callbacks).toHaveLength(0);
  });

  test("writeReport tx REVERTED -> throws with the error message", async () => {
    const sub = await makeSubmission("success");
    installMocks({ evidence: makeEvidence(sub), writeStatus: "TX_STATUS_REVERTED" });
    expect(() => run(triggerFor(sub))).toThrow(/writeReport failed: REVERTED execution reverted/);
  });

  test("simulate without --broadcast (no tx hash) -> DRY_RUN, no callback", async () => {
    const sub = await makeSubmission("success");
    const rec = installMocks({ evidence: makeEvidence(sub), txHash: null, applyWrite: false });
    const { result, logs } = run(triggerFor(sub));
    expect(result.decision).toBe("DRY_RUN");
    expect(result.passed).toBe(true);
    expect(rec.callbacks).toHaveLength(0);
    expect(logs.join("\n")).toContain("--broadcast");
    expectSerializable(result);
  });
});

describe("onSettlementTrigger — result callback is best-effort", () => {
  test("callback answered with HTTP 500 -> still SETTLED", async () => {
    const sub = await makeSubmission("success");
    installMocks({ evidence: makeEvidence(sub), callbackStatus: 500 });
    const { result, logs } = run(triggerFor(sub));
    expect(result.decision).toBe("SETTLED");
    expect(logs.join("\n")).toContain("HTTP 500 (ignored)");
  });

  test("callback transport error -> still SETTLED", async () => {
    const sub = await makeSubmission("success");
    const rec = installMocks({ evidence: makeEvidence(sub), callbackThrows: true });
    const { result, logs } = run(triggerFor(sub));
    expect(result.decision).toBe("SETTLED");
    expect(rec.callbacks).toHaveLength(1);
    expect(logs.join("\n")).toMatch(/\[8\/8\] Backend notified of SETTLED: failed .*ignored/);
  });

  test("oversized reasons/details are clipped to the backend's limits", async () => {
    const sub = await makeSubmission("success");
    const long = "x".repeat(2000);
    const rec = installMocks({ evidence: makeEvidence(sub, { ...SPEC, robot_id: `robot_${long}`.slice(0, 128) }) });
    run(triggerFor(sub));
    const cb = rec.callbacks[0] as { checks: Array<{ detail: string }>; reasons: string[] };
    expect(cb.checks.every((c) => c.detail.length <= 500)).toBe(true);
    expect(cb.reasons.every((r) => r.length <= 500)).toBe(true);
  });
});

describe("wiring", () => {
  test("config.local.json is valid", () => {
    expect(CONFIG.chainSelectorName).toBe("anvil-devnet");
    expect(CONFIG.authorizedTriggerKeys).toEqual([]);
  });

  test("initWorkflow: one HTTP-trigger handler; authorizedKeys only when configured", () => {
    const authorizedKeys = (handlers: ReturnType<typeof initWorkflow>) =>
      (handlers[0].trigger as unknown as { config: { authorizedKeys: unknown[] } }).config.authorizedKeys;
    const open = initWorkflow(CONFIG);
    expect(open).toHaveLength(1);
    expect(authorizedKeys(open)).toEqual([]);
    const key = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
    const locked = initWorkflow({ ...CONFIG, authorizedTriggerKeys: [key] });
    // Stored as a protobuf message: KeyType.KEY_TYPE_ECDSA_EVM = 1.
    expect(authorizedKeys(locked)).toEqual([expect.objectContaining({ type: 1, publicKey: key })]);
  });

  test("amount is reported in ETH in the logs", async () => {
    const sub = await makeSubmission("success");
    installMocks({ evidence: makeEvidence(sub), onchain: { ...fundedOnchain(), task: { ...fundedOnchain().task, amount: ONE_ETH / 4n } } });
    const { logs } = run(triggerFor(sub));
    expect(logs.join("\n")).toContain("0.25 ETH");
  });
});

// Keep TxStatus import meaningful for readers: the SDK enum the workflow compares against.
test("TxStatus.SUCCESS is the enum value writeReport mocks map 'TX_STATUS_SUCCESS' to", () => {
  expect(TxStatus.SUCCESS).toBe(2);
});
