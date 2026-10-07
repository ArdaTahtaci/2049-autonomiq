/**
 * MachineProof settlement policy — the workflow's independent verification of a robot proof.
 *
 * Pure and deterministic: no CRE SDK imports, no I/O, no clock. Every DON node evaluating the
 * same (trigger, evidence, on-chain state) reaches the same verdict, and the function is
 * unit-testable outside the WASM runtime.
 *
 * Trust inputs:
 *   - trigger   : what the backend asked us to settle (task_id + the proof hash it claims)
 *   - evidence  : what the backend serves at GET /cre/tasks/:id/evidence (UNTRUSTED)
 *   - onchain   : MachineTaskEscrow state read by the workflow itself (TRUSTED: robot identity,
 *                 anchored task spec, escrow status)
 *
 * Checks (in order). Any failure among the first group => REJECT (never written on-chain):
 *   evidence_schema    evidence has a task spec and a submission (proof object + 65-byte signature)
 *   trigger_binding    keccak256(JCS(proof)) == trigger.proof_hash (and == submission.proof_hash)
 *   task_binding       evidence is for the triggered task; onchain_task_id == keccak256(task_id)
 *   proof_schema       required proof fields present with correct types (extra fields allowed)
 *   proof_task_match   proof.task_id / proof.robot_id match the task
 *   spec_anchor        keccak256(JCS(task spec)) == taskSpecHash anchored on-chain at funding
 *   signature          EIP-191 signature over the proof hash recovers to the ON-CHAIN task.robot
 *   task_geometry      proof start/target positions equal the anchored task's
 *   freshness          proof is not older than the task (minus clock skew)
 * Then (ACCEPT; the verdict decides settle vs refund):
 *   physical_placement |final_object_position - target_position| <= tolerance (measured, not claimed)
 *   success_claim      passed = robot claimed success AND measurement confirms it
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { type Hex, bytesToHex, concat, getAddress, hexToBytes, keccak256, stringToBytes } from "viem";
// Single source of truth for canonicalization (RFC 8785 JCS), shared with the backend.
import { canonicalize } from "../../src/proof/canonicalize";

// ─── Types ────────────────────────────────────────────────────────────────────────────────────

export type Vec3 = { x: number; y: number; z: number };

export interface PolicyConfig {
  /** A proof may be timestamped up to this many seconds before the task's created_at. */
  proofClockSkewSeconds: number;
  /** Reject when the escrow has no task spec anchored on-chain. */
  requireSpecAnchor: boolean;
}

/** MachineTaskEscrow.getTask() as read by the workflow. */
export interface OnchainTask {
  requester: string;
  robot: string;
  payee: string;
  amount: bigint;
  proofHash: string;
  status: number;
}

export interface TriggerInput {
  task_id: string;
  proof_hash: string;
}

export interface SettlementInput {
  trigger: TriggerInput;
  /** Raw JSON body of GET /cre/tasks/:id/evidence. Untrusted. */
  evidence: unknown;
  onchain: { task: OnchainTask; specHash: string };
  config: PolicyConfig;
}

export type CheckName =
  | "evidence_schema"
  | "trigger_binding"
  | "task_binding"
  | "proof_schema"
  | "proof_task_match"
  | "spec_anchor"
  | "signature"
  | "task_geometry"
  | "freshness"
  | "physical_placement"
  | "success_claim";

export interface PolicyCheck {
  name: CheckName;
  ok: boolean;
  detail: string;
}

