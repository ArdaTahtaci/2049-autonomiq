import type { OnchainTask } from "../chain/escrow";
import type { PlacementCheck, Vec3, VerificationCheck } from "../proof";

/**
 * CREATED ─fund─► FUNDED ─start─► RUNNING ─proof─► PROOF_RECEIVED ─┬─ passed ─► VERIFIED ─settle─► SETTLED
 *                                                                   └─ failed ─► FAILED (escrow refunded)
 * A rejected (invalid/tampered) proof does not change state: the task returns to FUNDED/RUNNING.
 *
 * Settlement mode "cre": PROOF_RECEIVED means the proof passed the backend's pre-screen and was handed
 * to the Chainlink CRE workflow, which verifies it independently and settles on-chain; the backend
 * then moves to SETTLED / FAILED from the escrow's on-chain state (VERIFIED is skipped: the
 * workflow's report commits and settles atomically).
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
  | "CRE_TRIGGERED"
  | "CRE_WORKFLOW_RESULT"
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

export type SettlementMode = "direct" | "cre";

/** What the CRE workflow reported back (informational; money state always comes from the chain). */
export interface CreWorkflowResult {
  decision: "SETTLED" | "REFUNDED" | "REJECTED" | "SKIPPED";
  proof_hash?: string;
  passed?: boolean | null;
  reasons: string[];
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  tx_hash?: string | null;
  onchain_status?: string;
  workflow?: string;
  received_at: string;
}

export interface CreSettlementState {
  status: "TRIGGERED" | "TRIGGER_FAILED" | "SETTLED_ONCHAIN" | "REFUNDED_ONCHAIN" | "TIMEOUT";
  trigger_url: string;
  triggered_at: string;
  attempts: number;
  proof_hash: string;
  /** Task status before the proof arrived (kept across replacement proofs). */
  previous_status: TaskStatus;
  workflow_result?: CreWorkflowResult;
  /** Number of workflow result callbacks received (bounded). */
  callbacks?: number;
  /** From the escrow's CreReportProcessed event once the workflow's report landed on-chain. */
  report_tx?: string;
  workflow_id?: string;
  forwarder?: string;
  transmitter?: string;
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
  /** keccak256 of the canonical task spec, anchored on-chain at funding (see src/proof/taskSpec.ts). */
  spec_hash?: string;
  settlement_mode: SettlementMode;
  status: TaskStatus;
  proof?: TaskProofRecord;
  verification?: TaskVerification;
  transactions: { fund?: string; commit?: string; settle?: string; refund?: string };
  cre?: CreSettlementState;
  rejected_proofs: number;
  error?: string;
  events: TaskEvent[];
  created_at: string;
  updated_at: string;
}

export type TaskView = Task & { onchain?: OnchainTask | { error: string } };
