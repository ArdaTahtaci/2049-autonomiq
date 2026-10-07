/**
 * Runs the MachineProof workflow in the official Chainlink CRE simulator:
 *
 *   cre workflow simulate ./machineproof-settlement --target local-simulation --listen --broadcast --limits none
 *
 * --listen keeps it alive as the workflow's HTTP trigger (http://localhost:2000/trigger),
 * --broadcast makes its EVM writes real transactions (transmitter → MockKeystoneForwarder → escrow),
 * --limits none lifts the production trigger rate limit (1 HTTP trigger / 30 s; extra ones are dropped).
 * Not --non-interactive: the CLI then demands --http-payload even in listen mode; with a single
 * trigger the simulator does not prompt anyway.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { CRE_PROJECT_DIR } from "./deploy";
import { LOCAL_CRE } from "./forwarder";

export const CRE_TARGET = "local-simulation";
export const CRE_WORKFLOW = "./machineproof-settlement";

/** CRE_CLI env var, else `cre` on PATH, else the default install location (~/.cre/bin/cre). */
export function resolveCreCli(): string | undefined {
  if (process.env.CRE_CLI) return process.env.CRE_CLI;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, "cre");
    if (dir && fs.existsSync(candidate)) return candidate;
  }
  const fallback = path.join(os.homedir(), ".cre", "bin", "cre");
  return fs.existsSync(fallback) ? fallback : undefined;
}

/** `cre workflow simulate` needs a CRE account session (`cre login`) or CRE_API_KEY. */
export function creWhoami(cli: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(cli, ["whoami", "--non-interactive"], { timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout}${stderr}`.trim() });
    });
  });
}

export function simulatorEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Transmitter of the simulator's report transactions (Hardhat dev account #9; local only).
    CRE_ETH_PRIVATE_KEY: process.env.CRE_ETH_PRIVATE_KEY ?? LOCAL_CRE.transmitterKey.slice(2),
    NO_COLOR: "1",
  };
}

export function simulateArgs(extra: string[] = []): string[] {
  return [
    "workflow",
    "simulate",
    CRE_WORKFLOW,
    "--target",
    CRE_TARGET,
    "--listen",
    "--broadcast",
    "--limits",
    "none",
    ...extra,
  ];
}

export interface CreSimulator {
  process: ChildProcess;
  stop(): Promise<void>;
}

/** Starts the listening simulator and resolves once its HTTP trigger is accepting requests. */
export function startCreSimulator(opts: { cli: string; onLine?: (line: string) => void; readyTimeoutMs?: number }): Promise<CreSimulator> {
  const child = spawn(opts.cli, simulateArgs(), { cwd: CRE_PROJECT_DIR, env: simulatorEnv(), stdio: ["ignore", "pipe", "pipe"] });
  const stop = () =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGINT");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    });

  return new Promise((resolve, reject) => {
    const tail: string[] = [];
    let ready = false;
    const onLine = (line: string) => {
      tail.push(line);
      if (tail.length > 40) tail.shift();
      opts.onLine?.(line);
      if (!ready && /Waiting for HTTP request/i.test(line)) {
        ready = true;
        clearTimeout(timer);
        resolve({ process: child, stop });
      }
    };
    readline.createInterface({ input: child.stdout! }).on("line", onLine);
    readline.createInterface({ input: child.stderr! }).on("line", onLine);
    const timer = setTimeout(() => {
      void stop();
      reject(new Error(`CRE simulator did not become ready in time. Last output:\n${tail.join("\n")}`));
    }, opts.readyTimeoutMs ?? 180_000);
    child.once("exit", (code) => {
      if (!ready) {
        clearTimeout(timer);
        reject(new Error(`CRE simulator exited (code ${code}) before it was ready. Last output:\n${tail.join("\n")}`));
      }
    });
  });
}
