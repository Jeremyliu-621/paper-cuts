from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import time
from io import BytesIO
from datetime import UTC, datetime
from typing import Any

from openai import OpenAI
from PIL import Image, ImageDraw

from .config import env, load_backend_env
from .schemas import (
    AgentCapabilityStatus,
    AgentJobRequest,
    AgentJobResponse,
    AgentStatusResponse,
    VisualObservation,
    VisualObservationHint,
)


DEFAULT_VLM_MODEL = "gpt-5.4-mini"
OPENAI_RETRY_DELAYS = (0.25, 0.75)


def agent_status() -> AgentStatusResponse:
    load_backend_env()
    openai_key_present = bool(env("OPENAI_API_KEY"))
    return AgentStatusResponse(
        capabilities=[
            AgentCapabilityStatus(
                id="deterministic_semantic",
                status="enabled",
                hotPath=False,
                requiredEnv=[],
                configuredModel=None,
                message="Vector projection heuristics build candidate geometry; VLM classification is required for auto-apply.",
            ),
            AgentCapabilityStatus(
                id="vlm_semantic",
                status="enabled" if openai_key_present else "missing_key",
                hotPath=False,
                requiredEnv=["OPENAI_API_KEY"],
                configuredModel=env("MAGICBOARD_VLM_MODEL") or DEFAULT_VLM_MODEL,
                message="Phase 1 VLM classification observes drawing candidates and chooses gameplay classes.",
            ),
        ]
    )


def _job_id(room_id: str, request: AgentJobRequest) -> str:
    raw = "|".join(
        [
            room_id,
            request.idempotency_key,
            str(request.capture_version),
            request.modality,
        ]
    )
    return "agent-job-" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


def visual_job_id(room_id: str, capture_version: int) -> str:
    raw = "|".join([room_id, str(capture_version), env("MAGICBOARD_VLM_MODEL") or DEFAULT_VLM_MODEL])
    return "visual-job-" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


def initial_visual_observation(
    *,
    room_id: str,
    world_id: str | None,
    capture_version: int,
) -> VisualObservation:
    model = env("MAGICBOARD_VLM_MODEL") or DEFAULT_VLM_MODEL
    if not env("OPENAI_API_KEY"):
        return VisualObservation(
            status="missing_key",
            roomId=room_id,
            worldId=world_id,
            captureVersion=capture_version,
            jobId=visual_job_id(room_id, capture_version),
            model=model,
            description="OPENAI_API_KEY is not configured; Phase 1 VLM classification is required before doodles can auto-apply.",
            errors=["missing OPENAI_API_KEY"],
            updatedAt=datetime.now(UTC),
        )
    return VisualObservation(
        status="pending",
        roomId=room_id,
        worldId=world_id,
        captureVersion=capture_version,
        jobId=visual_job_id(room_id, capture_version),
        model=model,
        description="Classifying candidate doodles with OpenAI vision.",
        updatedAt=datetime.now(UTC),
    )


def stale_visual_observation(observation: VisualObservation) -> VisualObservation:
    return VisualObservation(
        status="stale",
        roomId=observation.room_id,
        worldId=observation.world_id,
        captureVersion=observation.capture_version,
        jobId=observation.job_id,
        model=observation.model,
        description="A newer capture arrived before this observation finished.",
        hints=observation.hints,
        latencyMs=observation.latency_ms,
        errors=observation.errors,
        updatedAt=datetime.now(UTC),
    )


def _source_intersects_geometry(item: dict[str, Any], geometry: dict[str, Any]) -> bool:
    item_id = str(item.get("sourceId") or item.get("id") or "")
    if item_id in set(str(source_id) for source_id in geometry.get("sourceIds") or []):
        return True
    gx = float(geometry.get("x") or 0)
    gy = float(geometry.get("y") or 0)
    gw = float(geometry.get("w") or 0)
    gh = float(geometry.get("h") or 0)
    if "points" in item:
        for point in item.get("points") or []:
            if not isinstance(point, dict):
                continue
            x = point.get("x")
            y = point.get("y")
            if isinstance(x, int | float) and isinstance(y, int | float) and gx <= x <= gx + gw and gy <= y <= gy + gh:
                return True
        return False
    x, y, w, h = item.get("x"), item.get("y"), item.get("w"), item.get("h")
    if not all(isinstance(value, int | float) for value in (x, y, w, h)):
        return False
    return gx <= float(x) + float(w) and gx + gw >= float(x) and gy <= float(y) + float(h) and gy + gh >= float(y)


