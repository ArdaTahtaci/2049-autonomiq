/**
 * npm run cre -- <args> — runs the CRE CLI from the CRE project root (cre/), resolving the binary
 * like the other scripts (CRE_CLI, `cre` on PATH, or ~/.cre/bin/cre).
 * Example: npm run cre -- workflow build ./machineproof-settlement -T local-simulation
 */
import { spawn } from "node:child_process";
import { CRE_PROJECT_DIR } from "../src/cre/deploy";
import { resolveCreCli } from "../src/cre/simulator";

const cli = resolveCreCli();
if (!cli) {
  console.error("CRE CLI not found. Install it: https://docs.chain.link/cre/getting-started/cli-installation (or set CRE_CLI)");
  process.exit(1);
}
const child = spawn(cli, process.argv.slice(2), { cwd: CRE_PROJECT_DIR, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
