/**
 * npm run demo — the complete MachineProof flow on a local chain, driven over the real HTTP API.
 *
 *   Scenario 1: task → escrow → robot executes → proof → verify → on-chain commit → settlement
 *   Scenario 2: tampered / forged / malformed / lying proofs → nothing is paid, escrow refunded
 *
 * Uses the chain at RPC_URL if one is running, otherwise starts a Hardhat node for the duration
 * of the demo. Always deploys a fresh escrow contract. Exits non-zero if any check fails.
 */
import { Wallet, type JsonRpcProvider } from "ethers";
import { startServer, type RunningServer } from "../src/bootstrap";
import { ChainError, deployEscrow, toOnchainTaskId } from "../src/chain/escrow";
import { connectProvider } from "../src/chain/provider";
import { loadConfig, type AppConfig } from "../src/config";
import { computeProofHash, signProof } from "../src/proof";
import { generateMockProof } from "../src/robot/mockProof";
import type { TaskEvent, TaskView } from "../src/tasks/types";
import { ensureLocalChain } from "./lib/chain";
import { apiClient, bad, blocked, bold, check, dim, eth, failures, green, ok, reasonOf, red, section, short, sleep, vec, yellow } from "./lib/ui";

let api: ReturnType<typeof apiClient>;

// ── Event narration ────────────────────────────────────────────────────────────────────────────
async function narrate(task: TaskView, event: TaskEvent): Promise<void> {
  const d = (event.data ?? {}) as {
    passed?: boolean;
    tx_hash?: string;
    block_number?: number;
    amount_wei?: string;
    payee?: string;
    reasons?: string[];
  };
  switch (event.type) {
    case "PROOF_RECEIVED": {
      const raw = task.proof?.raw as { trajectory?: unknown[]; timestamp?: string } | undefined;
      await ok("Execution proof received", raw ? `${task.robot_id}, ${raw.trajectory?.length ?? 0} trajectory points, ${raw.timestamp}` : "");
      return;
    }
    case "PROOF_VERIFIED": {
      const p = task.proof!;
      await ok("Proof canonicalized", `RFC 8785 JSON canonical form, ${Buffer.byteLength(p.canonical_proof)} bytes`);
      await ok("Proof hash generated", `keccak256 = ${p.proof_hash}`);
      await ok("Signature verified", `signer ${p.signer} = registered key of ${task.robot_id}`);
      const placement = task.verification!.placement;
      const claim = (p.raw as { success?: boolean }).success;
      const line = `object ${placement.distance.toFixed(4)} m from target (tolerance ${placement.tolerance} m), robot claimed success=${claim}`;
      if (d.passed) await ok("Physical result verified", line);
      else await blocked("Physical check FAILED", line);
      return;
    }
    case "PROOF_COMMITTED":
      await ok("Proof committed on-chain", `commitProof(passed=${d.passed}) tx ${d.tx_hash} (block ${d.block_number})`);
      return;
    case "SETTLEMENT_RELEASED":
      await ok("Settlement released", `${eth(d.amount_wei ?? "0")} → payee ${short(d.payee ?? "")}  tx ${d.tx_hash}`);
      return;
    case "TASK_FAILED":
      await blocked("Payment withheld", (d.reasons ?? []).join("; "));
      return;
    case "ESCROW_REFUNDED":
      await ok("Escrow refunded to requester", `${eth(d.amount_wei ?? "0")}  tx ${d.tx_hash}`);
      return;
    case "ERROR":
      bad("Error", event.message);
      return;
    default:
      return;
  }
}

