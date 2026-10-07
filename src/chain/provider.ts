import fs from "node:fs";
import path from "node:path";
import { JsonRpcProvider, Network } from "ethers";

export const DEPLOYMENT_FILE = path.resolve(__dirname, "../../deployments/localhost.json");

export interface DeploymentRecord {
  chain_id: string;
  escrow_address: string;
  verifier: string;
  tx_hash: string;
  block_number: number;
  deployed_at: string;
}

/** Asks the node for its chain id with a timeout, so a missing node fails fast with a clear message. */
export async function probeChainId(rpcUrl: string, timeoutMs = 2000): Promise<bigint | undefined> {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json()) as { result?: string };
    return body.result ? BigInt(body.result) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Provider pinned to a known chain id (no background network detection, fast receipt polling).
 * cacheTimeout -1 disables ethers' 250 ms request cache, which otherwise returns a stale
 * "pending" nonce for back-to-back transactions from the same wallet (commit → settle).
 */
export async function connectProvider(rpcUrl: string): Promise<{ provider: JsonRpcProvider; chainId: bigint }> {
  const chainId = await probeChainId(rpcUrl);
  if (chainId === undefined) {
    throw new Error(`Cannot reach an Ethereum node at ${rpcUrl}. Start the local chain first: npm run chain`);
  }
  const provider = new JsonRpcProvider(rpcUrl, Network.from(chainId), { staticNetwork: true, pollingInterval: 250, cacheTimeout: -1 });
  return { provider, chainId };
}

export function readDeployment(): DeploymentRecord | undefined {
  if (!fs.existsSync(DEPLOYMENT_FILE)) return undefined;
  return JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf8")) as DeploymentRecord;
}

export function writeDeployment(record: DeploymentRecord): void {
  fs.mkdirSync(path.dirname(DEPLOYMENT_FILE), { recursive: true });
  fs.writeFileSync(DEPLOYMENT_FILE, JSON.stringify(record, null, 2) + "\n");
}
