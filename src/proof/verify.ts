/**
 * Off-chain proof verification pipeline (the backend acts as verifier/oracle).
 *
 *   submission schema -> proof schema -> task/robot identity -> proof hash
 *   -> robot signature -> task geometry -> timestamp freshness -> physical placement -> success claim
 *
 * Outcomes:
 *   - "rejected": the proof is invalid or untrusted (malformed, wrong task, wrong signer,
 *     tampered). It must never be committed on-chain.
 *   - "accepted": an authentic, correctly signed proof for this task. `passed` says whether
 *     the task physically succeeded; an accepted-but-failed proof is committed as failed
 *     (escrow refunded).
 *
 * Pure and synchronous. Never throws for a malformed submission; it only throws when the
 * verifier's own context is invalid (a server bug, not a client error).
 */
import type { PlacementCheck } from "./physical";
import { checkPlacement, positionsMatch } from "./physical";
import { hashCanonicalProof } from "./hash";
import { recoverProofSigner } from "./signature";
import type { RobotProof, Vec3 } from "./schema";
import { ProofSubmissionSchema, RobotProofSchema, formatZodError } from "./schema";

export interface ProofVerificationContext {
  task_id: string;
  robot_id: string;
  robot_address: string; // registered signer address of the robot assigned to the task
  start_position: Vec3; // task's pickup point A
  target_position: Vec3; // task's placement point B
  tolerance: number; // meters
  /** Proofs timestamped before this ISO instant are stale (e.g. replayed from an earlier task). */
  not_before?: string;
}

export type CheckName =
  | "submission_schema"
  | "proof_schema"
  | "task_id_match"
  | "robot_id_match"
  | "proof_hash"
  | "signature"
  | "task_geometry"
  | "timestamp"
  | "physical_placement"
  | "success_claim";

export interface VerificationCheck {
  name: CheckName;
  ok: boolean;
  detail: string;
}

export type VerificationResult =
  | { outcome: "rejected"; reasons: string[]; checks: VerificationCheck[]; proof_hash?: string }
  | {
      outcome: "accepted";
      passed: boolean; // true ONLY if robot claims success AND measured placement is within tolerance
      reasons: string[]; // empty when passed; explains why not passed otherwise
      checks: VerificationCheck[];
      proof: RobotProof; // zod-parsed proof
      canonical_proof: string;
      proof_hash: string;
      signature: string;
      signer: string; // recovered, checksummed
      placement: PlacementCheck;
    };

