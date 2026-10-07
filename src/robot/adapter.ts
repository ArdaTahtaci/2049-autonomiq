import type { Signer } from "ethers";
import { signProof, type Vec3 } from "../proof";
import { generateMockProof, type MockOutcome } from "./mockProof";

/** What the backend asks a robot (or simulator) to do. */
export interface RobotExecutionRequest {
  task_id: string;
  robot_id: string;
  start_position: Vec3;
  target_position: Vec3;
  tolerance: number;
  /** Mock adapter only: which outcome to simulate. */
  mock_outcome?: MockOutcome;
}

/** Where a robot delivers its signed proof — same payload as POST /tasks/:taskId/proof. */
export type ProofSink = (taskId: string, submission: { proof: unknown; signature: string; proof_hash?: string }) => Promise<unknown>;

/**
 * Boundary between the backend and the robotics layer.
 * `execute` only kicks off execution; the proof arrives asynchronously through the sink
 * (mock) or over HTTP POST /tasks/:taskId/proof (real simulator).
 */
export interface RobotAdapter {
  readonly name: string;
  execute(request: RobotExecutionRequest, sink: ProofSink): void;
}

/** Simulates the robot in-process: produces a realistic proof, signs it with the robot key, submits it. */
export class MockRobotAdapter implements RobotAdapter {
  readonly name = "mock";

  constructor(
    private readonly robotSigner: Signer,
    private readonly delayMs = 1500,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  execute(request: RobotExecutionRequest, sink: ProofSink): void {
    const outcome = request.mock_outcome ?? "success";
    setTimeout(() => {
      void (async () => {
        const proof = generateMockProof(request, outcome);
        const { proof_hash, signature } = await signProof(proof, this.robotSigner);
        await sink(request.task_id, { proof, signature, proof_hash });
      })().catch((err: unknown) => {
        this.log(`[mock-robot] proof submission for ${request.task_id} failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.delayMs);
  }
}

/**
 * Real simulator integration: the backend does nothing on start; the external simulator
 * (or `npm run robot:submit`) POSTs the signed proof to /tasks/:taskId/proof.
 */
export class ExternalRobotAdapter implements RobotAdapter {
  readonly name = "external";

  constructor(private readonly log: (msg: string) => void = () => {}) {}

  execute(request: RobotExecutionRequest): void {
    this.log(`[external-robot] waiting for simulator proof: POST /tasks/${request.task_id}/proof`);
  }
}
