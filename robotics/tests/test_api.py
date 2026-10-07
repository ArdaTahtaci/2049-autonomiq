import pytest
from fastapi.testclient import TestClient

from robot_sim import api

TS = "2026-01-01T00:00:00Z"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "RESULTS_DIR", tmp_path / "results")
    monkeypatch.setattr(api, "LATEST_OUTPUT", tmp_path / "output.json")
    return TestClient(api.app)


def test_run_task_and_fetch_result(client, tmp_path):
    r = client.post("/run-task", json={"timestamp": TS})
    assert r.status_code == 200
    proof = r.json()
    assert proof["task_id"] == "task_001"
    assert proof["success"] is True

    got = client.get("/task/task_001/result")
    assert got.status_code == 200
    assert got.json() == proof
    assert (tmp_path / "output.json").exists()


def test_empty_body_and_auto_ids(client):
    assert client.post("/run-task").json()["task_id"] == "task_001"
    assert client.post("/run-task").json()["task_id"] == "task_002"
    ids = [t["task_id"] for t in client.get("/tasks").json()]
    assert ids == ["task_001", "task_002"]


def test_custom_task(client):
    r = client.post("/run-task", json={
        "task_id": "custom-1", "robot_id": "robot_007",
        "start_position": {"x": 0.4, "y": 0.2}, "target_position": {"x": 0.6, "y": -0.2},
        "timestamp": TS,
    }).json()
    assert r["task_id"] == "custom-1" and r["robot_id"] == "robot_007"
    assert r["target_position"] == {"x": 0.6, "y": -0.2, "z": 0.0}
    assert r["success"] is True


def test_fault_returns_failure(client):
    r = client.post("/run-task", json={"fault": "drop_in_transit", "timestamp": TS}).json()
    assert r["success"] is False


def test_api_matches_cli_hash(client):
    from robot_sim.config import TaskConfig
    from robot_sim.sim import run_task

    r = client.post("/run-task", json={"task_id": "task_001", "timestamp": TS}).json()
    assert r["replay_hash"] == run_task(TaskConfig(timestamp=TS))["replay_hash"]


def test_errors(client):
    assert client.get("/task/missing/result").status_code == 404
    assert client.get("/task/missing/recording").status_code == 404
    assert client.post("/run-task", json={"task_id": "../x"}).status_code == 400
    assert client.post("/run-task", json={"target_position": {"x": 3, "y": 0}}).status_code == 422
    assert client.post("/run-task", json={"fault": "nope"}).status_code == 422
    assert client.post("/run-task", json={"tolerance_m": -1}).status_code == 422


def test_reset_and_health(client):
    assert client.get("/health").json() == {"status": "ok"}
    r = client.post("/reset").json()
    assert r["status"] == "reset"
    assert r["object_position"] == {"x": 0.5, "y": -0.3, "z": 0.0}
