# CHLOE Build Spec — the coder/mechanics model (read before writing any file)

CHLOE maps a drawn object's **description/label → a bounded JSON mechanic spec** (pick one node
from a fixed library + clamped params). The spec is **data, never code** — the game already runs it.
Single source of truth: `services/chloe/config.py` (`NODES`, `SYSTEM_PROMPT`, `node_menu()`,
`clamp_spec()`, serve config). Import it on the Neuron/serve side; mirror its values on Colab.

## The pipeline (distill Claude → train a small student on Trainium → serve)
```
[local/Colab] gen_chloe_dataset.py ──Claude teacher──► data/chloe_pairs.jsonl (SFT chat rows)
                                                              │
[Trainium]    train_chloe_sft.py  (NeuronSFTTrainer LoRA on Qwen2.5-1.5B) ──► chloe_lora/
                                                              │
[Trainium|API] serve.py: description/label -> generate spec -> clamp_spec() -> {node,params,name,flavor}
                                                              │
[game]        DS.AI POSTs the label -> attaches the returned spec as the prop's mechanic
```

## Files to build (one agent each)
| File | Env | Purpose |
|---|---|---|
| `data/gen_chloe_dataset.py` | local/Colab (Anthropic API) | distill Claude → `data/chloe_pairs.jsonl` SFT chat rows |
| `train/train_chloe_sft.py` + `train/requirements-chloe.txt` | Trainium | `NeuronSFTTrainer` LoRA fine-tune of `config.BASE_MODEL` on the jsonl |
| `services/chloe/serve.py` + `services/chloe/requirements-serve.txt` | Trainium **or** API | `/mechanic` endpoint: generate spec → `clamp_spec` → JSON; backends: `claude` (Anthropic) + `local` (trained model) |
| `js/ai.js` (EXTEND) | game | after a prop spawns, POST its label to CHLOE → set `prop.mechanic` to the returned spec |
| `RUNBOOK-chloe.md` (repo root) + `services/chloe/README.md` | — | operator steps: dataset → train → fuse/serve → wire |

## Data format (gen_chloe_dataset.py writes, train reads)
`data/chloe_pairs.jsonl` — one JSON object per line, a chat conversation:
```json
{"messages": [
  {"role": "system", "content": "<config.SYSTEM_PROMPT>\n\n<config.node_menu()>"},
  {"role": "user", "content": "a heavy slow cannon"},
  {"role": "assistant", "content": "{\"node\":\"projectile_weapon\",\"params\":{\"speed\":520,\"damage\":18,...},\"name\":\"Cannon\",\"flavor\":\"slow heavy shot\"}"}
]}
```
The assistant content is a **clamped** spec string (run it through `config.clamp_spec` before writing,
so training targets are always valid). Generate breadth by crossing **objects × adjectives**
(objects from `config.NODES` semantics + the 35 CAELLUM labels; adjectives: heavy/light/tiny/giant/
fast/slow/rapid-fire/explosive/powerful/weak/bouncy/etc.). Target ~1500–3000 rows.

## Verified API references (use these exactly)
- **Anthropic SDK** (teacher + the `claude` serve backend): `from anthropic import Anthropic;
  client = Anthropic(); client.messages.create(model="claude-haiku-4-5", max_tokens=400,
  system=<sys>, messages=[{"role":"user","content": desc}])`. Read the key from `ANTHROPIC_API_KEY`.
  Parse the JSON out of the text (strip ```json fences); on parse failure, retry once then skip.
- **NeuronSFTTrainer** (training): base it on optimum-neuron's `sft_lora_finetune_llm` example —
  `from optimum.neuron import NeuronSFTConfig, NeuronSFTTrainer` (+ `LoraConfig` from peft). Load the
  jsonl via `datasets.load_dataset("json", ...)`, format each row with the tokenizer's
  `apply_chat_template`, LoRA-fine-tune `config.BASE_MODEL`, save the adapter to `--output_dir`.
  argparse: `--data`, `--model`, `--output_dir`, `--max_steps`, `--lr`, `--batch_size`,
  `--max_seq_len 1024`. Cite the optimum-neuron LLM SFT tutorial in a comment.
- **Serving (CRITICAL — avoid the FastAPI bug we already hit):** this box's FastAPI mis-classifies
  typed handler params → 422. So `serve.py` MUST serve `/mechanic` via a **plain Starlette route**
  (`app.add_route(config.MECHANIC_ENDPOINT, handler, methods=["POST"])`, read the body with
  `await request.json()`), plus `CORSMiddleware(allow_origins=["*"])`, exactly like the working
  `services/caellum/serve.py`. Read that file as the pattern. Backends via `--backend {claude,local}`.

## Conventions
- Python 3.10+, argparse CLIs, top docstring naming the ENV + an example invocation, clear prints.
- Neuron/serve side `import config` (run from `services/chloe/`); Colab side may mirror constants.
- Always pass model output through `config.clamp_spec` before returning/saving — it's the safety net.
- The `js/ai.js` edit must be ADDITIVE and not break Track A: keep the default mechanic (instant),
  then POST the label to `DS.AI.chloeEndpoint` and, on success, replace `prop.mechanic` with the
  clamped spec (progressive enhancement, same as the sprite swap). Read the existing `js/ai.js` +
  `js/prop.js` + `js/mechanics.js` first; match their style; no build step.
- Do NOT touch CAELLUM files, the game engine beyond `js/ai.js`, or anything outside your list.
