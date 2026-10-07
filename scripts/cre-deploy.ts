/**
 * npm run cre:deploy — deploys (or reuses) the local Chainlink CRE settlement stack:
 * MockKeystoneForwarder + MachineTaskEscrow (creForwarder set), then points the backend
 * (deployments/localhost.json) and the workflow (cre/machineproof-settlement/config.local.json) at it.
 *
 *   npm run chain        # terminal 1
 *   npm run cre:deploy   # terminal 2
 */
import { Wallet } from "ethers";
import { connectProvider } from "../src/chain/provider";
import { assertSafeKeys, loadConfig } from "../src/config";
import { CRE_WORKFLOW_CONFIG, deployCreStack, writeCreConfig } from "../src/cre/deploy";

async function main(): Promise<void> {
  const config = loadConfig();
  const { provider, chainId } = await connectProvider(config.rpcUrl);
  assertSafeKeys(config, chainId);
  const verifier = new Wallet(config.verifierPrivateKey, provider);
  const backendUrl = process.env.CRE_BACKEND_URL ?? `http://127.0.0.1:${config.port}`;

  const stack = await deployCreStack(provider, verifier);
  writeCreConfig(stack, verifier.address, backendUrl);

  console.log("Chainlink CRE settlement stack ready (chainId 31337, chain-selector anvil-devnet)");
  console.log(`  MockKeystoneForwarder : ${stack.forwarder} ${stack.deployed.forwarder ? "(deployed)" : "(reused)"}`);
  console.log(`  MachineTaskEscrow     : ${stack.escrow} ${stack.deployed.escrow ? "(deployed)" : "(reused)"}  creForwarder ✓`);
  console.log(`  CRE transmitter       : ${stack.transmitter}`);
  console.log(`  workflow config       : ${CRE_WORKFLOW_CONFIG} (backendUrl ${backendUrl})`);
  console.log(`  backend deployment    : deployments/localhost.json`);
  provider.destroy();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
