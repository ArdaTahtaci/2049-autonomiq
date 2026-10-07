"""PyBullet pick-and-place: a Franka Panda moves one cube from point A to point B.

The grasp is a real friction grasp (fingers squeeze the cube); there is no
teleporting or welding of the object. The final position is read back from the
physics engine after the object has come to rest.
"""

from __future__ import annotations

import math
import time
from datetime import datetime, timezone
from importlib import metadata
from typing import Optional

import pybullet as p
import pybullet_data

from .config import CUBE_HALF_EXTENT, CUBE_REST_Z, TaskConfig
from .frame import place_robot
from .proof import replay_hash, round_floats, xyz

SCHEMA_VERSION = "1.0"
TIMESTEP = 1.0 / 240.0
SAMPLE_EVERY = 48  # trajectory sample every 0.2 s of sim time

CUBE_MASS = 0.1
HOVER_HEIGHT = 0.15  # clearance above the cube for approach / transport
GRASP_Z_OFFSET = 0.0  # grasp point relative to cube center
PLACE_Z_OFFSET = 0.003  # release slightly above the resting height
EE_SPEED = 0.25  # m/s for Cartesian moves
MAX_WRIST_TWIST = math.radians(90)

# Franka Panda (pybullet_data/franka_panda/panda.urdf)
ARM_JOINTS = list(range(7))
FINGER_JOINTS = [9, 10]
ROBOT_BASE = (0.0, 0.0, 0.0)  # URDF base frame, fixed to the floor
EE_LINK = 11  # panda_grasptarget: point between the fingertips
FINGER_OPEN = 0.04
FINGER_CLOSED = 0.0
ARM_FORCE = 240.0
FINGER_FORCE = 40.0
# IK limits cover all 9 movable joints (7 arm + 2 fingers). PyBullet silently
# ignores the null-space terms unless the arrays match the robot's DoF count.
LOWER = [-2.9671, -1.8326, -2.9671, -3.0718, -2.9671, -0.0175, -2.9671, 0.0, 0.0]
UPPER = [2.9671, 1.8326, 2.9671, -0.0698, 2.9671, 3.7525, 2.9671, 0.04, 0.04]
RANGES = [u - l for l, u in zip(LOWER, UPPER)]


def _down(yaw: float):
    """Gripper pointing straight down, rotated by `yaw` about the world z axis."""
    return p.getQuaternionFromEuler([math.pi, 0.0, yaw])


def _snap90(angle: float) -> float:
    return round(angle / (math.pi / 2)) * (math.pi / 2)


def _pybullet_version() -> str:
    try:
        return metadata.version("pybullet")
    except metadata.PackageNotFoundError:
        return "unknown"


def _dist(a, b) -> float:
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


