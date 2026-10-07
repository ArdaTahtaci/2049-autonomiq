#!/usr/bin/env python3
"""Independent checks on a proof file (what a verifier backend could do).

    python verify_proof.py output.json            # static checks
    python verify_proof.py output.json --replay   # also re-run the simulation and compare

Static checks: required fields, replay_hash matches content, the success flag
agrees with distance(final, target) <= tolerance, the event log contains the
expected sequence. Replay: re-executes the task from the parameters recorded in the
proof and requires an identical replay_hash (the simulation is deterministic).
"""

from __future__ import annotations

import argparse
import json
import math
import sys

from robot_sim.proof import canonical_json, replay_hash, sha256_hex

REQUIRED = (
    "task_id", "robot_id", "timestamp", "start_position", "target_position",
    "final_object_position", "success", "tolerance_m", "trajectory", "replay_hash",
)
EXPECTED_EVENTS = (
    "reset", "approach_started", "arrived_at_object", "object_grasped", "object_lifted",
    "transport_started", "arrived_at_target", "object_released", "object_at_rest",
    "final_state_measured",
)


def _vec(d: dict) -> tuple[float, float, float]:
    return (d["x"], d["y"], d["z"])


def static_checks(proof: dict) -> list[tuple[str, bool, str]]:
    results = []
    missing = [k for k in REQUIRED if k not in proof]
    results.append(("required fields present", not missing, f"missing: {missing}" if missing else ""))
    if missing:
        return results

    h = replay_hash(proof)
    results.append(("replay_hash matches content", h == proof["replay_hash"], h))

    dist = math.dist(_vec(proof["final_object_position"]), _vec(proof["target_position"]))
    expected = dist <= proof["tolerance_m"]
    results.append((
        "success flag consistent with measured distance",
        expected == proof["success"],
        f"distance={dist:.4f} tolerance={proof['tolerance_m']} -> {expected}",
    ))

    events = [e["event"] for e in proof["trajectory"] if "event" in e]
    it = iter(events)
    in_order = all(any(e == want for e in it) for want in EXPECTED_EVENTS)
    if proof["success"]:
        results.append(("event log shows full pick-and-place sequence", in_order, " > ".join(events)))
    else:
        results.append(("event log present", bool(events), " > ".join(events)))

    steps = [e["step"] for e in proof["trajectory"]]
    results.append(("trajectory steps monotonic", steps == sorted(steps), f"{len(steps)} entries"))
    return results


def replay_check(proof: dict) -> tuple[str, bool, str]:
    from robot_sim.config import TaskConfig
    from robot_sim.sim import run_task

    cfg = TaskConfig(
        task_id=proof["task_id"], robot_id=proof["robot_id"],
        object_start=_vec(proof["start_position"]), target=_vec(proof["target_position"]),
        tolerance_m=proof["tolerance_m"], fault=proof["task"]["fault_injection"],
        timestamp=proof["timestamp"],
        robot_start_joints=tuple(proof["robot_start_pose"]["joint_positions"]),
    )
    again = run_task(cfg)
    ok = again["replay_hash"] == proof["replay_hash"]
    return ("replay reproduces identical execution", ok, again["replay_hash"])


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("proof", nargs="?", default="output.json")
    ap.add_argument("--replay", action="store_true", help="re-run the simulation and compare")
    args = ap.parse_args(argv)

    with open(args.proof, encoding="utf-8") as f:
        proof = json.load(f)

    checks = static_checks(proof)
    if args.replay:
        checks.append(replay_check(proof))

    for name, ok, info in checks:
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f"  ({info})" if info else ""))
    print(f"\ntask success flag: {proof.get('success')}")
    print(f"sha256(canonical JSON of full proof): {sha256_hex(proof)}")
    print(f"canonical JSON size: {len(canonical_json(proof).encode())} bytes")
    return 0 if all(ok for _, ok, _ in checks) else 1


if __name__ == "__main__":
    sys.exit(main())
