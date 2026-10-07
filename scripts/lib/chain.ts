import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { probeChainId } from "../../src/chain/provider";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Uses the chain at rpcUrl if one is running, otherwise starts a Hardhat node there (returned for cleanup). */
export async function ensureLocalChain(rpcUrl: string, log: (msg: string) => void): Promise<ChildProcess | undefined> {
  if ((await probeChainId(rpcUrl)) !== undefined) {
    log(`Using running chain at ${rpcUrl}`);
    return undefined;
  }
  const { hostname, port } = new URL(rpcUrl);
  log(`No chain at ${rpcUrl} — starting a local Hardhat node…`);
  const root = path.resolve(__dirname, "../..");
  const child = spawn(path.join(root, "node_modules/.bin/hardhat"), ["node", "--hostname", hostname, "--port", port || "8545"], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`hardhat node exited early:\n${stderr}`);
    if ((await probeChainId(rpcUrl, 500)) !== undefined) return child;
    await sleep(300);
  }
  child.kill();
  throw new Error("Timed out waiting for the local Hardhat node");
}