class Simulation:
    def __init__(self, cfg: TaskConfig, gui: bool = False, record_path: Optional[str] = None):
        cfg.validate()
        self.cfg = cfg
        # Physics runs in the robot frame; the proof is reported in the task frame.
        self.base = place_robot(cfg.object_start, cfg.target)
        self.start_r = self.base.to_robot(cfg.object_start)
        self.target_r = self.base.to_robot(cfg.target)
        self.gui = gui
        self.record_path = record_path
        self.frames: list = []
        self.client = p.connect(p.GUI if gui else p.DIRECT)
        self.step_count = 0
        self.trajectory: list[dict] = []
        self.phase = "reset"
        self.max_object_z = 0.0
        self.object_path_length = 0.0
        self._last_obj_pos = None

    # ----------------------------------------------------------------- setup
    def reset(self) -> None:
        c = self.client
        p.resetSimulation(physicsClientId=c)
        p.setAdditionalSearchPath(pybullet_data.getDataPath(), physicsClientId=c)
        p.setGravity(0, 0, -9.81, physicsClientId=c)
        p.setTimeStep(TIMESTEP, physicsClientId=c)
        p.setPhysicsEngineParameter(
            numSolverIterations=150, deterministicOverlappingPairs=1, physicsClientId=c
        )
        if self.gui:
            p.configureDebugVisualizer(p.COV_ENABLE_GUI, 0, physicsClientId=c)
            p.resetDebugVisualizerCamera(1.3, 50, -35, [0.4, 0.0, 0.1], physicsClientId=c)

        self.plane = p.loadURDF("plane.urdf", physicsClientId=c)
        self.robot = p.loadURDF(
            "franka_panda/panda.urdf", ROBOT_BASE, useFixedBase=True, physicsClientId=c
        )
        for j, q in zip(ARM_JOINTS, self.cfg.robot_start_joints):
            p.resetJointState(self.robot, j, q, physicsClientId=c)
        for j in FINGER_JOINTS:
            p.resetJointState(self.robot, j, FINGER_OPEN, physicsClientId=c)
            p.changeDynamics(self.robot, j, lateralFriction=2.0, physicsClientId=c)
        # Couple the two fingers (mimic joint). Without this both fingers saturate at
        # max force on the cube and the pair can drift sideways, so the cube slides.
        gear = p.createConstraint(
            self.robot, FINGER_JOINTS[0], self.robot, FINGER_JOINTS[1], p.JOINT_GEAR,
            [1, 0, 0], [0, 0, 0], [0, 0, 0], physicsClientId=c,
        )
        p.changeConstraint(gear, gearRatio=-1, erp=0.1, maxForce=50, physicsClientId=c)

        he = [CUBE_HALF_EXTENT] * 3
        col = p.createCollisionShape(p.GEOM_BOX, halfExtents=he, physicsClientId=c)
        vis = p.createVisualShape(
            p.GEOM_BOX, halfExtents=he, rgbaColor=[0.85, 0.25, 0.2, 1], physicsClientId=c
        )
        sx, sy, sz = self.start_r
        self.cube = p.createMultiBody(
            CUBE_MASS, col, vis, [sx, sy, sz + CUBE_REST_Z], physicsClientId=c
        )
        p.changeDynamics(
            self.cube, -1, lateralFriction=1.0, spinningFriction=0.001,
            physicsClientId=c,
        )

        # Visual-only floor markers for A (grey) and B (green), no collision.
        self._marker(self.start_r, [0.6, 0.6, 0.6, 0.6])
        self._marker(self.target_r, [0.2, 0.8, 0.3, 0.6])

        self.arm_cmd = list(self.cfg.robot_start_joints)
        self.finger_cmd = FINGER_OPEN
        self._apply_commands()
        self.step_count = 0
        self.trajectory = []
        self.phase = "reset"
        self.ee_cmd = self.ee_position()
        self.yaw_cmd = 0.0

        # Let the cube settle on the floor before measuring the start state.
        self.event("reset")
        self.hold(0.5)
        self.start_object_pos = self.object_position()
        self._last_obj_pos = self.start_object_pos
        self.max_object_z = self.start_object_pos[2]
        self.object_path_length = 0.0
        self.start_pose = {
            "base_position": xyz((self.base.x, self.base.y, ROBOT_BASE[2])),
            "base_yaw_rad": self.base.yaw,
            "joint_positions": [self.joint(j) for j in ARM_JOINTS],
            "end_effector_position": xyz(self.base.to_task(self.ee_position())),
            "gripper_width": self.gripper_width(),
        }

    def _marker(self, pos, rgba) -> None:
        vis = p.createVisualShape(
            p.GEOM_CYLINDER, radius=0.05, length=0.001, rgbaColor=rgba, physicsClientId=self.client
        )
        p.createMultiBody(0, -1, vis, [pos[0], pos[1], 0.0005], physicsClientId=self.client)

    # --------------------------------------------------------------- readout
    def joint(self, j: int) -> float:
        return p.getJointState(self.robot, j, physicsClientId=self.client)[0]

    def ee_position(self):
        return p.getLinkState(self.robot, EE_LINK, physicsClientId=self.client)[4]

    def object_position(self):
        """Center of the object's base (reported convention; z = 0 on the floor)."""
        x, y, z = p.getBasePositionAndOrientation(self.cube, physicsClientId=self.client)[0]
        return (x, y, z - CUBE_HALF_EXTENT)

    def object_orientation(self):
        return p.getBasePositionAndOrientation(self.cube, physicsClientId=self.client)[1]

    def gripper_width(self) -> float:
        return sum(self.joint(j) for j in FINGER_JOINTS)

    def finger_contacts(self) -> int:
        n = 0
        for link in FINGER_JOINTS:
            if p.getContactPoints(self.robot, self.cube, link, -1, physicsClientId=self.client):
                n += 1
        return n

    def object_speed(self) -> tuple[float, float]:
        lin, ang = p.getBaseVelocity(self.cube, physicsClientId=self.client)
        return _dist(lin, (0, 0, 0)), _dist(ang, (0, 0, 0))

    # --------------------------------------------------------------- control
    def _apply_commands(self) -> None:
        c = self.client
        p.setJointMotorControlArray(
            self.robot, ARM_JOINTS, p.POSITION_CONTROL,
            targetPositions=self.arm_cmd, forces=[ARM_FORCE] * 7, physicsClientId=c,
        )
        p.setJointMotorControlArray(
            self.robot, FINGER_JOINTS, p.POSITION_CONTROL,
            targetPositions=[self.finger_cmd] * 2, forces=[FINGER_FORCE] * 2, physicsClientId=c,
        )

    def _ik(self, pos, yaw):
        sol = p.calculateInverseKinematics(
            self.robot, EE_LINK, pos, _down(yaw),
            lowerLimits=LOWER, upperLimits=UPPER, jointRanges=RANGES,
            # Null-space pull: base joint faces the target, the rest stays near the start pose.
            restPoses=[math.atan2(pos[1], pos[0])] + list(self.cfg.robot_start_joints[1:])
            + [FINGER_OPEN / 2] * 2,
            maxNumIterations=100, residualThreshold=1e-5, physicsClientId=self.client,
        )
        return list(sol[:7])

    def step(self) -> None:
        self._apply_commands()
        p.stepSimulation(physicsClientId=self.client)
        self.step_count += 1
        obj = self.object_position()
        self.object_path_length += _dist(obj, self._last_obj_pos) if self._last_obj_pos else 0.0
        self._last_obj_pos = obj
        self.max_object_z = max(self.max_object_z, obj[2])
        if self.step_count % SAMPLE_EVERY == 0:
            self.sample()
        if self.record_path and self.step_count % 10 == 0:
            self._capture_frame()
        if self.gui:
            time.sleep(TIMESTEP)

    def hold(self, seconds: float) -> None:
        for _ in range(int(round(seconds / TIMESTEP))):
            self.step()

    def move_ee(self, target, yaw=None, settle: float = 0.3, on_progress=None) -> None:
        """Gripper move with a minimum-jerk speed profile.

        The path is interpolated in cylindrical coordinates around the robot base
        (radius, angle, height), so moves between opposite sides sweep around the
        robot instead of cutting through it. Vertical moves stay straight lines.
        Smooth acceleration matters: with an abrupt velocity jump the cube slides
        between the finger pads.
        """
        start = list(self.ee_cmd)
        yaw0 = self.yaw_cmd
        yaw1 = yaw0 if yaw is None else yaw
        r0, th0 = math.hypot(start[0], start[1]), math.atan2(start[1], start[0])
        r1, th1 = math.hypot(target[0], target[1]), math.atan2(target[1], target[0])
        # Workspace is the front half (|angle| <= 135 deg), so never wrap around the back.
        length = math.sqrt((r1 - r0) ** 2 + (0.5 * (r0 + r1) * (th1 - th0)) ** 2 + (target[2] - start[2]) ** 2)
        # Min-jerk peak speed is 1.875x the average, so stretch the duration.
        n = max(1, int(math.ceil(1.875 * length / EE_SPEED / TIMESTEP)))
        for i in range(1, n + 1):
            a = i / n
            s_ = a ** 3 * (10 - 15 * a + 6 * a * a)
            r = r0 + (r1 - r0) * s_
            th = th0 + (th1 - th0) * s_
            wp = [r * math.cos(th), r * math.sin(th), start[2] + (target[2] - start[2]) * s_]
            self.arm_cmd = self._ik(wp, yaw0 + (yaw1 - yaw0) * s_)
            self.step()
            if on_progress:
                on_progress(a)
        self.ee_cmd = list(target)
        self.yaw_cmd = yaw1
        self.hold(settle)

    def set_gripper(self, width_per_finger: float, seconds: float = 0.5) -> None:
        self.finger_cmd = width_per_finger
        self.hold(seconds)

    # --------------------------------------------------------------- logging
    def sample(self) -> None:
        self.trajectory.append({
            "step": self.step_count,
            "sim_time_s": self.step_count * TIMESTEP,
            "phase": self.phase,
            "robot_position": list(self.base.to_task(self.ee_position())),
            "object_position": list(self.base.to_task(self.object_position())),
            "gripper_width": self.gripper_width(),
        })

    def event(self, name: str, **details) -> None:
        entry = {"step": self.step_count, "sim_time_s": self.step_count * TIMESTEP, "event": name}
        if details:
            entry["details"] = details
        self.trajectory.append(entry)

    def _capture_frame(self) -> None:
        c = self.client
        view = p.computeViewMatrixFromYawPitchRoll([0.35, 0.0, 0.25], 1.7, 50, -28, 0, 2, physicsClientId=c)
        proj = p.computeProjectionMatrixFOV(55, 4 / 3, 0.05, 5, physicsClientId=c)
        w, h, rgb, _, _ = p.getCameraImage(
            320, 240, view, proj, renderer=p.ER_TINY_RENDERER, physicsClientId=c
        )
        import numpy as np

        self.frames.append(np.reshape(np.asarray(rgb, dtype=np.uint8), (h, w, 4))[:, :, :3])

    # ------------------------------------------------------------------ task
    def run(self) -> dict:
        cfg = self.cfg
        timestamp = cfg.timestamp or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.reset()

        obj = self.start_object_pos
        tgt = self.target_r
        # Gripper targets are relative to the cube center (base + half extent).
        above_obj = [obj[0], obj[1], obj[2] + CUBE_HALF_EXTENT + HOVER_HEIGHT]
        grasp = [obj[0], obj[1], obj[2] + CUBE_HALF_EXTENT + GRASP_Z_OFFSET]
        # The cube is always set down on the floor; the target z is only used when
        # measuring (z = 0 is an object resting on the floor).
        above_tgt = [tgt[0], tgt[1], CUBE_REST_Z + HOVER_HEIGHT]
        place = [tgt[0], tgt[1], CUBE_REST_Z + PLACE_Z_OFFSET]
        # Gripper yaw. At the object it snaps to the nearest 90 deg of the arm's
        # heading so the fingers line up with the cube faces. While carrying, the
        # hand turns only as much as needed to keep the wrist twist (hand yaw vs.
        # arm heading) within MAX_WRIST_TWIST. Large in-hand rotations are avoided
        # because Bullet keeps stale contact normals on a rotating grasp, which can
        # jam the fingers on release.
        th_obj = math.atan2(obj[1], obj[0])
        th_tgt = math.atan2(tgt[1], tgt[0])
        grasp_yaw = _snap90(th_obj)
        place_yaw = min(max(grasp_yaw, th_tgt - MAX_WRIST_TWIST), th_tgt + MAX_WRIST_TWIST)

        self.phase = "approach"
        self.event("approach_started")
        self.move_ee(above_obj, yaw=grasp_yaw)
        self.move_ee(grasp, settle=0.4)
        self.event("arrived_at_object", end_effector_position=list(self.base.to_task(self.ee_position())))

        self.phase = "grasp"
        if cfg.fault == "no_grasp":
            self.event("fault_injected", fault="no_grasp")
            self.hold(0.8)
        else:
            self.set_gripper(FINGER_CLOSED, seconds=0.8)
        contacts = self.finger_contacts()
        grasped = contacts == 2
        self.event(
            "object_grasped" if grasped else "grasp_failed",
            finger_contacts=contacts, gripper_width=self.gripper_width(),
        )

        self.phase = "lift"
        self.move_ee(above_obj)
        lifted = self.object_position()[2] - self.start_object_pos[2]
        self.event("object_lifted" if lifted > 0.05 else "object_not_lifted", lift_height_m=lifted)

        self.phase = "transport"
        dropped = {"done": False}

        def maybe_drop(a: float) -> None:
            if cfg.fault == "drop_in_transit" and not dropped["done"] and a >= 0.5:
                dropped["done"] = True
                self.finger_cmd = FINGER_OPEN
                self.event("fault_injected", fault="drop_in_transit",
                           object_position=list(self.base.to_task(self.object_position())))

        self.event("transport_started")
        self.move_ee(above_tgt, yaw=place_yaw, on_progress=maybe_drop)
        self.move_ee(place, settle=0.4)
        self.event("arrived_at_target", end_effector_position=list(self.base.to_task(self.ee_position())))

        self.phase = "place"
        self.set_gripper(FINGER_OPEN, seconds=0.6)
        released = self.finger_contacts() == 0
        self.event("object_released" if released else "release_failed",
                   object_position=list(self.base.to_task(self.object_position())))

        self.phase = "retreat"
        self.move_ee(above_tgt, settle=0.2)

        self.phase = "settle"
        at_rest = self._settle()

        self.phase = "measure"
        # Decide on the same rounded numbers that go into the proof, so a verifier
        # recomputing distance(final, target) from the JSON always agrees.
        final = round_floats(list(self.base.to_task(self.object_position())))
        distance = _dist(final, round_floats(list(cfg.target)))
        success = distance <= cfg.tolerance_m
        self.sample()
        self.event("final_state_measured", distance_to_target_m=distance, success=success)

        proof = {
            "schema_version": SCHEMA_VERSION,
            "task_id": cfg.task_id,
            "robot_id": cfg.robot_id,
            "timestamp": timestamp,
            "simulator": {
                "engine": "pybullet",
                "engine_version": _pybullet_version(),
                "physics_rate_hz": round(1 / TIMESTEP),
                "robot_model": "franka_panda",
                "frame": "task frame, meters, z-up; robot base pose in robot_start_pose; object position = center of the object's base (z=0 on the floor)",
            },
            "task": {
                "description": "move one object from point A to point B",
                "object": {"shape": "cube", "size_m": 2 * CUBE_HALF_EXTENT, "mass_kg": CUBE_MASS},
                "tolerance_m": cfg.tolerance_m,
                "fault_injection": cfg.fault,
            },
            "robot_start_pose": self.start_pose,
            # Requested start point (must equal the task's), plus what was measured.
            "start_position": xyz(cfg.object_start),
            "measured_start_position": xyz(self.base.to_task(self.start_object_pos)),
            "target_position": xyz(cfg.target),
            "final_object_position": xyz(final),
            "final_object_orientation_xyzw": list(p.multiplyTransforms(
                [0, 0, 0], p.getQuaternionFromEuler([0, 0, self.base.yaw]),
                [0, 0, 0], self.object_orientation())[1]),
            "distance_to_target_m": distance,
            "tolerance_m": cfg.tolerance_m,
            "success": success,
            "checks": {
                "object_grasped": grasped,
                "object_lifted": lifted > 0.05,
                "object_released": released,
                "object_at_rest": at_rest,
                "within_tolerance": success,
            },
            "metrics": {
                "total_steps": self.step_count,
                "sim_duration_s": self.step_count * TIMESTEP,
                "max_object_height_m": self.max_object_z,
                "object_path_length_m": self.object_path_length,
            },
            "trajectory": self.trajectory,
        }
        proof = round_floats(proof)
        proof["replay_hash"] = replay_hash(proof)

        if self.record_path and self.frames:
            self._write_recording()
        return proof

    def _settle(self, max_seconds: float = 3.0) -> bool:
        still = 0
        need = int(0.25 / TIMESTEP)
        for _ in range(int(max_seconds / TIMESTEP)):
            self.step()
            lin, ang = self.object_speed()
            still = still + 1 if (lin < 1e-3 and ang < 1e-2) else 0
            if still >= need:
                self.event("object_at_rest")
                return True
        self.event("object_not_at_rest")
        return False

    def _write_recording(self) -> None:
        import imageio.v2 as imageio
        from pathlib import Path

        Path(self.record_path).parent.mkdir(parents=True, exist_ok=True)
        imageio.mimsave(self.record_path, self.frames, duration=1000 * 10 * TIMESTEP, loop=0)

    def close(self) -> None:
        try:
            p.disconnect(physicsClientId=self.client)
        except p.error:
            pass


def run_task(cfg: TaskConfig, gui: bool = False, record_path: Optional[str] = None) -> dict:
    """RESET -> execute -> measure -> proof. Each call builds a fresh physics world."""
    sim = Simulation(cfg, gui=gui, record_path=record_path)
    try:
        return sim.run()
    finally:
        sim.close()
