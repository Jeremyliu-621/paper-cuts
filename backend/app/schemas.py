from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


BACKEND_VERSION = "0.1.0"


class RecentEvent(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["canvas_capture"] = "canvas_capture"
    version: int
    updated_at: datetime = Field(alias="updatedAt")
    client_id: str | None = Field(default=None, alias="clientId")
    sent_at: str | None = Field(default=None, alias="sentAt")


class SemanticGeometry(BaseModel):
    x: float
    y: float
    w: float
    h: float


class SemanticChoice(BaseModel):
    id: Literal[
        "yes_platform",
        "no_ignore",
        "decor",
        "normal",
        "pass_through",
        "bouncy",
        "damaging",
        "icy",
        "breakable",
    ]
    label: str
    role: Literal["platform", "ignore", "decor"]
    behavior: Literal["solid", "pass", "bounce", "hurt", "ice", "breakable", "decor", "ignore"]


class SemanticQuestion(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    question_id: str = Field(alias="questionId")
    candidate_id: str = Field(alias="candidateId")
    prompt: str
    choices: list[SemanticChoice]
    room_id: str = Field(alias="roomId")
    world_id: str | None = Field(default=None, alias="worldId")
    capture_version: int = Field(alias="captureVersion")
    source_ids: list[str] = Field(alias="sourceIds")
    geometry_hash: str = Field(alias="geometryHash")
    client_id: str | None = Field(default=None, alias="clientId")


class SemanticAnswer(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    answer_id: str = Field(alias="answerId")
    question_id: str = Field(alias="questionId")
    candidate_id: str = Field(alias="candidateId")
    choice_id: str = Field(alias="choiceId")
    role: Literal["platform", "ignore", "decor"] = "platform"
    behavior: Literal["solid", "pass", "bounce", "hurt", "ice", "breakable", "decor", "ignore"] = "solid"
    room_id: str = Field(alias="roomId")
    world_id: str | None = Field(default=None, alias="worldId")
    capture_version: int = Field(alias="captureVersion")
    source_ids: list[str] = Field(alias="sourceIds")
    geometry_hash: str = Field(alias="geometryHash")
    client_id: str | None = Field(default=None, alias="clientId")
    answered_at: datetime = Field(alias="answeredAt")


class SemanticCandidate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    candidate_id: str = Field(alias="candidateId")
    type: Literal["platform_candidate"] = "platform_candidate"
    status: Literal["needs_answer", "confirmed", "ignored", "decor"] = "needs_answer"
    extractor: Literal["rectangle", "stroke", "grouped_strokes"]
    confidence: float
    geometry: SemanticGeometry
    source_ids: list[str] = Field(alias="sourceIds")
    geometry_hash: str = Field(alias="geometryHash")
    room_id: str = Field(alias="roomId")
    world_id: str | None = Field(default=None, alias="worldId")
    capture_version: int = Field(alias="captureVersion")
    question_id: str = Field(alias="questionId")
    question: SemanticQuestion
    answer: SemanticAnswer | None = None


class SemanticDraft(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["magicboard_semantic_draft"] = "magicboard_semantic_draft"
    version: int = 1
    room_id: str = Field(alias="roomId")
    world_id: str | None = Field(default=None, alias="worldId")
    capture_version: int = Field(alias="captureVersion")
    client_id: str | None = Field(default=None, alias="clientId")
    generated_at: datetime = Field(alias="generatedAt")
    candidates: list[SemanticCandidate]
    questions: list[SemanticQuestion]
    answers: list[SemanticAnswer]
    stale_answers: list[SemanticAnswer] = Field(default_factory=list, alias="staleAnswers")


class RoomCaptureResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    room_id: str = Field(alias="roomId")
    version: int
    capture: dict[str, Any] | None
    projection: dict[str, Any] | None
    semantic_draft: SemanticDraft | None = Field(default=None, alias="semanticDraft")
    updated_at: datetime | None = Field(alias="updatedAt")
    recent_events: list[RecentEvent] = Field(alias="recentEvents")


class RoomSelectionRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    room_id: str = Field(alias="roomId")
    world_id: str | None = Field(default=None, alias="worldId")
    world_name: str | None = Field(default=None, alias="worldName")


class RoomSelectionResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    room_id: str | None = Field(default=None, alias="roomId")
    world_id: str | None = Field(default=None, alias="worldId")
    world_name: str | None = Field(default=None, alias="worldName")
    selected_at: datetime | None = Field(default=None, alias="selectedAt")


class CanvasCaptureMessage(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)

    type: Literal["canvas_capture"]
    capture: dict[str, Any]
    projection: dict[str, Any]
    world_id: str | None = Field(default=None, alias="worldId")
    client_id: str | None = Field(default=None, alias="clientId")
    sent_at: str | None = Field(default=None, alias="sentAt")


class ClarificationAnswerMessage(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["clarification_answer"] = "clarification_answer"
    question_id: str = Field(alias="questionId")
    candidate_id: str = Field(alias="candidateId")
    choice_id: Literal[
        "yes_platform",
        "no_ignore",
        "decor",
        "normal",
        "pass_through",
        "bouncy",
        "damaging",
        "icy",
        "breakable",
    ] = Field(alias="choiceId")
    capture_version: int = Field(alias="captureVersion")
    source_ids: list[str] = Field(alias="sourceIds")
    geometry_hash: str = Field(alias="geometryHash")
    world_id: str | None = Field(default=None, alias="worldId")
    client_id: str | None = Field(default=None, alias="clientId")


class HelloMessage(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["hello"] = "hello"
    room_id: str = Field(alias="roomId")
    version: int
    backend_version: str = Field(default=BACKEND_VERSION, alias="backendVersion")
    projection: dict[str, Any] | None = None
    semantic_draft: SemanticDraft | None = Field(default=None, alias="semanticDraft")


class ProjectionUpdatedMessage(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["projection_updated"] = "projection_updated"
    room_id: str = Field(alias="roomId")
    version: int
    updated_at: datetime = Field(alias="updatedAt")
    projection: dict[str, Any]
    semantic_draft: SemanticDraft | None = Field(default=None, alias="semanticDraft")
    source_client_id: str | None = Field(default=None, alias="sourceClientId")


class ErrorMessage(BaseModel):
    type: Literal["error"] = "error"
    message: str


class SemanticDraftUpdatedMessage(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["semantic_draft_updated"] = "semantic_draft_updated"
    room_id: str = Field(alias="roomId")
    version: int
    semantic_draft: SemanticDraft = Field(alias="semanticDraft")
    source_client_id: str | None = Field(default=None, alias="sourceClientId")


class AgentCapabilityStatus(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: Literal["deterministic_semantic", "vlm_semantic", "voice"]
    status: Literal["enabled", "stubbed_ready", "missing_key", "deferred"]
    hot_path: bool = Field(alias="hotPath")
    required_env: list[str] = Field(default_factory=list, alias="requiredEnv")
    configured_model: str | None = Field(default=None, alias="configuredModel")
    message: str


class AgentStatusResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["magicboard_agent_status"] = "magicboard_agent_status"
    capabilities: list[AgentCapabilityStatus]


class AgentJobRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["agent_semantic_review"] = "agent_semantic_review"
    idempotency_key: str = Field(alias="idempotencyKey")
    capture_version: int = Field(alias="captureVersion")
    world_id: str | None = Field(default=None, alias="worldId")
    modality: Literal["vlm", "llm", "voice"] = "vlm"
    prompt: str | None = None
    client_id: str | None = Field(default=None, alias="clientId")


class AgentJobResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["agent_job"] = "agent_job"
    job_id: str = Field(alias="jobId")
    room_id: str = Field(alias="roomId")
    world_id: str | None = Field(default=None, alias="worldId")
    idempotency_key: str = Field(alias="idempotencyKey")
    capture_version: int = Field(alias="captureVersion")
    current_capture_version: int = Field(alias="currentCaptureVersion")
    modality: Literal["vlm", "llm", "voice"]
    status: Literal["stale", "stubbed_missing_key", "stubbed_ready", "unsupported"]
    required_env: list[str] = Field(default_factory=list, alias="requiredEnv")
    message: str
    client_id: str | None = Field(default=None, alias="clientId")
    created_at: datetime = Field(alias="createdAt")
