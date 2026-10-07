/**
 * Deploys (or reuses) the local CRE settlement stack on the Hardhat chain:
 *   MockKeystoneForwarder  — what `cre workflow simulate --broadcast` writes through (cre/project.yaml)
 *   MachineTaskEscrow      — verifier = backend key, creForwarder = the forwarder above
 * Both come from dedicated accounts at nonce 0, so their addresses are deterministic and match the
 * committed CRE config. The workflow config (escrow + backend URL) is rewritten to match reality.
 */
import fs from "node:fs";
import path from "node:path";
import { Wallet, getAddress, type JsonRpcProvider } from "ethers";
import { MachineTaskEscrow__factory } from "../../typechain-types";
import { deployEscrow } from "../chain/escrow";
import { writeDeployment } from "../chain/provider";
import { LOCAL_CHAIN_ID } from "../config";
import { PROJECT_ROOT } from "../paths";
import { LOCAL_CRE, deployMockForwarder } from "./forwarder";

export const CRE_PROJECT_DIR = path.join(PROJECT_ROOT, "cre");
export const CRE_WORKFLOW_DIR = path.join(CRE_PROJECT_DIR, "machineproof-settlement");
export const CRE_WORKFLOW_CONFIG = path.join(CRE_WORKFLOW_DIR, "config.local.json");

export interface CreStack {
  forwarder: string;
  escrow: string;
  transmitter: string;
  deployed: { forwarder: boolean; escrow: boolean };
}

async function deployAtDeterministicAddress(
  provider: JsonRpcProvider,
  deployerKey: string,
  expected: string,
  label: string,
  deploy: (deployer: Wallet) => Promise<{ getAddress(): Promise<string> }>,
): Promise<boolean> {
  if ((await provider.getCode(expected)) !== "0x") return false;
  const deployer = new Wallet(deployerKey, provider);
  const nonce = await provider.getTransactionCount(deployer.address);
  if (nonce !== 0) {
    throw new Error(
      `${label} is expected at ${expected} (first deployment of ${deployer.address}), but that account already sent ${nonce} txs. ` +
        `Restart the local chain (npm run chain) and run npm run cre:deploy again.`,
    );
  }
  const contract = await deploy(deployer);
  const actual = getAddress(await contract.getAddress());
  if (actual !== getAddress(expected)) throw new Error(`${label} deployed at ${actual}, expected ${expected}`);
  return true;
}

export async function deployCreStack(provider: JsonRpcProvider, verifier: Wallet): Promise<CreStack> {
  const { chainId } = await provider.getNetwork();
  if (chainId !== LOCAL_CHAIN_ID) {
    throw new Error(`The local CRE target uses chain-selector anvil-devnet (chainId 31337); RPC is chainId ${chainId}`);
  }

  const forwarderDeployed = await deployAtDeterministicAddress(
    provider,
    LOCAL_CRE.forwarderDeployerKey,
    LOCAL_CRE.forwarderAddress,
    "MockKeystoneForwarder",
    (d) => deployMockForwarder(d),
  );
  const escrowDeployed = await deployAtDeterministicAddress(
    provider,
    LOCAL_CRE.escrowDeployerKey,
    LOCAL_CRE.escrowAddress,
    "MachineTaskEscrow",
    (d) => deployEscrow(d, verifier.address),
  );

  const escrow = MachineTaskEscrow__factory.connect(LOCAL_CRE.escrowAddress, verifier);
  if (getAddress(await escrow.verifier()) !== verifier.address) {
    throw new Error(`Escrow ${LOCAL_CRE.escrowAddress} has a different verifier; restart the local chain`);
  }
  if (getAddress(await escrow.creForwarder()) !== getAddress(LOCAL_CRE.forwarderAddress)) {
    await (await escrow.setCreForwarder(LOCAL_CRE.forwarderAddress)).wait();
  }

  return {
    forwarder: LOCAL_CRE.forwarderAddress,
    escrow: LOCAL_CRE.escrowAddress,
    transmitter: LOCAL_CRE.transmitterAddress,
    deployed: { forwarder: forwarderDeployed, escrow: escrowDeployed },
  };
}

/** Records the stack for the backend (deployments/localhost.json) and the workflow (config.local.json). */
export function writeCreConfig(stack: CreStack, verifier: string, backendUrl: string): void {
  writeDeployment({
    chain_id: LOCAL_CHAIN_ID.toString(),
    escrow_address: stack.escrow,
    verifier,
    tx_hash: "",
    block_number: 0,
    deployed_at: new Date().toISOString(),
    cre_forwarder: stack.forwarder,
  });
  const config = JSON.parse(fs.readFileSync(CRE_WORKFLOW_CONFIG, "utf8")) as Record<string, unknown>;
  config.escrowAddress = stack.escrow;
  config.backendUrl = backendUrl;
  fs.writeFileSync(CRE_WORKFLOW_CONFIG, JSON.stringify(config, null, 2) + "\n");
}