def _focus_bounds(
    projection: dict[str, Any] | None,
    candidate: dict[str, Any] | None,
) -> tuple[float, float, float, float]:
    projection = projection or {}
    coordinate_space = projection.get("coordinateSpace") or {}
    source_w = float(coordinate_space.get("width") or 1920)
    source_h = float(coordinate_space.get("height") or 1080)
    geometry = candidate.get("geometry") if isinstance(candidate, dict) else None
    if not isinstance(geometry, dict):
        return (0.0, 0.0, source_w, source_h)
    pad = max(80.0, min(220.0, max(float(geometry.get("w") or 0), float(geometry.get("h") or 0)) * 0.45))
    x0 = max(0.0, float(geometry.get("x") or 0) - pad)
    y0 = max(0.0, float(geometry.get("y") or 0) - pad)
    x1 = min(source_w, float(geometry.get("x") or 0) + float(geometry.get("w") or 0) + pad)
    y1 = min(source_h, float(geometry.get("y") or 0) + float(geometry.get("h") or 0) + pad)
    if x1 - x0 < 40 or y1 - y0 < 40:
        return (0.0, 0.0, source_w, source_h)
    return (x0, y0, x1, y1)


def _projection_png_data_url(projection: dict[str, Any] | None, candidate: dict[str, Any] | None = None) -> str:
    projection = projection or {}
    coordinate_space = projection.get("coordinateSpace") or {}
    source_w = float(coordinate_space.get("width") or 1920)
    source_h = float(coordinate_space.get("height") or 1080)
    crop_x0, crop_y0, crop_x1, crop_y1 = _focus_bounds(projection, candidate)
    crop_w = max(1.0, crop_x1 - crop_x0)
    crop_h = max(1.0, crop_y1 - crop_y0)
    target_w = 960
    target_h = max(1, round(target_w * crop_h / max(crop_w, 1.0)))
    sx = target_w / max(crop_w, 1.0)
    sy = target_h / max(crop_h, 1.0)
    focus_source_ids = set(str(source_id) for source_id in (candidate or {}).get("sourceIds") or [])

    image = Image.new("RGB", (target_w, target_h), "#fffaf0")
    draw = ImageDraw.Draw(image)

    for shape in projection.get("shapes") or []:
        if not isinstance(shape, dict):
            continue
        x, y, w, h = (shape.get("x"), shape.get("y"), shape.get("w"), shape.get("h"))
        if all(isinstance(value, int | float) for value in (x, y, w, h)):
            if candidate and not _source_intersects_geometry(shape, {"sourceIds": list(focus_source_ids), **((candidate or {}).get("geometry") or {})}):
                continue
            x1 = round((float(x) - crop_x0) * sx)
            y1 = round((float(y) - crop_y0) * sy)
            x2 = round((float(x) + float(w) - crop_x0) * sx)
            y2 = round((float(y) + float(h) - crop_y0) * sy)
            width = max(2, round(float(shape.get("width") or 10) * sx))
            source_id = str(shape.get("sourceId") or shape.get("id") or "")
            color = "#d4663f" if source_id in focus_source_ids else "#2f2a26"
            draw.rectangle([x1, y1, x2, y2], outline=color, width=width)

    for stroke in projection.get("strokes") or []:
        if not isinstance(stroke, dict):
            continue
        if candidate and not _source_intersects_geometry(stroke, {"sourceIds": list(focus_source_ids), **((candidate or {}).get("geometry") or {})}):
            continue
        points = []
        for point in stroke.get("points") or []:
            if isinstance(point, dict) and isinstance(point.get("x"), int | float) and isinstance(point.get("y"), int | float):
                points.append((round((float(point["x"]) - crop_x0) * sx), round((float(point["y"]) - crop_y0) * sy)))
        if len(points) >= 2:
            width = max(2, round(float(stroke.get("width") or 6) * sx))
            source_id = str(stroke.get("sourceId") or stroke.get("id") or "")
            color = "#d4663f" if source_id in focus_source_ids else "#2f2a26"
            draw.line(points, fill=color, width=width, joint="curve")

    if isinstance(candidate, dict) and isinstance(candidate.get("geometry"), dict):
        geometry = candidate["geometry"]
        x1 = round((float(geometry.get("x") or 0) - crop_x0) * sx)
        y1 = round((float(geometry.get("y") or 0) - crop_y0) * sy)
        x2 = round((float(geometry.get("x") or 0) + float(geometry.get("w") or 0) - crop_x0) * sx)
        y2 = round((float(geometry.get("y") or 0) + float(geometry.get("h") or 0) - crop_y0) * sy)
        draw.rectangle([x1, y1, x2, y2], outline="#2f6fe0", width=5)

    buffer = BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _safe_projection_context(projection: dict[str, Any] | None) -> dict[str, Any]:
    projection = projection or {}
    return {
        "coordinateSpace": projection.get("coordinateSpace"),
        "strokes": (projection.get("strokes") or [])[:24],
        "shapes": (projection.get("shapes") or [])[:24],
        "labels": (projection.get("labels") or [])[:12],
    }