export interface SettlementEvaluation {
  decision: "ACCEPT" | "REJECT";
  /** Settle (true) or refund (false). Always false on REJECT. */
  passed: boolean;
  /** Why the proof was rejected, or why an accepted proof did not pass. Empty when passed. */
  reasons: string[];
  checks: PolicyCheck[];
  /** keccak256(JCS(submission.proof)), or null if the proof could not be hashed. */
  proofHash: Hex | null;
  /** keccak256(JCS(task spec)), or null if the spec could not be hashed. */
  specHash: Hex | null;
  /** keccak256(utf8(task_id)) — the escrow's bytes32 task key. */
  onchainTaskId: Hex;
  /** The robot's signature (present on ACCEPT; goes into the report for on-chain re-verification). */
  signature: Hex | null;
  /** Recovered signer (checksummed), when the signature was well-formed. */
  signer: string | null;
  /** Measured placement error in meters (present when the proof schema was valid). */
  distance: number | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────────────────────

export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const HASH32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;
const ZERO_HASH = `0x${"0".repeat(64)}`;

/** Same tolerances as the backend verifier (src/proof/physical.ts). */
export const PLACEMENT_EPSILON_M = 1e-9;
export const POSITION_EPSILON = 1e-9;

const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
/** secp256k1n / 2 — OpenZeppelin ECDSA (EIP-2) rejects any s above this. */
const SECP256K1_HALF_N = BigInt("0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0");
const EIP191_PREFIX_32 = stringToBytes("\x19Ethereum Signed Message:\n32");

// RFC 3339 date-time with mandatory seconds and a Z or ±hh:mm offset. Same grammar as the
// backend's zod `z.iso.datetime({ offset: true })` (date part validates real calendar days).
const DATE_SOURCE =
  "(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))";
const ISO_DATETIME = new RegExp(
  `^${DATE_SOURCE}T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)$`,
);
const ISO_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

// ─── Small pure helpers (exported for main.ts and tests) ─────────────────────────────────────

export const onchainTaskIdOf = (taskId: string): Hex => keccak256(stringToBytes(taskId));

/** keccak256(utf8(JCS(value))). Throws CanonicalizationError for values JSON cannot represent. */
export const hashCanonical = (value: unknown): Hex => keccak256(stringToBytes(canonicalize(value)));

/** proof_hash = keccak256(utf8(JCS(proof))) — identical to the backend's computeProofHash. */
export const computeProofHash = (proof: unknown): Hex => hashCanonical(proof);

/** The six anchored fields; vectors reduced to {x,y,z} (same as backend taskSpecOf). */
export const computeTaskSpecHash = (task: {
  task_id: string;
  robot_id: string;
  start_position: Vec3;
  target_position: Vec3;
  tolerance: number;
  created_at: string;
}): Hex =>
  hashCanonical({
    task_id: task.task_id,
    robot_id: task.robot_id,
    start_position: vec(task.start_position),
    target_position: vec(task.target_position),
    tolerance: task.tolerance,
    created_at: task.created_at,
  });

export const isHash32 = (v: unknown): v is Hex => typeof v === "string" && HASH32_PATTERN.test(v);

export const isIsoDateTime = (v: unknown): v is string => typeof v === "string" && ISO_DATETIME.test(v);

/**
 * Epoch milliseconds of an RFC 3339 timestamp. Parsed by hand (sub-millisecond digits truncated)
 * so the result never depends on the JS engine's Date.parse — QuickJS in the WASM runtime and V8
 * in the backend agree.
 */
export function parseIsoMillis(v: string): number {
  if (!ISO_DATETIME.test(v)) return Number.NaN;
  const m = ISO_PARTS.exec(v);
  if (!m) return Number.NaN;
  const ms = m[7] ? Number((m[7] + "00").slice(0, 3)) : 0;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
  if (m[8] === "Z") return utc;
  const offsetMin = (+m[10] * 60 + +m[11]) * (m[9] === "-" ? -1 : 1);
  return utc - offsetMin * 60_000;
}

/**
 * Recovers the signer of an EIP-191 personal_sign over the 32 raw bytes of `proofHash`:
 *   digest = keccak256("\x19Ethereum Signed Message:\n32" ++ proofHash)
 * As strict as OpenZeppelin ECDSA.recover (65 bytes, v in {27,28}, 0 < r < n, 0 < s <= n/2), so a
 * signature accepted here is never rejected by MachineTaskEscrow on-chain. Throws when invalid.
 */
export function recoverProofSigner(proofHash: string, signature: string): string {
  if (!isHash32(proofHash)) throw new Error("proof hash must be 0x-prefixed 32-byte hex");
  if (typeof signature !== "string" || !SIGNATURE_PATTERN.test(signature)) {
    throw new Error("signature must be 0x-prefixed 65-byte hex");
  }
  const sig = hexToBytes(signature as Hex);
  const v = sig[64];
  if (v !== 27 && v !== 28) throw new Error(`v must be 27 or 28, got ${v}`);
  const r = BigInt(bytesToHex(sig.slice(0, 32)));
  const s = BigInt(bytesToHex(sig.slice(32, 64)));
  if (r === 0n || r >= SECP256K1_N) throw new Error("r out of range");
  if (s === 0n) throw new Error("s out of range");
  if (s > SECP256K1_HALF_N) throw new Error("non-canonical (high) s value");

  const digest = hexToBytes(keccak256(concat([EIP191_PREFIX_32, hexToBytes(proofHash as Hex)])));
  const publicKey = new secp256k1.Signature(r, s).addRecoveryBit(v - 27).recoverPublicKey(digest).toRawBytes(false);
  return getAddress(`0x${keccak256(publicKey.slice(1)).slice(-40)}`);
}

export function distance3d(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// ─── Evidence / proof shape validation (hand-written: no schema library in the hot path) ─────

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isVec3 = (v: unknown): v is Vec3 => isObject(v) && isFiniteNumber(v.x) && isFiniteNumber(v.y) && isFiniteNumber(v.z);
const isIdString = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= 128;
const vec = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });
const fmtVec = (v: Vec3): string => `(${v.x}, ${v.y}, ${v.z})`;
const meters = (n: number): string => `${n.toFixed(3)} m`;
const short = (h: string): string => (h.length > 18 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h);
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface EvidenceTask {
  task_id: string;
  onchain_task_id: string;
  robot_id: string;
  start_position: Vec3;
  target_position: Vec3;
  tolerance: number;
  created_at: string;
  spec_hash: string | null;
}

