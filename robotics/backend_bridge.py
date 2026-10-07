#!/usr/bin/env python3
"""Run a MachineProof backend task in the PyBullet simulator and submit the proof.

    python backend_bridge.py <task_id> [--api http://127.0.0.1:3000] [--fault drop_in_transit]
                             [--record results/<task_id>.gif] [--no-submit]

1. GET  /tasks/<task_id>           read robot_id, start/target position and tolerance
2. POST /tasks/<task_id>/start     only if the task is FUNDED (marks it RUNNING)
3. run the simulation with exactly those parameters, write results/<task_id>.json
4. `npm run robot:submit -- results/<task_id>.json`: the repo's robot gateway
   canonicalizes (RFC 8785), hashes (keccak256), signs (EIP-191, ROBOT_PRIVATE_KEY)
   and POSTs the proof to /tasks/<task_id>/proof

Run the backend with ROBOT_ADAPTER=external so it waits for this proof instead of
running its mock robot. Uses only the standard library besides the simulator.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

from robot_sim.config import FAULTS, TaskConfig
from robot_sim.sim import run_task

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent  # robotics/ lives inside the MachineProof repo


def _call(method: str, url: str) -> dict:
    req = urllib.request.Request(url, method=method, headers={"content-type": "application/json"},
                                 data=b"{}" if method == "POST" else None)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {url} -> HTTP {e.code}: {e.read().decode(errors='replace')}")
    except urllib.error.URLError as e:
        raise SystemExit(f"{method} {url} failed: {e.reason} (is the backend running?)")


def _vec(d: dict) -> tuple[float, float, float]:
    return (float(d["x"]), float(d["y"]), float(d["z"]))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("task_id")
    ap.add_argument("--api", default="http://127.0.0.1:3000", help="MachineProof backend URL")
    ap.add_argument("--fault", choices=FAULTS, default="none", help="inject a failure (demo)")
    ap.add_argument("--record", metavar="GIF", help="also save an animation of the run")
    ap.add_argument("--no-submit", action="store_true", help="only run the simulation and write the proof")
    args = ap.parse_args(argv)

    api = args.api.rstrip("/")
    task = _call("GET", f"{api}/tasks/{args.task_id}")
    print(f"task {task['task_id']}  status {task['status']}  robot {task['robot_id']}")
    print(f"  {task['start_position']} -> {task['target_position']}  tolerance {task['tolerance']} m")

    cfg = TaskConfig(
        task_id=task["task_id"], robot_id=task["robot_id"],
        object_start=_vec(task["start_position"]), target=_vec(task["target_position"]),
        tolerance_m=float(task["tolerance"]), fault=args.fault,
    )
    try:
        cfg.validate()  # before touching the task, so an unsimulatable task stays FUNDED
    except ValueError as e:
        print(f"cannot simulate this task: {e}", file=sys.stderr)
        return 2

    if task["status"] == "FUNDED":
        task = _call("POST", f"{api}/tasks/{args.task_id}/start")
        print(f"  started, status {task['status']}")

    proof = run_task(cfg, record_path=args.record)

    out_dir = HERE / "results"
    out_dir.mkdir(exist_ok=True)
    out = out_dir / f"{cfg.task_id}.json"
    out.write_text(json.dumps(proof, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"  simulated: final {proof['final_object_position']}  distance "
          f"{proof['distance_to_target_m']} m  success {proof['success']}")
    print(f"  proof written to {out.relative_to(REPO_ROOT) if out.is_relative_to(REPO_ROOT) else out}")

    if args.no_submit:
        return 0
    print("  submitting via `npm run robot:submit` (sign + POST)")
    r = subprocess.run(["npm", "run", "--silent", "robot:submit", "--", str(out), "--api", api], cwd=REPO_ROOT)
    return r.returncode


if __name__ == "__main__":
    sys.exit(main())
