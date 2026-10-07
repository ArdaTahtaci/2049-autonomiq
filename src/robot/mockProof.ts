/**
 * Mock robotics simulator output for a pick-and-place task (A -> B).
 *
 * Produces proofs in exactly the format the real simulator emits (required fields plus
 * optional `trajectory`, `events`, `duration_ms`, `simulator`), so swapping mock -> real
 * changes nothing downstream.
 *
 * `start_position` / `target_position` echo the task spec verbatim (the verifier checks
 * they match the task); simulated coordinates are in meters, rounded to 4 decimals.
 */
import type { RobotProof, Vec3 } from "../proof/schema";
import { distance3d } from "../proof/physical";

export type MockOutcome = "success" | "failure" | "false_success";
export const MOCK_OUTCOMES: readonly MockOutcome[] = ["success", "failure", "false_success"] as const;

export interface MockTaskSpec {
  task_id: string;
  robot_id: string;
  start_position: Vec3;
  target_position: Vec3;
  tolerance: number;
}

export interface MockProofOptions {
  rng?: () => number; // uniform [0, 1); inject a seeded generator for deterministic tests
  now?: Date;
}

type Gripper = "open" | "closed";
type EventType = "GRASP" | "LIFT" | "MOVE" | "PLACE" | "RELEASE" | "DROP";
interface Waypoint {
  t_ms: number;
  x: number;
  y: number;
  z: number;
  gripper: Gripper;
}
interface SimEvent {
  t_ms: number;
  type: EventType;
}

const LIFT_HEIGHT_M = 0.15;
const MOVE_STEPS = 5;

const round4 = (n: number): number => {
  const r = Math.round(n * 1e4) / 1e4;
  return r === 0 ? 0 : r; // normalize -0
};
const roundVec = (v: Vec3): Vec3 => ({ x: round4(v.x), y: round4(v.y), z: round4(v.z) });
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});
const lifted = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z + LIFT_HEIGHT_M });

/** Point at `radius` from `center` in a random horizontal direction (object rests on the surface). */
function offsetXY(center: Vec3, radius: number, rng: () => number): Vec3 {
  const angle = rng() * 2 * Math.PI;
  return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle), z: center.z };
}

function finalPosition(spec: MockTaskSpec, outcome: MockOutcome, rng: () => number): { final: Vec3; dropFraction?: number } {
  const { start_position: start, target_position: target, tolerance } = spec;
  switch (outcome) {
    case "success": {
      // Noise well inside tolerance (<= 40%).
      const final = roundVec(offsetXY(target, rng() * 0.4 * tolerance, rng));
      // Guard against 4-decimal rounding pushing a tiny-tolerance placement outside the band.
      return { final: distance3d(final, target) <= 0.4 * tolerance ? final : { ...target } };
    }
    case "false_success": {
      // Clearly outside tolerance (>= 3x, with margin for rounding; at least 1 cm).
      const radius = Math.max((3.2 + 1.8 * rng()) * tolerance, 0.01);
      return { final: roundVec(offsetXY(target, radius, rng)) };
    }
    case "failure": {
      // Object slips out of the gripper 35-65% of the way and lands on the ground.
      const dropFraction = 0.35 + 0.3 * rng();
      const p = lerp(start, target, dropFraction);
      return { final: roundVec({ x: p.x, y: p.y, z: 0 }), dropFraction };
    }
  }
}

export function generateMockProof(spec: MockTaskSpec, outcome: MockOutcome, options: MockProofOptions = {}): RobotProof {
  if (!MOCK_OUTCOMES.includes(outcome)) {
    throw new Error(`unknown mock outcome: ${String(outcome)}`);
  }
  if (!Number.isFinite(spec.tolerance) || spec.tolerance < 0) {
    throw new RangeError(`tolerance must be a finite number >= 0, got ${String(spec.tolerance)}`);
  }
  const rng = options.rng ?? Math.random;
  const timestamp = (options.now ?? new Date()).toISOString();

  const { final, dropFraction } = finalPosition(spec, outcome, rng);
  const start = spec.start_position;
  const startHigh = lifted(start);
  const placeHigh = lifted(final);

  const trajectory: Waypoint[] = [];
  const events: SimEvent[] = [];
  let t = 0;
  const step = (baseMs: number): number => (t += Math.round(baseMs + rng() * baseMs * 0.25));
  const waypoint = (p: Vec3, gripper: Gripper): void => {
    const r = roundVec(p);
    trajectory.push({ t_ms: t, x: r.x, y: r.y, z: r.z, gripper });
  };
  const event = (type: EventType): void => {
    events.push({ t_ms: t, type });
  };

  // Approach + grasp at A, then lift.
  waypoint(start, "open");
  step(400);
  waypoint(start, "closed");
  event("GRASP");
  step(500);
  waypoint(startHigh, "closed");
  event("LIFT");
  event("MOVE");

  if (dropFraction !== undefined) {
    // Carry toward B, object slips at dropFraction; arm halts above the drop point.
    const targetHigh = lifted(spec.target_position);
    for (let i = 1; i <= MOVE_STEPS; i++) {
      const f = i / MOVE_STEPS;
      if (f >= dropFraction) break;
      step(350);
      waypoint(lerp(startHigh, targetHigh, f), "closed");
    }
    step(350);
    const dropPoint = lerp(startHigh, targetHigh, dropFraction);
    waypoint(dropPoint, "closed");
    event("DROP");
    step(300);
    waypoint(dropPoint, "open"); // controller opens the (empty) gripper and aborts
  } else {
    // Carry to above B, lower, place, release, retreat.
    for (let i = 1; i <= MOVE_STEPS; i++) {
      step(350);
      waypoint(lerp(startHigh, placeHigh, i / MOVE_STEPS), "closed");
    }
    step(500);
    waypoint(final, "closed");
    event("PLACE");
    step(250);
    waypoint(final, "open");
    event("RELEASE");
    step(400);
    waypoint(placeHigh, "open");
  }

  return {
    task_id: spec.task_id,
    robot_id: spec.robot_id,
    timestamp,
    start_position: { ...spec.start_position },
    target_position: { ...spec.target_position },
    final_object_position: final,
    success: outcome !== "failure",
    trajectory,
    events,
    duration_ms: t,
    simulator: { name: "mock-sim", version: "0.1.0" },
  };
}
