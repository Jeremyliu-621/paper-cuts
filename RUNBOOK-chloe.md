# RUNBOOK — CHLOE mechanic-spec engine (operator step-by-step)

> The human/operator (Sai or a person) runs these steps to stand up the **mechanics engine**:
> a drawn object's description/label → a **bounded JSON mechanic spec** (one node from a fixed
> library + clamped params) that the game runs as-is. This is the runtime *gameplay* half of the AI
> pipeline (CAELLUM is the *visual* half — see [`RUNBOOK-image.md`](RUNBOOK-image.md)). The
> implementation contract is
> [`services/chloe/IMPLEMENTATION-SPEC.md`](services/chloe/IMPLEMENTATION-SPEC.md); the single source
> of truth for the node library, the system prompt, and the `clamp_spec()` safety net is
> [`services/chloe/config.py`](services/chloe/config.py).

**Mental model:** *playable before it's tuned.* When a prop spawns, the game gives it a default
**instant** mechanic immediately — playable NOW with zero AI. CHLOE is the best-effort upgrade that
arrives a moment later and replaces that mechanic with one that *feels like the drawing* ("a heavy
slow cannon" → a slow, high-damage, long-cooldown `projectile_weapon`). Nothing here blocks the
frame loop, and **every rung of the fallback ladder (§7) is demoable** — including with no trained
model at all (the `claude` backend, or even just the default instant mechanic).

**The output is DATA, never code.** CHLOE picks one node and fills its params; the spec is *always*
passed through [`config.clamp_spec()`](services/chloe/config.py) before it is saved or returned, so a
hallucinated/garbage value can never break a match. That clamp is the safety net — trust it.

---

## 0. The two environments — what runs where

There are **two separate machines** with **separate Python envs**. Do not install one's deps on the
other.

| Env | What it is | What it runs | Key trait |
|---|---|---|---|
| **Trainium box** | AWS workshop Code Editor / **trn1 (or inf2)** instance | `train/train_chloe_sft.py`, `services/chloe/serve.py --backend local` | Has the Neuron SDK (torch-neuronx, neuronx-cc, optimum-neuron). **No CUDA.** Has this repo, so scripts `import config`. |
| **Local / Colab (Anthropic API)** | any box with `pip install anthropic` + an `ANTHROPIC_API_KEY` | `data/gen_chloe_dataset.py`, `services/chloe/serve.py --backend claude` | No Neuron needed. Just the SDK + the key. |

The two halves meet at **one artifact**: the Colab/local side distills the dataset; the Trainium
side trains a LoRA on it (`chloe_lora/`) and serves it. The **`claude` backend short-circuits the
whole training track** — it serves correct, clamped specs from the Anthropic API with no Trainium at
all, so it is both the day-one runtime *and* the fallback if training/serving the student isn't
ready (see §7).

---

## 1. Build the dataset (local / Colab — Anthropic API)

On any box with the Anthropic SDK and your key, from the repo root:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pip install anthropic
python data/gen_chloe_dataset.py
```

`gen_chloe_dataset.py` distills the **Claude teacher** (`claude-haiku-4-5`) into SFT chat rows: it
crosses the node-library objects × the 35 CAELLUM labels × adjectives (heavy/light/tiny/giant/fast/
slow/rapid-fire/explosive/bouncy/…), asks Claude for a spec per description, **runs each spec through
`config.clamp_spec()`**, and writes `data/chloe_pairs.jsonl` (~**2000 rows**). Each line is a chat
conversation `{"messages":[system, user, assistant]}` where the assistant content is the *clamped*
spec string — so every training target is already valid.

Sanity check the output:
```bash
wc -l data/chloe_pairs.jsonl                      # expect ~1500–3000 rows
head -1 data/chloe_pairs.jsonl | python -m json.tool   # one {"messages":[...]} row
```

> Costs a small amount of Anthropic credit and a few minutes. If a row fails to parse, the generator
> retries once then skips it (per the spec) — a few dropped rows are fine.

---

## 2. Train the student on Trainium (LoRA SFT)

Move to the **Trainium box** (it has the repo, so `import config` works). Activate the workshop's
**Neuron venv**, install the training deps, and run the SFT:

```bash
# activate the workshop's Neuron Python env (path varies by AMI; e.g.):
source /opt/aws_neuronx_venv_pytorch/bin/activate

pip install -r train/requirements-chloe.txt

cd services/chloe   # run from here so train picks up config.py / the node library
python ../../train/train_chloe_sft.py \
  --data ../../data/chloe_pairs.jsonl \
  --model Qwen/Qwen2.5-1.5B-Instruct \
  --output_dir chloe_lora \
  --max_seq_len 1024 \
  --max_steps 800 \
  --lr 1e-4 \
  --batch_size 1
```

`train_chloe_sft.py` (built on optimum-neuron's `NeuronSFTTrainer` / `NeuronSFTConfig` + a peft
`LoraConfig`) loads the jsonl with `datasets.load_dataset("json", …)`, formats each row with the
tokenizer's `apply_chat_template`, LoRA-fine-tunes `config.BASE_MODEL` (`Qwen/Qwen2.5-1.5B-Instruct`,
fallback `meta-llama/Llama-3.2-1B-Instruct`), and saves the adapter to `--output_dir` (`chloe_lora/`).

> Defaults above are a starting point — bump `--max_steps` if the loss is still falling, drop
> `--lr` if it diverges. The dataset is small and bounded, so this is a short run.

---

## 3. Serve it (the `/mechanic` endpoint)

`serve.py` exposes the contract from `config.py` — `POST /mechanic` (description/label → clamped
spec) and `GET /healthz` — on port **8500**. It serves `/mechanic` via a **plain Starlette route**
(NOT FastAPI typed params: this box's FastAPI mis-reads typed handler params and 422s — same trap
CAELLUM hit), with `CORSMiddleware(allow_origins=["*"])` so the browser game can call it. Pick a
backend:

**Reliable runtime — `claude` backend** (the day-one path; needs only `ANTHROPIC_API_KEY`, no
Trainium):
```bash
export ANTHROPIC_API_KEY=sk-ant-...
cd services/chloe
python serve.py --backend claude
```

**Trained student — `local` backend** (on the Trainium box, after §2):
```bash
cd services/chloe
python serve.py --backend local --lora-dir chloe_lora
```

Either way, every response is passed through `config.clamp_spec()` before it leaves the server. Check
health and smoke-test the endpoint:

```bash
curl -s http://localhost:8500/healthz

curl -s -X POST http://localhost:8500/mechanic \
  -H 'Content-Type: application/json' \
  -d '{"description":"a heavy slow cannon"}'
# -> {"node":"projectile_weapon","params":{...clamped...},"name":"Cannon","flavor":"slow heavy shot"}
```

The body accepts `{"description": ...}` or `{"label": ...}`; the response is the clamped spec
`{node, params, name, flavor}` (per `config.py`).

### Expose the port (like CAELLUM)

The game runs in a browser from a different origin, so the `:8500` endpoint must be reachable from
where the game is served. Use the same approach as CAELLUM's `:8400`:

- **Quick tunnel (easiest for a workshop):** `cloudflared tunnel --url http://localhost:8500`
  prints a public `https://…trycloudflare.com` URL — use `<that-url>/mechanic` in step 4. (HTTPS also
  avoids mixed-content blocks if the game is served over HTTPS.)
- **Or open the port directly:** add an inbound rule for **TCP 8500** to the instance's **security
  group** (scope the source to your IP) and use `http://<instance-public-ip>:8500/mechanic`.

CORS is already `*` on the server, so no extra config is needed once the URL is reachable.

---

## 4. Wire it into the game

In the running game's **browser console** (or wherever you bootstrap `DS.AI`), point CHLOE at the
exposed URL:

```js
DS.AI.connectChloe('https://<your-url>/mechanic');   // or http://<host>:8500/mechanic
```

After this, when a prop spawns the game keeps its instant default mechanic, POSTs the prop's label to
CHLOE, and on success **replaces `prop.mechanic` with the returned clamped spec** — progressive
enhancement, exactly like the CAELLUM sprite swap (`DS.AI.connect(...)` for the visual side). If
CHLOE is down or unset, the default mechanic just keeps playing; nothing stalls.

> CHLOE (mechanics) and CAELLUM (sprite) are independent — you can connect either, both, or neither.
> Both upgrade the same prop in place and neither blocks the frame loop.

---

## 5. Snapshot the LoRA to S3 (before the workshop window closes)

The Trainium workshop window is time-boxed. **Snapshot the trained adapter to S3 so it survives after
the box goes away:**

```bash
aws s3 cp services/chloe/chloe_lora/ s3://<your-bucket>/chloe/chloe_lora/ --recursive
```

To restore later (on any Neuron box), pull it back and serve — no retraining needed:
```bash
aws s3 cp s3://<your-bucket>/chloe/chloe_lora/ services/chloe/chloe_lora/ --recursive
cd services/chloe && python serve.py --backend local --lora-dir chloe_lora
```

Do this **before you leave the Trainium window** — it's the cheapest insurance against the time-box.
(The dataset `data/chloe_pairs.jsonl` is worth keeping too — it's the input to any re-train.)

---

## 6. Suggested time order

The student-training track is optional polish; the `claude` backend is a complete, demoable runtime
on its own. Front-load whichever you can start immediately.

| When | Local / Colab (API) | Trainium box |
|---|---|---|
| **t0** | §1 `gen_chloe_dataset.py` → `data/chloe_pairs.jsonl` (a few minutes). | activate the Neuron venv, `pip -r train/requirements-chloe.txt`. |
| **as soon as you have the key** | §3 `serve.py --backend claude` + §4 wire — **you have a working demo now**. | (waiting on the dataset) |
| **when the dataset lands** | (done) | §2 `train_chloe_sft.py` → `chloe_lora/`. |
| **when the LoRA trains** | re-point §4 at the `local`-backend URL if you want the student. | §3 `serve.py --backend local --lora-dir chloe_lora` → §5 **snapshot to S3**. |

Rule of thumb: **get the `claude` backend serving and wired first** (a guaranteed, demoable result),
*then* chase the trained student as an upgrade.

---

## 7. Fallback ladder (every rung is demoable)

Take the highest rung that works; never block on a higher one.

1. **Trained student on Trainium** (`serve.py --backend local --lora-dir chloe_lora`) — the
   fine-tuned, self-hosted model. The quality/independence target.
2. → **`claude` backend** (`serve.py --backend claude`) — if the Trainium **training** or **serving**
   isn't ready (dataset not built, train OOMs/segfaults, Neuron load fails, or the window closed).
   Needs only `ANTHROPIC_API_KEY`; emits the *same* clamped contract, so the game can't tell the
   difference. **This is the reliable runtime — default to it whenever the student isn't ready.**
3. → **no CHLOE server at all** — leave `DS.AI.connectChloe(...)` unset. Every spawned prop keeps the
   game's **default instant mechanic** (pure-JS, zero AI). Fully playable; just not description-aware.

The `clamp_spec()` safety net applies to rungs 1–2 identically, so any served spec is always valid.
Rung 3 needs nothing — the game ships a working mechanic with no model in the loop.

---

## Reference

- Contract / verified API references / data format / conventions:
  [`services/chloe/IMPLEMENTATION-SPEC.md`](services/chloe/IMPLEMENTATION-SPEC.md).
- Single source of truth (node library, system prompt, `clamp_spec`, serve config):
  [`services/chloe/config.py`](services/chloe/config.py).
- Dir orientation + file map: [`services/chloe/README.md`](services/chloe/README.md).
- The visual sibling pipeline (CAELLUM): [`RUNBOOK-image.md`](RUNBOOK-image.md).
