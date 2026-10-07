/**
 * Task spec hash: the task's acceptance criteria, anchored on-chain when the escrow is funded
 * (MachineTaskEscrow.fundTaskWithSpec). The CRE workflow recomputes it from the evidence the backend
 * serves and compares it with the on-chain anchor, so an off-chain store cannot quietly change the
 * target or tolerance after the requester funded the task.
 *
 *   spec_hash = keccak256(utf8(canonicalize({ task_id, robot_id, start_position, target_position, tolerance, created_at })))
 */
import { keccak256, toUtf8Bytes } from "ethers";
import { canonicalize } from "./canonicalize";
import type { Vec3 } from "./schema";

export interface TaskSpec {
  task_id: string;
  robot_id: string;
  start_position: Vec3;
  target_position: Vec3;
  tolerance: number;
  created_at: string;
}

/** Picks exactly the anchored fields (extra properties on `task` are ignored). */
export function taskSpecOf(task: TaskSpec): TaskSpec {
  const { task_id, robot_id, start_position, target_position, tolerance, created_at } = task;
  const vec = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });
  return { task_id, robot_id, start_position: vec(start_position), target_position: vec(target_position), tolerance, created_at };
}

export function computeTaskSpecHash(task: TaskSpec): string {
  return keccak256(toUtf8Bytes(canonicalize(taskSpecOf(task))));
}
