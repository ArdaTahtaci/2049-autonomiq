/**
 * MachineProof settlement — Chainlink CRE workflow logic (entry point: main.ts).
 *
 * CRE is the orchestration layer between verified machine execution and autonomous on-chain
 * settlement:
 *
 *   robot proof -> backend (pre-screens, stores) -> HTTP trigger -> THIS WORKFLOW
 *     1. decode trigger {task_id, proof_hash}
 *     2. fetch evidence (task spec + robot-signed proof) from the backend      [HTTP, node mode + consensus]
 *     3. read the escrow on-chain: status, robot identity, anchored spec hash  [EVM read]
 *     4. verify independently (policy.ts): proof hash, task binding, spec anchor,
 *        robot signature vs ON-CHAIN robot, geometry, freshness, measured placement
 *     5. REJECT -> nothing is written on-chain
 *     6. ACCEPT -> DON-signed report abi.encode(taskId, proofHash, passed, robotSignature)
 *        -> forwarder -> MachineTaskEscrow.onReport (commit + settle / refund atomically)
 *     7. read the chain back (the forwarder swallows receiver reverts, so tx SUCCESS != settled)
 *     8. best-effort result callback to the backend
 *
 * The backend is never trusted for money-relevant facts: robot identity and the task spec come
 * from the chain, the verdict is recomputed here from the raw proof.
 */
import {
  bytesToHex,
  consensusIdenticalAggregation,
  decodeJson,
  EVMClient,
  encodeCallMsg,
  getNetwork,
  HTTPCapability,
  HTTPClient,
  type HTTPPayload,
  type HTTPSendRequester,
  handler,
  LATEST_BLOCK_NUMBER,
  prepareReportRequest,
  type Runtime,
  TxStatus,
  text,
} from "@chainlink/cre-sdk";
import { type Address, decodeFunctionResult, encodeFunctionData, formatEther, type Hex, zeroAddress } from "viem";
import { z } from "zod";
import { ESCROW_ABI, STATUS_FUNDED, STATUS_REFUNDED, STATUS_SETTLED, encodeSettlementReport, statusName } from "./abi";
import {
  type OnchainTask,
  type PolicyCheck,
  type TriggerInput,
  TASK_ID_PATTERN,
  evaluateSettlement,
  isHash32,
  onchainTaskIdOf,
} from "./policy";

export const WORKFLOW_NAME = "machineproof-settlement";
const TOTAL_STEPS = 8;
/** EVM_PB.ReceiverContractExecutionStatus.REVERTED (not re-exported from the SDK root). */
const RECEIVER_EXECUTION_REVERTED = 1;

// ─── Config ───────────────────────────────────────────────────────────────────────────────────

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address");

export const configSchema = z.object({
  /** Backend base URL (evidence + result callback). Regex, not z.url(): bare QuickJS has no URL global (the SDK polyfills it). */
  backendUrl: z.string().regex(/^https?:\/\/\S+$/, "must be an http(s) URL"),
  /** chain-selectors name, e.g. "anvil-devnet" (local Hardhat, chainId 31337) or "ethereum-testnet-sepolia". */
  chainSelectorName: z.string().min(1),
  escrowAddress: address,
  gasLimit: z.string().regex(/^[1-9]\d*$/, "must be a positive integer string"),
  proofClockSkewSeconds: z.number().int().min(0).max(86_400),
  requireSpecAnchor: z.boolean(),
  /** EVM addresses allowed to fire the HTTP trigger. Empty = no auth (valid ONLY in `cre workflow simulate`). */
  authorizedTriggerKeys: z.array(address),
});

export type Config = z.infer<typeof configSchema>;

// ─── Result types ─────────────────────────────────────────────────────────────────────────────

/** DRY_RUN: simulator ran without --broadcast — the report passed eth_call but nothing was mined. */
export type Decision = "SETTLED" | "REFUNDED" | "REJECTED" | "SKIPPED" | "DRY_RUN";

/**
 * Handler return value. CRE wraps it in a protobuf Value, which cannot hold null/undefined, so
 * absent values are "" (tx_hash, proof_hash) and `passed` is false unless the task settled.
 */
export type WorkflowResult = {
  workflow: string;
  decision: Decision;
  task_id: string;
  proof_hash: string;
  passed: boolean;
  tx_hash: string;
  onchain_status: string;
  reasons: string[];
  checks: PolicyCheck[];
};

