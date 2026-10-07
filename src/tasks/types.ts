import type { OnchainTask } from "../chain/escrow";
import type { PlacementCheck, Vec3, VerificationCheck } from "../proof";

/**
 * CREATED ─fund─► FUNDED ─start─► RUNNING ─proof─► PROOF_RECEIVED ─┬─ passed ─► VERIFIED ─settle─► SETTLED
 *                                                                   └─ failed ─► FAILED (escrow refunded)
 * A rejected (invalid/tampered) proof does not change state: the task returns to FUNDED/RUNNING.
 */
export const TASK_STATUSES = [
  "CREATED",
  "FUNDED",
  "RUNNING",
  "PROOF_RECEIVED",
  "VERIFIED",
  "SETTLED",
  "FAILED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type TaskEventType =
  | "TASK_CREATED"
  | "ESCROW_FUNDED"
  | "ROBOT_EXECUTION_STARTED"
  | "PROOF_RECEIVED"
  | "PROOF_REJECTED"
  | "PROOF_VERIFIED"
  | "PROOF_COMMITTED"
  | "SETTLEMENT_RELEASED"
  | "TASK_FAILED"
  | "ESCROW_REFUNDED"
  | "ERROR";

export interface TaskEvent {
  at: string;
  type: TaskEventType;
  message: string;
  data?: Record<string, unknown>;
}

/** The accepted proof: raw payload stays off-chain, only proof_hash is committed on-chain. */
export interface TaskProofRecord {
  raw: Record<string, unknown>;
  canonical_proof: string;
  proof_hash: string;
  signature: string;
  signer: string;
  received_at: string;
}

export interface TaskVerification {
  passed: boolean;
  reasons: string[];
  checks: VerificationCheck[];
  placement: PlacementCheck;
}

export interface Task {
  task_id: string;
  /** bytes32 id used by the escrow contract: keccak256(utf8(task_id)). */
  onchain_task_id: string;
  description?: string;
  robot_id: string;
  robot_address: string;
  payee: string;
  start_position: Vec3;
  target_position: Vec3;
  tolerance: number;
  reward_wei: string;
  status: TaskStatus;
  proof?: TaskProofRecord;
  verification?: TaskVerification;
  transactions: { fund?: string; commit?: string; settle?: string; refund?: string };
  rejected_proofs: number;
  error?: string;
  events: TaskEvent[];
  created_at: string;
  updated_at: string;
}

export type TaskView = Task & { onchain?: OnchainTask | { error: string } };
