/**
 * npm run cre:simulate — runs the MachineProof settlement workflow in the official CRE simulator,
 * listening for HTTP triggers (http://localhost:2000/trigger) and broadcasting its on-chain writes
 * to the local chain. Start the backend with SETTLEMENT_MODE=cre to feed it robot proofs.
 * Extra flags are passed through, e.g. `npm run cre:simulate -- --engine-logs`.
 */
import { spawn } from "node:child_process";
import { CRE_PROJECT_DIR } from "../src/cre/deploy";
import { resolveCreCli, simulateArgs, simulatorEnv } from "../src/cre/simulator";

const cli = resolveCreCli();
if (!cli) {
  console.error("CRE CLI not found. Install it: https://docs.chain.link/cre/getting-started/cli-installation (or set CRE_CLI)");
  process.exit(1);
}
const args = simulateArgs(process.argv.slice(2));
console.log(`$ cd cre && cre ${args.join(" ")}\n`);
const child = spawn(cli, args, { cwd: CRE_PROJECT_DIR, env: simulatorEnv(), stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => child.kill("SIGINT"));