/** Body of POST {backendUrl}/cre/tasks/{task_id}/result (limits mirror the backend's zod schema). */
type CallbackBody = {
  decision: Exclude<Decision, "DRY_RUN">;
  proof_hash?: string;
  passed: boolean | null;
  reasons: string[];
  checks: PolicyCheck[];
  tx_hash: string | null;
  onchain_status?: string;
  workflow: string;
};

type HttpResult = { statusCode: number; body: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────────────────────

const clip = (s: string, max = 500): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
/** CRE caps log lines at 1 kB (`LogLineLimit`). */
const logLine = (runtime: Runtime<Config>, msg: string): void => runtime.log(clip(msg, 900));
const step = (runtime: Runtime<Config>, n: number, msg: string): void => logLine(runtime, `[${n}/${TOTAL_STEPS}] ${msg}`);
const shortHex = (h: string): string => (h.length > 18 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h);
const baseUrl = (config: Config): string => config.backendUrl.replace(/\/+$/, "");
const encodeBody = (value: unknown): string => Buffer.from(new TextEncoder().encode(JSON.stringify(value))).toString("base64");

/** Accepts {task_id, proof_hash} or {input: {task_id, proof_hash}} (raw gateway-style body). */
export function parseTriggerInput(raw: Uint8Array): { ok: true; trigger: TriggerInput } | { ok: false; reason: string } {
  let body: unknown;
  try {
    body = decodeJson(raw);
  } catch {
    return { ok: false, reason: "trigger payload is not valid JSON" };
  }
  if (typeof body === "object" && body !== null && !("task_id" in body) && "input" in body) {
    body = (body as { input: unknown }).input;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, reason: "trigger payload must be a JSON object {task_id, proof_hash}" };
  }
  const { task_id, proof_hash } = body as Record<string, unknown>;
  if (typeof task_id !== "string" || !TASK_ID_PATTERN.test(task_id)) {
    return { ok: false, reason: "trigger task_id must match /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/" };
  }
  if (!isHash32(proof_hash)) {
    return { ok: false, reason: "trigger proof_hash must be 0x-prefixed 32-byte hex" };
  }
  return { ok: true, trigger: { task_id, proof_hash } };
}

// Node-mode HTTP functions: every DON node runs them, consensus requires identical results.
const fetchEvidence = (sendRequester: HTTPSendRequester, url: string): HttpResult => {
  const resp = sendRequester.sendRequest({ url, method: "GET", headers: { Accept: "application/json" } }).result();
  return { statusCode: resp.statusCode, body: text(resp) };
};

const postJson = (sendRequester: HTTPSendRequester, url: string, bodyBase64: string): number => {
  const resp = sendRequester
    .sendRequest({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyBase64, // RequestJson bytes fields are base64
      // In a multi-node DON one node sends, the others reuse its cached response (no duplicate POSTs).
      cacheSettings: { store: true, maxAge: "60s" },
    })
    .result();
  return resp.statusCode;
};

function readEscrow(
  runtime: Runtime<Config>,
  evm: EVMClient,
  escrow: Address,
  taskKey: Hex,
): { task: OnchainTask; specHash: Hex } {
  // LATEST block: the local Hardhat chain automines. Production should read at a finalized/safe
  // block (LAST_FINALIZED_BLOCK_NUMBER) so a reorg cannot change what the verdict is based on.
  const call = (data: Hex) =>
    evm.callContract(runtime, {
      call: encodeCallMsg({ from: zeroAddress, to: escrow, data }),
      blockNumber: LATEST_BLOCK_NUMBER,
    });
  // Fire both reads before awaiting either.
  const taskCall = call(encodeFunctionData({ abi: ESCROW_ABI, functionName: "getTask", args: [taskKey] }));
  const specCall = call(encodeFunctionData({ abi: ESCROW_ABI, functionName: "taskSpecHash", args: [taskKey] }));
  const taskData = bytesToHex(taskCall.result().data);
  const specData = bytesToHex(specCall.result().data);
  if (taskData === "0x" || specData === "0x") {
    throw new Error(`no MachineTaskEscrow at ${escrow} on ${runtime.config.chainSelectorName} (empty call result)`);
  }
  const t = decodeFunctionResult({ abi: ESCROW_ABI, functionName: "getTask", data: taskData });
  const specHash = decodeFunctionResult({ abi: ESCROW_ABI, functionName: "taskSpecHash", data: specData });
  return {
    task: {
      requester: t.requester,
      robot: t.robot,
      payee: t.payee,
      amount: t.amount,
      proofHash: t.proofHash,
      status: Number(t.status),
    },
    specHash,
  };
}

