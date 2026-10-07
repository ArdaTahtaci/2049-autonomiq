#!/usr/bin/env python3
"""Reliability sweep: random start/target pairs across the workspace.

    python tools/sweep.py 300          # pairs 0..299
    python tools/sweep.py 100 200      # pairs 100..199 (run slices in parallel shells)

Pair i is generated from seed i, so every run of the sweep tests the same pairs.
"""

import math
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from robot_sim.config import (  # noqa: E402
    WORKSPACE_MAX_ANGLE_DEG, WORKSPACE_MAX_R, WORKSPACE_MIN_R, TaskConfig,
)
from robot_sim.sim import run_task  # noqa: E402


def random_point(rng: random.Random) -> tuple[float, float, float]:
    r = rng.uniform(WORKSPACE_MIN_R, WORKSPACE_MAX_R)
    a = math.radians(WORKSPACE_MAX_ANGLE_DEG)
    th = rng.uniform(-a, a)
    return (round(r * math.cos(th), 3), round(r * math.sin(th), 3), 0.0)


def pair(i: int):
    rng = random.Random(i)
    while True:
        a, b = random_point(rng), random_point(rng)
        if math.dist(a, b) > 0.1:
            return a, b


def main() -> int:
    args = [int(v) for v in sys.argv[1:]] or [100]
    lo, hi = (0, args[0]) if len(args) == 1 else (args[0], args[1])
    errors, failures = [], []
    for i in range(lo, hi):
        a, b = pair(i)
        r = run_task(TaskConfig(object_start=a, target=b, timestamp="2026-01-01T00:00:00Z"))
        status = "OK  " if r["success"] else "FAIL"
        print(f"{i:4d} {status} {a[:2]} -> {b[:2]}  error {r['distance_to_target_m']:.4f} m", flush=True)
        (errors if r["success"] else failures).append(r["distance_to_target_m"])
    errors.sort()
    n = hi - lo
    print(f"\n{len(errors)}/{n} succeeded")
    if errors:
        print(f"error median {errors[len(errors) // 2]:.4f} m, "
              f"p95 {errors[int(len(errors) * 0.95)]:.4f} m, max {errors[-1]:.4f} m")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
