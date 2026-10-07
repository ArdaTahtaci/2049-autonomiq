/**
 * Physical success check: the verdict is computed by the verifier from the coordinates the
 * robot/simulator measured, never taken from its self-reported `success` flag. (The coordinates
 * themselves are still robot-reported; see the trust model in the README.)
 */
import type { Vec3 } from "./schema";

/** Euclidean distance in meters. */
export function distance3d(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** 1 nanometer: far below any physical tolerance, far above float rounding error. */
export const PLACEMENT_EPSILON_M = 1e-9;

export interface PlacementCheck {
  distance: number;
  tolerance: number;
  within_tolerance: boolean;
}

export function checkPlacement(finalObjectPosition: Vec3, targetPosition: Vec3, tolerance: number): PlacementCheck {
  if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError(`tolerance must be a finite number >= 0, got ${String(tolerance)}`);
  }
  const distance = distance3d(finalObjectPosition, targetPosition);
  // Boundary is inclusive; the epsilon keeps decimal boundaries (|1.05 - 1| = 0.050000000000000044)
  // from failing on binary floating-point noise.
  return { distance, tolerance, within_tolerance: distance <= tolerance + PLACEMENT_EPSILON_M };
}

/** Per-axis comparison with a small epsilon to absorb float round-tripping. */
export function positionsMatch(a: Vec3, b: Vec3, epsilon = 1e-9): boolean {
  return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon && Math.abs(a.z - b.z) <= epsilon;
}
