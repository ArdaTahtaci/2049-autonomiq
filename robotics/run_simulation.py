#!/usr/bin/env python3
"""One command: reset -> run task -> robot executes -> result written to output.json.

Examples:
    python run_simulation.py
    python run_simulation.py --gui                       # watch it in a 3D window
    python run_simulation.py --record demo.gif           # save an animation
    python run_simulation.py --start 0.4,0.2 --target 0.6,-0.2
    python run_simulation.py --fault drop_in_transit     # produces success=false
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from robot_sim.config import FAULTS, TaskConfig
from robot_sim.sim import run_task


def _point(s: str) -> tuple[float, float, float]:
    parts = [float(v) for v in s.split(",")]
    if len(parts) == 2:
        parts.append(0.0)
    if len(parts) != 3:
        raise argparse.ArgumentTypeError("expected x,y or x,y,z")
    return tuple(parts)


def main(argv=None) -> int:
    d = TaskConfig()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--task-id", default=d.task_id)
    ap.add_argument("--robot-id", default=d.robot_id)
    ap.add_argument("--start", type=_point, default=d.object_start, help="object start x,y[,z] (m)")
    ap.add_argument("--target", type=_point, default=d.target, help="target x,y[,z] (m)")
    ap.add_argument("--tolerance", type=float, default=d.tolerance_m, help="success tolerance (m)")
    ap.add_argument("--fault", choices=FAULTS, default="none", help="inject a failure for demos")
    ap.add_argument("--timestamp", help="fixed ISO-8601 timestamp (default: now, UTC)")
    ap.add_argument("--output", default="output.json", help="where to write the proof JSON")
    ap.add_argument("--gui", action="store_true", help="open the PyBullet 3D viewer (real time)")
    ap.add_argument("--record", metavar="GIF", help="save an animated GIF of the run")
    args = ap.parse_args(argv)

    cfg = TaskConfig(
        task_id=args.task_id, robot_id=args.robot_id, object_start=args.start,
        target=args.target, tolerance_m=args.tolerance, fault=args.fault, timestamp=args.timestamp,
    )
    try:
        proof = run_task(cfg, gui=args.gui, record_path=args.record)
    except ValueError as e:
        print(f"invalid task: {e}", file=sys.stderr)
        return 2

    out = Path(args.output)
    out.write_text(json.dumps(proof, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    f = proof["final_object_position"]
    t = proof["target_position"]
    print(f"task {proof['task_id']}  robot {proof['robot_id']}  {proof['timestamp']}")
    print(f"  target  ({t['x']:.4f}, {t['y']:.4f}, {t['z']:.4f})")
    print(f"  final   ({f['x']:.4f}, {f['y']:.4f}, {f['z']:.4f})")
    print(f"  distance {proof['distance_to_target_m']:.4f} m  (tolerance {proof['tolerance_m']} m)")
    print(f"  success  {proof['success']}")
    print(f"  replay_hash {proof['replay_hash']}")
    print(f"  wrote {out}" + (f" and {args.record}" if args.record else ""))
    return 0 if proof["success"] else 1


if __name__ == "__main__":
    sys.exit(main())
