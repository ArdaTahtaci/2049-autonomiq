"""Task definition: everything that determines a run. Same config -> same execution."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Optional

# Task frame: meters, z up. The robot base is placed in it by frame.place_robot.
# Object positions are the center of the object's base, so an object resting on the
# floor has z = 0 (same convention as the task spec and the MachineProof backend).

CUBE_HALF_EXTENT = 0.02  # 4 cm cube
CUBE_REST_Z = CUBE_HALF_EXTENT  # physics body (cube center) height when on the floor

# Workspace limits live in frame.py (robot frame); re-exported for convenience.
from .frame import (  # noqa: E402,F401
    WORKSPACE_MAX_ANGLE_DEG, WORKSPACE_MAX_R, WORKSPACE_MIN_R, place_robot,
)

FAULTS = ("none", "drop_in_transit", "no_grasp")


@dataclass
class TaskConfig:
    task_id: str = "task_001"
    robot_id: str = "robot_001"
    object_start: tuple[float, float, float] = (0.5, -0.3, 0.0)
    target: tuple[float, float, float] = (0.5, 0.3, 0.0)
    tolerance_m: float = 0.05
    # Fault injection, used to demonstrate that a failed execution yields success=false.
    fault: str = "none"
    # Optional fixed timestamp (ISO-8601). None -> current UTC time.
    timestamp: Optional[str] = None
    # Joint angles (rad) of the 7 arm joints at RESET.
    robot_start_joints: tuple[float, ...] = field(
        default=(0.0, -0.4, 0.0, -2.2, 0.0, 1.8, 0.785)
    )

    def validate(self) -> None:
        if self.fault not in FAULTS:
            raise ValueError(f"fault must be one of {FAULTS}, got {self.fault!r}")
        if self.tolerance_m <= 0:
            raise ValueError("tolerance_m must be > 0")
        for name in ("object_start", "target"):
            if len(getattr(self, name)) != 3:
                raise ValueError(f"{name} must have 3 components")
        place_robot(self.object_start, self.target)  # raises if the task is unreachable
        if len(self.robot_start_joints) != 7:
            raise ValueError("robot_start_joints must have 7 values")
        if not self.task_id or not self.robot_id:
            raise ValueError("task_id and robot_id are required")

    def to_dict(self) -> dict:
        return asdict(self)
