import { isError, keccak256, toUtf8Bytes, type Signer } from "ethers";
import { MachineTaskEscrow__factory, type MachineTaskEscrow } from "../../typechain-types";

/** Mirrors `MachineTaskEscrow.TaskStatus` in Solidity (same order). */
export const ONCHAIN_TASK_STATUSES = ["None", "Funded", "Verified", "Failed", "Settled", "Refunded"] as const;
export type OnchainTaskStatus = (typeof ONCHAIN_TASK_STATUSES)[number];

export interface OnchainTask {
  onchain_task_id: string;
  requester: string;
  robot: string;
  payee: string;
  amount_wei: string;
  proof_hash: string;
  status: OnchainTaskStatus;
  /** Task spec hash anchored at funding (zero hash if the task was funded without one). */
  spec_hash: string;
}

export interface TxResult {
  tx_hash: string;
  block_number: number;
}

export type EscrowEventName = "TaskFunded" | "ProofCommitted" | "TaskSettled" | "TaskRefunded" | "CreReportProcessed";
export interface EscrowEvent extends TxResult {
  args: Record<string, unknown>;
}

/** Revert reason decoded from the contract's custom errors (e.g. "InvalidStatus"), if any. */
export class ChainError extends Error {
  constructor(
    message: string,
    readonly revertName?: string,
  ) {
    super(message);
    this.name = "ChainError";
  }
}

/** String task ids (e.g. "task_001") map to bytes32 on-chain ids via keccak256(utf8(task_id)). */
export function toOnchainTaskId(taskId: string): string {
  return keccak256(toUtf8Bytes(taskId));
}

export async function deployEscrow(deployer: Signer, verifierAddress: string): Promise<MachineTaskEscrow> {
  const contract = await new MachineTaskEscrow__factory(deployer).deploy(verifierAddress);
  await contract.waitForDeployment();
  return contract;
}

/**
 * Thin wrapper around MachineTaskEscrow used by the backend.
 * - `verifier` signs commitProof / settle / refund (the backend oracle identity).
 * - `requester` funds tasks (a dev wallet held by the backend until a frontend wallet exists).
 * Transactions are serialized through one queue so concurrent requests never race on nonces.
 */
export class EscrowClient {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly asVerifier: MachineTaskEscrow;
  private readonly asRequester: MachineTaskEscrow;

  constructor(
    readonly address: string,
    verifier: Signer,
    private readonly requester: Signer,
    /** First block to scan for events (the deployment block on public networks). */
    private readonly fromBlock = 0,
  ) {
    this.asVerifier = MachineTaskEscrow__factory.connect(address, verifier);
    this.asRequester = MachineTaskEscrow__factory.connect(address, requester);
  }

  requesterAddress(): Promise<string> {
    return this.requester.getAddress();
  }

  /** Sender and target of a transaction (e.g. CRE transmitter → forwarder for a workflow report). */
  async getTransaction(txHash: string): Promise<{ from: string; to: string | null } | undefined> {
    const tx = await this.requester.provider?.getTransaction(txHash);
    return tx ? { from: tx.from, to: tx.to } : undefined;
  }

  /** True if `address` holds contract code (such a payee might reject ETH and lock settlement). */
  async isContract(address: string): Promise<boolean> {
    const provider = this.requester.provider;
    if (!provider) throw new ChainError("requester signer has no provider");
    return (await provider.getCode(address)) !== "0x";
  }

  get contract(): MachineTaskEscrow {
    return this.asVerifier;
  }

  async verifierAddress(): Promise<string> {
    return this.asVerifier.verifier();
  }

  /** Funds the escrow; with `specHash` the task spec is anchored on-chain (fundTaskWithSpec). */
  fundTask(taskId: string, robot: string, payee: string, amountWei: bigint, specHash?: string): Promise<TxResult> {
    const id = toOnchainTaskId(taskId);
    return this.send("fundTask", () =>
      specHash
        ? this.asRequester.fundTaskWithSpec(id, robot, payee, specHash, { value: amountWei })
        : this.asRequester.fundTask(id, robot, payee, { value: amountWei }),
    );
  }

