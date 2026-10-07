"""Proof serialization: stable rounding, canonical JSON and a replay hash.

The downstream backend does: proof -> canonical JSON -> hash -> signature -> chain.
`canonical_json` here is the reference canonicalization (sorted keys, no whitespace,
UTF-8, floats rounded to PRECISION decimals) so both sides can agree byte for byte.
"""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any

PRECISION = 4  # 0.1 mm / 0.0001 rad

# Fields that legitimately differ between two runs of the same task.
NON_DETERMINISTIC_FIELDS = ("timestamp", "replay_hash")


def round_floats(value: Any, ndigits: int = PRECISION) -> Any:
    """Recursively round floats and normalize -0.0 to 0.0. Tuples become lists."""
    if isinstance(value, bool) or value is None or isinstance(value, (int, str)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"non-finite float in proof: {value}")
        r = round(value, ndigits)
        return 0.0 if r == 0 else r
    if isinstance(value, dict):
        return {str(k): round_floats(v, ndigits) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [round_floats(v, ndigits) for v in value]
    # numpy scalars and similar
    if hasattr(value, "item"):
        return round_floats(value.item(), ndigits)
    raise TypeError(f"unsupported type in proof: {type(value).__name__}")


def canonical_json(obj: Any) -> str:
    return json.dumps(
        round_floats(obj), sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    )


def sha256_hex(obj: Any) -> str:
    return hashlib.sha256(canonical_json(obj).encode("utf-8")).hexdigest()


def replay_hash(proof: dict) -> str:
    """Hash of everything except run-specific fields (timestamp).

    Re-running the same task config must give the same replay_hash, which lets a
    verifier re-execute the simulation and compare.
    """
    body = {k: v for k, v in proof.items() if k not in NON_DETERMINISTIC_FIELDS}
    return sha256_hex(body)


def xyz(v) -> dict:
    return {"x": float(v[0]), "y": float(v[1]), "z": float(v[2])}