interface EvidenceSubmission {
  proof: Json;
  signature: Hex;
  proof_hash: string | null;
}

function parseEvidence(evidence: unknown): { task: EvidenceTask; submission: EvidenceSubmission } | { problems: string[] } {
  const problems: string[] = [];
  if (!isObject(evidence)) return { problems: ["evidence is not a JSON object"] };
  const t = evidence.task;
  const s = evidence.submission;
  if (!isObject(t)) problems.push("task: missing");
  else {
    if (!isIdString(t.task_id)) problems.push("task.task_id: expected non-empty string");
    if (typeof t.onchain_task_id !== "string") problems.push("task.onchain_task_id: expected string");
    if (!isIdString(t.robot_id)) problems.push("task.robot_id: expected non-empty string");
    if (!isVec3(t.start_position)) problems.push("task.start_position: expected {x,y,z} numbers");
    if (!isVec3(t.target_position)) problems.push("task.target_position: expected {x,y,z} numbers");
    if (!isFiniteNumber(t.tolerance) || t.tolerance < 0) problems.push("task.tolerance: expected number >= 0");
    if (!isIsoDateTime(t.created_at)) problems.push("task.created_at: expected RFC 3339 date-time");
    if (t.spec_hash !== undefined && t.spec_hash !== null && typeof t.spec_hash !== "string") {
      problems.push("task.spec_hash: expected string or null");
    }
  }
  if (!isObject(s)) problems.push("submission: missing");
  else {
    if (!isObject(s.proof)) problems.push("submission.proof: expected JSON object");
    if (typeof s.signature !== "string" || !SIGNATURE_PATTERN.test(s.signature)) {
      problems.push("submission.signature: expected 0x-prefixed 65-byte hex");
    }
    if (s.proof_hash !== undefined && s.proof_hash !== null && !isHash32(s.proof_hash)) {
      problems.push("submission.proof_hash: expected 0x-prefixed 32-byte hex");
    }
  }
  if (problems.length > 0 || !isObject(t) || !isObject(s)) return { problems };
  return {
    task: {
      task_id: t.task_id as string,
      onchain_task_id: t.onchain_task_id as string,
      robot_id: t.robot_id as string,
      start_position: t.start_position as Vec3,
      target_position: t.target_position as Vec3,
      tolerance: t.tolerance as number,
      created_at: t.created_at as string,
      spec_hash: typeof t.spec_hash === "string" ? t.spec_hash : null,
    },
    submission: {
      proof: s.proof as Json,
      signature: s.signature as Hex,
      proof_hash: typeof s.proof_hash === "string" ? s.proof_hash : null,
    },
  };
}

interface RobotProof {
  task_id: string;
  robot_id: string;
  timestamp: string;
  start_position: Vec3;
  target_position: Vec3;
  final_object_position: Vec3;
  success: boolean;
}

/** Mirrors the backend's RobotProofSchema (src/proof/schema.ts). Unknown extra fields are allowed. */
function validateProof(p: Json): string[] {
  const problems: string[] = [];
  if (!isIdString(p.task_id)) problems.push("proof.task_id: expected string of 1-128 chars");
  if (!isIdString(p.robot_id)) problems.push("proof.robot_id: expected string of 1-128 chars");
  if (!isIsoDateTime(p.timestamp)) problems.push("proof.timestamp: expected RFC 3339 date-time with timezone");
  for (const k of ["start_position", "target_position", "final_object_position"] as const) {
    if (!isVec3(p[k])) problems.push(`proof.${k}: expected {x,y,z} finite numbers`);
  }
  if (typeof p.success !== "boolean") problems.push("proof.success: expected boolean");
  return problems;
}

