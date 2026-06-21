"""Paper Trail — Retrieval-Augmented Recognition over a Redis vector memory.

Every confirmed doodle is embedded (cheap 16x16 grayscale descriptor) and written
into a RediSearch HNSW index alongside its label, mechanic, thumbnail, and room.
A new drawing is recognized by k-NN retrieval over that shared memory; the same
index can surface "others drew this too" remixes.

Graceful degradation is mandatory: if Redis is unreachable or any op throws, every
function and endpoint fails safe (returns empty / ``degraded`` results) so the game
is unaffected. See ``docs/paper-trail.md`` for the full contract.

This is Phase 1 (RAR only). The ``/similar`` endpoint is included as it is the same
k-NN; the "Déjà Draw" remix UI is out of scope here.
"""

from __future__ import annotations

import base64
import binascii
import io
import os
import struct
import time
import uuid
from collections import Counter
from typing import Any

from fastapi import APIRouter
from PIL import Image, ImageOps
from pydantic import BaseModel

try:  # numpy is optional at import time so the module never hard-fails on a thin env.
    import numpy as np
except Exception:  # pragma: no cover - numpy missing
    np = None  # type: ignore[assignment]

try:
    import redis
    from redis.commands.search.field import NumericField, TagField, TextField, VectorField
    try:
        # redis-py >= 6 renamed this module to snake_case; keep the old path as a fallback.
        from redis.commands.search.index_definition import IndexDefinition, IndexType
    except Exception:  # pragma: no cover - older redis-py
        from redis.commands.search.indexDefinition import IndexDefinition, IndexType
    from redis.commands.search.query import Query
except Exception:  # pragma: no cover - redis missing
    redis = None  # type: ignore[assignment]


EMBED_DIM = 256
INDEX = "paper_trail_idx"
PREFIX = "doodle:"
GRID = 16  # 16x16 grayscale -> 256-dim descriptor (GRID * GRID == EMBED_DIM)


# ---------------------------------------------------------------------------
# Redis connection + index
# ---------------------------------------------------------------------------
def redis_client() -> "redis.Redis | None":
    """Connect to ``REDIS_URL`` (default ``redis://localhost:6379``).

    Returns ``None`` if redis-py is missing or the server is unreachable so every
    caller can degrade silently. The connect + ``PING`` is wrapped in try/except;
    this never raises and never hangs (short socket timeouts).
    """
    if redis is None:
        return None
    url = os.getenv("REDIS_URL", "redis://localhost:6379")
    try:
        client = redis.Redis.from_url(
            url,
            decode_responses=False,
            protocol=2,  # RESP2: redis-py's ft().search() helper misparses RESP3 maps (returns empty)
            socket_connect_timeout=1.0,
            socket_timeout=2.0,
        )
        client.ping()
        return client
    except Exception:
        return None


def ensure_index(r: "redis.Redis | None") -> None:
    """Idempotently create the RediSearch HNSW index from the spec §3 schema.

    No-ops if ``r`` is None. Swallows "Index already exists" and any other error
    (e.g. RediSearch module not loaded) so boot/index calls never crash.
    """
    if r is None or redis is None:
        return
    try:
        r.ft(INDEX).info()
        return  # already exists
    except Exception:
        pass
    try:
        schema = (
            TagField("label"),
            TextField("mechanic"),
            TagField("room"),
            NumericField("ts", sortable=True),
            TextField("thumb"),
            VectorField(
                "vec",
                "HNSW",
                {"TYPE": "FLOAT32", "DIM": EMBED_DIM, "DISTANCE_METRIC": "COSINE"},
            ),
        )
        definition = IndexDefinition(prefix=[PREFIX], index_type=IndexType.HASH)
        r.ft(INDEX).create_index(schema, definition=definition)
    except Exception:
        # Most commonly "Index already exists" (race) or no RediSearch module.
        return


# ---------------------------------------------------------------------------
# Embedding (pure, no Redis)
# ---------------------------------------------------------------------------
def _decode_image_b64(image_b64: str) -> bytes:
    """Strip an optional ``data:`` URI prefix and base64-decode to raw bytes."""
    data = image_b64 or ""
    if "," in data and data.strip().startswith("data:"):
        data = data.split(",", 1)[1]
    return base64.b64decode(data, validate=False)


