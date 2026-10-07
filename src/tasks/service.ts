import { randomBytes } from "node:crypto";
import { ZeroAddress, formatEther, getAddress, isAddress, parseEther } from "ethers";
import { z } from "zod";
import { ChainError, toOnchainTaskId, type EscrowClient, type TxResult } from "../chain/escrow";
import type { CreTrigger } from "../cre/trigger";
import { computeTaskSpecHash, formatZodError, verifyProofSubmission, type VerificationResult } from "../proof";
import type { RobotAdapter } from "../robot/adapter";
import { MOCK_OUTCOMES } from "../robot/mockProof";
import type { CreWorkflowResult, Task, TaskEvent, TaskEventType, TaskStatus, TaskView } from "./types";

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
  /** Optional upper bound for a task's reward (public deployments: anyone can create + fund tasks). */
  maxRewardWei?: bigint;
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
  /** Settlement via the Chainlink CRE workflow instead of the backend's verifier key. */
  cre?: { trigger: CreTrigger; settlementTimeoutMs?: number };
  log?: (msg: string) => void;
}

const DEFAULT_CRE_SETTLEMENT_TIMEOUT_MS = 120_000;
/** Keeps the evidence document under the CRE consensus observation limit (25 kB). */
const MAX_CRE_PROOF_BYTES = 16_000;
/** Workflow result callbacks are unauthenticated input: bound what they can make a task retain. */
const MAX_CRE_CALLBACKS = 10;

