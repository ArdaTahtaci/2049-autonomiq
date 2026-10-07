/**
 * npm run demo:sim [-- --cre] — the MachineProof flow with the real PyBullet robot simulator
 * (robotics/) instead of the in-process mock robot.
 *
 *   Scenario 1: Franka Panda picks the cube at A, places it at B → proof → verify → settle
 *   Scenario 2: the cube is dropped in transit (--fault drop_in_transit) → measured miss → refund
 *
 * The backend runs with ROBOT_ADAPTER=external. For each task the demo calls
 * `robotics/backend_bridge.py <task_id>` (the same command an operator runs), which starts the
 * task, simulates it with the task's own A/B/tolerance and submits the unsigned simulator proof
 * through `npm run robot:submit` (RFC 8785 → keccak256 → EIP-191 → POST /tasks/:id/proof).
 * With --cre, settlement goes through the Chainlink CRE workflow simulator, as in demo:cre.
 *
 * Requires robotics/.venv (cd robotics && ./setup.sh). Exits non-zero if any check fails.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Wallet } from "ethers";
import { startServer, type RunningServer } from "../src/bootstrap";
import { deployEscrow, toOnchainTaskId } from "../src/chain/escrow";
import { connectProvider } from "../src/chain/provider";
import { loadConfig } from "../src/config";
import { CRE_WORKFLOW_CONFIG, deployCreStack, writeCreConfig } from "../src/cre/deploy";
import { creWhoami, resolveCreCli, startCreSimulator, type CreSimulator } from "../src/cre/simulator";
import { computeProofHash } from "../src/proof";
import type { TaskView } from "../src/tasks/types";
import { ensureLocalChain } from "./lib/chain";
import { apiClient, bad, blocked, bold, check, dim, eth, failures, green, magenta, ok, red, section, short, sleep, vec, yellow } from "./lib/ui";

const CRE = process.argv.includes("--cre");
const PORT = Number(process.env.DEMO_SIM_PORT ?? 3100);
const TRIGGER_URL = "http://127.0.0.1:2000/trigger";
const VERBOSE = Boolean(process.env.DEMO_VERBOSE);
const ROBOTICS_DIR = path.resolve(__dirname, "../robotics");
const PYTHON = path.join(ROBOTICS_DIR, ".venv/bin/python");

let api: ReturnType<typeof apiClient>;
let sys: RunningServer | undefined;

function die(lines: string[]): never {
  console.error(`\n${red(bold("Cannot run the simulator demo:"))}\n${lines.map((l) => `  ${l}`).join("\n")}\n`);
  process.exit(2);
}

/** Runs robotics/backend_bridge.py for one task, streaming its output indented under the demo. */
function runSimulator(taskId: string, fault: "none" | "drop_in_transit"): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ["backend_bridge.py", taskId, "--api", `http://127.0.0.1:${PORT}`, "--fault", fault], {
      cwd: ROBOTICS_DIR,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    // robot:submit ends with the backend's JSON response; the demo reads the task state itself.
    let jsonBody = false;
    const relay = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (!line.trim() || jsonBody) continue;
        if (/^HTTP \d+/.test(line)) jsonBody = !VERBOSE;
        console.log(`   ${magenta("🦾 sim")} ${dim(`│ ${line}`)}`);
      }
    };
    child.stdout.on("data", relay);
    child.stderr.on("data", relay);
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function waitForTask(taskId: string, timeoutMs: number): Promise<TaskView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api("GET", `/tasks/${taskId}`);
    if (body.status === "SETTLED" || body.status === "FAILED") return body;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for task ${taskId} (status ${body.status})`);
    await sleep(300);
  }
}

async function runScenario(fault: "none" | "drop_in_transit"): Promise<TaskView> {
  const created = await api("POST", "/tasks", {
    description: "Pick up the cube at A and place it at B",
    start_position: { x: 0, y: 0, z: 0 },
    target_position: { x: 1, y: 0, z: 0 },
    tolerance: 0.05,
    reward_eth: "0.1",
  });
  if (created.status !== 201) throw new Error(`create task failed: ${JSON.stringify(created.body)}`);
  const task = created.body;
  await ok("Task created", `${task.task_id}: pick ${vec(task.start_position)} → place ${vec(task.target_position)} ±${task.tolerance} m`);

  const funded = await api("POST", `/tasks/${task.task_id}/fund`);
  if (funded.status !== 200) throw new Error(`fund failed: ${JSON.stringify(funded.body)}`);
  await ok("Escrow funded", `${eth(task.reward_wei)} locked in MachineTaskEscrow  tx ${short(funded.body.transactions.fund!)}`);

  console.log(dim(`   … robotics/backend_bridge.py ${task.task_id}${fault === "none" ? "" : ` --fault ${fault}`} (PyBullet, Franka Panda)`));
  const code = await runSimulator(task.task_id, fault);
  if (code !== 0) bad("Simulator run + proof submission", `backend_bridge.py exited ${code}`);
  else await ok("Simulator proof signed + submitted", "robot:submit → POST /tasks/:id/proof");

  const final = await waitForTask(task.task_id, CRE ? 180_000 : 60_000);
  const p = final.proof!;
  const raw = p.raw as { trajectory?: unknown[]; simulator?: { engine?: string }; replay_hash?: string; success?: boolean };
  await check(raw.simulator?.engine === "pybullet", "Proof produced by the real simulator", `engine ${raw.simulator?.engine}, ${raw.trajectory?.length ?? 0} trajectory entries, replay_hash ${short(raw.replay_hash ?? "")}`);
  await ok("Proof hash + signature verified", `keccak256 ${short(p.proof_hash)}, signer ${short(p.signer)}`);
  const placement = final.verification?.placement;
  const line = placement ? `object ${placement.distance.toFixed(4)} m from target (tolerance ${placement.tolerance} m), robot claimed success=${raw.success}` : "";
  if (final.status === "SETTLED") await ok("Physical result verified", line);
  else await blocked("Physical check FAILED", line);
  if (CRE) await ok("Settlement decided by Chainlink CRE", `report tx ${short(final.cre?.report_tx ?? "")}, decision ${final.cre?.workflow_result?.decision ?? "?"}`);

  const onchain = final.onchain && "status" in final.onchain ? final.onchain : undefined;
  await check(
    onchain?.proof_hash === computeProofHash(p.raw),
    "On-chain commitment matches proof",
    `keccak256(canonical(off-chain proof)) == on-chain proofHash ${short(onchain?.proof_hash ?? "")}`,
  );
  // Per-task escrow events, not payee balances: the local chain may be shared with other demos.
  const escrow = sys!.escrow.contract;
  const id = toOnchainTaskId(task.task_id);
  const settledEvents = await escrow.queryFilter(escrow.filters.TaskSettled(id));
  const refundedEvents = await escrow.queryFilter(escrow.filters.TaskRefunded(id));
  const paid = settledEvents.reduce((sum, e) => sum + e.args.amount, 0n);
  if (fault === "none") {
    await check(
      final.status === "SETTLED" && onchain?.status === "Settled" && settledEvents.length === 1 && paid === BigInt(task.reward_wei) && refundedEvents.length === 0,
      "Payment settled exactly once",
      `status ${final.status}, escrow ${onchain?.status}, 1 TaskSettled ${eth(paid)} → payee ${short(task.payee)}`,
      `status ${final.status}, escrow ${onchain?.status}, ${settledEvents.length} TaskSettled (${eth(paid)}), ${refundedEvents.length} TaskRefunded`,
    );
  } else {
    await check(
      final.status === "FAILED" && onchain?.status === "Refunded" && settledEvents.length === 0 && refundedEvents.length === 1,
      "No payment released, escrow refunded",
      `status ${final.status}, escrow ${onchain?.status}, 0 TaskSettled, 1 TaskRefunded ${eth(refundedEvents[0]?.args.amount ?? 0n)}`,
      `status ${final.status}, escrow ${onchain?.status}, ${settledEvents.length} TaskSettled, ${refundedEvents.length} TaskRefunded`,
    );
  }
  return final;
}


async function main(): Promise<void> {
  console.log(bold(`\nMachineProof × PyBullet robot simulator${CRE ? " × Chainlink CRE" : ""}\n`));
  if (!fs.existsSync(PYTHON)) die(["robotics/.venv not found. Set it up once:", "  cd robotics && ./setup.sh"]);
  let cli: string | undefined;
  if (CRE) {
    cli = resolveCreCli();
    if (!cli) die(["CRE CLI not found (set CRE_CLI or install it); or run without --cre."]);
    if (!(await creWhoami(cli)).ok) die([`Not logged in to CRE: run \`${cli} login\` in a terminal, or run without --cre.`]);
  }

  const config = loadConfig({
    ...process.env,
    PORT: String(PORT),
    ROBOT_ADAPTER: "external",
    SETTLEMENT_MODE: CRE ? "cre" : "direct",
    CRE_TRIGGER_URL: TRIGGER_URL,
  });
  const chain = await ensureLocalChain(config.rpcUrl, (m) => console.log(dim(m)));
  const originalWorkflowConfig = CRE ? fs.readFileSync(CRE_WORKFLOW_CONFIG, "utf8") : undefined;
  let simulator: CreSimulator | undefined;
  try {
    const { provider } = await connectProvider(config.rpcUrl);
    const verifier = new Wallet(config.verifierPrivateKey, provider);
    if (CRE) {
      const stack = await deployCreStack(provider, verifier);
      writeCreConfig(stack, verifier.address, `http://127.0.0.1:${PORT}`);
      config.escrowAddress = stack.escrow;
    } else {
      config.escrowAddress = await (await deployEscrow(verifier, verifier.address)).getAddress();
    }
    console.log(dim(`MachineTaskEscrow ${config.escrowAddress} · settlement ${config.settlementMode}`));

    sys = await startServer(config, VERBOSE ? console.log : () => {});
    api = apiClient(sys.url);
    console.log(dim(`Backend ${sys.url} (robot adapter: ${sys.service.robotAdapterName})`));
    if (CRE) {
      console.log(dim("Starting the CRE workflow simulator…"));
      simulator = await startCreSimulator({ cli: cli!, onLine: (l) => VERBOSE && console.log(dim(`   ⬡ CRE │ ${l}`)) });
    }

    section("Scenario 1 — simulated robot places the cube at B; payment released");
    const settled = await runScenario("none");

    section("Scenario 2 — cube dropped in transit; measured miss, escrow refunded");
    const failed = await runScenario("drop_in_transit");

    section("Summary");
    console.log(`  ${settled.task_id}: ${settled.status === "SETTLED" ? green("SETTLED") : red(settled.status)} — real simulator proof verified and paid`);
    console.log(`  ${failed.task_id}: ${failed.status === "FAILED" ? yellow("FAILED") : red(failed.status)}  — dropped cube measured off-target, requester refunded`);
    console.log(failures() === 0 ? green(bold("\nAll checks passed ✓\n")) : red(bold(`\n${failures()} check(s) failed ✗\n`)));
    provider.destroy();
  } finally {
    await simulator?.stop();
    await sys?.close();
    chain?.kill();
    if (originalWorkflowConfig !== undefined) fs.writeFileSync(CRE_WORKFLOW_CONFIG, originalWorkflowConfig);
  }
  process.exit(failures() === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(red(`\nSimulator demo failed: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
