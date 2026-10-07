"""Task frame <-> robot frame.

Tasks are given in a task (world) frame. The robot base is placed in that frame at
(x, y) with heading `yaw`. The simulation runs in the robot frame (base at the origin,
facing +x). Everything reported in the proof is converted back to the task frame.

If both points already fit the workspace with the robot at the task-frame origin, the
robot stays there. Otherwise the base is placed automatically: on the perpendicular
bisector of A-B, facing the midpoint, so A and B sit symmetrically left and right of
the arm. This is like positioning the robot cell for the job and lets tasks such as
(0,0,0) -> (1,0,0) be executed. The placement is deterministic.
"""

from __future__ import annotations

import math
from typing import NamedTuple

# Reachable floor area in the robot frame: an annulus sector in front of the robot
# (Panda reach ~0.85 m).
WORKSPACE_MIN_R = 0.30
WORKSPACE_MAX_R = 0.75
WORKSPACE_MAX_ANGLE_DEG = 135.0  # measured from the robot's +x axis, both sides
WORKSPACE_MAX_Z = 0.3

# Auto placement: points end up at this radius, as far as the span allows.
_PLACEMENT_R = 0.6
_PLACEMENT_MAX_HALF_ANGLE = math.radians(75)


class BasePose(NamedTuple):
    x: float
    y: float
    yaw: float

    def to_robot(self, p):
        """Task-frame point -> robot-frame point."""
        dx, dy = p[0] - self.x, p[1] - self.y
        c, s = math.cos(self.yaw), math.sin(self.yaw)
        return (c * dx + s * dy, -s * dx + c * dy, p[2])

    def to_task(self, p):
        """Robot-frame point -> task-frame point."""
        c, s = math.cos(self.yaw), math.sin(self.yaw)
        return (self.x + c * p[0] - s * p[1], self.y + s * p[0] + c * p[1], p[2])


ORIGIN = BasePose(0.0, 0.0, 0.0)


def workspace_error(p, name: str):
    """Why a robot-frame point is unreachable, or None if it is fine."""
    r = math.hypot(p[0], p[1])
    if not (WORKSPACE_MIN_R <= r <= WORKSPACE_MAX_R):
        return (f"{name} is {r:.3f} m from the robot base; it must be "
                f"{WORKSPACE_MIN_R}-{WORKSPACE_MAX_R} m")
    ang = math.degrees(math.atan2(p[1], p[0]))
    if abs(ang) > WORKSPACE_MAX_ANGLE_DEG:
        return f"{name} is behind the robot ({ang:.1f} deg, limit ±{WORKSPACE_MAX_ANGLE_DEG:g})"
    if not (0.0 <= p[2] <= WORKSPACE_MAX_Z):
        return f"{name} z must be between 0 and {WORKSPACE_MAX_Z} m"
    return None


def place_robot(start, target) -> BasePose:
    """Choose the robot base pose for a task. Raises ValueError if no placement works."""
    if workspace_error(start, "start") is None and workspace_error(target, "target") is None:
        return ORIGIN

    dx, dy = target[0] - start[0], target[1] - start[1]
    half = math.hypot(dx, dy) / 2
    mx, my = (start[0] + target[0]) / 2, (start[1] + target[1]) / 2
    if half < 1e-9:
        # A and B coincide: put the base in front of them, facing +x.
        base = BasePose(mx - _PLACEMENT_R, my, 0.0)
    else:
        r = max(_PLACEMENT_R, half / math.sin(_PLACEMENT_MAX_HALF_ANGLE))
        r = min(r, WORKSPACE_MAX_R)
        if half > r:
            raise ValueError(
                f"start and target are {2 * half:.3f} m apart; one robot placement can "
                f"cover at most {2 * WORKSPACE_MAX_R:.2f} m"
            )
        d = math.sqrt(r * r - half * half)
        ux, uy = dx / (2 * half), dy / (2 * half)
        nx, ny = uy, -ux  # perpendicular to A->B; the base sits on this side of A-B
        base = BasePose(mx + nx * d, my + ny * d, math.atan2(-ny, -nx))

    for p, name in ((start, "start"), (target, "target")):
        err = workspace_error(base.to_robot(p), name)
        if err:
            raise ValueError(f"no reachable robot placement: {err}")
    return base
