/**
 * Zod schemas for robot execution proofs.
 *
 * Field names are snake_case because the proof format is owned by the robotics
 * simulator team. Objects are "loose": unknown extra fields (trajectory, events,
 * sensor data, ...) are accepted and preserved, never rejected — they are part of
 * the evidence and are covered by the proof hash.
 */
import { z } from "zod";

// zod v4 z.number() already rejects NaN and +/-Infinity.
export const Vec3Schema = z.looseObject({ x: z.number(), y: z.number(), z: z.number() });
export type Vec3 = { x: number; y: number; z: number };

export const RobotProofSchema = z.looseObject({
  task_id: z.string().min(1).max(128),
  robot_id: z.string().min(1).max(128),
  timestamp: z.iso.datetime({ offset: true }),
  start_position: Vec3Schema,
  target_position: Vec3Schema,
  final_object_position: Vec3Schema,
  success: z.boolean(),
});
export type RobotProof = z.infer<typeof RobotProofSchema>;

/** What a robot/simulator POSTs to the backend. */
export const ProofSubmissionSchema = z.object({
  // Only checked to be an object here; RobotProofSchema validates it separately
  // so schema errors can be reported against the proof itself.
  proof: z.record(z.string(), z.unknown()),
  // 65-byte EIP-191 (personal_sign) signature over the 32-byte proof hash.
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, "must be a 0x-prefixed 65-byte hex signature"),
  // Optional hash claimed by the robot; if present it must match the recomputed hash.
  proof_hash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex hash")
    .optional(),
});
export type ProofSubmission = z.infer<typeof ProofSubmissionSchema>;

/** Flattens a ZodError into human-readable "path: message" strings. */
export function formatZodError(err: z.ZodError): string[] {
  return err.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}
