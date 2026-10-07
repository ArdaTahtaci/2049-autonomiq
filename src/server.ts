import type { AddressInfo } from "node:net";
import { startServer } from "./bootstrap";
import { loadConfig } from "./config";

async function main(): Promise<void> {
  const config = loadConfig();
  const running = await startServer(config);
  const { port } = running.server.address() as AddressInfo;
  console.log(`MachineProof backend listening on ${config.host ?? "0.0.0.0"}:${port} (${running.url})`);
  console.log(`  escrow contract : ${running.escrow.address}`);
  console.log(`  robot adapter   : ${running.service.robotAdapterName}`);
  console.log(`  settlement      : ${config.settlementMode === "cre" ? `Chainlink CRE workflow (trigger ${config.creTriggerUrl})` : "direct (verifier key)"}`);
  console.log(`  rpc             : ${new URL(config.rpcUrl).origin}`); // origin only: hosted RPC URLs embed API keys

  const shutdown = () => {
    void running.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  console.error(`Failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
