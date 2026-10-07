import "dotenv/config";
import { Wallet, getAddress, isAddress, parseEther } from "ethers";
import { z } from "zod";

/**
 * Hardhat's built-in dev accounts (mnemonic "test test ... junk").
 * These keys are PUBLIC and for LOCAL DEVELOPMENT ONLY — never use them on a real network.
 * The backend refuses to start with them on any chain other than 31337 (see assertSafeKeys).
 */
export const HARDHAT_DEV_KEYS = {
  verifier: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // account #0 (deployer + verifier/oracle)
  requester: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // account #1 (funds tasks)
  robot: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // account #2 (robot signing identity)
  payee: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // account #3 (robot operator wallet)
} as const;

export const LOCAL_CHAIN_ID = 31337n;

const privateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex private key");
const address = z.string().refine((v) => isAddress(v), "must be an Ethereum address");

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  RPC_URL: z.url().default("http://127.0.0.1:8545"),
  ESCROW_ADDRESS: address.optional(),
  VERIFIER_PRIVATE_KEY: privateKey.default(HARDHAT_DEV_KEYS.verifier),
  REQUESTER_PRIVATE_KEY: privateKey.default(HARDHAT_DEV_KEYS.requester),
  ROBOT_PRIVATE_KEY: privateKey.default(HARDHAT_DEV_KEYS.robot),
  ROBOT_ID: z.string().min(1).default("robot_001"),
  ROBOT_ADDRESS: address.optional(),
  PAYEE_ADDRESS: address.optional(),
  ROBOT_ADAPTER: z.enum(["mock", "external"]).default("mock"),
  MOCK_ROBOT_DELAY_MS: z.coerce.number().int().min(0).default(1500),
  POSITION_TOLERANCE_M: z.coerce.number().positive().default(0.05),
  DEFAULT_REWARD_ETH: z.string().regex(/^\d+(\.\d+)?$/).default("0.1"),
});

export type RobotAdapterKind = "mock" | "external";

export interface AppConfig {
  port: number;
  rpcUrl: string;
  /** If unset, read from deployments/localhost.json (written by `npm run deploy`). */
  escrowAddress?: string;
  verifierPrivateKey: string;
  requesterPrivateKey: string;
  /** Used only by the mock robot adapter / robot-submit CLI to sign proofs as the robot. */
  robotPrivateKey: string;
  /** Robot registry: robot_id → address whose signature is accepted for that robot's proofs. */
  robots: Record<string, string>;
  defaultRobotId: string;
  payeeAddress: string;
  robotAdapter: RobotAdapterKind;
  mockRobotDelayMs: number;
  defaultTolerance: number;
  defaultRewardWei: bigint;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Blank entries (e.g. `ESCROW_ADDRESS=` copied from .env.example) mean "use the default".
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = EnvSchema.safeParse(present);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;
  const robotAddress = getAddress(e.ROBOT_ADDRESS ?? new Wallet(e.ROBOT_PRIVATE_KEY).address);

  return {
    port: e.PORT,
    rpcUrl: e.RPC_URL,
    escrowAddress: e.ESCROW_ADDRESS ? getAddress(e.ESCROW_ADDRESS) : undefined,
    verifierPrivateKey: e.VERIFIER_PRIVATE_KEY,
    requesterPrivateKey: e.REQUESTER_PRIVATE_KEY,
    robotPrivateKey: e.ROBOT_PRIVATE_KEY,
    robots: { [e.ROBOT_ID]: robotAddress },
    defaultRobotId: e.ROBOT_ID,
    payeeAddress: getAddress(e.PAYEE_ADDRESS ?? new Wallet(HARDHAT_DEV_KEYS.payee).address),
    robotAdapter: e.ROBOT_ADAPTER,
    mockRobotDelayMs: e.MOCK_ROBOT_DELAY_MS,
    defaultTolerance: e.POSITION_TOLERANCE_M,
    defaultRewardWei: parseEther(e.DEFAULT_REWARD_ETH),
  };
}

/** Refuse to use the publicly known Hardhat keys anywhere but the local dev chain. */
export function assertSafeKeys(config: AppConfig, chainId: bigint): void {
  if (chainId === LOCAL_CHAIN_ID) return;
  const devKeys = new Set<string>(Object.values(HARDHAT_DEV_KEYS).map((k) => k.toLowerCase()));
  const used = [config.verifierPrivateKey, config.requesterPrivateKey, config.robotPrivateKey];
  if (used.some((k) => devKeys.has(k.toLowerCase()))) {
    throw new Error(
      `Refusing to use public Hardhat dev keys on chainId ${chainId}. Set VERIFIER_PRIVATE_KEY, ` +
        `REQUESTER_PRIVATE_KEY and ROBOT_PRIVATE_KEY for non-local networks.`,
    );
  }
}
