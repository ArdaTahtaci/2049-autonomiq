#!/usr/bin/env bash
# Create .venv and install dependencies. Usage: ./setup.sh
set -euo pipefail
cd "$(dirname "$0")"

PY=${PYTHON:-python3.11}
if command -v uv >/dev/null 2>&1; then
  [[ -x .venv/bin/python ]] || uv venv --python "$PY" .venv
  PIP="uv pip install --python .venv/bin/python"
else
  [[ -x .venv/bin/python ]] || "$PY" -m venv .venv
  PIP=".venv/bin/python -m pip install"
fi

# macOS arm64: no PyBullet wheel on PyPI and the plain source build fails, so use
# (or build once) a patched wheel in vendor/.
if [[ "$(uname -s)-$(uname -m)" == "Darwin-arm64" ]]; then
  WHEEL=$(ls vendor/pybullet-*.whl 2>/dev/null | head -1 || true)
  if [[ -z "$WHEEL" ]]; then
    echo "Building PyBullet for macOS arm64 (one time, a few minutes)…"
    tools/build_pybullet_macos.sh .venv/bin/python
    WHEEL=$(ls vendor/pybullet-*.whl | head -1)
  fi
  $PIP "$WHEEL"
fi
$PIP -r requirements.txt
.venv/bin/python -c "import pybullet; print('pybullet OK')"