function proofHashUsedOnchain(runtime: Runtime<Config>, evm: EVMClient, escrow: Address, proofHash: Hex): boolean {
  const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: "proofHashUsed", args: [proofHash] });
  const reply = evm
    .callContract(runtime, { call: encodeCallMsg({ from: zeroAddress, to: escrow, data }), blockNumber: LATEST_BLOCK_NUMBER })
    .result();
  return decodeFunctionResult({ abi: ESCROW_ABI, functionName: "proofHashUsed", data: bytesToHex(reply.data) });
}

function notifyBackend(runtime: Runtime<Config>, taskId: string, body: CallbackBody): string {
  const url = `${baseUrl(runtime.config)}/cre/tasks/${encodeURIComponent(taskId)}/result`;
  const safeBody: CallbackBody = {
    ...body,
    reasons: body.reasons.slice(0, 50).map((r) => clip(r)),
    checks: body.checks.slice(0, 30).map((c) => ({ name: c.name, ok: c.ok, detail: clip(c.detail) })),
  };
  try {
    const status = new HTTPClient()
      .sendRequest(runtime, postJson, consensusIdenticalAggregation<number>())(url, encodeBody(safeBody))
      .result();
    return status >= 200 && status < 300 ? `HTTP ${status}` : `HTTP ${status} (ignored)`;
  } catch (e) {
    // Informational only: settlement state lives on-chain, a failed callback must not fail the run.
    return `failed (${e instanceof Error ? e.message : String(e)}) — ignored`;
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────────────────────

export const onSettlementTrigger = (runtime: Runtime<Config>, payload: HTTPPayload): WorkflowResult => {
  const config = runtime.config;

  // [1/8] trigger
  const parsedTrigger = parseTriggerInput(payload.input);
  if (!parsedTrigger.ok) {
    step(runtime, 1, `Trigger rejected: ${parsedTrigger.reason}`);
    // No callback: a malformed trigger says nothing about any task's proof.
    return {
      workflow: WORKFLOW_NAME,
      decision: "REJECTED",
      task_id: "",
      proof_hash: "",
      passed: false,
      tx_hash: "",
      onchain_status: "",
      reasons: [parsedTrigger.reason],
      checks: [],
    };
  }
  const trigger = parsedTrigger.trigger;
  const taskKey = onchainTaskIdOf(trigger.task_id);
  step(runtime, 1, `Trigger: settle task ${trigger.task_id} with proof ${shortHex(trigger.proof_hash)}`);

  const finish = (
    decision: Exclude<Decision, "DRY_RUN">,
    fields: { passed: boolean | null; reasons: string[]; checks: PolicyCheck[]; tx_hash: string | null; onchain_status: string },
  ): WorkflowResult => {
    const outcome = notifyBackend(runtime, trigger.task_id, {
      decision,
      proof_hash: trigger.proof_hash,
      passed: fields.passed,
      reasons: fields.reasons,
      checks: fields.checks,
      tx_hash: fields.tx_hash,
      onchain_status: fields.onchain_status || undefined,
      workflow: WORKFLOW_NAME,
    });
    step(runtime, 8, `Backend notified of ${decision}: ${outcome}`);
    return {
      workflow: WORKFLOW_NAME,
      decision,
      task_id: trigger.task_id,
      proof_hash: trigger.proof_hash,
      passed: fields.passed === true,
      tx_hash: fields.tx_hash ?? "",
      onchain_status: fields.onchain_status,
      reasons: fields.reasons,
      checks: fields.checks,
    };
  };

  // [2/8] evidence from the backend
  const evidenceUrl = `${baseUrl(config)}/cre/tasks/${encodeURIComponent(trigger.task_id)}/evidence`;
  let fetched: HttpResult;
  try {
    fetched = new HTTPClient()
      .sendRequest(runtime, fetchEvidence, consensusIdenticalAggregation<HttpResult>())(evidenceUrl)
      .result();
  } catch (e) {
    const reason = `evidence unavailable: ${e instanceof Error ? e.message : String(e)}`;
    step(runtime, 2, reason);
    return finish("REJECTED", { passed: null, reasons: [reason], checks: [], tx_hash: null, onchain_status: "" });
  }
  if (fetched.statusCode !== 200) {
    const reason = `evidence unavailable: GET ${evidenceUrl} returned HTTP ${fetched.statusCode} ${clip(fetched.body, 200)}`;
    step(runtime, 2, reason);
    return finish("REJECTED", { passed: null, reasons: [reason], checks: [], tx_hash: null, onchain_status: "" });
  }
  let evidence: unknown;
  try {
    evidence = JSON.parse(fetched.body);
  } catch {
    const reason = "evidence unavailable: backend returned invalid JSON";
    step(runtime, 2, reason);
    return finish("REJECTED", { passed: null, reasons: [reason], checks: [], tx_hash: null, onchain_status: "" });
  }
  step(runtime, 2, `Evidence fetched from backend (HTTP 200, ${fetched.body.length} bytes): task spec + robot-signed proof`);

  // [3/8] on-chain context — the source of truth for robot identity, task spec and escrow state
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName });
  if (!network) throw new Error(`unknown chain selector name: ${config.chainSelectorName}`);
  const evm = new EVMClient(network.chainSelector.selector);
  const escrow = config.escrowAddress as Address;
  const before = readEscrow(runtime, evm, escrow, taskKey);
  const statusBefore = statusName(before.task.status);
  step(
    runtime,
    3,
    `Escrow ${shortHex(escrow)} on ${config.chainSelectorName}: status ${statusBefore}, ${formatEther(before.task.amount)} ETH locked, robot ${before.task.robot}, spec anchor ${shortHex(before.specHash)}`,
  );
  if (before.task.status !== STATUS_FUNDED || before.task.amount === 0n) {
    const reason =
      before.task.status === STATUS_SETTLED || before.task.status === STATUS_REFUNDED
        ? `task already ${statusBefore} on-chain — duplicate trigger ignored`
        : before.task.status === STATUS_FUNDED
          ? "escrow holds no funds for this task"
          : `task is ${statusBefore} on-chain (expected Funded) — nothing to settle`;
    step(runtime, 4, `Skipped: ${reason}`);
    return finish("SKIPPED", { passed: null, reasons: [reason], checks: [], tx_hash: null, onchain_status: statusBefore });
  }

  // [4/8] independent verification
  const verdict = evaluateSettlement({
    trigger,
    evidence,
    onchain: before,
    config: { proofClockSkewSeconds: config.proofClockSkewSeconds, requireSpecAnchor: config.requireSpecAnchor },
  });
  step(runtime, 4, `Independent verification — ${verdict.checks.filter((c) => c.ok).length}/${verdict.checks.length} checks passed:`);
  for (const c of verdict.checks) logLine(runtime, `      ${c.ok ? "✓" : "✗"} ${c.name.padEnd(18)} ${c.detail}`);

  // [5/8] decision
  if (verdict.decision === "REJECT") {
    const failedChecks = verdict.checks.filter((c) => !c.ok).map((c) => c.name);
    step(runtime, 5, `Verdict: REJECT (${failedChecks.join(", ")}) — evidence is invalid or untrusted; nothing is written on-chain`);
    return finish("REJECTED", {
      passed: null,
      reasons: verdict.reasons,
      checks: verdict.checks,
      tx_hash: null,
      onchain_status: statusBefore,
    });
  }
  const proofHash = verdict.proofHash as Hex;
  const signature = verdict.signature as Hex;

  // A robot signature is public once submitted; if this proof hash was already committed (e.g. replayed
  // onto another task through the open simulation forwarder), the escrow would refuse the write.
  if (proofHashUsedOnchain(runtime, evm, escrow, proofHash)) {
    const reason = `proof_reuse: proof hash ${proofHash} is already committed on-chain (replayed robot signature) — a fresh robot proof is required`;
    step(runtime, 5, `Verdict: REJECT (proof_reuse) — nothing is written on-chain`);
    return finish("REJECTED", { passed: null, reasons: [reason], checks: verdict.checks, tx_hash: null, onchain_status: statusBefore });
  }
  step(
    runtime,
    5,
    verdict.passed
      ? `Verdict: ACCEPT — task PASSED (${verdict.distance?.toFixed(3)} m from target) → settle: pay ${formatEther(before.task.amount)} ETH to ${before.task.payee}`
      : `Verdict: ACCEPT — task FAILED (${verdict.reasons.join("; ")}) → refund ${formatEther(before.task.amount)} ETH to requester ${before.task.requester}`,
  );

  // [6/8] DON-signed report -> forwarder -> MachineTaskEscrow.onReport
  const reportPayload = encodeSettlementReport({ taskId: taskKey, proofHash, passed: verdict.passed, robotSignature: signature });
  const report = runtime.report(prepareReportRequest(reportPayload)).result();
  const reply = evm
    .writeReport(runtime, { receiver: escrow, report, gasConfig: { gasLimit: config.gasLimit } })
    .result();
  if (reply.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`writeReport failed: ${TxStatus[reply.txStatus] ?? reply.txStatus} ${reply.errorMessage ?? ""}`.trim());
  }
  if (reply.receiverContractExecutionStatus === RECEIVER_EXECUTION_REVERTED) {
    throw new Error(`writeReport: receiver reverted ${reply.errorMessage ?? ""}`.trim());
  }
  const txHash = reply.txHash && reply.txHash.length > 0 ? bytesToHex(reply.txHash) : "";
  if (!txHash) {
    // `cre workflow simulate` without --broadcast: the report was eth_call'ed, not mined.
    step(runtime, 6, "DRY RUN: report validated via eth_call but NOT broadcast (re-run simulate with --broadcast)");
    return {
      workflow: WORKFLOW_NAME,
      decision: "DRY_RUN",
      task_id: trigger.task_id,
      proof_hash: proofHash,
      passed: verdict.passed,
      tx_hash: "",
      onchain_status: statusBefore,
      reasons: verdict.reasons,
      checks: verdict.checks,
    };
  }
  step(runtime, 6, `DON-signed report (taskId, proofHash, passed=${verdict.passed}, robotSig) delivered via forwarder: tx ${txHash}`);

  // [7/8] read the chain back: the forwarder catches receiver reverts, so SUCCESS alone proves nothing
  const after = readEscrow(runtime, evm, escrow, taskKey);
  const expected = verdict.passed ? STATUS_SETTLED : STATUS_REFUNDED;
  const statusAfter = statusName(after.task.status);
  if (after.task.status !== expected || after.task.proofHash.toLowerCase() !== proofHash.toLowerCase()) {
    throw new Error(
      `report delivered in tx ${txHash} but escrow shows status ${statusAfter} with proof hash ${after.task.proofHash} ` +
        `(expected ${statusName(expected)} with ${proofHash}): MachineTaskEscrow.onReport rejected the report`,
    );
  }
  step(
    runtime,
    7,
    verdict.passed
      ? `Confirmed on-chain: task Settled, proof ${shortHex(proofHash)} committed, ${formatEther(before.task.amount)} ETH released to ${before.task.payee}`
      : `Confirmed on-chain: task Refunded, proof ${shortHex(proofHash)} committed, ${formatEther(before.task.amount)} ETH returned to ${before.task.requester}`,
  );

  // [8/8] best-effort callback + result
  return finish(verdict.passed ? "SETTLED" : "REFUNDED", {
    passed: verdict.passed,
    reasons: verdict.reasons,
    checks: verdict.checks,
    tx_hash: txHash,
    onchain_status: statusAfter,
  });
};

// ─── Wiring ───────────────────────────────────────────────────────────────────────────────────

export const initWorkflow = (config: Config) => {
  const http = new HTTPCapability();
  // An empty trigger config is accepted ONLY by `cre workflow simulate`; a deployed workflow
  // must list the EVM addresses allowed to fire it (requests are signed by those keys).
  const trigger =
    config.authorizedTriggerKeys.length > 0
      ? http.trigger({
          authorizedKeys: config.authorizedTriggerKeys.map((publicKey) => ({ type: "KEY_TYPE_ECDSA_EVM" as const, publicKey })),
        })
      : http.trigger({});
  return [handler(trigger, onSettlementTrigger)];
};
