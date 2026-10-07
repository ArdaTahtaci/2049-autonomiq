/**
 * Test fixtures built with the BACKEND's own code (mock robot, signer, spec hash), so the
 * workflow tests double as cross-implementation compatibility tests.
 *
 * All keys are Hardhat's public development keys — never use them on a real network.
 */
import { Wallet } from "ethers";
import { keccak256, stringToBytes } from "viem";
import { signProof } from "../../src/proof/signature";
import { computeTaskSpecHash as backendTaskSpecHash } from "../../src/proof/taskSpec";
import { type MockOutcome, generateMockProof } from "../../src/robot/mockProof";
import type { OnchainTask } from "./policy";

/** Hardhat dev account #2 — the robot's signing identity. */
export const ROBOT_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
export const ROBOT_ADDRESS = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
/** Hardhat dev account #3 — an impostor key that is NOT the on-chain robot. */
export const IMPOSTOR_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
export const REQUESTER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const PAYEE = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
export const ZERO_HASH = `0x${"0".repeat(64)}` as const;
export const ONE_ETH = 10n ** 18n;

export interface TaskSpec {
  task_id: string;
  robot_id: string;
  start_position: { x: number; y: number; z: number };
  target_position: { x: number; y: number; z: number };
  tolerance: number;
  created_at: string;
}

export const SPEC: TaskSpec = {
  task_id: "task_ab12cd34",
  robot_id: "robot_001",
  start_position: { x: 0, y: 0, z: 0 },
  target_position: { x: 1, y: 0, z: 0 },
  tolerance: 0.05,
  created_at: "2026-10-07T09:24:46.123Z",
};

export const PROOF_TIME = new Date("2026-10-07T09:25:30.000Z");

/** Deterministic LCG in [0, 1) so generated proofs are reproducible. */
export function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export interface Submission {
  proof: Record<string, unknown>;
  signature: string;
  proof_hash: string;
}

/** Mock robot run + robot signature, exactly as the robot/backend produce them. */
export async function makeSubmission(
  outcome: MockOutcome,
  opts: { seed?: number; key?: string; spec?: TaskSpec; now?: Date } = {},
): Promise<Submission> {
  const spec = opts.spec ?? SPEC;
  const proof = generateMockProof(spec, outcome, { rng: seededRng(opts.seed ?? 7), now: opts.now ?? PROOF_TIME });
  return signRaw(proof as unknown as Record<string, unknown>, opts.key ?? ROBOT_KEY);
}

/** Signs an arbitrary (possibly hand-modified) proof object. */
export async function signRaw(proof: Record<string, unknown>, key = ROBOT_KEY): Promise<Submission> {
  const { proof_hash, signature } = await signProof(proof, new Wallet(key));
  return { proof, signature, proof_hash };
}

export const onchainTaskIdOf = (taskId: string) => keccak256(stringToBytes(taskId));

/** What GET /cre/tasks/:id/evidence returns. */
export function makeEvidence(submission: Submission, spec: TaskSpec = SPEC) {
  return {
    task: {
      ...spec,
      onchain_task_id: onchainTaskIdOf(spec.task_id),
      spec_hash: backendTaskSpecHash(spec),
    },
    submission: { proof: submission.proof, signature: submission.signature, proof_hash: submission.proof_hash },
  };
}

/** A freshly funded escrow whose spec anchor was computed by the backend at funding time. */
export function fundedOnchain(spec: TaskSpec = SPEC, robot = ROBOT_ADDRESS): { task: OnchainTask; specHash: string } {
  return {
    task: { requester: REQUESTER, robot, payee: PAYEE, amount: ONE_ETH, proofHash: ZERO_HASH, status: 1 },
    specHash: backendTaskSpecHash(spec),
  };
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