async function followTask(taskId: string, fromEvent: number, timeoutMs = 60_000): Promise<TaskView> {
  const deadline = Date.now() + timeoutMs;
  let seen = fromEvent;
  while (Date.now() < deadline) {
    const { body: task } = await api("GET", `/tasks/${taskId}`);
    for (; seen < task.events.length; seen++) {
      await narrate(task, task.events[seen]);
      if (task.events[seen].type === "ERROR") throw new Error(`task ${taskId}: ${task.events[seen].message}`);
    }
    if (task.status === "SETTLED" || task.status === "FAILED") return task;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for task ${taskId}`);
}

// ── Scenarios ──────────────────────────────────────────────────────────────────────────────────
async function scenarioSuccess(sys: RunningServer, provider: JsonRpcProvider): Promise<string> {
  section("Scenario 1 — robot completes the task, payment is released");

  const created = await api("POST", "/tasks", {
    description: "Pick up the part at A and place it at B",
    start_position: { x: 0, y: 0, z: 0 },
    target_position: { x: 1, y: 0, z: 0 },
    tolerance: 0.05,
    reward_eth: "0.1",
  });
  if (created.status !== 201) throw new Error(`create task failed: ${JSON.stringify(created.body)}`);
  const task = created.body;
  await ok("Task created", `${task.task_id}: pick ${vec(task.start_position)} → place ${vec(task.target_position)} ±${task.tolerance} m, reward ${eth(task.reward_wei)}`);

  const payeeBefore = await provider.getBalance(task.payee);
  const funded = await api("POST", `/tasks/${task.task_id}/fund`);
  if (funded.status !== 200) throw new Error(`fund failed: ${JSON.stringify(funded.body)}`);
  await ok("Escrow funded", `${eth(task.reward_wei)} locked in MachineTaskEscrow  tx ${funded.body.transactions.fund}`);

  const started = await api("POST", `/tasks/${task.task_id}/start`, { mock_outcome: "success" });
  if (started.status !== 202) throw new Error(`start failed: ${JSON.stringify(started.body)}`);
  await ok("Robot execution started", `${task.robot_id} via ${sys.service.robotAdapterName} simulator adapter`);
  console.log(dim("  … robot executing pick-and-place in simulation"));

  const final = await followTask(task.task_id, started.body.events.length);

  section("Confirm final state (read back from chain)");
  const onchain = final.onchain && "status" in final.onchain ? final.onchain : undefined;
  await check(final.status === "SETTLED", "Backend task status", `${final.status}`);
  await check(onchain?.status === "Settled", "Transaction confirmed", `on-chain escrow status = ${onchain?.status}`);
  const recomputed = computeProofHash(final.proof!.raw);
  await check(
    onchain?.proof_hash === recomputed,
    "On-chain commitment matches proof",
    `keccak256(canonical(off-chain proof)) == on-chain proofHash ${short(recomputed)}`,
  );
  const payeeDelta = (await provider.getBalance(task.payee)) - payeeBefore;
  const settledEvents = await sys.escrow.contract.queryFilter(sys.escrow.contract.filters.TaskSettled(toOnchainTaskId(task.task_id)));
  await check(
    payeeDelta === BigInt(task.reward_wei) && settledEvents.length === 1,
    "Payment settled exactly once",
    `payee +${eth(payeeDelta)}, ${settledEvents.length} TaskSettled event, escrow balance ${eth(await provider.getBalance(sys.escrow.address))}`,
  );

  const again = await api("POST", `/tasks/${task.task_id}/settle`);
  await check(again.status === 409, "Double settlement via API rejected", `HTTP ${again.status}: ${reasonOf(again.body)}`);
  try {
    await sys.escrow.settle(task.task_id);
    bad("Double settle on-chain reverted", "contract accepted a second settle!");
  } catch (err) {
    const reverted = err instanceof ChainError && err.revertName === "InvalidStatus";
    await check(reverted, "Double settle on-chain reverted", reverted ? "settle() → InvalidStatus(Settled)" : String(err));
  }
  return task.task_id;
}

async function scenarioAttacks(sys: RunningServer, provider: JsonRpcProvider, config: AppConfig): Promise<string> {
  section("Scenario 2 — attacks & failures: no valid proof, no payment");
  const robot = new Wallet(config.robotPrivateKey);
  const attacker = Wallet.createRandom();

  const { body: task } = await api("POST", "/tasks", { reward_eth: "0.1" });
  await api("POST", `/tasks/${task.task_id}/fund`);
  await ok("Task created & funded", `${task.task_id}, ${eth(task.reward_wei)} in escrow`);
  const payeeBefore = await provider.getBalance(task.payee);
  const spec = { ...task, tolerance: task.tolerance };

  // 1. Robot reports a dropped object; attacker rewrites the coordinates after signing.
  const dropped = generateMockProof(spec, "failure");
  const signedDrop = await signProof(dropped, robot);
  const tampered = { ...dropped, final_object_position: { ...task.target_position }, success: true };
  let r = await api("POST", `/tasks/${task.task_id}/proof`, { proof: tampered, signature: signedDrop.signature });
  await check(r.status === 422, "Tampered proof rejected", `HTTP ${r.status}: ${reasonOf(r.body)}`);

  // 2. A perfect-looking proof signed by a key that is not the robot's.
  const forged = generateMockProof(spec, "success");
  r = await api("POST", `/tasks/${task.task_id}/proof`, { proof: forged, signature: (await signProof(forged, attacker)).signature });
  await check(r.status === 422, "Wrong signer rejected", `HTTP ${r.status}: ${reasonOf(r.body)}`);

  // 3. A genuine robot proof for a different task replayed against this one.
  const replay = generateMockProof({ ...spec, task_id: "task_other" }, "success");
  r = await api("POST", `/tasks/${task.task_id}/proof`, { proof: replay, signature: (await signProof(replay, robot)).signature });
  await check(r.status === 422, "Wrong task_id rejected", `HTTP ${r.status}: ${reasonOf(r.body)}`);

  // 4. Malformed payloads.
  const { final_object_position: _omit, ...missing } = generateMockProof(spec, "success");
  r = await api("POST", `/tasks/${task.task_id}/proof`, { proof: missing, signature: (await signProof(missing, robot)).signature });
  await check(r.status === 422, "Missing fields rejected", `HTTP ${r.status}: ${reasonOf(r.body)}`);
  r = await api("POST", `/tasks/${task.task_id}/proof`, undefined, '{"proof": {"task_id": ');
  await check(r.status === 400, "Malformed JSON rejected", `HTTP ${r.status}: ${reasonOf(r.body)}`);

  const mid = await api("GET", `/tasks/${task.task_id}`);
  await check(
    mid.body.status === "FUNDED" && mid.body.onchain !== undefined && "status" in mid.body.onchain && mid.body.onchain.status === "Funded",
    "Rejected proofs never hit chain",
    `task still ${mid.body.status}, escrow ${"status" in (mid.body.onchain ?? {}) ? (mid.body.onchain as { status: string }).status : "?"}, ${mid.body.rejected_proofs} proofs rejected`,
  );

  // 5. Authentic robot signature, but the robot lies: success=true while the object is far from B.
  const lying = generateMockProof(spec, "false_success");
  const lyingSubmission = { proof: lying, ...(await signProof(lying, robot)) };
  console.log(dim("  … robot submits a correctly signed proof claiming success=true, object misplaced"));
  r = await api("POST", `/tasks/${task.task_id}/proof`, lyingSubmission);
  const final = await followTask(task.task_id, mid.body.events.length);
  await check(final.status === "FAILED", "False success flag caught", `measured placement overrides the robot's claim → ${final.status}`);

  // 6. The same proof again.
  r = await api("POST", `/tasks/${task.task_id}/proof`, lyingSubmission);
  await check(r.status === 409, "Duplicate proof rejected", `HTTP ${r.status}: ${reasonOf(r.body)}`);

  const settle = await api("POST", `/tasks/${task.task_id}/settle`);
  await check(settle.status === 409, "Settlement of failed task rejected", `HTTP ${settle.status}: ${reasonOf(settle.body)}`);

  const onchain = await sys.escrow.getTask(task.task_id);
  const payeeDelta = (await provider.getBalance(task.payee)) - payeeBefore;
  await check(
    onchain.status === "Refunded" && payeeDelta === 0n,
    "No payment released",
    `payee +${eth(payeeDelta)}, on-chain status ${onchain.status}, failed proof hash committed ${short(onchain.proof_hash)}`,
  );
  return task.task_id;
}

async function main(): Promise<void> {
  console.log(bold("\nMachineProof — verifiable machine work, settled on-chain\n"));
  const config = loadConfig({
    ...process.env,
    PORT: "0",
    ROBOT_ADAPTER: "mock",
    MOCK_ROBOT_DELAY_MS: process.env.MOCK_ROBOT_DELAY_MS ?? "1500",
  });

  const chain = await ensureLocalChain(config.rpcUrl, (msg) => console.log(dim(msg)));
  let sys: RunningServer | undefined;
  try {
    const { provider, chainId } = await connectProvider(config.rpcUrl);
    const verifier = new Wallet(config.verifierPrivateKey, provider);
    const escrow = await deployEscrow(verifier, verifier.address);
    config.escrowAddress = await escrow.getAddress();
    console.log(dim(`Chain ${chainId} @ ${config.rpcUrl}`));
    console.log(dim(`MachineTaskEscrow deployed at ${config.escrowAddress} (verifier ${verifier.address})`));

    sys = await startServer(config, process.env.DEMO_VERBOSE ? console.log : () => {});
    api = apiClient(sys.url);
    console.log(dim(`Backend API listening on ${sys.url} (robot adapter: ${sys.service.robotAdapterName})`));

    const settledTask = await scenarioSuccess(sys, provider);
    const failedTask = await scenarioAttacks(sys, provider, config);

    section("Summary");
    console.log(`  ${settledTask}: ${green("SETTLED")} — robot proof verified, committed on-chain, payment released once`);
    console.log(`  ${failedTask}: ${yellow("FAILED")}  — invalid proofs rejected, lying proof committed as failed, escrow refunded`);
    console.log(failures() === 0 ? green(bold("\nAll checks passed ✓\n")) : red(bold(`\n${failures()} check(s) failed ✗\n`)));
    provider.destroy();
  } finally {
    await sys?.close();
    chain?.kill();
  }
  process.exit(failures() === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(red(`\nDemo failed: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
