import fs from "node:fs";
import path from "node:path";
import { JsonRpcProvider, Network } from "ethers";
import { PROJECT_ROOT } from "../paths";

export const DEPLOYMENT_FILE = path.join(PROJECT_ROOT, "deployments", "localhost.json");

export interface DeploymentRecord {
  chain_id: string;
  escrow_address: string;
  verifier: string;
  tx_hash: string;
  block_number: number;
  deployed_at: string;
  /** Set by `npm run cre:deploy`: the Chainlink forwarder the escrow accepts CRE reports from. */
  cre_forwarder?: string;
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

/** True for RPC URLs on this machine (local Hardhat node). */
export function isLocalRpc(rpcUrl: string): boolean {
  const host = new URL(rpcUrl).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/**
 * Provider pinned to a known chain id (no background network detection).
 * cacheTimeout -1 disables ethers' 250 ms request cache, which otherwise returns a stale
 * "pending" nonce for back-to-back transactions from the same wallet (commit → settle).
 * Local nodes automine, so receipts are polled fast; hosted RPCs (testnets, ~12 s blocks, rate
 * limits) get a longer connect timeout and gentler polling.
 */
export async function connectProvider(rpcUrl: string): Promise<{ provider: JsonRpcProvider; chainId: bigint }> {
  const local = isLocalRpc(rpcUrl);
  const chainId = await probeChainId(rpcUrl, local ? 2_000 : 10_000);
  if (chainId === undefined) {
    throw new Error(
      local
        ? `Cannot reach an Ethereum node at ${rpcUrl}. Start the local chain first: npm run chain`
        : `Cannot reach the RPC endpoint at ${new URL(rpcUrl).origin} (check RPC_URL).`,
    );
  }
  const provider = new JsonRpcProvider(rpcUrl, Network.from(chainId), {
    staticNetwork: true,
    pollingInterval: local ? 250 : 2_000,
    cacheTimeout: -1,
  });
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
