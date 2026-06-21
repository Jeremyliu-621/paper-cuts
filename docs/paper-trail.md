# Paper Trail — a living vector memory of every doodle (Redis Vector Search)

**Sponsor track:** Redis. **Angle:** Redis as the *brain*, not a cache — Vector Search + agent memory +
content retrieval. This doc is the implementation spec AND the contract the implementation agents follow.
If the runtime never boots, this document is the deliverable of record.

**Current build scope — Phase 1 = Retrieval-Augmented Recognition (RAR) only.** Build the doodle index/memory
and the RAR path: `embed`, `ensure_index`, `index_drawing`, `knn`, `recognize_via_retrieval`, the
`/paper-trail/index`, `/paper-trail/recognize`, `/paper-trail/health` endpoints, and the `recognize()` RAR
wiring in `js/ai.js` (consult RAR first, fall back to CNN/VLM, background-index every confirmed label).
The **"Déjà Draw" remix surface** (`/similar` + the drawpad strip, §6 "Déjà Draw") is **Phase 2 / later** —
implement the `/similar` endpoint only if trivial, and **skip the drawpad remix UI for now.**

---

## 1. Concept

Every drawing anyone makes is embedded and written into a **RediSearch HNSW vector index** alongside its
confirmed label, its composed mechanic, a thumbnail, and the room it came from. That shared visual memory
powers three features — none of which are caching:

1. **Retrieval-Augmented Recognition (RAR).** A new drawing is embedded and we do a **k-NN vector search**
   over everything ever drawn, then vote the nearest confirmed labels. Recognition gets smarter and cheaper
   the more people play; the expensive VLM is only called on a cold/low-confidence retrieval.
2. **"Déjà Draw" discovery & remix.** On finishing a drawing: *"43 people drew a sword like yours — remix
   one?"* Vector similarity surfaces kindred community creations to pull into your level.
3. **Mechanic memory (CHLOE).** Every `drawing → composed mechanic` decision is stored and retrieved, so a
   "sword" behaves consistently across rooms/sessions; player love/hate signals nudge future composition.

**Graceful degradation is mandatory:** if Redis is down/unreachable, every call falls back to the existing
CNN/VLM path and the game is unaffected. Paper Trail is strictly additive.

---

## 2. Architecture

```
              ┌── drawpad.html ──┐         ┌──────────── FastAPI :8000 ────────────┐
  draw ──────▶│  POST drawing    │────────▶│  /paper-trail/recognize  (RAR)        │
              │  show "Déjà Draw"│◀────────│  /paper-trail/similar    (remix feed) │
              └──────────────────┘         │  /paper-trail/index      (write mem)  │
                                           │            paper_trail.py             │
  js/ai.js recognize() ───consults RAR────▶│   embed() · ensure_index() · knn()    │
                                           └──────────────┬────────────────────────┘
                                                          │ redis-py
                                                  ┌───────▼────────┐
                                                  │  redis-stack   │  FT.CREATE … VECTOR HNSW
                                                  │  (RediSearch)  │  doodle:<id> HASH
                                                  └────────────────┘
```

- **Embedding (MVP, dependency-light, zero model latency):** server-side, from the drawing PNG —
  decode → **invert (ink-focus)** → **crop to the ink bounding box** (translation/scale invariant; discards
  the dominating white page) → resize to **16×16** → flatten → L2-normalize → **256-dim FLOAT32** vector.
  Define a single `EMBED_DIM = 256`. **Swappable:** `embed()` is the only thing that changes to upgrade to CLIP.
  > NOTE (as-built): the naive "grayscale → 16×16" version scored ~4/9 on held-out variants because a
  > line doodle is ~95% white page, so every vector was ~identical (cosine ≈0.99). Ink-focus + content-crop
  > lifted it to **7/9 live** with discriminative similarities (right class ≈1.0, others ≈0.4–0.6).
- **Index:** RediSearch HNSW, `COSINE` distance, FLOAT32, `EMBED_DIM`.