def embed(image_b64: str) -> list[float]:
    """PNG b64 -> ink-focus + content-crop -> 16x16 -> flatten -> L2-normalize -> 256 floats.

    We invert (so dark strokes are bright, the white page is 0), crop to the ink's
    bounding box (translation/scale invariant, and discards the dominating white
    background), then downscale. Without this the descriptor is ~95% white page and
    every doodle looks ~identical (cosine ~0.99); with it, classes separate cleanly.
    Pure and Redis-free. Returns a zero vector of length ``EMBED_DIM`` if the input
    cannot be decoded so callers never crash on a bad image.
    """
    zero = [0.0] * EMBED_DIM
    try:
        raw = _decode_image_b64(image_b64)
        with Image.open(io.BytesIO(raw)) as img:
            # Flatten transparency onto white so doodles on a transparent canvas
            # read the same as doodles on a white page.
            if img.mode in ("RGBA", "LA", "P"):
                img = img.convert("RGBA")
                background = Image.new("RGBA", img.size, (255, 255, 255, 255))
                img = Image.alpha_composite(background, img)
            ink = ImageOps.invert(img.convert("L"))            # ink bright, white page -> 0
            mask = ink.point(lambda p: 255 if p > 40 else 0)   # ignore near-white anti-aliasing
            box = mask.getbbox()
            content = ink.crop(box) if box else ink            # content-crop -> shape, not background
            small = content.resize((GRID, GRID), Image.BILINEAR)
            pixels = list(small.getdata())
    except Exception:
        return zero

    if np is not None:
        vec = np.asarray(pixels, dtype=np.float32) / 255.0
        norm = float(np.linalg.norm(vec))
        if norm > 0.0:
            vec = vec / norm
        return [float(x) for x in vec.tolist()]

    # numpy-free fallback so embed() still works on a thin env.
    floats = [p / 255.0 for p in pixels]
    norm = sum(x * x for x in floats) ** 0.5
    if norm > 0.0:
        floats = [x / norm for x in floats]
    return floats


def _pack_vector(vector: list[float]) -> bytes:
    """Pack a float list to little-endian FLOAT32 bytes for Redis."""
    if np is not None:
        return np.asarray(vector, dtype=np.float32).tobytes()
    return struct.pack(f"<{len(vector)}f", *vector)


# ---------------------------------------------------------------------------
# Index + query
# ---------------------------------------------------------------------------
def index_drawing(
    r: "redis.Redis | None",
    *,
    label: str,
    image_b64: str,
    mechanic: str | None,
    room: str | None,
    thumb_b64: str | None,
) -> str:
    """Embed + ``HSET doodle:<uuid>`` with all fields + packed vector.

    Returns the new doodle id, or an empty string if Redis is down / the write
    fails. Best-effort and never raises.
    """
    doodle_id = uuid.uuid4().hex
    if r is None:
        return ""
    try:
        vector = embed(image_b64)
        mapping = {
            "label": label or "",
            "mechanic": mechanic or "",
            "room": room or "",
            "ts": str(int(time.time())),
            "thumb": thumb_b64 or "",
            "vec": _pack_vector(vector),
        }
        r.hset(PREFIX + doodle_id, mapping=mapping)
        return doodle_id
    except Exception:
        return ""


def _decode(value: Any) -> str:
    """Decode a possibly-bytes Redis field to ``str``."""
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8", "replace")
        except Exception:
            return ""
    return "" if value is None else str(value)


def knn(r: "redis.Redis | None", vector: list[float], k: int = 8) -> list[dict]:
    """k-NN search over the index; nearest first.

    Returns ``[{id, label, mechanic, thumb, room, score}]`` where ``score`` is a
    similarity in ``[0, 1]`` (``1 - cosine_distance``). Empty list if Redis is down
    or the query fails.
    """
    if r is None or redis is None:
        return []
    try:
        k = max(1, int(k))
        blob = _pack_vector(vector)
        query = (
            Query(f"*=>[KNN {k} @vec $blob AS score]")
            .sort_by("score")
            .return_fields("score", "label", "mechanic", "thumb", "room")
            .dialect(2)
        )
        result = r.ft(INDEX).search(query, query_params={"blob": blob})
    except Exception:
        return []

    neighbors: list[dict] = []
    for doc in getattr(result, "docs", []) or []:
        try:
            distance = float(_decode(getattr(doc, "score", "1")) or 1.0)
        except (TypeError, ValueError):
            distance = 1.0
        doc_id = _decode(getattr(doc, "id", ""))
        if doc_id.startswith(PREFIX):
            doc_id = doc_id[len(PREFIX):]
        neighbors.append(
            {
                "id": doc_id,
                "label": _decode(getattr(doc, "label", "")),
                "mechanic": _decode(getattr(doc, "mechanic", "")),
                "thumb": _decode(getattr(doc, "thumb", "")),
                "room": _decode(getattr(doc, "room", "")),
                "score": max(0.0, 1.0 - distance),
            }
        )
    return neighbors


