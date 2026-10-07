/**
 * npm run demo:cre — MachineProof with Chainlink CRE as the orchestration layer between verified
 * machine execution and on-chain settlement. Runs the real workflow in the official CRE simulator
 * (`cre workflow simulate --listen --broadcast`) against a local Hardhat chain.
 *
 *   Scenario 1: robot succeeds → backend pre-screens → CRE re-verifies → CRE report settles on-chain
 *   Scenario 2: robot lies (success=true, object misplaced) → CRE verdict failed → refund on-chain
 *   Scenario 3: duplicate CRE trigger → workflow sees the task already settled on-chain → no write
 *
 * Requires: CRE CLI + `cre login` (or CRE_API_KEY), bun. Exits non-zero if any check fails.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Contract, Wallet, type JsonRpcProvider } from "ethers";
import { startServer, type RunningServer } from "../src/bootstrap";
import { toOnchainTaskId } from "../src/chain/escrow";
import { connectProvider } from "../src/chain/provider";
import { loadConfig } from "../src/config";
import { CRE_WORKFLOW_CONFIG, CRE_WORKFLOW_DIR, deployCreStack, writeCreConfig, type CreStack } from "../src/cre/deploy";
import { MOCK_FORWARDER_ABI } from "../src/cre/forwarder";
import { creWhoami, resolveCreCli, startCreSimulator, type CreSimulator } from "../src/cre/simulator";
import { computeProofHash } from "../src/proof";
import type { TaskView } from "../src/tasks/types";
import { ensureLocalChain } from "./lib/chain";
import { apiClient, bad, blocked, bold, check, cyan, dim, eth, failures, green, magenta, ok, red, section, short, sleep, vec, yellow } from "./lib/ui";

const DEMO_PORT = Number(process.env.DEMO_CRE_PORT ?? 3100);
const TRIGGER_URL = "http://127.0.0.1:2000/trigger";
const VERBOSE = Boolean(process.env.DEMO_VERBOSE);
const CRE_TIMEOUT_MS = Number(process.env.DEMO_CRE_TIMEOUT_MS ?? 120_000);

let api: ReturnType<typeof apiClient>;

function die(lines: string[]): never {
  console.error(`\n${red(bold("Cannot run the CRE demo:"))}\n${lines.map((l) => `  ${l}`).join("\n")}\n`);
  process.exit(2);
}

const run = (cmd: string, args: string[], cwd?: string) =>
  new Promise<{ ok: boolean; out: string }>((resolve) =>
    execFile(cmd, args, { cwd, timeout: 300_000 }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}` })),
  );

const portInUse = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });

async function preflight(): Promise<string> {
  const cli = resolveCreCli();
  if (!cli) die(["CRE CLI not found.", "Install: https://docs.chain.link/cre/getting-started/cli-installation  (or set CRE_CLI=/path/to/cre)"]);
  const who = await creWhoami(cli);
  if (!who.ok) {
    die([
      "`cre workflow simulate` needs a CRE account session (the simulator is part of the CRE platform).",
      `  1. Create a free account: https://cre.chain.link`,
      `  2. Log in once:           ${cli} login        (opens a browser)  — or export CRE_API_KEY=…`,
      "  3. Re-run:                npm run demo:cre",
      "(No account? `npm run demo` runs the same flow with the backend's verifier key instead of CRE.)",
    ]);
  }
  if (!(await run("bun", ["--version"])).ok) die(["bun is required to compile the TypeScript workflow: https://bun.sh"]);
  if (!fs.existsSync(path.join(CRE_WORKFLOW_DIR, "node_modules"))) {
    console.log(dim("Installing workflow dependencies (bun install)…"));
    const install = await run("bun", ["install"], CRE_WORKFLOW_DIR);
    if (!install.ok) die(["bun install failed in cre/machineproof-settlement:", install.out.slice(-800)]);
  }
  if (await portInUse(2000)) die(["Port 2000 (the CRE simulator's HTTP trigger) is already in use — stop the other simulator first."]);
  if (await portInUse(DEMO_PORT)) die([`Port ${DEMO_PORT} is in use (set DEMO_CRE_PORT to another port).`]);
  return cli;
}

/** Workflow log lines emitted by the CRE simulator (the CRE run's own record of what it decided). */
const creUserLogs: string[] = [];

