#!/usr/bin/env bash
#
# CAELLUM — Neuron box setup.
#
# ENV: the AWS Neuron workshop / inf2 instance ONLY (NO CUDA). Run this once inside
#      the workshop Code Editor terminal to layer optimum-neuron + diffusers + the
#      serve-side libs ON TOP OF the pre-installed Neuron SDK (torch-neuronx, neuronx-cc).
#
# Example:
#   cd services/caellum
#   bash setup_neuron.sh
#
# It is idempotent: re-running just re-resolves the pinned set. It NEVER touches the
# pre-installed Neuron SDK packages (torch-neuronx / neuronx-cc / torch_xla) — those
# come from the workshop DLAMI and must stay at their matched versions.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REQ_FILE="${SCRIPT_DIR}/requirements-neuron.txt"

echo "=============================================================="
echo " CAELLUM Neuron setup  (env: AWS workshop inf2, no CUDA)"
echo " script dir : ${SCRIPT_DIR}"
echo " requirements: ${REQ_FILE}"
echo "=============================================================="

if [[ ! -f "${REQ_FILE}" ]]; then
  echo "ERROR: ${REQ_FILE} not found. Run this from a checkout of services/caellum/." >&2
  exit 1
fi

# NEURON_FUSE_SOFTMAX is required by the optimum-neuron Stable Diffusion path (per spec).
# Export it for THIS shell and persist it to the user's bashrc so compile.py / serve.py
# inherit it in later sessions too.
export NEURON_FUSE_SOFTMAX=1
echo "exported NEURON_FUSE_SOFTMAX=1 for this shell"

BASHRC="${HOME}/.bashrc"
if [[ -w "${BASHRC}" || ! -e "${BASHRC}" ]]; then
  if ! grep -qs 'NEURON_FUSE_SOFTMAX=1' "${BASHRC}" 2>/dev/null; then
    {
      echo ''
      echo '# CAELLUM: required by optimum-neuron Stable Diffusion compile/serve'
      echo 'export NEURON_FUSE_SOFTMAX=1'
    } >> "${BASHRC}"
    echo "persisted NEURON_FUSE_SOFTMAX=1 to ${BASHRC}"
  else
    echo "NEURON_FUSE_SOFTMAX already present in ${BASHRC}"
  fi
else
  echo "WARN: ${BASHRC} not writable; skipped persisting NEURON_FUSE_SOFTMAX (already set for this shell)"
fi

# Pick a python: prefer python3.
PY="$(command -v python3 || command -v python)"
echo "using python: ${PY} ($("${PY}" --version 2>&1))"

# Guard: we MUST be inside the Neuron virtualenv (torch-neuronx importable), not the bare
# system python (which is PEP-668 externally-managed AND has no Neuron SDK). This is the #1
# setup mistake on the workshop box.
if ! "${PY}" -c "import torch_neuronx" >/dev/null 2>&1; then
  echo "" >&2
  echo "ERROR: torch_neuronx is NOT importable with ${PY}." >&2
  echo "You are not in the Neuron virtualenv. Activate it first, then re-run, e.g.:" >&2
  echo "    source /opt/aws_neuronx_venv_pytorch_2_9/bin/activate" >&2
  echo "(run 'ls /opt' and pick the aws_neuronx_venv_pytorch_* that matches this box)" >&2
  exit 1
fi
echo "torch_neuronx import OK — inside the Neuron venv."

echo
echo "--> upgrading pip tooling"
"${PY}" -m pip install --upgrade pip setuptools wheel

echo
echo "--> installing CAELLUM Neuron deps (on top of the workshop Neuron SDK)"
# --no-deps is NOT used: we want optimum-neuron's transitive resolution. The Neuron SDK
# packages are already satisfied and pip will leave them in place (we don't list them).
"${PY}" -m pip install -r "${REQ_FILE}"

echo
echo "=============================================================="
echo " Installed versions (sanity check):"
echo "=============================================================="
# Print the key versions. Each guarded so a missing one prints a clear note instead
# of aborting the whole script.
print_ver () {
  local import_name="$1"
  local pretty="$2"
  "${PY}" - "$import_name" "$pretty" <<'PYEOF'
import importlib, sys
mod_name, pretty = sys.argv[1], sys.argv[2]
try:
    mod = importlib.import_module(mod_name)
    ver = getattr(mod, "__version__", None)
    if ver is None:
        # torch-neuronx exposes its version via torch's plugin; fall back to pkg metadata.
        from importlib.metadata import version as _v
        ver = _v(pretty)
    print(f"  {pretty:18s} {ver}")
except Exception as exc:  # noqa: BLE001
    print(f"  {pretty:18s} NOT FOUND ({exc})")
PYEOF
}

# torch-neuronx is imported as torch_neuronx; its dist name is torch-neuronx.
print_ver "torch_neuronx" "torch-neuronx"
# neuronx-cc (the compiler) imports as neuronxcc.
print_ver "neuronxcc" "neuronx-cc"
print_ver "optimum.neuron" "optimum-neuron"
# A couple more that the pipeline depends on, for quick triage:
print_ver "torch" "torch"
print_ver "diffusers" "diffusers"

echo
echo "Setup complete. Next:"
echo "  python compile.py --base sd15            # guaranteed floor"
echo "  python compile.py --base sdxl            # primary/quality (segfault risk on AL2; falls back to sd15)"
