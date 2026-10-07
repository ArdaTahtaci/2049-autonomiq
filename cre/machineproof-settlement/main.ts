/**
 * WASM entry point of the MachineProof settlement workflow (logic lives in workflow.ts).
 *
 * Keep this file's exports to parameterless functions: Javy turns the bundle's ESM exports into
 * WASM exports and refuses exported functions that take parameters. cre-compile appends
 * `main().catch(sendErrorResponse)` when it builds this entry.
 */
import { Runner } from "@chainlink/cre-sdk";
import { type Config, configSchema, initWorkflow } from "./workflow";

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}