// ─── The policy ───────────────────────────────────────────────────────────────────────────────

export function evaluateSettlement(input: SettlementInput): SettlementEvaluation {
  const { trigger, onchain, config } = input;
  const checks: PolicyCheck[] = [];
  const record = (name: CheckName, ok: boolean, detail: string): boolean => {
    checks.push({ name, ok, detail });
    return ok;
  };
  const onchainTaskId = onchainTaskIdOf(trigger.task_id);
  let proofHash: Hex | null = null;
  let specHash: Hex | null = null;
  let signer: string | null = null;
  let distance: number | null = null;
  const reject = (signature: Hex | null = null): SettlementEvaluation => ({
    decision: "REJECT",
    passed: false,
    reasons: checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`),
    checks,
    proofHash,
    specHash,
    onchainTaskId,
    signature,
    signer,
    distance,
  });

  // evidence_schema
  const parsed = parseEvidence(input.evidence);
  if ("problems" in parsed) {
    record("evidence_schema", false, `malformed evidence: ${parsed.problems.join("; ")}`);
    return reject();
  }
  record("evidence_schema", true, "evidence contains a task spec and a signed proof submission");
  const { task, submission } = parsed;
  let integrityOk = true;
  const integrity = (name: CheckName, ok: boolean, detail: string): void => {
    integrityOk = record(name, ok, detail) && integrityOk;
  };

  // trigger_binding — the proof we were asked to settle is the proof we were served
  try {
    proofHash = computeProofHash(submission.proof);
  } catch (e) {
    integrity("trigger_binding", false, `proof cannot be canonicalized: ${errorMessage(e)}`);
  }
  if (proofHash) {
    const lc = proofHash.toLowerCase();
    const triggerOk = trigger.proof_hash.toLowerCase() === lc;
    const backendOk = submission.proof_hash === null || submission.proof_hash.toLowerCase() === lc;
    integrity(
      "trigger_binding",
      triggerOk && backendOk,
      triggerOk && backendOk
        ? `proof hash ${proofHash} matches the trigger${submission.proof_hash ? " and the backend's record" : ""}`
        : `served proof hashes to ${proofHash}, but ${[
            triggerOk ? null : `the trigger expects ${trigger.proof_hash}`,
            backendOk ? null : `the backend recorded ${submission.proof_hash}`,
          ]
            .filter(Boolean)
            .join(" and ")}: proof altered or a different proof was served`,
    );
  }

  // task_binding
  const idOk = task.task_id === trigger.task_id;
  const keyOk = task.onchain_task_id.toLowerCase() === onchainTaskId.toLowerCase();
  integrity(
    "task_binding",
    idOk && keyOk,
    idOk && keyOk
      ? `evidence is for ${trigger.task_id} (escrow key ${short(onchainTaskId)})`
      : [
          idOk ? null : `evidence is for task "${task.task_id}", trigger is for "${trigger.task_id}"`,
          keyOk ? null : `evidence onchain_task_id ${task.onchain_task_id} != keccak256("${trigger.task_id}") ${onchainTaskId}`,
        ]
          .filter(Boolean)
          .join("; "),
  );

  // proof_schema
  const proofProblems = validateProof(submission.proof);
  integrity(
    "proof_schema",
    proofProblems.length === 0,
    proofProblems.length === 0 ? "proof has all required fields with valid types" : `invalid proof: ${proofProblems.join("; ")}`,
  );
  const proof = proofProblems.length === 0 ? (submission.proof as unknown as RobotProof) : null;

  // proof_task_match
  if (proof) {
    const tOk = proof.task_id === trigger.task_id;
    const rOk = proof.robot_id === task.robot_id;
    integrity(
      "proof_task_match",
      tOk && rOk,
      tOk && rOk
        ? `proof names task ${proof.task_id} and robot ${proof.robot_id}`
        : [
            tOk ? null : `proof task_id "${proof.task_id}" != "${trigger.task_id}"`,
            rOk ? null : `proof robot_id "${proof.robot_id}" != assigned robot "${task.robot_id}"`,
          ]
            .filter(Boolean)
            .join("; "),
    );
  }

  // spec_anchor — the off-chain task spec is the one the requester funded
  try {
    specHash = computeTaskSpecHash(task);
  } catch (e) {
    integrity("spec_anchor", false, `task spec cannot be canonicalized: ${errorMessage(e)}`);
  }
  if (specHash) {
    const anchored = onchain.specHash.toLowerCase();
    if (anchored === ZERO_HASH) {
      if (config.requireSpecAnchor) integrity("spec_anchor", false, "task spec not anchored on-chain");
      else record("spec_anchor", true, "no on-chain spec anchor (requireSpecAnchor=false): spec not verified");
    } else {
      const ok = anchored === specHash.toLowerCase();
      const backendClaim = task.spec_hash && task.spec_hash.toLowerCase() !== specHash.toLowerCase() ? ` (backend claimed ${task.spec_hash})` : "";
      integrity(
        "spec_anchor",
        ok,
        ok
          ? `task spec hash ${specHash} matches the on-chain anchor`
          : `task spec hash ${specHash} != on-chain anchor ${onchain.specHash}${backendClaim}: the task (target/tolerance/robot) was altered after funding`,
      );
    }
  }

  // signature — robot identity comes from the chain, never from the backend
  if (proofHash) {
    try {
      const recovered = recoverProofSigner(proofHash, submission.signature);
      signer = recovered;
      const ok = recovered.toLowerCase() === onchain.task.robot.toLowerCase();
      integrity(
        "signature",
        ok,
        ok
          ? `EIP-191 signature recovers to ${recovered}, the robot registered on-chain`
          : `signature recovers to ${recovered}, not the on-chain robot ${onchain.task.robot} (wrong signer or proof modified after signing)`,
      );
    } catch (e) {
      integrity("signature", false, `invalid signature: ${errorMessage(e)}`);
    }
  }

  // task_geometry — the robot may not redefine pickup/placement points
  if (proof) {
    const startOk = positionsMatch(proof.start_position, task.start_position);
    const targetOk = positionsMatch(proof.target_position, task.target_position);
    integrity(
      "task_geometry",
      startOk && targetOk,
      startOk && targetOk
        ? `proof start ${fmtVec(proof.start_position)} / target ${fmtVec(proof.target_position)} match the task`
        : [
            startOk ? null : `start_position ${fmtVec(proof.start_position)} != task ${fmtVec(task.start_position)}`,
            targetOk ? null : `target_position ${fmtVec(proof.target_position)} != task ${fmtVec(task.target_position)}`,
          ]
            .filter(Boolean)
            .join("; "),
    );
  }

  // freshness — blocks replaying an old signed proof onto a re-created task id
  if (proof) {
    const proofMs = parseIsoMillis(proof.timestamp);
    const notBeforeMs = parseIsoMillis(task.created_at) - config.proofClockSkewSeconds * 1000;
    const ok = proofMs >= notBeforeMs;
    integrity(
      "freshness",
      ok,
      ok
        ? `proof timestamp ${proof.timestamp} is not before task creation ${task.created_at} (skew ${config.proofClockSkewSeconds}s)`
        : `proof timestamp ${proof.timestamp} predates task creation ${task.created_at} by more than ${config.proofClockSkewSeconds}s: stale or replayed proof`,
    );
  }

  if (!integrityOk || !proof || !proofHash || !signer) return reject();

  // physical_placement — measured against the task's (anchored) target, independent of `success`
  distance = distance3d(proof.final_object_position, task.target_position);
  const within = distance <= task.tolerance + PLACEMENT_EPSILON_M;
  const placementText = `object placed ${meters(distance)} from target ${fmtVec(task.target_position)} (tolerance ${meters(task.tolerance)})`;
  record("physical_placement", within, placementText);

  // success_claim — does the robot's self-reported flag agree with the measurement?
  let claimDetail: string;
  if (proof.success && within) claimDetail = "robot claimed success and the measured placement confirms it";
  else if (proof.success) claimDetail = `robot claimed success but ${placementText}: false success claim`;
  else if (within) claimDetail = "robot reported failure although the measured placement is within tolerance";
  else claimDetail = "robot reported failure and the measured placement confirms it";
  record("success_claim", proof.success === within, claimDetail);

  const passed = proof.success === true && within;
  const reasons: string[] = [];
  if (!proof.success) reasons.push("robot reported failure (success=false)");
  if (!within) reasons.push(proof.success ? `robot claimed success but ${placementText}` : placementText);

  return {
    decision: "ACCEPT",
    passed,
    reasons,
    checks,
    proofHash,
    specHash,
    onchainTaskId,
    signature: submission.signature,
    signer,
    distance,
  };
}

function positionsMatch(a: Vec3, b: Vec3, epsilon = POSITION_EPSILON): boolean {
  return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon && Math.abs(a.z - b.z) <= epsilon;
}
