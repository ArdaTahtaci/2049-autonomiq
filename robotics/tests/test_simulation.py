import copy
import json
import subprocess
import sys
from pathlib import Path

import pytest

from robot_sim.config import CUBE_HALF_EXTENT, TaskConfig
from robot_sim.proof import canonical_json, replay_hash, round_floats
from robot_sim.sim import run_task
from verify_proof import static_checks

ROOT = Path(__file__).resolve().parent.parent
TS = "2026-01-01T00:00:00Z"


@pytest.fixture(scope="module")
def proof():
    return run_task(TaskConfig(timestamp=TS))


def test_default_task_succeeds(proof):
    assert proof["success"] is True
    assert proof["distance_to_target_m"] <= proof["tolerance_m"]
    assert all(proof["checks"].values())


def test_spec_minimum_schema(proof):
    for key in ("task_id", "robot_id", "timestamp", "start_position", "target_position",
                "final_object_position", "success"):
        assert key in proof
    for key in ("start_position", "target_position", "final_object_position"):
        assert set(proof[key]) == {"x", "y", "z"}
        assert all(isinstance(v, float) for v in proof[key].values())
    assert isinstance(proof["success"], bool)


def test_proof_fits_cre_settlement_limit():
    # The backend rejects proofs over 16 000 canonical bytes when settling via Chainlink CRE.
    # Longest accepted task (A and B 1.5 m apart) produces the longest trajectory.
    longest = run_task(TaskConfig(object_start=(0.0, 0.0, 0.0), target=(1.49, 0.0, 0.0), timestamp=TS))
    assert len(canonical_json(longest).encode("utf-8")) < 14_000


def test_object_was_physically_moved(proof):
    t = proof["trajectory"]
    samples = [e for e in t if "object_position" in e and "event" not in e]
    events = [e["event"] for e in t if "event" in e]
    assert "object_grasped" in events and "object_released" in events
    assert events.index("object_grasped") < events.index("object_released")
    assert proof["metrics"]["max_object_height_m"] > 0.1  # it was lifted
    assert proof["metrics"]["object_path_length_m"] > 0.6  # it travelled A -> B
    # While carried, the object stays with the gripper.
    carried = [s for s in samples if s["phase"] == "transport"]
    assert carried
    for s in carried:
        # robot_position is the grip point (cube center); object_position is the cube's base.
        rx, ry, rz = s["robot_position"]
        ox, oy, oz = s["object_position"]
        assert max(abs(rx - ox), abs(ry - oy), abs(rz - CUBE_HALF_EXTENT - oz)) < 0.01


def test_deterministic_replay(proof):
    again = run_task(TaskConfig(timestamp=TS))
    assert canonical_json(again) == canonical_json(proof)
    assert again["replay_hash"] == proof["replay_hash"]


def test_replay_hash_ignores_only_timestamp(proof):
    other = run_task(TaskConfig(timestamp="2030-05-05T12:00:00Z"))
    assert other["replay_hash"] == proof["replay_hash"]
    assert canonical_json(other) != canonical_json(proof)


def test_deterministic_across_processes(tmp_path):
    outs = []
    for i in range(2):
        out = tmp_path / f"out{i}.json"
        subprocess.run(
            [sys.executable, "run_simulation.py", "--timestamp", TS, "--output", str(out)],
            cwd=ROOT, check=True, capture_output=True,
        )
        outs.append(out.read_bytes())
    assert outs[0] == outs[1]


def test_tampering_is_detected(proof):
    forged = copy.deepcopy(proof)
    forged["final_object_position"]["x"] += 0.2
    assert replay_hash(forged) != forged["replay_hash"]
    names = {n: ok for n, ok, _ in static_checks(forged)}
    assert not names["replay_hash matches content"]

    flipped = copy.deepcopy(run_task(TaskConfig(fault="no_grasp", timestamp=TS)))
    flipped["success"] = True
    names = {n: ok for n, ok, _ in static_checks(flipped)}
    assert not names["success flag consistent with measured distance"]


def test_verifier_passes_on_genuine_proof(proof):
    assert all(ok for _, ok, _ in static_checks(proof))


@pytest.mark.parametrize("fault", ["drop_in_transit", "no_grasp"])
def test_faults_produce_failure(fault):
    r = run_task(TaskConfig(fault=fault, timestamp=TS))
    assert r["success"] is False
    assert r["distance_to_target_m"] > r["tolerance_m"]
    assert all(ok for _, ok, _ in static_checks(r))


@pytest.mark.parametrize("start,target", [
    ((0.4, 0.2), (0.6, -0.2)),
    ((0.3, -0.4), (0.65, 0.1)),
    ((0.6, 0.0), (0.35, 0.35)),
    ((-0.1, 0.5), (0.5, -0.2)),
])
def test_various_positions(start, target):
    r = run_task(TaskConfig(object_start=(*start, 0.0), target=(*target, 0.0), timestamp=TS))
    assert r["success"] is True


@pytest.mark.parametrize("kwargs", [
    {"object_start": (0.0, 0.0, 0.0), "target": (2.0, 0.0, 0.0)},
    {"target": (0.5, 0.3, 0.5)},
    {"tolerance_m": 0},
    {"fault": "explode"},
    {"task_id": ""},
])
def test_invalid_config_rejected(kwargs):
    with pytest.raises(ValueError):
        run_task(TaskConfig(**kwargs))


def test_round_floats_normalizes():
    assert round_floats({"a": -0.00001, "b": (1.234567, 2)}) == {"a": 0.0, "b": [1.2346, 2]}
    assert canonical_json({"b": 1.0, "a": [0.5]}) == '{"a":[0.5],"b":1.0}'
    with pytest.raises(ValueError):
        round_floats(float("nan"))


def test_output_json_is_sorted_and_stable(tmp_path):
    out = tmp_path / "o.json"
    subprocess.run(
        [sys.executable, "run_simulation.py", "--timestamp", TS, "--output", str(out)],
        cwd=ROOT, check=True, capture_output=True,
    )
    data = json.loads(out.read_text())
    assert list(data) == sorted(data)


def test_spec_example_task_auto_places_robot():
    # The spec / MachineProof default task: (0,0,0) -> (1,0,0), outside a base-at-origin workspace.
    r = run_task(TaskConfig(object_start=(0.0, 0.0, 0.0), target=(1.0, 0.0, 0.0), timestamp=TS))
    assert r["success"] is True
    assert r["start_position"] == {"x": 0.0, "y": 0.0, "z": 0.0}
    assert r["target_position"] == {"x": 1.0, "y": 0.0, "z": 0.0}
    assert r["robot_start_pose"]["base_position"] != {"x": 0.0, "y": 0.0, "z": 0.0}
    assert all(ok for _, ok, _ in static_checks(r))


def test_frame_round_trip():
    from robot_sim.frame import place_robot

    base = place_robot((2.0, 3.0, 0.0), (2.4, 2.5, 0.0))
    p = (1.234, -0.5, 0.1)
    back = base.to_task(base.to_robot(p))
    assert max(abs(a - b) for a, b in zip(p, back)) < 1e-12


def test_too_far_apart_rejected():
    with pytest.raises(ValueError, match="apart"):
        run_task(TaskConfig(object_start=(0.0, 0.0, 0.0), target=(2.0, 0.0, 0.0)))
