from __future__ import annotations

import asyncio
import hashlib
import time
from dataclasses import dataclass
from typing import Any

import httpx

from .config import env
from .schemas import FinisherJobRequest, FinisherJobResponse


PIKAFFECTS_MODEL = "fal-ai/pika/v1.5/pikaffects"
PIKAFRAMES_MODEL = "fal-ai/pika/v2.2/pikaframes"
KLING_MOTION_MODEL = "fal-ai/kling-video/v3/pro/motion-control"
FAL_MODEL = PIKAFFECTS_MODEL
PROMPT_TEMPLATE = (
    "Preserve the exact simple hand-drawn black marker doodle character from the input image. "
    "Warm paper background. Do not redesign the character, do not add realistic detail, "
    "do not add extra body parts. Animate the character with the {style} effect as a short "
    "dramatic KO finisher."
)
KEYFRAME_PROMPT_TEMPLATE = (
    "Animate this exact simple hand-drawn doodle fighter performing the recorded custom ultimate. "
    "Keep the black marker line art, paper background, proportions, and character identity. "
    "Make the move read as a powerful {style} finishing attack, with clear anticipation, impact, and recovery."
)
ITEM_FINISHER_PROMPT_TEMPLATE = (
    "Two simple hand-drawn black marker doodle fighters on a warm paper background (keep both, keep the "
    "scene). {action} Keep the marker line art and paper background; do not add realistic detail, do not "
    "redesign the characters. Short, dramatic KO finisher."
)
NEGATIVE_PROMPT = "realism, 3D, extra limbs, redesign, detailed face, photorealism"


@dataclass
class FinisherJob:
    job_id: str
    cache_key: str
    request: FinisherJobRequest
    status: str
    created_at: float
    fal_request_id: str | None = None
    status_url: str | None = None
    response_url: str | None = None
    fal_model: str | None = None
    video_url: str | None = None
    error: str | None = None
    poll_task: asyncio.Task | None = None


_jobs: dict[str, FinisherJob] = {}
_cache_to_job: dict[str, str] = {}


def reset_finisher_jobs() -> None:
    for job in _jobs.values():
        if job.poll_task and not job.poll_task.done():
            job.poll_task.cancel()
    _jobs.clear()
    _cache_to_job.clear()


