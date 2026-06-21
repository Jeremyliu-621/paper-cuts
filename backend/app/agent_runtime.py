from __future__ import annotations

import hashlib
import os
from datetime import UTC, datetime

from .schemas import AgentCapabilityStatus, AgentJobRequest, AgentJobResponse, AgentStatusResponse


DEFAULT_VLM_MODEL = "gpt-4.1-mini"


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
                status="stubbed_ready" if openai_key_present else "missing_key",
                hotPath=False,
                requiredEnv=["OPENAI_API_KEY"],
                configuredModel=os.getenv("MAGICBOARD_VLM_MODEL") or DEFAULT_VLM_MODEL,
                message="Cold-path VLM review is shaped but intentionally not called in the MVP hot path.",
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
            message = "OPENAI_API_KEY is present; real VLM/LLM review is still intentionally stubbed."
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