def recognize_via_retrieval(
    r: "redis.Redis | None", image_b64: str, k: int = 8
) -> dict | None:
    """embed -> knn -> weighted vote -> ``{label, confidence, votes, neighbors}``.

    Returns ``None`` when there are fewer than 2 neighbors (cold / low-signal
    retrieval) so the caller falls back to the CNN/VLM path. Never raises.
    """
    if r is None:
        return None
    try:
        vector = embed(image_b64)
        neighbors = knn(r, vector, k=k)
    except Exception:
        return None

    labeled = [n for n in neighbors if n.get("label")]
    if len(labeled) < 2:
        return None

    # Weight each label by its similarity score; confidence is the winning label's
    # share of the total similarity mass across all labeled neighbors.
    weights: Counter[str] = Counter()
    counts: Counter[str] = Counter()
    for n in labeled:
        weight = max(0.0, float(n.get("score", 0.0)))
        weights[n["label"]] += weight
        counts[n["label"]] += 1

    total = sum(weights.values())
    if total <= 0.0:
        # All-zero similarity (degenerate); fall back to plain majority vote.
        label, votes = counts.most_common(1)[0]
        confidence = votes / max(1, len(labeled))
    else:
        label, top_weight = weights.most_common(1)[0]
        votes = counts[label]
        confidence = top_weight / total

    return {
        "label": label,
        "confidence": round(float(confidence), 4),
        "votes": int(votes),
        "neighbors": neighbors,
    }


def similar(
    r: "redis.Redis | None",
    image_b64: str,
    k: int = 12,
    exclude_label: str | None = None,
) -> list[dict]:
    """embed -> knn -> de-duped neighbors (with thumbs) for the remix surface.

    De-dupes by ``(label, thumb)`` and optionally drops ``exclude_label`` (the
    drawer's own label). Empty list if Redis is down. Never raises.
    """
    if r is None:
        return []
    try:
        vector = embed(image_b64)
        neighbors = knn(r, vector, k=k)
    except Exception:
        return []

    seen: set[tuple[str, str]] = set()
    out: list[dict] = []
    for n in neighbors:
        if exclude_label and n.get("label") == exclude_label:
            continue
        key = (n.get("label", ""), n.get("thumb", ""))
        if key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "id": n.get("id", ""),
                "label": n.get("label", ""),
                "thumb": n.get("thumb", ""),
                "score": n.get("score", 0.0),
            }
        )
    return out


def indexed_count(r: "redis.Redis | None") -> int:
    """Number of indexed doodles (``num_docs`` from ``FT.INFO``). 0 if degraded."""
    if r is None or redis is None:
        return 0
    try:
        info = r.ft(INDEX).info()
        num = info.get("num_docs") if isinstance(info, dict) else None
        if num is None and isinstance(info, list):
            # Older clients return a flat list; find the num_docs pair.
            for i in range(0, len(info) - 1):
                if _decode(info[i]) == "num_docs":
                    num = info[i + 1]
                    break
        return int(_decode(num) or 0)
    except Exception:
        return 0


# ---------------------------------------------------------------------------
# FastAPI router
# ---------------------------------------------------------------------------
router = APIRouter(prefix="/paper-trail", tags=["paper-trail"])


class IndexRequest(BaseModel):
    label: str
    image_b64: str
    mechanic: str | None = None
    room: str | None = None
    thumb_b64: str | None = None


class RecognizeRequest(BaseModel):
    image_b64: str
    k: int = 8


class SimilarRequest(BaseModel):
    image_b64: str
    k: int = 12
    exclude_label: str | None = None


@router.post("/index")
async def index_endpoint(request: IndexRequest) -> dict[str, Any]:
    """Write a confirmed doodle into the vector memory. Degrades to ``ok:false``."""
    r = redis_client()
    if r is None:
        return {"ok": False, "degraded": True, "id": ""}
    ensure_index(r)
    doodle_id = index_drawing(
        r,
        label=request.label,
        image_b64=request.image_b64,
        mechanic=request.mechanic,
        room=request.room,
        thumb_b64=request.thumb_b64,
    )
    return {"ok": bool(doodle_id), "id": doodle_id}


@router.post("/recognize")
async def recognize_endpoint(request: RecognizeRequest) -> dict[str, Any]:
    """RAR: k-NN vote over the memory. ``ok:false`` if degraded or no confident hit."""
    r = redis_client()
    if r is None:
        return {"ok": False, "degraded": True}
    ensure_index(r)
    result = recognize_via_retrieval(r, request.image_b64, k=request.k)
    if result is None:
        return {"ok": False}
    return {"ok": True, **result}


@router.post("/similar")
async def similar_endpoint(request: SimilarRequest) -> dict[str, Any]:
    """Déjà Draw feed: de-duped nearest neighbors. ``ok:false`` if degraded."""
    r = redis_client()
    if r is None:
        return {"ok": False, "degraded": True, "results": []}
    ensure_index(r)
    results = similar(r, request.image_b64, k=request.k, exclude_label=request.exclude_label)
    return {"ok": True, "results": results}


@router.get("/health")
async def health_endpoint() -> dict[str, Any]:
    """Liveness + index size. ``ok:false`` + ``degraded`` when Redis is down."""
    r = redis_client()
    if r is None:
        return {"ok": False, "degraded": True, "indexed_count": 0}
    ensure_index(r)
    return {"ok": True, "indexed_count": indexed_count(r)}
