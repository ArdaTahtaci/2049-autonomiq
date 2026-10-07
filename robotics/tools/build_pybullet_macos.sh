#!/usr/bin/env bash
# Build a PyBullet 3.2.7 wheel on macOS (Apple Silicon) into vendor/.
#
# PyPI has no macOS arm64 wheel, and the source build fails with recent macOS SDKs:
# the bundled zlib defines `fdopen(fd, mode)` as NULL, which clashes with the SDK's
# stdio.h. We remove that one define and build normally. Takes a few minutes.
#
# Usage: tools/build_pybullet_macos.sh <python>   (e.g. .venv/bin/python)
set -euo pipefail
PY=${1:?usage: $0 <python>}
[[ "$PY" == */* ]] && PY="$(cd "$(dirname "$PY")" && pwd)/$(basename "$PY")"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

URL=$("$PY" -c 'import json,urllib.request;d=json.load(urllib.request.urlopen("https://pypi.org/pypi/pybullet/3.2.7/json"));print([u["url"] for u in d["urls"] if u["packagetype"]=="sdist"][0])')
curl -sSL "$URL" -o "$WORK/pybullet.tar.gz"
tar xzf "$WORK/pybullet.tar.gz" -C "$WORK"
SRC="$WORK/pybullet-3.2.7"
sed -i '' 's|#define fdopen(fd, mode) NULL /\* No fdopen() \*/|/* fdopen define removed for modern macOS SDKs */|' \
  "$SRC/examples/ThirdPartyLibs/zlib/zutil.h"

"$PY" -m pip --version >/dev/null 2>&1 || { command -v uv >/dev/null && uv pip install --python "$PY" pip; }
"$PY" -m pip install --quiet setuptools wheel
mkdir -p "$ROOT/vendor"
(cd "$SRC" && "$PY" setup.py --quiet bdist_wheel -d "$ROOT/vendor")
ls "$ROOT"/vendor/pybullet-*.whl
