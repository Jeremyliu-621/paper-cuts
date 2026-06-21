# services/chloe — CHLOE mechanic-spec engine

This directory is the **mechanics engine** for Doodle Smash: it maps a drawn object's
**description/label → a bounded JSON mechanic spec** (pick ONE node from a fixed library +
clamped params). The spec is **data, never code** — the game already runs it (a ranged/throwable
spec *is* the engine's projectile cfg, so the host spawns it with zero translation). CHLOE is the
**gameplay** half of the AI pipeline, the sibling of CAELLUM (the visual half).

## Read this first
- **[`IMPLEMENTATION-SPEC.md`](IMPLEMENTATION-SPEC.md)** — the shared contract every script in this
  pipeline obeys (flow, file list, **verified** Anthropic SDK / optimum-neuron API references, the
  dataset format, conventions). Read it before touching any file here.
- **[`../../RUNBOOK-chloe.md`](../../RUNBOOK-chloe.md)** — the human/operator step-by-step: build
  the dataset, train on Trainium, serve (`--backend claude` or `--backend local`), expose the port,
  wire it into the game console, snapshot the LoRA to S3, and the fallback ladder.

## Two environments — do not mix their deps
The scripts split across **two machines** that never share a Python env:

1. **Trainium box** (`train/`, `serve.py`) — the AWS workshop Code Editor / **trn1/inf2** instance.
   Has the Neuron SDK (torch-neuronx, neuronx-cc, optimum-neuron). **No CUDA.** Runs
   `train/train_chloe_sft.py` (LoRA SFT) and `serve.py --backend local`, which `import config`.
2. **Local / Colab (Anthropic API)** — any box with `pip install anthropic` and an
   `ANTHROPIC_API_KEY`. Runs `data/gen_chloe_dataset.py` (distills the Claude teacher into the SFT
   jsonl). The `claude` serve backend also lives here-or-anywhere with just the API key — no Neuron
   needed.

`config.py` is the **single source of truth** for the node library (`NODES`), `SYSTEM_PROMPT`,
`node_menu()`, the `clamp_spec()` safety net, and the HTTP contract (`PORT`, `MECHANIC_ENDPOINT`,
`HEALTH_ENDPOINT`). The Neuron/serve side imports it; the Colab side mirrors its values.

## The safety net
Every spec the model emits is passed through **`config.clamp_spec()`** before it is saved (dataset)
or returned (serve). It validates the node, fills missing params with defaults, and clamps every
value to `NODES` ranges — so a hallucinated or garbage number can never break a match.

## File map
| File | Env | Purpose |
|---|---|---|
| `config.py` | Neuron / serve | **Single source of truth**: `NODES`, `SYSTEM_PROMPT`, `node_menu()`, `clamp_spec()`, `/mechanic` contract. |
| `serve.py` | Trainium **or** API | `/mechanic` endpoint (plain **Starlette** route, not FastAPI typed params) → generate spec → `clamp_spec` → JSON. Backends: `--backend claude` (Anthropic) / `--backend local` (trained LoRA). |
| `requirements-serve.txt` | Trainium / API | Pinned deps for the serve runtime. |
| `IMPLEMENTATION-SPEC.md` | — | The contract (read first). |
| `README.md` | — | This orientation. |

**Sibling files** (not in this dir — they live where their env expects them):
`data/gen_chloe_dataset.py` (Anthropic API → `data/chloe_pairs.jsonl`),
`train/train_chloe_sft.py` + `train/requirements-chloe.txt` (Trainium LoRA SFT),
`js/ai.js` (the game-side `DS.AI.connectChloe('<url>/mechanic')` glue).

## Quick start
```bash
# Reliable runtime — Claude backend (needs ANTHROPIC_API_KEY, no Neuron required):
export ANTHROPIC_API_KEY=sk-ant-...
cd services/chloe
python serve.py --backend claude          # serves /mechanic on :8500

# Trained student instead (on the Trainium box, after train/train_chloe_sft.py):
python serve.py --backend local --lora-dir chloe_lora
```
Then in the game console: `DS.AI.connectChloe('http://<host>:8500/mechanic')`.
Full sequence (dataset → train → serve → wire → S3 snapshot, plus the fallback ladder) is in
[`../../RUNBOOK-chloe.md`](../../RUNBOOK-chloe.md).
