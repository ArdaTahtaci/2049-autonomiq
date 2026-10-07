import { randomBytes } from "node:crypto";
import { ZeroAddress, getAddress, isAddress, parseEther } from "ethers";
import { z } from "zod";
import { ChainError, toOnchainTaskId, type EscrowClient, type TxResult } from "../chain/escrow";
import { formatZodError, verifyProofSubmission, type VerificationResult } from "../proof";
import type { RobotAdapter } from "../robot/adapter";
import { MOCK_OUTCOMES } from "../robot/mockProof";
import type { Task, TaskEvent, TaskEventType, TaskStatus, TaskView } from "./types";

type AcceptedVerification = Extract<VerificationResult, { outcome: "accepted" }>;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const Vec3Input = z.object({ x: z.number(), y: z.number(), z: z.number() }).strict();

const CreateTaskInput = z
  .object({
    task_id: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, "task_id must be 1-64 chars of [A-Za-z0-9_.-], starting with a letter or digit")
      .optional(),
    description: z.string().max(500).optional(),
    robot_id: z.string().min(1).optional(),
    start_position: Vec3Input.default({ x: 0, y: 0, z: 0 }),
    target_position: Vec3Input.default({ x: 1, y: 0, z: 0 }),
    tolerance: z.number().positive().max(10).optional(),
    reward_eth: z
      .string()
      .regex(/^\d+(\.\d{1,18})?$/, "reward_eth must be a decimal string, e.g. \"0.1\"")
      .optional(),
    payee: z
      .string()
      .refine((v) => isAddress(v) && getAddress(v) !== ZeroAddress, "payee must be a non-zero Ethereum address")
      .optional(),
  })
  .strict();

const StartTaskInput = z.object({ mock_outcome: z.enum(MOCK_OUTCOMES).optional() }).strict();

export interface TaskServiceConfig {
  robots: Record<string, string>;
  defaultRobotId: string;
  payeeAddress: string;
  defaultTolerance: number;
  defaultRewardWei: bigint;
  /** Allowed clock drift between robot and backend when checking that a proof is not older than its task. */
  proofClockSkewSeconds?: number;
}

const DEFAULT_PROOF_CLOCK_SKEW_S = 300;
/** Rejected proofs are unauthenticated input: bound what they can make the task retain. */
const MAX_STORED_REJECTIONS = 20;
const MAX_REASON_LENGTH = 300;
const UINT256_MAX = 2n ** 256n - 1n;

export interface TaskServiceDeps {
  config: TaskServiceConfig;
  escrow: EscrowClient;
  robot: RobotAdapter;
  log?: (msg: string) => void;
}

/**
 * Orchestrates the task lifecycle: escrow funding, robot execution, proof verification,
 * on-chain commitment and settlement. State lives in memory; every money-moving transition is
 * reconciled against the escrow's events when a transaction's outcome is uncertain, and
 * GET /tasks/:id always includes a live on-chain read.
 */