def _output_text(response: dict[str, Any]) -> str:
    if isinstance(response.get("output_text"), str):
        return response["output_text"]
    chunks: list[str] = []
    for item in response.get("output") or []:
        if not isinstance(item, dict):
            continue
        for content in item.get("content") or []:
            if isinstance(content, dict) and content.get("type") in {"output_text", "text"}:
                text = content.get("text")
                if isinstance(text, str):
                    chunks.append(text)
    return "".join(chunks)


def _visual_prompt(projection: dict[str, Any] | None, candidate: dict[str, Any] | None = None) -> str:
    candidate_text = ""
    if candidate:
        candidate_text = (
            "\nCandidate to classify:\n"
            + json.dumps(
                {
                    "candidateId": candidate.get("candidateId"),
                    "sourceIds": candidate.get("sourceIds") or [],
                    "geometry": candidate.get("geometry"),
                    "extractor": candidate.get("extractor"),
                    "semanticType": candidate.get("semanticType"),
                },
                sort_keys=True,
            )
        )
    return (
        "You classify candidate doodles in a 1920x1080 level editor. The program owns all geometry; "
        "you only choose the class for the single highlighted candidate. Valid gameplay classes are "
        "platform, cannon, spikes, portal_endpoint, portal_pair, decor, unknown, or ignore. Return only "
        "compact JSON with keys description and hints. Return exactly one hint. The hint must use the "
        "candidate sourceIds exactly. Keep descriptions under 80 characters. Do not invent coordinates "
        "or gameplay rules."
        "\nProjection JSON:\n"
        + json.dumps(_safe_projection_context(projection), sort_keys=True)
        + candidate_text
    )


def _visual_json_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["description", "hints"],
        "properties": {
            "description": {"type": "string"},
            "hints": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["kind", "confidence", "description", "behavior", "sourceIds"],
                    "properties": {
                        "kind": {
                            "type": "string",
                            "enum": [
                                "platform",
                                "cannon",
                                "spikes",
                                "portal_endpoint",
                                "portal_pair",
                                "hazard",
                                "decor",
                                "ignore",
                                "unknown",
                            ],
                        },
                        "confidence": {"type": "number"},
                        "description": {"type": "string"},
                        "behavior": {
                            "type": ["string", "null"],
                            "enum": [
                                "solid",
                                "pass",
                                "bounce",
                                "hurt",
                                "ice",
                                "breakable",
                                "cannon",
                                "spikes",
                                "portal_endpoint",
                                "portal_pair",
                                "unknown",
                                "decor",
                                "ignore",
                                None,
                            ],
                        },
                        "sourceIds": {"type": "array", "items": {"type": "string"}},
                    },
                },
            },
        },
    }