/** Prints the simulator's workflow logs ([USER LOG] lines) inline, tagged as coming from CRE. */
function creLog(line: string): void {
  const user = line.match(/\[USER LOG\]\s?(.*)$/);
  if (user) {
    creUserLogs.push(user[1]);
    console.log(`   ${magenta("⬡ CRE")} ${dim("│")} ${user[1]}`);
    return;
  }
  if (/\[SIMULATION\].*Running trigger/.test(line)) {
    console.log(`   ${magenta("⬡ CRE")} ${dim("│ ▶ workflow run started by HTTP trigger")}`);
    return;
  }
  if (VERBOSE || /\b(ERROR|panic)\b|Error:/.test(line)) console.log(`   ${magenta("⬡ CRE")} ${dim(`│ ${line}`)}`);
}

async function waitForTask(taskId: string, done: (t: TaskView) => boolean, timeoutMs: number, what: string): Promise<TaskView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api("GET", `/tasks/${taskId}`);
    if (done(body)) return body;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what} (task ${taskId} is ${body.status}, CRE ${body.cre?.status ?? "-"})`);
    await sleep(300);
  }
}

async function runTask(outcome: "success" | "false_success"): Promise<TaskView> {
  const created = await api("POST", "/tasks", { reward_eth: "0.1", tolerance: 0.05, target_position: { x: 1, y: 0, z: 0 } });
  if (created.status !== 201) throw new Error(`create failed: ${JSON.stringify(created.body)}`);
  const task = created.body;
  await ok("Task created", `${task.task_id}: pick ${vec(task.start_position)} → place ${vec(task.target_position)} ±${task.tolerance} m`);

  const funded = await api("POST", `/tasks/${task.task_id}/fund`);
  if (funded.status !== 200) throw new Error(`fund failed: ${JSON.stringify(funded.body)}`);
  await ok("Escrow funded + task spec anchored", `${eth(task.reward_wei)} locked, spec_hash ${short(funded.body.spec_hash!)}  tx ${short(funded.body.transactions.fund!)}`);

  await api("POST", `/tasks/${task.task_id}/start`, { mock_outcome: outcome });
  await ok("Robot execution started", `${task.robot_id} via mock simulator (${outcome === "success" ? "places the part" : "claims success, misplaces the part"})`);

  const handed = await waitForTask(task.task_id, (t) => Boolean(t.cre) || t.status === "SETTLED" || t.status === "FAILED", 30_000, "the robot proof");
  const p = handed.proof!;
  await ok("Execution proof received", `${(p.raw as { trajectory?: unknown[] }).trajectory?.length ?? 0} trajectory points, signed by ${short(p.signer)}`);
  await ok("Backend pre-screen passed", `keccak256(RFC 8785 proof) = ${short(p.proof_hash)}, robot signature valid`);
  await ok("Handed to Chainlink CRE", `HTTP trigger ${TRIGGER_URL} {task_id, proof_hash} — the backend does not settle`);
  console.log(dim("   … CRE workflow running: the lines tagged ⬡ CRE are streamed live from `cre workflow simulate`"));

  return waitForTask(task.task_id, (t) => t.status === "SETTLED" || t.status === "FAILED", CRE_TIMEOUT_MS, "CRE settlement");
}

async function confirmOnchain(final: TaskView, stack: CreStack, provider: JsonRpcProvider, verifier: string, expected: "Settled" | "Refunded") {
  const cre = final.cre!;
  const reportTx = cre.report_tx!;
  const tx = await provider.getTransaction(reportTx);
  const receipt = await provider.getTransactionReceipt(reportTx);
  const forwarderIface = new Contract(stack.forwarder, MOCK_FORWARDER_ABI).interface;
  const processed = receipt?.logs
    .filter((l) => l.address.toLowerCase() === stack.forwarder.toLowerCase())
    .map((l) => forwarderIface.parseLog(l))
    .find((l) => l?.name === "ReportProcessed");

  await check(
    tx?.from === stack.transmitter && tx?.to === stack.forwarder,
    "CRE report written on-chain",
    `tx ${short(reportTx)}: CRE transmitter ${short(tx?.from ?? "?")} → MockKeystoneForwarder ${short(tx?.to ?? "?")}`,
  );
  await check(
    processed?.args.result === true && Boolean(cre.workflow_id),
    "Escrow accepted it (IReceiver.onReport)",
    `ReportProcessed(result=true), CreReportProcessed(workflowId ${short(cre.workflow_id ?? "0x")})`,
  );
  const payoutTx = expected === "Settled" ? final.transactions.settle : final.transactions.refund;
  await check(
    final.transactions.commit === reportTx && payoutTx === reportTx,
    expected === "Settled" ? "Proof committed + paid atomically" : "Proof committed + refunded atomically",
    `commit and ${expected === "Settled" ? "payout" : "refund"} in the same CRE transaction`,
  );
  const onchain = final.onchain && "status" in final.onchain ? final.onchain : undefined;
  await check(
    onchain?.status === expected && onchain.proof_hash === computeProofHash(final.proof!.raw),
    "Final on-chain state confirmed",
    `escrow status ${onchain?.status}, on-chain proofHash == keccak256(canonical off-chain proof)`,
  );
  await check(tx?.from !== verifier, "Settled by CRE, not the backend key", `backend verifier ${short(verifier)} sent no settlement transaction`);
  const wr = cre.workflow_result;
  if (wr) {
    const passedChecks = wr.checks.filter((c) => c.ok).length;
    await ok("CRE workflow reported back", `decision ${wr.decision}, ${passedChecks}/${wr.checks.length} checks ok${wr.reasons.length ? ` — ${wr.reasons[0]}` : ""}`);
  }
}

async function main(): Promise<void> {
  console.log(bold("\nMachineProof × Chainlink CRE — autonomous settlement of verified machine work\n"));
  console.log(dim("  Robot ──signed proof──► Backend (pre-screen, evidence API) ──HTTP trigger──► CRE workflow"));
  console.log(dim("  CRE: fetch evidence · read escrow on-chain · re-verify hash, signature, spec, placement · signed report"));
  console.log(dim("  ──► KeystoneForwarder ──► MachineTaskEscrow.onReport ──► commit proof + pay | refund\n"));

  const cli = await preflight();
  const config = loadConfig({
    ...process.env,
    PORT: String(DEMO_PORT),
    ROBOT_ADAPTER: "mock",
    SETTLEMENT_MODE: "cre",
    CRE_TRIGGER_URL: TRIGGER_URL,
    MOCK_ROBOT_DELAY_MS: process.env.MOCK_ROBOT_DELAY_MS ?? "1500",
  });

  const chain = await ensureLocalChain(config.rpcUrl, (m) => console.log(dim(m)));
  // The demo points the workflow at its own backend port; put the committed config back afterwards.
  const originalWorkflowConfig = fs.readFileSync(CRE_WORKFLOW_CONFIG, "utf8");
  let sys: RunningServer | undefined;
  let simulator: CreSimulator | undefined;
  try {
    const { provider } = await connectProvider(config.rpcUrl);
    const verifier = new Wallet(config.verifierPrivateKey, provider);
    const stack = await deployCreStack(provider, verifier);
    writeCreConfig(stack, verifier.address, `http://127.0.0.1:${DEMO_PORT}`);
    config.escrowAddress = stack.escrow;
    console.log(dim(`MockKeystoneForwarder ${stack.forwarder} · MachineTaskEscrow ${stack.escrow} (creForwarder set)`));

    sys = await startServer(config, VERBOSE ? console.log : () => {});
    api = apiClient(sys.url);
    console.log(dim(`Backend ${sys.url} (settlement: Chainlink CRE, trigger ${TRIGGER_URL})`));

    console.log(dim(`Starting the CRE simulator: cd cre && cre workflow simulate ./machineproof-settlement --target local-simulation --listen --broadcast …`));
    const started = Date.now();
    simulator = await startCreSimulator({ cli, onLine: creLog });
    console.log(dim(`CRE workflow compiled to WASM and listening (${((Date.now() - started) / 1000).toFixed(1)}s)`));

    // ── Scenario 1 ─────────────────────────────────────────────────────────────────────────────
    section("Scenario 1 — robot delivers; Chainlink CRE verifies and settles on-chain");
    const payee = sys.service.listTasks()[0]?.payee ?? config.payeeAddress;
    const payeeBefore = await provider.getBalance(payee);
    const settled = await runTask("success");
    await check(settled.status === "SETTLED", "Backend adopted CRE settlement", `task ${settled.status} (read from the escrow, not trusted from CRE's callback)`);
    if (settled.status === "SETTLED") await confirmOnchain(settled, stack, provider, verifier.address, "Settled");
    const paidOnce = (await provider.getBalance(payee)) - payeeBefore;
    const settledEvents = await sys.escrow.contract.queryFilter(sys.escrow.contract.filters.TaskSettled(toOnchainTaskId(settled.task_id)));
    await check(paidOnce === BigInt(settled.reward_wei) && settledEvents.length === 1, "Payment settled exactly once", `payee +${eth(paidOnce)}, ${settledEvents.length} TaskSettled event`);

    // ── Scenario 2 ─────────────────────────────────────────────────────────────────────────────
    section("Scenario 2 — robot lies (success=true, part misplaced); CRE refunds on-chain");
    const payeeBefore2 = await provider.getBalance(payee);
    const failed = await runTask("false_success");
    if (failed.status === "FAILED") {
      await blocked("CRE verdict: physical check FAILED", failed.cre?.workflow_result?.reasons[0] ?? "measured placement outside tolerance");
      await confirmOnchain(failed, stack, provider, verifier.address, "Refunded");
    } else bad("CRE verdict", `expected FAILED, task is ${failed.status}`);
    await check((await provider.getBalance(payee)) === payeeBefore2, "No payment released", "payee balance unchanged; escrow refunded to requester");

    // ── Scenario 3 ─────────────────────────────────────────────────────────────────────────────
    section("Scenario 3 — duplicate CRE trigger for the settled task");
    const logsBefore = creUserLogs.length;
    const payeeBefore3 = await provider.getBalance(payee);
    const dup = await fetch(TRIGGER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { task_id: settled.task_id, proof_hash: settled.proof!.proof_hash } }),
    });
    await ok("Re-triggered the CRE workflow", `HTTP ${dup.status} for ${settled.task_id}`);
    // The CRE run's own log is the record of its decision (the backend refuses callbacks for settled tasks).
    const runLogs = async () => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const lines = creUserLogs.slice(logsBefore);
        if (lines.some((l) => l.startsWith("[8/8]"))) return lines;
        await sleep(200);
      }
      return creUserLogs.slice(logsBefore);
    };
    const lines = await runLogs();
    const skipped = lines.some((l) => /\[4\/8\] Skipped: task already Settled on-chain/.test(l));
    const wrote = lines.some((l) => l.startsWith("[6/8]"));
    await check(skipped && !wrote, "CRE ignored the duplicate", `workflow read on-chain status Settled → SKIPPED, no report written`);
    const settledAgain = await sys.escrow.contract.queryFilter(sys.escrow.contract.filters.TaskSettled(toOnchainTaskId(settled.task_id)));
    await check(
      settledAgain.length === 1 && (await provider.getBalance(payee)) === payeeBefore3,
      "Still paid exactly once",
      `${settledAgain.length} TaskSettled event, payee balance unchanged`,
    );

    section("Summary");
    console.log(`  ${settled.task_id}: ${green("SETTLED")} — CRE re-verified the robot proof and settled via its signed report`);
    console.log(`  ${failed.task_id}: ${yellow("FAILED")}  — CRE measured the misplacement and refunded the requester`);
    console.log(`  duplicate trigger: ${cyan("SKIPPED")} — CRE checked the chain first; the escrow pays at most once`);
    console.log(failures() === 0 ? green(bold("\nAll checks passed ✓\n")) : red(bold(`\n${failures()} check(s) failed ✗\n`)));
    provider.destroy();
  } finally {
    await simulator?.stop();
    await sys?.close();
    chain?.kill();
    fs.writeFileSync(CRE_WORKFLOW_CONFIG, originalWorkflowConfig);
  }
  process.exit(failures() === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(red(`\nCRE demo failed: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