export class TaskService {
  private readonly tasks = new Map<string, Task>();
  /** Per-task mutex: one state-changing operation at a time (blocks duplicate/concurrent proofs). */
  private readonly busy = new Set<string>();
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: TaskServiceDeps) {
    this.log = deps.log ?? (() => {});
  }

  get robotAdapterName(): string {
    return this.deps.robot.name;
  }

  createTask(input: unknown): Task {
    const parsed = CreateTaskInput.safeParse(input ?? {});
    if (!parsed.success) throw new HttpError(400, "Invalid task", formatZodError(parsed.error));
    const body = parsed.data;
    const { config } = this.deps;

    const taskId = body.task_id ?? `task_${randomBytes(4).toString("hex")}`;
    if (this.tasks.has(taskId)) throw new HttpError(409, `Task ${taskId} already exists`);

    const robotId = body.robot_id ?? config.defaultRobotId;
    const robotAddress = Object.hasOwn(config.robots, robotId) ? config.robots[robotId] : undefined;
    if (!robotAddress) throw new HttpError(400, `Unknown robot_id "${robotId}"`, { known_robots: Object.keys(config.robots) });

    const rewardWei = body.reward_eth !== undefined ? parseEther(body.reward_eth) : config.defaultRewardWei;
    if (rewardWei <= 0n || rewardWei > UINT256_MAX) throw new HttpError(400, "reward_eth must be greater than 0 and fit in uint256");

    const now = new Date().toISOString();
    const task: Task = {
      task_id: taskId,
      onchain_task_id: toOnchainTaskId(taskId),
      description: body.description ?? "Pick up the object at start_position and place it at target_position",
      robot_id: robotId,
      robot_address: robotAddress,
      payee: getAddress(body.payee ?? config.payeeAddress),
      start_position: body.start_position,
      target_position: body.target_position,
      tolerance: body.tolerance ?? config.defaultTolerance,
      reward_wei: rewardWei.toString(),
      status: "CREATED",
      transactions: {},
      rejected_proofs: 0,
      events: [],
      created_at: now,
      updated_at: now,
    };
    this.tasks.set(taskId, task);
    this.addEvent(task, "TASK_CREATED", `Task created for ${robotId}`, {
      start_position: task.start_position,
      target_position: task.target_position,
      tolerance: task.tolerance,
      reward_wei: task.reward_wei,
    });
    return task;
  }

  getTask(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new HttpError(404, `Task ${taskId} not found`);
    return task;
  }

  listTasks(): Task[] {
    return [...this.tasks.values()];
  }

  /** Task plus a live read of the escrow contract (the source of truth for settlement). */
  async getTaskView(taskId: string): Promise<TaskView> {
    const task = this.getTask(taskId);
    try {
      return { ...task, onchain: await this.deps.escrow.getTask(taskId) };
    } catch (err) {
      return { ...task, onchain: { error: errorMessage(err) } };
    }
  }

  fundTask(taskId: string): Promise<Task> {
    return this.withLock(taskId, async (task) => {
      requireStatus(task, ["CREATED"], "fund");
      if (await this.deps.escrow.isContract(task.payee)) {
        // settle() pushes ETH to the payee; a contract that rejects it would lock the escrow forever.
        throw new HttpError(400, `payee ${task.payee} is a contract; use an externally owned account`);
      }
      const tx = await this.chain(
        task,
        () => this.deps.escrow.fundTask(task.task_id, task.robot_address, task.payee, BigInt(task.reward_wei)),
        async () => {
          // Adopt only an escrow this backend funded with these exact terms that is still awaiting a proof.
          const e = await this.deps.escrow.findEvent("TaskFunded", task.task_id);
          const ours =
            e &&
            (await this.deps.escrow.getTask(task.task_id)).status === "Funded" &&
            String(e.args.requester) === (await this.deps.escrow.requesterAddress()) &&
            String(e.args.robot) === task.robot_address &&
            String(e.args.payee) === task.payee &&
            String(e.args.amount) === task.reward_wei;
          return ours ? e : undefined;
        },
      );
      task.transactions.fund = tx.tx_hash;
      this.setStatus(task, "FUNDED");
      this.addEvent(task, "ESCROW_FUNDED", "Escrow funded on-chain", {
        tx_hash: tx.tx_hash,
        block_number: tx.block_number,
        amount_wei: task.reward_wei,
        onchain_task_id: task.onchain_task_id,
      });
      return task;
    });
  }

  async startTask(taskId: string, input: unknown): Promise<Task> {
    const parsed = StartTaskInput.safeParse(input ?? {});
    if (!parsed.success) throw new HttpError(400, "Invalid start request", formatZodError(parsed.error));

    const task = await this.withLock(taskId, async (t) => {
      requireStatus(t, ["FUNDED"], "start");
      this.setStatus(t, "RUNNING");
      this.addEvent(t, "ROBOT_EXECUTION_STARTED", `Robot execution started (${this.deps.robot.name} adapter)`, {
        adapter: this.deps.robot.name,
        ...(parsed.data.mock_outcome ? { mock_outcome: parsed.data.mock_outcome } : {}),
      });
      return t;
    });

    // Kick off execution outside the lock: the proof comes back through submitProof.
    this.deps.robot.execute(
      {
        task_id: task.task_id,
        robot_id: task.robot_id,
        start_position: task.start_position,
        target_position: task.target_position,
        tolerance: task.tolerance,
        mock_outcome: parsed.data.mock_outcome,
      },
      (id, submission) => this.submitProof(id, submission),
    );
    return task;
  }

  /**
   * Proof ingestion pipeline:
   * validate → canonicalize → keccak256 → verify robot signature → check measured placement
   * → commit proof hash on-chain → settle (passed) or refund (failed).
   */
  submitProof(taskId: string, submission: unknown): Promise<Task> {
    return this.withLock(taskId, async (task) => {
      requireStatus(task, ["FUNDED", "RUNNING"], "accept a proof for");
      const previousStatus = task.status;

      this.setStatus(task, "PROOF_RECEIVED");
      this.addEvent(task, "PROOF_RECEIVED", "Execution proof received");

      let result: AcceptedVerification;
      let commit: TxResult;
      try {
        result = this.verifyOrReject(task, submission);
        commit = await this.chain(
          task,
          () => this.deps.escrow.commitProof(task.task_id, result.proof_hash, result.passed, result.signature),
          async () => {
            const e = await this.deps.escrow.findEvent("ProofCommitted", task.task_id);
            return e && String(e.args.proofHash) === result.proof_hash && e.args.passed === result.passed ? e : undefined;
          },
        );
      } catch (err) {
        // Nothing was committed on-chain: roll back so a valid proof can still be submitted.
        delete task.proof;
        delete task.verification;
        this.setStatus(task, previousStatus);
        throw err;
      }
      task.transactions.commit = commit.tx_hash;
      this.addEvent(task, "PROOF_COMMITTED", "Proof hash committed on-chain", {
        tx_hash: commit.tx_hash,
        block_number: commit.block_number,
        proof_hash: result.proof_hash,
        passed: result.passed,
      });

      if (result.passed) {
        this.setStatus(task, "VERIFIED");
        await this.releaseSettlement(task);
      } else {
        this.addEvent(task, "TASK_FAILED", `Task failed verification: ${result.reasons.join("; ")}`, {
          reasons: result.reasons,
        });
        try {
          const refund = await this.chain(
            task,
            () => this.deps.escrow.refund(task.task_id),
            () => this.deps.escrow.findEvent("TaskRefunded", task.task_id),
          );
          task.transactions.refund = refund.tx_hash;
          this.addEvent(task, "ESCROW_REFUNDED", "Payment withheld; escrow refunded to requester", {
            tx_hash: refund.tx_hash,
            amount_wei: task.reward_wei,
          });
        } finally {
          // Terminal status only once the refund attempt is over, so pollers that see FAILED
          // also see the refunded escrow on-chain.
          this.setStatus(task, "FAILED");
        }
      }
      return task;
    });
  }

  /** Runs the off-chain verification pipeline; records the result or throws 422 for invalid proofs. */
  private verifyOrReject(task: Task, submission: unknown): AcceptedVerification {
    const result = verifyProofSubmission(submission, {
      task_id: task.task_id,
      robot_id: task.robot_id,
      robot_address: task.robot_address,
      start_position: task.start_position,
      target_position: task.target_position,
      tolerance: task.tolerance,
      not_before: new Date(
        Date.parse(task.created_at) - (this.deps.config.proofClockSkewSeconds ?? DEFAULT_PROOF_CLOCK_SKEW_S) * 1000,
      ).toISOString(),
    });

    if (result.outcome === "rejected") {
      // Invalid proofs never reach the chain and never change the task's lifecycle.
      task.rejected_proofs += 1;
      if (task.rejected_proofs <= MAX_STORED_REJECTIONS) {
        const reasons = result.reasons.map((r) => (r.length > MAX_REASON_LENGTH ? `${r.slice(0, MAX_REASON_LENGTH)}…` : r));
        this.addEvent(task, "PROOF_REJECTED", `Proof rejected: ${reasons.join("; ")}`, {
          reasons,
          ...(result.proof_hash ? { proof_hash: result.proof_hash } : {}),
        });
      }
      throw new HttpError(422, "Proof rejected", { reasons: result.reasons, checks: result.checks });
    }

    task.proof = {
      // Exactly what the robot sent (the hash covers this object, not the zod-parsed copy).
      raw: (submission as { proof: Record<string, unknown> }).proof,
      canonical_proof: result.canonical_proof,
      proof_hash: result.proof_hash,
      signature: result.signature,
      signer: result.signer,
      received_at: new Date().toISOString(),
    };
    task.verification = {
      passed: result.passed,
      reasons: result.reasons,
      checks: result.checks,
      placement: result.placement,
    };
    this.addEvent(task, "PROOF_VERIFIED", result.passed ? "Proof verified: task physically succeeded" : "Proof verified: task physically FAILED", {
      proof_hash: result.proof_hash,
      signer: result.signer,
      distance: result.placement.distance,
      tolerance: result.placement.tolerance,
      passed: result.passed,
      reasons: result.reasons,
    });
    return result;
  }

  /** Manual settlement retry (settlement normally happens automatically after a passing proof). */
  settleTask(taskId: string): Promise<Task> {
    return this.withLock(taskId, async (task) => {
      requireStatus(task, ["VERIFIED"], "settle");
      await this.releaseSettlement(task);
      return task;
    });
  }

  private async releaseSettlement(task: Task): Promise<void> {
    const tx = await this.chain(
      task,
      () => this.deps.escrow.settle(task.task_id),
      () => this.deps.escrow.findEvent("TaskSettled", task.task_id),
    );
    task.transactions.settle = tx.tx_hash;
    delete task.error;
    this.setStatus(task, "SETTLED");
    this.addEvent(task, "SETTLEMENT_RELEASED", "Payment released to payee", {
      tx_hash: tx.tx_hash,
      block_number: tx.block_number,
      payee: task.payee,
      amount_wei: task.reward_wei,
    });
  }

  /**
   * Runs a chain call; on failure records the error on the task and maps it to an HTTP error.
   * `reconcile` looks for the transaction's on-chain effect first: if it was mined but the receipt
   * was lost (or a retry finds it already done), the backend adopts the chain's result instead of
   * diverging from it.
   */
  private async chain(
    task: Task,
    call: () => Promise<TxResult>,
    reconcile?: () => Promise<TxResult | undefined>,
  ): Promise<TxResult> {
    try {
      return await call();
    } catch (err) {
      const onchain = reconcile ? await reconcile().catch(() => undefined) : undefined;
      if (onchain) {
        this.log(`[chain] ${task.task_id}: ${errorMessage(err)} — reconciled from on-chain event in tx ${onchain.tx_hash}`);
        return { tx_hash: onchain.tx_hash, block_number: onchain.block_number };
      }
      const message = errorMessage(err);
      task.error = message;
      this.addEvent(task, "ERROR", message);
      this.log(`[chain] ${task.task_id}: ${message}`);
      const conflict = err instanceof ChainError && ["InvalidStatus", "TaskAlreadyExists", "ProofAlreadyUsed"].includes(err.revertName ?? "");
      throw new HttpError(conflict ? 409 : 502, message);
    }
  }

  private async withLock<T>(taskId: string, fn: (task: Task) => Promise<T>): Promise<T> {
    const task = this.getTask(taskId);
    if (this.busy.has(taskId)) {
      throw new HttpError(409, `Task ${taskId} has another operation in progress (status ${task.status})`);
    }
    this.busy.add(taskId);
    try {
      return await fn(task);
    } finally {
      this.busy.delete(taskId);
    }
  }

  private setStatus(task: Task, status: TaskStatus): void {
    task.status = status;
    task.updated_at = new Date().toISOString();
  }

  private addEvent(task: Task, type: TaskEventType, message: string, data?: Record<string, unknown>): void {
    const event: TaskEvent = { at: new Date().toISOString(), type, message, ...(data ? { data } : {}) };
    task.events.push(event);
    task.updated_at = event.at;
    this.log(`[task ${task.task_id}] ${type}: ${message}`);
  }
}

function requireStatus(task: Task, allowed: TaskStatus[], action: string): void {
  if (!allowed.includes(task.status)) {
    throw new HttpError(409, `Cannot ${action} task ${task.task_id} in status ${task.status} (expected ${allowed.join(" or ")})`);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