def _parse_openai_json(text: str) -> dict[str, Any]:
    clean = text.strip()
    if clean.startswith("```"):
        clean = clean.removeprefix("```json").removeprefix("```").strip()
        if clean.endswith("```"):
            clean = clean[:-3].strip()
    try:
        parsed = json.loads(clean)
    except json.JSONDecodeError as error:
        start = clean.find("{")
        end = clean.rfind("}")
        if 0 <= start < end:
            try:
                parsed = json.loads(clean[start : end + 1])
            except json.JSONDecodeError:
                preview = clean[:700].replace("\n", "\\n")
                raise RuntimeError(f"OpenAI returned malformed JSON at char {error.pos}: {preview}") from error
        else:
            preview = clean[:700].replace("\n", "\\n")
            raise RuntimeError(f"OpenAI returned non-JSON visual response: {preview}") from error
    if not isinstance(parsed, dict):
        raise RuntimeError("OpenAI visual response JSON must be an object")
    return parsed


def _clean_hint(raw: dict[str, Any]) -> VisualObservationHint | None:
    kind = str(raw.get("kind") or "unknown").lower()
    if kind not in {"platform", "cannon", "spikes", "portal_endpoint", "portal_pair", "hazard", "decor", "ignore", "unknown"}:
        kind = "unknown"
    behavior = raw.get("behavior")
    if isinstance(behavior, str):
        value = behavior.lower()
        if "pass" in value:
            behavior = "pass"
        elif "bounce" in value or "trampoline" in value:
            behavior = "bounce"
        elif "hurt" in value or "damage" in value or "hazard" in value:
            behavior = "hurt"
        elif "ice" in value or "icy" in value:
            behavior = "ice"
        elif "break" in value:
            behavior = "breakable"
        elif "cannon" in value:
            behavior = "cannon"
        elif "spike" in value:
            behavior = "spikes"
        elif "portal_pair" in value or "portal pair" in value:
            behavior = "portal_pair"
        elif "portal" in value:
            behavior = "portal_endpoint"
        elif "unknown" in value:
            behavior = "unknown"
        elif "decor" in value:
            behavior = "decor"
        elif "ignore" in value:
            behavior = "ignore"
        elif "solid" in value or "platform" in value:
            behavior = "solid"
        else:
            behavior = None
    elif behavior is not None:
        behavior = None
    source_ids = raw.get("sourceIds") if isinstance(raw.get("sourceIds"), list) else []
    return VisualObservationHint(
        kind=kind,  # type: ignore[arg-type]
        confidence=max(0.0, min(1.0, float(raw.get("confidence") or 0.0))),
        description=str(raw.get("description") or ""),
        behavior=behavior,  # type: ignore[arg-type]
        sourceIds=[str(source_id) for source_id in source_ids],
    )


def _parse_response_output_text(response: Any) -> str:
    output_text = getattr(response, "output_text", None)
    if isinstance(output_text, str):
        return output_text
    if hasattr(response, "model_dump"):
        return _output_text(response.model_dump())
    return _output_text(response if isinstance(response, dict) else {})


def _request_openai_candidate_observation(
    *,
    projection: dict[str, Any] | None,
    candidate: dict[str, Any],
    model: str,
) -> dict[str, Any]:
    client = OpenAI(api_key=env("OPENAI_API_KEY"))
    response = client.responses.create(
        model=model,
        input=[
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": _visual_prompt(projection, candidate)},
                    {"type": "input_image", "image_url": _projection_png_data_url(projection, candidate), "detail": "low"},
                ],
            }
        ],
        max_output_tokens=500,
        text={
            "format": {
                "type": "json_schema",
                "name": "magicboard_visual_observation",
                "strict": True,
                "schema": _visual_json_schema(),
            }
        },
    )
    text = _parse_response_output_text(response)
    if not text:
        raise RuntimeError("OpenAI response did not include output text")
    parsed = _parse_openai_json(text)
    hints = parsed.get("hints") if isinstance(parsed.get("hints"), list) else []
    if hints and isinstance(hints[0], dict):
        hints[0]["sourceIds"] = [str(source_id) for source_id in candidate.get("sourceIds") or []]
    return parsed