---

## 3. Redis schema

Index name: `paper_trail_idx`. Keyspace: `doodle:<uuid>` (HASH). Created idempotently on boot.

```
FT.CREATE paper_trail_idx ON HASH PREFIX 1 doodle: SCHEMA
  label    TAG
  mechanic TEXT
  room     TAG
  ts       NUMERIC SORTABLE
  thumb    TEXT                      # data: URI (small webp/png) for the remix UI
  vec      VECTOR HNSW 6 TYPE FLOAT32 DIM 256 DISTANCE_METRIC COSINE
```

Stored fields per doodle: `label`, `mechanic` (JSON string of the composed mechanic, optional),
`room`, `ts`, `thumb`, `vec` (packed float32 bytes).

---

## 4. Python module — `backend/app/paper_trail.py`

Use `redis` (redis-py ≥ 5, which bundles RediSearch command support) + `numpy` + `Pillow`. Expose an
`APIRouter` so `main.py` only adds `app.include_router(paper_trail.router)`.

**Required functions (the contract):**

```python
EMBED_DIM = 256
INDEX = "paper_trail_idx"

def redis_client() -> "redis.Redis | None":
    """Connect to REDIS_URL (default redis://localhost:6379). Return None if unreachable (caller degrades)."""

def ensure_index(r) -> None:
    """Idempotently FT.CREATE the index above. Swallow 'Index already exists'."""

def embed(image_b64: str) -> list[float]:
    """PNG b64 -> grayscale -> 16x16 -> flatten -> L2-normalize -> 256 floats. Pure, no Redis."""

def index_drawing(r, *, label: str, image_b64: str, mechanic: str | None,
                  room: str | None, thumb_b64: str | None) -> str:
    """Embed + HSET doodle:<uuid> with all fields + packed vector. Returns the id. Best-effort."""

def knn(r, vector: list[float], k: int = 8) -> list[dict]:
    """KNN query: returns [{id,label,mechanic,thumb,room,score}], nearest first (1 - cosine_distance)."""

def recognize_via_retrieval(r, image_b64: str, k: int = 8) -> dict | None:
    """embed -> knn -> majority/weighted vote -> {label, confidence, votes, neighbors}. None if <2 hits."""

def similar(r, image_b64: str, k: int = 12, exclude_label: str | None = None) -> list[dict]:
    """embed -> knn -> de-duped neighbors (with thumbs) for the Déjà Draw remix surface."""
```

Vector packing: `np.asarray(vec, dtype=np.float32).tobytes()`. KNN query:
`FT.SEARCH paper_trail_idx "*=>[KNN $k @vec $blob AS score]" PARAMS 4 k <k> blob <bytes> SORTBY score DIALECT 2`.

**Every public fn must no-op/return safe defaults if `r is None`** (Redis down) so callers degrade silently.

---

## 5. FastAPI endpoints (`paper_trail.router`)

All take/return JSON. All degrade gracefully (Redis down → `{ok:false, degraded:true, ...}` + empty results).

| Method | Route | Body | Returns |
|---|---|---|---|
| POST | `/paper-trail/index` | `{label, image_b64, mechanic?, room?, thumb_b64?}` | `{ok, id}` |
| POST | `/paper-trail/recognize` | `{image_b64, k?}` | `{ok, label, confidence, votes, neighbors[]}` or `{ok:false}` |
| POST | `/paper-trail/similar` | `{image_b64, k?, exclude_label?}` | `{ok, results:[{id,label,thumb,score}]}` |
| GET | `/paper-trail/health` | – | `{ok, indexed_count}` |

CORS: allow `*` (same as the rest of the backend — the game page is on a different origin).

---

## 6. Frontend integration

