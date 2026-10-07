/**
 * Deploys MachineTaskEscrow to RPC_URL (default: local Hardhat node) and records the address in
 * deployments/localhost.json, where the backend picks it up.
 *
 *   npm run chain     # terminal 1
 *   npm run deploy    # terminal 2
 */
import { Wallet } from "ethers";
import { deployEscrow } from "../src/chain/escrow";
import { connectProvider, writeDeployment, DEPLOYMENT_FILE } from "../src/chain/provider";
import { assertSafeKeys, loadConfig } from "../src/config";

async function main(): Promise<void> {
  const config = loadConfig();
  const { provider, chainId } = await connectProvider(config.rpcUrl);
  assertSafeKeys(config, chainId);

  const verifier = new Wallet(config.verifierPrivateKey, provider);
  const escrow = await deployEscrow(verifier, verifier.address);
  const receipt = await escrow.deploymentTransaction()?.wait();
  const address = await escrow.getAddress();

  writeDeployment({
    chain_id: chainId.toString(),
    escrow_address: address,
    verifier: verifier.address,
    tx_hash: receipt?.hash ?? "",
    block_number: receipt?.blockNumber ?? 0,
    deployed_at: new Date().toISOString(),
  });

  console.log(`MachineTaskEscrow deployed`);
  console.log(`  address  : ${address}`);
  console.log(`  verifier : ${verifier.address}`);
  console.log(`  chainId  : ${chainId}`);
  console.log(`  tx       : ${receipt?.hash}`);
  console.log(`  saved to : ${DEPLOYMENT_FILE}`);
  provider.destroy();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
