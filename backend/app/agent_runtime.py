from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import ssl
import time
from io import BytesIO
from datetime import UTC, datetime
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import certifi
from PIL import Image, ImageDraw

from .schemas import (
    AgentCapabilityStatus,
    AgentJobRequest,
    AgentJobResponse,
    AgentStatusResponse,
    VisualObservation,
    VisualObservationHint,
)


DEFAULT_VLM_MODEL = "gpt-5.4-mini"
OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions"
OPENAI_SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())


def agent_status() -> AgentStatusResponse:
    openai_key_present = bool(os.getenv("OPENAI_API_KEY"))
    deepgram_key_present = bool(os.getenv("DEEPGRAM_API_KEY"))
    return AgentStatusResponse(
        capabilities=[
            AgentCapabilityStatus(
                id="deterministic_semantic",
                status="enabled",
                hotPath=False,
                requiredEnv=[],
                configuredModel=None,
                message="Vector projection heuristics build semantic drafts without model calls.",
            ),
            AgentCapabilityStatus(
                id="vlm_semantic",
                status="enabled" if openai_key_present else "missing_key",
                hotPath=False,
                requiredEnv=["OPENAI_API_KEY"],
                configuredModel=os.getenv("MAGICBOARD_VLM_MODEL") or DEFAULT_VLM_MODEL,
                message="Cold-path VLM review observes drawing captures after the deterministic hot path.",
            ),
            AgentCapabilityStatus(
                id="voice",
                status="deferred" if deepgram_key_present else "missing_key",
                hotPath=False,
                requiredEnv=["DEEPGRAM_API_KEY"],
                configuredModel=None,
                message="Voice is deferred until the visual and chat clarification loop is solid.",
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
    raw = "|".join([room_id, str(capture_version), os.getenv("MAGICBOARD_VLM_MODEL") or DEFAULT_VLM_MODEL])
    return "visual-job-" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


def initial_visual_observation(
    *,
    room_id: str,
    world_id: str | None,
    capture_version: int,
) -> VisualObservation:
    model = os.getenv("MAGICBOARD_VLM_MODEL") or DEFAULT_VLM_MODEL
    if not os.getenv("OPENAI_API_KEY"):
        return VisualObservation(
            status="missing_key",
            roomId=room_id,
            worldId=world_id,
            captureVersion=capture_version,
            jobId=visual_job_id(room_id, capture_version),
            model=model,
            description="OPENAI_API_KEY is not configured; deterministic platform recognition is still active.",
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
        description="Observing the drawing with OpenAI vision.",
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


def _projection_svg(projection: dict[str, Any] | None) -> str:
    projection = projection or {}
    coordinate_space = projection.get("coordinateSpace") or {}
    width = int(coordinate_space.get("width") or 1920)
    height = int(coordinate_space.get("height") or 1080)
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}">',
        '<rect width="100%" height="100%" fill="#fffaf0"/>',
    ]
    for shape in projection.get("shapes") or []:
        if not isinstance(shape, dict):
            continue
        x, y, w, h = (shape.get("x"), shape.get("y"), shape.get("w"), shape.get("h"))
        if all(isinstance(value, int | float) for value in (x, y, w, h)):
            color = str(shape.get("color") or "#2f2a26")
            parts.append(
                f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="none" stroke="{color}" stroke-width="10"/>'
            )
    for stroke in projection.get("strokes") or []:
        if not isinstance(stroke, dict):
            continue
        points = stroke.get("points") or []
        clean = [
            f'{point.get("x")},{point.get("y")}'
            for point in points
            if isinstance(point, dict) and isinstance(point.get("x"), int | float) and isinstance(point.get("y"), int | float)
        ]
        if len(clean) >= 2:
            color = str(stroke.get("color") or "#2f2a26")
            width_value = max(2, min(80, int(stroke.get("width") or 6)))
            parts.append(
                f'<polyline points="{" ".join(clean)}" fill="none" stroke="{color}" stroke-width="{width_value}" stroke-linecap="round" stroke-linejoin="round"/>'
            )
    for label in projection.get("labels") or []:
        if not isinstance(label, dict):
            continue
        x, y, text = label.get("x"), label.get("y"), str(label.get("text") or "")[:80]
        if isinstance(x, int | float) and isinstance(y, int | float) and text:
            escaped = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            parts.append(f'<text x="{x}" y="{y}" font-size="32" fill="#2f2a26">{escaped}</text>')
    parts.append("</svg>")
    return "".join(parts)


def _projection_png_data_url(projection: dict[str, Any] | None) -> str:
    projection = projection or {}
    coordinate_space = projection.get("coordinateSpace") or {}
    source_w = float(coordinate_space.get("width") or 1920)
    source_h = float(coordinate_space.get("height") or 1080)
    target_w = 960
    target_h = max(1, round(target_w * source_h / max(source_w, 1.0)))
    sx = target_w / max(source_w, 1.0)
    sy = target_h / max(source_h, 1.0)

    image = Image.new("RGB", (target_w, target_h), "#fffaf0")
    draw = ImageDraw.Draw(image)

    for shape in projection.get("shapes") or []:
        if not isinstance(shape, dict):
            continue
        x, y, w, h = (shape.get("x"), shape.get("y"), shape.get("w"), shape.get("h"))
        if all(isinstance(value, int | float) for value in (x, y, w, h)):
            x1 = round(float(x) * sx)
            y1 = round(float(y) * sy)
            x2 = round((float(x) + float(w)) * sx)
            y2 = round((float(y) + float(h)) * sy)
            width = max(2, round(float(shape.get("width") or 10) * sx))
            draw.rectangle([x1, y1, x2, y2], outline="#2f2a26", width=width)

    for stroke in projection.get("strokes") or []:
        if not isinstance(stroke, dict):
            continue
        points = []
        for point in stroke.get("points") or []:
            if isinstance(point, dict) and isinstance(point.get("x"), int | float) and isinstance(point.get("y"), int | float):
                points.append((round(float(point["x"]) * sx), round(float(point["y"]) * sy)))
        if len(points) >= 2:
            width = max(2, round(float(stroke.get("width") or 6) * sx))
            draw.line(points, fill="#2f2a26", width=width, joint="curve")

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


def _post_openai_json(url: str, body: dict[str, Any], api_key: str, timeout: int = 12) -> dict[str, Any]:
    request = Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=timeout, context=OPENAI_SSL_CONTEXT) as response:
        return json.loads(response.read().decode("utf-8"))


def _visual_prompt(projection: dict[str, Any] | None) -> str:
    return (
        "You are observing a 1920x1080 level-editing drawing. Identify visual intent, especially "
        "platforms, hazards, and decorative marks. Return only compact JSON with keys description and hints. "
        "Each hint has kind, confidence, description, behavior, and sourceIds. "
        "Use existing sourceId values when you can. Do not invent gameplay rules."
        "\nProjection JSON:\n"
        + json.dumps(_safe_projection_context(projection), sort_keys=True)
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
                        "kind": {"type": "string", "enum": ["platform", "hazard", "decor", "unknown"]},
                        "confidence": {"type": "number"},
                        "description": {"type": "string"},
                        "behavior": {
                            "type": ["string", "null"],
                            "enum": ["solid", "pass", "bounce", "hurt", "ice", "breakable", "decor", "ignore", None],
                        },
                        "sourceIds": {"type": "array", "items": {"type": "string"}},
                    },
                },
            },
        },
    }