const meters = (n: number): string => `${n.toFixed(3)} m`;
const fmtVec = (v: Vec3): string => `(${v.x}, ${v.y}, ${v.z})`;
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function verifyProofSubmission(submission: unknown, ctx: ProofVerificationContext): VerificationResult {
  if (typeof ctx.tolerance !== "number" || !Number.isFinite(ctx.tolerance) || ctx.tolerance < 0) {
    throw new RangeError(`verification context tolerance must be a finite number >= 0, got ${String(ctx.tolerance)}`);
  }

  const checks: VerificationCheck[] = [];
  const record = (name: CheckName, ok: boolean, detail: string): boolean => {
    checks.push({ name, ok, detail });
    return ok;
  };
  const reject = (proof_hash?: string): VerificationResult => ({
    outcome: "rejected",
    reasons: checks.filter((c) => !c.ok).map((c) => c.detail),
    checks,
    ...(proof_hash !== undefined ? { proof_hash } : {}),
  });

  // 1. submission envelope
  const sub = ProofSubmissionSchema.safeParse(submission);
  if (!sub.success) {
    record("submission_schema", false, `malformed submission: ${formatZodError(sub.error).join("; ")}`);
    return reject();
  }
  record("submission_schema", true, "submission contains a proof object and a well-formed signature");
  const { signature, proof_hash: claimedHash } = sub.data;
  // Hash the proof exactly as received (not zod's output) so every extra field is covered.
  const rawProof = (submission as { proof: unknown }).proof;

  // 2. proof schema
  const parsed = RobotProofSchema.safeParse(rawProof);
  if (!parsed.success) {
    const issues = formatZodError(parsed.error).map((s) => `proof.${s}`);
    record("proof_schema", false, `invalid proof: ${issues.join("; ")}`);
    return reject();
  }
  record("proof_schema", true, "proof matches the robot proof schema");
  const proof = parsed.data;

  // 3-7: identity, integrity and authenticity. Any failure -> rejected.
  let integrityOk = true;

  integrityOk =
    record(
      "task_id_match",
      proof.task_id === ctx.task_id,
      proof.task_id === ctx.task_id
        ? `proof task_id matches ${ctx.task_id}`
        : `proof task_id "${proof.task_id}" does not match task "${ctx.task_id}"`,
    ) && integrityOk;

  integrityOk =
    record(
      "robot_id_match",
      proof.robot_id === ctx.robot_id,
      proof.robot_id === ctx.robot_id
        ? `proof robot_id matches ${ctx.robot_id}`
        : `proof robot_id "${proof.robot_id}" does not match assigned robot "${ctx.robot_id}"`,
    ) && integrityOk;

  let hashed: { canonical_proof: string; proof_hash: string } | undefined;
  try {
    hashed = hashCanonicalProof(rawProof);
  } catch (e) {
    integrityOk = record("proof_hash", false, `proof cannot be canonicalized: ${errorMessage(e)}`) && integrityOk;
  }
  if (hashed) {
    if (claimedHash !== undefined && claimedHash.toLowerCase() !== hashed.proof_hash.toLowerCase()) {
      integrityOk =
        record(
          "proof_hash",
          false,
          `claimed proof_hash ${claimedHash} does not match recomputed ${hashed.proof_hash}: proof was tampered with or canonicalized differently`,
        ) && integrityOk;
    } else {
      record(
        "proof_hash",
        true,
        `proof hash ${hashed.proof_hash}${claimedHash !== undefined ? " (matches claimed hash)" : ""}`,
      );
    }
  }

  // 6. signature (needs the recomputed hash; skipped if the proof could not be hashed)
  let signer: string | undefined;
  if (hashed) {
    try {
      const recovered = recoverProofSigner(hashed.proof_hash, signature);
      if (recovered.toLowerCase() === ctx.robot_address.toLowerCase()) {
        signer = recovered;
        record("signature", true, `signature valid: signed by registered robot ${recovered}`);
      } else {
        integrityOk =
          record(
            "signature",
            false,
            `signature recovers to ${recovered}, not the registered robot ${ctx.robot_address}: proof was modified after signing or signed by an unregistered key`,
          ) && integrityOk;
      }
    } catch (e) {
      integrityOk = record("signature", false, `invalid signature: ${errorMessage(e)}`) && integrityOk;
    }
  }

  // 7. the robot must not redefine the task's pickup/placement points
  const startOk = positionsMatch(proof.start_position, ctx.start_position);
  const targetOk = positionsMatch(proof.target_position, ctx.target_position);
  const geometryProblems: string[] = [];
  if (!startOk) {
    geometryProblems.push(
      `start_position ${fmtVec(proof.start_position)} differs from task ${fmtVec(ctx.start_position)}`,
    );
  }
  if (!targetOk) {
    geometryProblems.push(
      `target_position ${fmtVec(proof.target_position)} differs from task ${fmtVec(ctx.target_position)}`,
    );
  }
  integrityOk =
    record(
      "task_geometry",
      startOk && targetOk,
      startOk && targetOk ? "proof start/target positions match the task" : geometryProblems.join("; "),
    ) && integrityOk;

  // 7b. freshness: a proof cannot predate the task it claims to fulfil (blocks replaying an old
  // robot-signed proof onto a re-created task with the same task_id).
  if (ctx.not_before !== undefined) {
    const fresh = Date.parse(proof.timestamp) >= Date.parse(ctx.not_before);
    integrityOk =
      record(
        "timestamp",
        fresh,
        fresh
          ? `proof timestamp ${proof.timestamp} is not before ${ctx.not_before}`
          : `proof timestamp ${proof.timestamp} predates the task (not before ${ctx.not_before}): stale or replayed proof`,
      ) && integrityOk;
  }

  if (!integrityOk || !hashed || !signer) return reject(hashed?.proof_hash);

  // 8. physical placement, measured against the TASK's target, independent of `success`
  const placement = checkPlacement(proof.final_object_position, ctx.target_position, ctx.tolerance);
  const distanceText = `final object position is ${meters(placement.distance)} from target (tolerance ${meters(placement.tolerance)})`;
  record("physical_placement", placement.within_tolerance, distanceText);

  // 9. does the robot's self-reported flag agree with the measurement?
  const claimAgrees = proof.success === placement.within_tolerance;
  let claimDetail: string;
  if (proof.success && placement.within_tolerance) {
    claimDetail = "robot claimed success and the measured placement confirms it";
  } else if (proof.success) {
    claimDetail = `robot claimed success but ${distanceText}`;
  } else if (placement.within_tolerance) {
    claimDetail = "robot reported failure (success=false) although the measured placement is within tolerance";
  } else {
    claimDetail = "robot reported failure (success=false) and the measured placement confirms it";
  }
  record("success_claim", claimAgrees, claimDetail);

  const passed = proof.success === true && placement.within_tolerance;
  const reasons: string[] = [];
  if (!proof.success) reasons.push("robot reported failure (success=false)");
  if (!placement.within_tolerance) {
    reasons.push(proof.success ? `robot claimed success but ${distanceText}` : distanceText);
  }

  return {
    outcome: "accepted",
    passed,
    reasons,
    checks,
    proof,
    canonical_proof: hashed.canonical_proof,
    proof_hash: hashed.proof_hash,
    signature,
    signer,
    placement,
  };
}