  /** Chainlink forwarder allowed to deliver CRE workflow reports (zero address = CRE path disabled). */
  creForwarder(): Promise<string> {
    return this.asVerifier.creForwarder();
  }

  commitProof(taskId: string, proofHash: string, passed: boolean, robotSignature: string): Promise<TxResult> {
    return this.send("commitProof", () =>
      this.asVerifier.commitProof(toOnchainTaskId(taskId), proofHash, passed, robotSignature),
    );
  }

  settle(taskId: string): Promise<TxResult> {
    return this.send("settle", () => this.asVerifier.settle(toOnchainTaskId(taskId)));
  }

  refund(taskId: string): Promise<TxResult> {
    return this.send("refund", () => this.asVerifier.refund(toOnchainTaskId(taskId)));
  }

  async getTask(taskId: string): Promise<OnchainTask> {
    const onchainTaskId = toOnchainTaskId(taskId);
    const [t, specHash] = await Promise.all([
      this.asVerifier.getTask(onchainTaskId),
      this.asVerifier.taskSpecHash(onchainTaskId),
    ]);
    return {
      onchain_task_id: onchainTaskId,
      requester: t.requester,
      robot: t.robot,
      payee: t.payee,
      amount_wei: t.amount.toString(),
      proof_hash: t.proofHash,
      status: ONCHAIN_TASK_STATUSES[Number(t.status)] ?? "None",
      spec_hash: specHash,
    };
  }

  /**
   * Finds the escrow event a mined transaction left for this task. Used to reconcile when a
   * transaction was mined but its receipt was lost (RPC timeout), so state never diverges from chain.
   */
  async findEvent(event: EscrowEventName, taskId: string): Promise<EscrowEvent | undefined> {
    const id = toOnchainTaskId(taskId);
    const c = this.asVerifier;
    const from = this.fromBlock;
    const logs =
      event === "TaskFunded"
        ? await c.queryFilter(c.filters.TaskFunded(id), from)
        : event === "ProofCommitted"
          ? await c.queryFilter(c.filters.ProofCommitted(id), from)
          : event === "TaskSettled"
            ? await c.queryFilter(c.filters.TaskSettled(id), from)
            : event === "TaskRefunded"
              ? await c.queryFilter(c.filters.TaskRefunded(id), from)
              : await c.queryFilter(c.filters.CreReportProcessed(id), from);
    const log = logs.at(-1);
    if (!log) return undefined;
    return {
      tx_hash: log.transactionHash,
      block_number: log.blockNumber,
      args: Object.fromEntries(log.fragment.inputs.map((input, i) => [input.name, log.args[i] as unknown])),
    };
  }

  private send(method: string, submit: () => Promise<{ wait(): Promise<unknown> }>): Promise<TxResult> {
    const run = async (): Promise<TxResult> => {
      try {
        const tx = await submit();
        const receipt = (await tx.wait()) as { hash: string; blockNumber: number; status: number | null } | null;
        if (!receipt || receipt.status !== 1) throw new ChainError(`${method} transaction failed`);
        return { tx_hash: receipt.hash, block_number: receipt.blockNumber };
      } catch (err) {
        throw toChainError(method, err);
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

const escrowInterface = MachineTaskEscrow__factory.createInterface();

function toChainError(method: string, err: unknown): ChainError {
  if (err instanceof ChainError) return err;
  // ethers only decodes custom errors for static calls; a send that reverts during gas estimation
  // (JSON-RPC: CALL_EXCEPTION with .data, in-process Hardhat: plain Error with .data) carries raw
  // revert data, so decode it against the escrow ABI here.
  const revert = (isError(err, "CALL_EXCEPTION") ? err.revert : null) ?? decodeRevert((err as { data?: unknown })?.data);
  if (revert) {
    const args = revert.args.map((a) => String(a)).join(", ");
    return new ChainError(`${method} reverted: ${revert.name}(${args})`, revert.name);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ChainError(`${method} failed: ${message.split("\n")[0]}`);
}

function decodeRevert(data: unknown): { name: string; args: readonly unknown[] } | null {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]{8,}$/.test(data)) return null;
  try {
    return escrowInterface.parseError(data);
  } catch {
    return null;
  }
}