def _cache_key(request: FinisherJobRequest) -> str:
    model = _model_for_request(request)
    motion_hash = _motion_hash(request)
    raw = "|".join(
        [
            request.attacker_id,
            request.style,
            request.victim_id,
            request.victim_skin_hash,
            request.skin_hash or "",
            request.source_type,
            request.finisher_kind or "",
            motion_hash,
            model,
        ]
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _motion_hash(request: FinisherJobRequest) -> str:
    if request.source_type == "doodle_keyframes":
        raw = "|".join(request.keyframe_data_urls[:5]) + "|" + str(request.motion_summary or {})
    elif request.source_type == "motion_reference":
        raw = (request.motion_clip_data_url or "") + "|" + str(request.motion_summary or {})
    else:
        raw = request.image_data_url or ""
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _model_for_request(request: FinisherJobRequest) -> str:
    if request.source_type == "doodle_keyframes":
        return PIKAFRAMES_MODEL
    if request.source_type == "motion_reference":
        return KLING_MOTION_MODEL
    return PIKAFFECTS_MODEL


def _response(job: FinisherJob) -> FinisherJobResponse:
    return FinisherJobResponse(
        jobId=job.job_id,
        status=job.status,
        videoUrl=job.video_url,
        error=job.error,
    )


async def create_finisher_job(request: FinisherJobRequest) -> FinisherJobResponse:
    cache_key = _cache_key(request)
    existing_id = _cache_to_job.get(cache_key)
    if existing_id and existing_id in _jobs:
        job = _jobs[existing_id]
        if job.status != "failed":
            return _response(job)

    job_id = "finisher-job-" + cache_key[:16]
    if not env("FAL_KEY"):
        job = FinisherJob(
            job_id=job_id,
            cache_key=cache_key,
            request=request,
            status="missing_key",
            created_at=time.time(),
            error="missing FAL_KEY",
        )
        _jobs[job_id] = job
        _cache_to_job[cache_key] = job_id
        return _response(job)

    job = FinisherJob(job_id=job_id, cache_key=cache_key, request=request, status="queued", created_at=time.time())
    _jobs[job_id] = job
    _cache_to_job[cache_key] = job_id
    job.poll_task = asyncio.create_task(_run_finisher_job(job_id))
    return _response(job)


async def get_finisher_job(job_id: str) -> FinisherJobResponse | None:
    job = _jobs.get(job_id)
    if job is None:
        return None
    if job.status in {"queued", "generating"}:
        await _refresh_finisher_job(job)
    return _response(job)


async def _run_finisher_job(job_id: str) -> None:
    job = _jobs.get(job_id)
    if job is None:
        return
    try:
        await _refresh_finisher_job(job)
        for _ in range(180):  # Pika gen time is variable (~100-300s); poll up to 360s
            if job.status not in {"queued", "generating"}:
                return
            await asyncio.sleep(2)
            await _refresh_finisher_job(job)
        job.status = "failed"
        job.error = "fal finisher generation timed out"
    except asyncio.CancelledError:
        raise
    except Exception as error:
        job.status = "failed"
        job.error = str(error)


async def _refresh_finisher_job(job: FinisherJob) -> None:
    if not env("FAL_KEY"):
        job.status = "missing_key"
        job.error = "missing FAL_KEY"
        return
    if not job.fal_request_id:
        try:
            result = await _submit_fal_job(job.request)
        except Exception as error:
            if _can_static_fallback(job):
                _arm_static_fallback(job, error)
                result = await _submit_fal_job(job.request)
            else:
                raise
        job.fal_request_id = result["request_id"]
        job.status_url = result.get("status_url")
        job.response_url = result.get("response_url")
        job.fal_model = result.get("model") or _model_for_request(job.request)
        job.status = "queued"

    status_payload = await _fal_status(job)
    state = str(status_payload.get("status") or "").upper()
    if state in {"IN_QUEUE", "QUEUED"}:
        job.status = "queued"
        return
    if state in {"IN_PROGRESS", "GENERATING", "RUNNING"}:
        job.status = "generating"
        return
    if state in {"COMPLETED", "READY"}:
        if status_payload.get("response_url"):
            job.response_url = str(status_payload["response_url"])
        result_payload = await _fal_result(job)
        video_url = _video_url(result_payload)
        if not video_url:
            raise RuntimeError("fal result did not include video.url")
        job.status = "ready"
        job.video_url = video_url
        job.error = None
        return
    if state in {"FAILED", "ERROR"}:
        if _can_static_fallback(job):
            _arm_static_fallback(job, _fal_error(status_payload))
            await _refresh_finisher_job(job)
            return
        job.status = "failed"
        job.error = _fal_error(status_payload)
        return

    job.status = "generating"


async def _submit_fal_job(request: FinisherJobRequest) -> dict[str, Any]:
    model = _model_for_request(request)
    if request.source_type == "doodle_keyframes":
        payload = _pikaframes_payload(request)
    elif request.source_type == "motion_reference":
        payload = _motion_reference_payload(request)
    else:
        payload = _pikaffects_payload(request)
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(_fal_queue_url(model), json=payload, headers=_fal_headers())
    response.raise_for_status()
    data = response.json()
    request_id = data.get("request_id") or data.get("requestId")
    if not request_id:
        raise RuntimeError("fal queue response did not include request_id")
    return {
        "request_id": str(request_id),
        "status_url": data.get("status_url"),
        "response_url": data.get("response_url"),
        "model": model,
    }


def _pikaffects_payload(request: FinisherJobRequest) -> dict[str, Any]:
    if not request.image_data_url:
        raise RuntimeError("imageDataUrl is required for pikaffects_image finishers")
    payload = {
        "image_url": request.image_data_url,
        "pikaffect": request.style,
        # item finishers pass a tailored two-character prompt; ultimate-KO finishers use the template.
        "prompt": request.prompt or PROMPT_TEMPLATE.format(style=request.style),
        "negative_prompt": NEGATIVE_PROMPT,
    }
    return payload


def _pikaframes_payload(request: FinisherJobRequest) -> dict[str, Any]:
    frames = [url for url in request.keyframe_data_urls[:5] if url]
    if len(frames) < 2:
        if request.image_data_url:
            return _pikaffects_payload(request)
        raise RuntimeError("at least two keyframeDataUrls are required for doodle_keyframes finishers")
    transition_count = max(1, len(frames) - 1)
    duration = max(1, min(2, int(round(2 / transition_count))))
    prompt = KEYFRAME_PROMPT_TEMPLATE.format(style=request.style)
    return {
        "image_urls": frames,
        "transitions": [{"duration": duration, "prompt": prompt} for _ in range(transition_count)],
        "prompt": prompt,
        "negative_prompt": NEGATIVE_PROMPT,
        "resolution": "720p",
    }


def _motion_reference_payload(request: FinisherJobRequest) -> dict[str, Any]:
    if not request.image_data_url or not request.motion_clip_data_url:
        if request.keyframe_data_urls:
            return _pikaframes_payload(request)
        raise RuntimeError("imageDataUrl and motionClipDataUrl are required for motion_reference finishers")
    return {
        "image_url": request.image_data_url,
        "video_url": request.motion_clip_data_url,
        "prompt": KEYFRAME_PROMPT_TEMPLATE.format(style=request.style),
        "negative_prompt": NEGATIVE_PROMPT,
        "resolution": "720p",
    }


def _can_static_fallback(job: FinisherJob) -> bool:
    return job.request.source_type != "pikaffects_image" and bool(job.request.image_data_url)


def _arm_static_fallback(job: FinisherJob, reason: Exception | str) -> None:
    job.error = f"motion generation fallback: {reason}"
    job.request.source_type = "pikaffects_image"
    job.fal_request_id = None
    job.status_url = None
    job.response_url = None
    job.fal_model = PIKAFFECTS_MODEL
    job.status = "queued"


async def _fal_status(job: FinisherJob) -> dict[str, Any]:
    if not job.fal_request_id:
        raise RuntimeError("missing fal request id")
    model = job.fal_model or _model_for_request(job.request)
    url = job.status_url or f"{_fal_request_url(model)}/{job.fal_request_id}/status"
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.get(url, headers=_fal_headers())
    response.raise_for_status()
    return response.json()


async def _fal_result(job: FinisherJob) -> dict[str, Any]:
    if not job.fal_request_id:
        raise RuntimeError("missing fal request id")
    model = job.fal_model or _model_for_request(job.request)
    url = job.response_url or f"{_fal_request_url(model)}/{job.fal_request_id}"
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(url, headers=_fal_headers())
    response.raise_for_status()
    return response.json()


def _fal_headers() -> dict[str, str]:
    key = env("FAL_KEY")
    if not key:
        raise RuntimeError("missing FAL_KEY")
    return {"Authorization": f"Key {key}", "Content-Type": "application/json"}


def _fal_queue_url(model: str) -> str:
    return f"https://queue.fal.run/{model}"


def _fal_request_url(model: str) -> str:
    return f"{_fal_queue_url(model)}/requests"


def _video_url(payload: dict[str, Any]) -> str | None:
    video = payload.get("video")
    if isinstance(video, dict) and video.get("url"):
        return str(video["url"])
    if payload.get("video_url"):
        return str(payload["video_url"])
    if payload.get("videoUrl"):
        return str(payload["videoUrl"])
    return None


def _fal_error(payload: dict[str, Any]) -> str:
    detail = payload.get("error") or payload.get("detail") or payload.get("message")
    if isinstance(detail, dict):
        return str(detail.get("message") or detail)
    return str(detail or "fal finisher generation failed")