### `js/ai.js`
- Add `paperTrailEndpoint` + `connectPaperTrail(url)` (mirror `connectVLM`).
- In `recognize(strokes)`: when a Paper Trail endpoint is set, **try RAR first** — POST the rasterized PNG to
  `/paper-trail/recognize`. If it returns a confident label (`confidence ≥ 0.6` and `votes ≥ 2`), use it
  (fast, free). Else fall through to the existing CNN→VLM chain. Whatever label is finally CONFIRMED, fire a
  background `POST /paper-trail/index` (write it into the memory, with the mechanic once composed).
- Never block spawn on Paper Trail; all calls are best-effort with `.catch`.

### `drawpad.html` — "Déjà Draw" surface
- After a stroke set is drawn (debounced), `POST /paper-trail/similar` with the normalized drawing PNG.
- Render up to ~6 returned thumbnails in a small "✏️ others drew this too" strip. Tapping one drops THAT
  community drawing onto the mini-map (remix) instead of your own — reuse the existing `{t:'draw',...}` relay
  message, carrying the chosen drawing's strokes/thumb + label.
- Fully optional UI: if `/similar` returns nothing or errors, the strip stays hidden.

---

## 7. Setup / ops

- **`docker-compose.redis.yml`** (new): one service `redis/redis-stack:latest`, ports `6379` + `8001`
  (RedisInsight). `docker compose -f docker-compose.redis.yml up -d`.
- **Dependency:** add `redis>=5`, `numpy` to the backend venv (`backend/.venv/bin/pip install redis numpy`).
- **Env:** `REDIS_URL` (default `redis://localhost:6379`). Never commit secrets.
- **Connect (game console), added to the existing 4-liner:**
  `DS.AI.connectPaperTrail(`http://${location.hostname}:8000/paper-trail`)`

---

## 8. Why it wins the track
- **Creative/original:** a growing, searchable *memory of human imagination*, not semantic caching.
- **Real human problems:** recognition robustness, the blank-canvas freeze, cross-room consistency.
- **Fun:** discover & remix what other people drew.
- **AI beyond caching:** Vector Search (RediSearch HNSW) + RAG + agent memory on Redis Stack.

## 9.5 As-built status — BUILT & VERIFIED LIVE ✅

Phase 1 (RAR) is implemented and verified end-to-end against a real `redis-stack-server`:
- `backend/app/paper_trail.py` (router `/paper-trail`, endpoints `/index` `/recognize` `/health`) wired into
  FastAPI `:8000`; `js/ai.js` `connectPaperTrail` + RAR-first in `recognize()` + background `/index`.
- Live HTTP round-trip confirmed: `POST /index` → `POST /recognize` returns the right label with confidence +
  votes; `GET /health` reports `indexed_count`. Held-out retrieval eval = **7/9** through the real HNSW index.
- Graceful degradation verified: with Redis stopped, every endpoint returns `degraded:true` + empty, game unaffected.

**Three gotchas fixed during integration (note for anyone re-running):**
1. **Embedding** was too weak (white-page domination) → switched to ink-focus + content-crop (see §2).
2. **redis-py ≥ 6 import path**: `redis.commands.search.index_definition` (snake_case), not `indexDefinition`.
3. **RESP3**: redis-py 8 + redis-stack negotiate RESP3, which `ft().search()` misparses (returns empty) —
   the client is pinned to **`protocol=2`** (RESP2) in `redis_client()`.

**Run it:** `redis-stack-server` (brew cask) or `docker compose -f docker-compose.redis.yml up -d`, then the
backend picks it up via `REDIS_URL`. Connect in the game console (append to the existing AI-connect block):
`DS.AI.connectPaperTrail(\`http://${location.hostname}:8000/paper-trail\`)`.

## 9. Devpost framing (for the Redis section)
"Paper Trail turns every doodle into a vector in a Redis Stack (RediSearch) HNSW index. New drawings are
recognized by k-NN retrieval over the community's collective memory (retrieval-augmented recognition), so the
system gets smarter and cheaper as more people draw; the same memory surfaces 'others drew this too' remixes
and gives our mechanic-composer cross-room consistency. Redis is our vector brain and agent memory — not a cache."
```