def _request_with_retries(callable_fn: Any) -> dict[str, Any]:
    errors: list[str] = []
    for attempt in range(len(OPENAI_RETRY_DELAYS) + 1):
        try:
            return callable_fn()
        except Exception as error:
            errors.append(f"{type(error).__name__}: {error}")
            if attempt >= len(OPENAI_RETRY_DELAYS):
                raise RuntimeError("; ".join(errors)) from error
            time.sleep(OPENAI_RETRY_DELAYS[attempt])
    raise RuntimeError("OpenAI request failed")


def _request_openai_visual_observation(
    *,
    projection: dict[str, Any] | None,
    candidates: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    api_key = env("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("missing OPENAI_API_KEY")
    model = env("MAGICBOARD_VLM_MODEL") or DEFAULT_VLM_MODEL
    candidate_list = [candidate for candidate in candidates or [] if isinstance(candidate, dict)]
    if not candidate_list:
        return {"description": "No semantic candidates needed visual classification.", "hints": []}
    hints: list[dict[str, Any]] = []
    descriptions: list[str] = []
    for candidate in candidate_list:
        result = _request_with_retries(
            lambda candidate=candidate: _request_openai_candidate_observation(
                projection=projection,
                candidate=candidate,
                model=model,
            )
        )
        if result.get("description"):
            descriptions.append(str(result.get("description")))
        for hint in result.get("hints") or []:
            if isinstance(hint, dict):
                hint["sourceIds"] = [str(source_id) for source_id in candidate.get("sourceIds") or []]
                hints.append(hint)
    return {
        "description": "; ".join(descriptions[:3]) or f"Classified {len(hints)} candidate doodles.",
        "hints": hints,
    }


async def run_visual_observation(
    *,
    room_id: str,
    world_id: str | None,
    capture_version: int,
    job_id: str,
    projection: dict[str, Any] | None,
    candidates: list[dict[str, Any]] | None = None,
) -> VisualObservation:
    started = time.perf_counter()
    model = env("MAGICBOARD_VLM_MODEL") or DEFAULT_VLM_MODEL
    try:
        result = await asyncio.to_thread(_request_openai_visual_observation, projection=projection, candidates=candidates)
        hints = [
            cleaned
            for hint in result.get("hints") or []
            if isinstance(hint, dict) and (cleaned := _clean_hint(hint)) is not None
        ]
        return VisualObservation(
            status="ready",
            roomId=room_id,
            worldId=world_id,
            captureVersion=capture_version,
            jobId=job_id,
            model=model,
            description=str(result.get("description") or "Observed the current drawing."),
            hints=hints,
            latencyMs=max(0, round((time.perf_counter() - started) * 1000)),
            updatedAt=datetime.now(UTC),
        )
    except Exception as error:
        return VisualObservation(
            status="error",
            roomId=room_id,
            worldId=world_id,
            captureVersion=capture_version,
            jobId=job_id,
            model=model,
            description="OpenAI vision classification failed; Phase 1 will not auto-apply this capture until VLM classification succeeds.",
            latencyMs=max(0, round((time.perf_counter() - started) * 1000)),
            errors=[str(error)],
            updatedAt=datetime.now(UTC),
        )


def make_stub_job(
    *,
    room_id: str,
    current_capture_version: int,
    request: AgentJobRequest,
) -> AgentJobResponse:
    required_env: list[str] = []
    if request.capture_version != current_capture_version:
        status = "stale"
        message = "Capture version changed before the cold-path agent job could run."
    elif request.modality in {"vlm", "llm"}:
        required_env = ["OPENAI_API_KEY"]
        if env("OPENAI_API_KEY"):
            status = "stubbed_ready"
            message = "OPENAI_API_KEY is present; VLM classification runs from capture updates."
        else:
            status = "stubbed_missing_key"
            message = "Phase 1 VLM classification is not configured. Candidate geometry can be detected but doodles will not auto-apply."
    else:
        status = "unsupported"
        message = "Unsupported agent modality."

    return AgentJobResponse(
        jobId=_job_id(room_id, request),
        roomId=room_id,
        worldId=request.world_id,
        idempotencyKey=request.idempotency_key,
        captureVersion=request.capture_version,
        currentCaptureVersion=current_capture_version,
        modality=request.modality,
        status=status,  # type: ignore[arg-type]
        requiredEnv=required_env,
        message=message,
        clientId=request.client_id,
        createdAt=datetime.now(UTC),
    )