const CreResultInput = z.object({
  decision: z.enum(["SETTLED", "REFUNDED", "REJECTED", "SKIPPED"]),
  proof_hash: z.string().max(66).optional(),
  passed: z.boolean().nullable().optional(),
  reasons: z.array(z.string().max(500)).max(50).default([]),
  checks: z
    .array(z.object({ name: z.string().max(64), ok: z.boolean(), detail: z.string().max(500) }))
    .max(30)
    .default([]),
  tx_hash: z.string().max(66).nullable().optional(),
  onchain_status: z.string().max(32).optional(),
  workflow: z.string().max(64).optional(),
});

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
  /** Chain syncs in flight (separate from `busy` so polling never blocks state changes). */
  private readonly syncing = new Set<string>();
  private readonly log: (msg: string) => void;
  private creWatcher?: NodeJS.Timeout;

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
    if (config.maxRewardWei !== undefined && rewardWei > config.maxRewardWei) {
      throw new HttpError(400, `reward_eth exceeds this deployment's cap of ${formatEther(config.maxRewardWei)} ETH`);
    }

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
      settlement_mode: this.deps.cre ? "cre" : "direct",
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
    const task = await this.syncCreSettlement(taskId);
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
      // Anchor the acceptance criteria on-chain so the CRE workflow can detect a changed task spec.
      const specHash = computeTaskSpecHash(task);
      const tx = await this.chain(
        task,
        () => this.deps.escrow.fundTask(task.task_id, task.robot_address, task.payee, BigInt(task.reward_wei), specHash),
        async () => {
          // Adopt only an escrow this backend funded with these exact terms that is still awaiting a proof.
          // In cre mode the anchored spec must match too, or the workflow would reject every proof for it.
          const e = await this.deps.escrow.findEvent("TaskFunded", task.task_id);
          const onchain = e ? await this.deps.escrow.getTask(task.task_id) : undefined;
          const ours =
            e &&
            onchain?.status === "Funded" &&
            (task.settlement_mode !== "cre" || onchain.spec_hash === specHash) &&
            String(e.args.requester) === (await this.deps.escrow.requesterAddress()) &&
            String(e.args.robot) === task.robot_address &&
            String(e.args.payee) === task.payee &&
            String(e.args.amount) === task.reward_wei;
          return ours ? e : undefined;
        },
      );
      task.transactions.fund = tx.tx_hash;
      task.spec_hash = specHash;
      this.setStatus(task, "FUNDED");
      this.addEvent(task, "ESCROW_FUNDED", "Escrow funded on-chain", {
        tx_hash: tx.tx_hash,
        block_number: tx.block_number,
        amount_wei: task.reward_wei,
        onchain_task_id: task.onchain_task_id,
        spec_hash: specHash,
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
   * validate → canonicalize → keccak256 → verify robot signature → check measured placement, then
   *   direct mode: commit proof hash on-chain → settle (passed) or refund (failed), signed by the verifier key
   *   cre mode:    hand the verified event to the Chainlink CRE workflow, which re-verifies it and settles
   *                on-chain; the backend learns the outcome from the escrow (syncCreSettlement)
   */
  submitProof(taskId: string, submission: unknown): Promise<Task> {
    return this.withLock(taskId, async (task) => {
      const resubmission = task.status === "PROOF_RECEIVED" && creAcceptsNewProof(task);
      if (!resubmission) requireStatus(task, ["FUNDED", "RUNNING"], "accept a proof for");
      const previousStatus = resubmission ? task.cre!.previous_status : task.status;
      // A failed (re)submission must leave everything exactly as it was, incl. a pending CRE settlement.
      const snapshot = { status: task.status, proof: task.proof, verification: task.verification, cre: task.cre && { ...task.cre } };

      this.setStatus(task, "PROOF_RECEIVED");
      this.addEvent(task, "PROOF_RECEIVED", resubmission ? "Replacement execution proof received" : "Execution proof received");

      const rollback = () => {
        task.proof = snapshot.proof;
        task.verification = snapshot.verification;
        task.cre = snapshot.cre;
        if (!snapshot.proof) delete task.proof;
        if (!snapshot.verification) delete task.verification;
        if (!snapshot.cre) delete task.cre;
        this.setStatus(task, snapshot.status);
      };

      let result: AcceptedVerification;
      try {
        result = this.verifyOrReject(task, submission);
      } catch (err) {
        rollback();
        throw err;
      }

      if (this.deps.cre) {
        await this.dispatchToCre(task, result.proof_hash, previousStatus);
        return task;
      }

      let commit: TxResult;
      try {
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
        rollback();
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
    if (this.deps.cre && result.canonical_proof.length > MAX_CRE_PROOF_BYTES) {
      // The workflow fetches the evidence in node mode; DON consensus caps an observation at 25 kB.
      const reason = `proof is ${result.canonical_proof.length} bytes; CRE settlement accepts at most ${MAX_CRE_PROOF_BYTES} (summarize the trajectory)`;
      task.rejected_proofs += 1;
      this.addEvent(task, "PROOF_REJECTED", `Proof rejected: ${reason}`, { reasons: [reason] });
      throw new HttpError(422, "Proof rejected", { reasons: [reason], checks: result.checks });
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

  /**
   * Manual settlement retry (settlement normally happens automatically after a passing proof).
   * In cre mode this re-triggers the workflow, which is safe: it skips tasks that are no longer
   * Funded on-chain, and the escrow pays out at most once.
   */
  settleTask(taskId: string): Promise<Task> {
    return this.withLock(taskId, async (task) => {
      if (task.settlement_mode === "cre") {
        requireStatus(task, ["PROOF_RECEIVED"], "re-trigger CRE settlement for");
        if (!task.proof || !task.cre) {
          throw new HttpError(409, `Task ${task.task_id} has no proof awaiting CRE settlement`);
        }
        await this.dispatchToCre(task, task.proof.proof_hash, task.cre.previous_status);
        return task;
      }
      requireStatus(task, ["VERIFIED"], "settle");
      await this.releaseSettlement(task);
      return task;
    });
  }

  // ─── Chainlink CRE settlement ─────────────────────────────────────────────────────────────

  /** What the CRE workflow fetches (GET /cre/tasks/:id/evidence): the task spec and the robot's signed proof. */
  getCreEvidence(taskId: string) {
    const task = this.getTask(taskId);
    if (!task.proof) throw new HttpError(404, `Task ${taskId} has no proof`);
    return {
      task: {
        task_id: task.task_id,
        onchain_task_id: task.onchain_task_id,
        robot_id: task.robot_id,
        start_position: task.start_position,
        target_position: task.target_position,
        tolerance: task.tolerance,
        created_at: task.created_at,
        spec_hash: task.spec_hash ?? null,
      },
      submission: { proof: task.proof.raw, signature: task.proof.signature, proof_hash: task.proof.proof_hash },
    };
  }

  /**
   * The workflow's own report of its run (POST /cre/tasks/:id/result). Strictly informational and
   * unauthenticated: it never changes settlement state (that only follows the chain). A REJECTED
   * report for the pending proof lets the robot submit a replacement proof (see creAcceptsNewProof).
   */
  async recordCreResult(taskId: string, body: unknown): Promise<Task> {
    const task = this.getTask(taskId);
    const parsed = CreResultInput.safeParse(body);
    if (!parsed.success) throw new HttpError(400, "Invalid CRE result", formatZodError(parsed.error));
    const cre = task.cre;
    if (!cre) throw new HttpError(409, `Task ${taskId} was not handed to CRE`);
    if (task.status === "SETTLED" || task.status === "FAILED") {
      throw new HttpError(409, `Task ${taskId} is already ${task.status}; workflow results are no longer accepted`);
    }
    if (parsed.data.proof_hash && parsed.data.proof_hash.toLowerCase() !== cre.proof_hash.toLowerCase()) {
      throw new HttpError(409, `Result is for proof ${parsed.data.proof_hash}, not the pending proof ${cre.proof_hash}`);
    }
    cre.callbacks = (cre.callbacks ?? 0) + 1;
    if (cre.callbacks > MAX_CRE_CALLBACKS) throw new HttpError(429, `Too many workflow results for task ${taskId}`);

    const result: CreWorkflowResult = { ...parsed.data, received_at: new Date().toISOString() };
    cre.workflow_result = result;
    this.addEvent(task, "CRE_WORKFLOW_RESULT", `CRE workflow reported: ${result.decision}`, {
      decision: result.decision,
      passed: result.passed ?? null,
      reasons: result.reasons,
      tx_hash: result.tx_hash ?? null,
    });
    return this.syncCreSettlement(taskId);
  }

  /** Adopts the workflow's on-chain outcome (SETTLED / FAILED) once the escrow shows it. */
  async syncCreSettlement(taskId: string): Promise<Task> {
    const task = this.getTask(taskId);
    const pending = () => task.settlement_mode === "cre" && task.cre !== undefined && task.status === "PROOF_RECEIVED";
    // Read-only until the very end, under its own in-flight flag: a poll must never make a
    // state-changing request (/settle, a resubmission) fail with "another operation in progress".
    if (!pending() || this.syncing.has(taskId) || this.busy.has(taskId)) return task;
    this.syncing.add(taskId);
    try {
      const onchain = await this.deps.escrow.getTask(taskId);
      if (onchain.status === "Settled" || onchain.status === "Refunded") {
        const evidence = await this.readCreSettlementEvidence(task, onchain.status);
        // A state-changing operation may have started while we were reading: let it win.
        if (pending() && !this.busy.has(taskId)) this.adoptCreSettlement(task, onchain.status, onchain.proof_hash, evidence);
      } else {
        const cre = task.cre;
        const timeoutMs = this.deps.cre?.settlementTimeoutMs ?? DEFAULT_CRE_SETTLEMENT_TIMEOUT_MS;
        if (cre?.status === "TRIGGERED" && Date.now() - Date.parse(cre.triggered_at) > timeoutMs && pending() && !this.busy.has(taskId)) {
          cre.status = "TIMEOUT";
          this.addEvent(task, "ERROR", "CRE workflow did not settle in time; retry with POST /tasks/:taskId/settle or submit a fresh robot proof");
        }
      }
    } catch (err) {
      this.log(`[cre] ${taskId}: sync failed: ${errorMessage(err)}`);
    } finally {
      this.syncing.delete(taskId);
    }
    return task;
  }

  /** Polls the chain for tasks handed to CRE (GET /tasks/:id also syncs on read). */
  startCreWatcher(intervalMs = 1_000): void {
    if (!this.deps.cre || this.creWatcher) return;
    this.creWatcher = setInterval(() => {
      for (const task of this.tasks.values()) {
        if (task.settlement_mode === "cre" && task.status === "PROOF_RECEIVED") void this.syncCreSettlement(task.task_id);
      }
    }, intervalMs);
    this.creWatcher.unref();
  }

  stopCreWatcher(): void {
    if (this.creWatcher) clearInterval(this.creWatcher);
    this.creWatcher = undefined;
  }

  private async dispatchToCre(task: Task, proofHash: string, previousStatus: TaskStatus): Promise<void> {
    const trigger = this.deps.cre!.trigger;
    const attempt = (task.cre?.attempts ?? 0) + 1;
    task.cre = {
      ...(task.cre ?? {}),
      status: "TRIGGERED",
      trigger_url: trigger.url,
      triggered_at: new Date().toISOString(),
      attempts: attempt,
      proof_hash: proofHash,
      previous_status: previousStatus,
    };
    delete task.cre.workflow_result;
    try {
      await trigger.trigger({ task_id: task.task_id, proof_hash: proofHash });
    } catch (err) {
      task.cre.status = "TRIGGER_FAILED";
      const message = `${errorMessage(err)}; retry with POST /tasks/${task.task_id}/settle`;
      task.error = message;
      this.addEvent(task, "ERROR", message);
      throw new HttpError(502, message);
    }
    delete task.error;
    this.addEvent(task, "CRE_TRIGGERED", "Handed to the Chainlink CRE workflow for independent verification and on-chain settlement", {
      trigger_url: trigger.url,
      proof_hash: proofHash,
      attempt,
    });
  }

  private async readCreSettlementEvidence(task: Task, status: "Settled" | "Refunded") {
    const escrow = this.deps.escrow;
    const [report, commit, payout] = await Promise.all([
      escrow.findEvent("CreReportProcessed", task.task_id),
      escrow.findEvent("ProofCommitted", task.task_id),
      escrow.findEvent(status === "Settled" ? "TaskSettled" : "TaskRefunded", task.task_id),
    ]);
    const tx = report ? await escrow.getTransaction(report.tx_hash) : undefined;
    return { report, commit, payout, tx };
  }

  private adoptCreSettlement(
    task: Task,
    status: "Settled" | "Refunded",
    onchainProofHash: string,
    { report, commit, payout, tx }: Awaited<ReturnType<TaskService["readCreSettlementEvidence"]>>,
  ): void {
    const cre = task.cre!;
    if (report) {
      cre.report_tx = report.tx_hash;
      cre.workflow_id = String(report.args.workflowId);
      cre.forwarder = tx?.to ?? undefined;
      cre.transmitter = tx?.from ?? undefined;
    }
    const via = {
      settled_by: report ? "chainlink-cre" : "verifier",
      ...(report ? { workflow_id: cre.workflow_id, forwarder: cre.forwarder, transmitter: cre.transmitter } : {}),
    };
    const passed = status === "Settled";

    // Adopt what the chain says, but never silently: flag settlements this backend cannot vouch for.
    if (onchainProofHash.toLowerCase() !== cre.proof_hash.toLowerCase()) {
      this.addEvent(task, "ERROR", `On-chain settlement committed proof ${onchainProofHash}, not the proof handed to CRE (${cre.proof_hash}): unexpected settlement`, {
        onchain_proof_hash: onchainProofHash,
        expected_proof_hash: cre.proof_hash,
      });
    } else if (task.verification && task.verification.passed !== passed) {
      this.addEvent(task, "ERROR", `On-chain outcome ${status} contradicts the backend pre-screen verdict (passed=${task.verification.passed})`, {
        onchain_status: status,
        backend_passed: task.verification.passed,
      });
    }

    if (commit) task.transactions.commit = commit.tx_hash;
    this.addEvent(task, "PROOF_COMMITTED", report ? "Proof hash committed on-chain by the CRE workflow report" : "Proof hash committed on-chain", {
      tx_hash: commit?.tx_hash ?? cre.report_tx,
      block_number: commit?.block_number,
      proof_hash: onchainProofHash,
      passed,
      ...via,
    });

    if (passed) {
      task.transactions.settle = payout?.tx_hash;
      cre.status = "SETTLED_ONCHAIN";
      this.setStatus(task, "SETTLED");
      this.addEvent(task, "SETTLEMENT_RELEASED", "Payment released to payee", {
        tx_hash: payout?.tx_hash,
        block_number: payout?.block_number,
        payee: task.payee,
        amount_wei: task.reward_wei,
        ...via,
      });
    } else {
      task.transactions.refund = payout?.tx_hash;
      cre.status = "REFUNDED_ONCHAIN";
      // The backend's own verdict, never text from the (unauthenticated) workflow callback.
      const reasons = task.verification?.reasons.length ? task.verification.reasons : ["settled as failed on-chain"];
      this.addEvent(task, "TASK_FAILED", `Task failed verification: ${reasons.join("; ")}`, { reasons, ...via });
      this.setStatus(task, "FAILED");
      this.addEvent(task, "ESCROW_REFUNDED", "Payment withheld; escrow refunded to requester", {
        tx_hash: payout?.tx_hash,
        amount_wei: task.reward_wei,
        ...via,
      });
    }
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

/**
 * In cre mode a pending settlement can be replaced by a fresh robot proof once it is stuck (trigger
 * failed, timed out) or the workflow reported rejecting exactly that proof. Safe: a replacement still
 * needs a valid robot signature, and the escrow pays at most once.
 */
function creAcceptsNewProof(task: Task): boolean {
  const cre = task.cre;
  if (!cre) return false;
  const rejected =
    cre.workflow_result?.decision === "REJECTED" && cre.workflow_result.proof_hash?.toLowerCase() === cre.proof_hash.toLowerCase();
  return cre.status === "TIMEOUT" || cre.status === "TRIGGER_FAILED" || (cre.status === "TRIGGERED" && rejected);
}

function requireStatus(task: Task, allowed: TaskStatus[], action: string): void {
  if (!allowed.includes(task.status)) {
    throw new HttpError(409, `Cannot ${action} task ${task.task_id} in status ${task.status} (expected ${allowed.join(" or ")})`);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
