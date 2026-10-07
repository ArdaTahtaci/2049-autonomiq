"""HTTP interface.

    POST /run-task               reset -> execute -> measure -> proof (returns the proof)
    GET  /task/{task_id}/result  stored proof for a task
    GET  /task/{task_id}/recording  GIF of the run (if it was run with record=true)
    GET  /tasks                  list of stored task results
    POST /reset                  reset the scene and return its initial state (no task run)
    GET  /health

Proofs are stored in results/<task_id>.json and the latest one is mirrored to output.json.
Running an existing task_id again overwrites its stored result.
"""

from __future__ import annotations

import json
import re
import threading
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .config import TaskConfig
from .proof import round_floats, xyz
from .sim import Simulation, run_task

ROOT = Path(__file__).resolve().parent.parent
RESULTS_DIR = ROOT / "results"
LATEST_OUTPUT = ROOT / "output.json"
TASK_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")

_lock = threading.Lock()  # one physics run at a time

_defaults = TaskConfig()


class Point(BaseModel):
    x: float
    y: float
    z: float = 0.0

    def as_tuple(self) -> tuple[float, float, float]:
        return (self.x, self.y, self.z)


class RunTaskRequest(BaseModel):
    task_id: Optional[str] = Field(None, description="auto-assigned (task_NNN) if omitted")
    robot_id: str = _defaults.robot_id
    start_position: Point = Point(x=_defaults.object_start[0], y=_defaults.object_start[1])
    target_position: Point = Point(x=_defaults.target[0], y=_defaults.target[1])
    tolerance_m: float = Field(_defaults.tolerance_m, gt=0)
    fault: Literal["none", "drop_in_transit", "no_grasp"] = "none"
    timestamp: Optional[str] = Field(None, description="fixed ISO-8601 timestamp; default now (UTC)")
    record: bool = Field(False, description="also render a GIF of the run (slower)")


app = FastAPI(title="Robot Simulation – Pick and Place Proof", version="1.0")


def _result_path(task_id: str, suffix: str = ".json") -> Path:
    if not TASK_ID_RE.match(task_id):
        raise HTTPException(400, "task_id must match [A-Za-z0-9_.-]{1,64}")
    return RESULTS_DIR / f"{task_id}{suffix}"


def _next_task_id() -> str:
    nums = [
        int(m.group(1))
        for f in RESULTS_DIR.glob("task_*.json")
        if (m := re.fullmatch(r"task_(\d+)", f.stem))
    ]
    return f"task_{(max(nums) + 1) if nums else 1:03d}"


def _dump(proof: dict) -> str:
    return json.dumps(proof, indent=2, sort_keys=True) + "\n"


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/run-task")
def run(req: RunTaskRequest = RunTaskRequest()) -> dict:
    with _lock:
        RESULTS_DIR.mkdir(exist_ok=True)
        task_id = req.task_id or _next_task_id()
        path = _result_path(task_id)
        cfg = TaskConfig(
            task_id=task_id, robot_id=req.robot_id,
            object_start=req.start_position.as_tuple(), target=req.target_position.as_tuple(),
            tolerance_m=req.tolerance_m, fault=req.fault, timestamp=req.timestamp,
        )
        gif = _result_path(task_id, ".gif") if req.record else None
        try:
            proof = run_task(cfg, record_path=str(gif) if gif else None)
        except ValueError as e:
            raise HTTPException(422, str(e))
        path.write_text(_dump(proof), encoding="utf-8")
        LATEST_OUTPUT.write_text(_dump(proof), encoding="utf-8")
        return proof


@app.get("/task/{task_id}/result")
def result(task_id: str) -> dict:
    path = _result_path(task_id)
    if not path.exists():
        raise HTTPException(404, f"no result for task {task_id}")
    return json.loads(path.read_text(encoding="utf-8"))


@app.get("/task/{task_id}/recording")
def recording(task_id: str):
    path = _result_path(task_id, ".gif")
    if not path.exists():
        raise HTTPException(404, f"no recording for task {task_id} (run it with record=true)")
    return FileResponse(path, media_type="image/gif")


@app.get("/tasks")
def tasks() -> list[dict]:
    out = []
    for f in sorted(RESULTS_DIR.glob("*.json")) if RESULTS_DIR.exists() else []:
        proof = json.loads(f.read_text(encoding="utf-8"))
        out.append({
            "task_id": proof["task_id"], "robot_id": proof["robot_id"],
            "timestamp": proof["timestamp"], "success": proof["success"],
            "distance_to_target_m": proof["distance_to_target_m"],
        })
    return out


@app.post("/reset")
def reset() -> dict:
    """Build a fresh scene and report its initial state. Does not run or store a task."""
    with _lock:
        sim = Simulation(TaskConfig())
        try:
            sim.reset()
            return round_floats({
                "status": "reset",
                "robot_start_pose": sim.start_pose,
                "object_position": xyz(sim.base.to_task(sim.start_object_pos)),
                "default_target_position": xyz(sim.cfg.target),
            })
        finally:
            sim.close()
