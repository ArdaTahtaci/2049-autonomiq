/**
 * Deploys MachineTaskEscrow to RPC_URL and records it in deployments/localhost.json.
 *
 *   Local:   npm run chain  (terminal 1)  →  npm run deploy  (terminal 2)
 *   Testnet: RPC_URL=https://… VERIFIER_PRIVATE_KEY=0x… npm run deploy
 *            then copy the printed ESCROW_ADDRESS / ESCROW_DEPLOY_BLOCK into the Render dashboard.
 *
 * Optional: CRE_FORWARDER_ADDRESS=0x… also points the escrow at a Chainlink forwarder (CRE settlement).
 */
import { Wallet, formatEther, getAddress, isAddress } from "ethers";
import { deployEscrow } from "../src/chain/escrow";
import { DEPLOYMENT_FILE, connectProvider, isLocalRpc, writeDeployment } from "../src/chain/provider";
import { assertSafeKeys, loadConfig } from "../src/config";

async function main(): Promise<void> {
  const config = loadConfig();
  const { provider, chainId } = await connectProvider(config.rpcUrl);
  assertSafeKeys(config, chainId);

  const verifier = new Wallet(config.verifierPrivateKey, provider);
  const balance = await provider.getBalance(verifier.address);
  if (balance === 0n) {
    throw new Error(`Deployer/verifier ${verifier.address} has no funds on chainId ${chainId}. Fund it (e.g. a Sepolia faucet) and retry.`);
  }

  const escrow = await deployEscrow(verifier, verifier.address);
  const receipt = await escrow.deploymentTransaction()?.wait();
  const address = await escrow.getAddress();

  const forwarder = process.env.CRE_FORWARDER_ADDRESS;
  if (forwarder) {
    if (!isAddress(forwarder)) throw new Error(`CRE_FORWARDER_ADDRESS is not an address: ${forwarder}`);
    await (await escrow.setCreForwarder(getAddress(forwarder))).wait();
  }

  writeDeployment({
    chain_id: chainId.toString(),
    escrow_address: address,
    verifier: verifier.address,
    tx_hash: receipt?.hash ?? "",
    block_number: receipt?.blockNumber ?? 0,
    deployed_at: new Date().toISOString(),
    ...(forwarder ? { cre_forwarder: getAddress(forwarder) } : {}),
  });

  console.log(`MachineTaskEscrow deployed`);
  console.log(`  address  : ${address}`);
  console.log(`  verifier : ${verifier.address} (balance ${formatEther(balance)} ETH before deploy)`);
  console.log(`  chainId  : ${chainId} via ${new URL(config.rpcUrl).origin}`);
  console.log(`  tx       : ${receipt?.hash} (block ${receipt?.blockNumber})`);
  if (forwarder) console.log(`  creForwarder : ${getAddress(forwarder)}`);
  console.log(`  saved to : ${DEPLOYMENT_FILE}`);
  if (!isLocalRpc(config.rpcUrl)) {
    console.log(`\nSet these on the Render service (Environment):`);
    console.log(`  ESCROW_ADDRESS=${address}`);
    console.log(`  ESCROW_DEPLOY_BLOCK=${receipt?.blockNumber ?? 0}`);
  }
  provider.destroy();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