def _chat_completion_output_text(response: dict[str, Any]) -> str:
    choices = response.get("choices") or []
    if not choices or not isinstance(choices[0], dict):
        return ""
    message = choices[0].get("message") or {}
    content = message.get("content")
    return content if isinstance(content, str) else ""


def _clean_hint(raw: dict[str, Any]) -> VisualObservationHint | None:
    kind = str(raw.get("kind") or "unknown").lower()
    if kind not in {"platform", "hazard", "decor", "unknown"}:
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


def _request_responses_visual_observation(
    *,
    projection: dict[str, Any] | None,
    image_url: str,
    prompt: str,
    model: str,
    api_key: str,
) -> dict[str, Any]:
    body = {
        "model": model,
        "input": [
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": prompt},
                    {"type": "input_image", "image_url": image_url, "detail": "low"},
                ],
            }
        ],
        "max_output_tokens": 300,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "magicboard_visual_observation",
                "strict": True,
                "schema": _visual_json_schema(),
            }
        },
    }
    payload = _post_openai_json(OPENAI_RESPONSES_URL, body, api_key)
    text = _output_text(payload)
    if not text:
        raise RuntimeError("OpenAI response did not include output text")
    return json.loads(text)


def _request_chat_visual_observation(
    *,
    projection: dict[str, Any] | None,
    image_url: str,
    prompt: str,
    model: str,
    api_key: str,
) -> dict[str, Any]:
    body = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": image_url, "detail": "low"}},
                ],
            }
        ],
        "max_tokens": 300,
        "response_format": {"type": "json_object"},
    }
    payload = _post_openai_json(OPENAI_CHAT_COMPLETIONS_URL, body, api_key, timeout=30)
    text = _chat_completion_output_text(payload)
    if not text:
        raise RuntimeError("OpenAI chat response did not include message content")
    return json.loads(text)


def _request_openai_visual_observation(*, projection: dict[str, Any] | None) -> dict[str, Any]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("missing OPENAI_API_KEY")
    model = os.getenv("MAGICBOARD_VLM_MODEL") or DEFAULT_VLM_MODEL
    image_url = _projection_png_data_url(projection)
    prompt = _visual_prompt(projection)
    # Responses is the target API, but this local environment currently hangs on
    # /v1/responses while Chat Completions returns quickly with the same key.
    # Keep the visual loop usable and low-latency.
    try:
        return _request_chat_visual_observation(
            projection=projection,
            image_url=image_url,
            prompt=prompt,
            model=model,
            api_key=api_key,
        )
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"OpenAI Chat Completions API returned {error.code}: {detail}") from error
    except URLError as error:
        raise RuntimeError(f"OpenAI Chat Completions API request failed: {error.reason}") from error


async def run_visual_observation(
    *,
    room_id: str,
    world_id: str | None,
    capture_version: int,
    job_id: str,
    projection: dict[str, Any] | None,
) -> VisualObservation:
    started = time.perf_counter()
    model = os.getenv("MAGICBOARD_VLM_MODEL") or DEFAULT_VLM_MODEL
    try:
        result = await asyncio.to_thread(_request_openai_visual_observation, projection=projection)
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
            description="OpenAI vision observation failed; deterministic recognition is still active.",
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
        if os.getenv("OPENAI_API_KEY"):
            status = "stubbed_ready"
            message = "OPENAI_API_KEY is present; VLM observation runs from capture updates."
        else:
            status = "stubbed_missing_key"
            message = "Cold-path VLM/LLM review is not configured. Local deterministic semantics still work."
    elif request.modality == "voice":
        required_env = ["DEEPGRAM_API_KEY"]
        status = "unsupported"
        message = "Voice jobs are deferred; answer through the visual panel or text command path."
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
