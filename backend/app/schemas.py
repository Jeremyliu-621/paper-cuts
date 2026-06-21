from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


BACKEND_VERSION = "0.1.0"

FinisherStyle = Literal["Melt", "Explode", "Dissolve", "Squish", "Tear", "Crumble", "Cake-ify"]
FinisherJobStatus = Literal["queued", "generating", "ready", "failed", "missing_key"]


AgentErrorCode = Literal[
    "missing_key",
    "stale_capture",
    "stale_candidate",
    "stale_stage_reference",
    "unknown_candidate",
    "manual_override_exists",
    "permission_required",
    "permission_denied",
    "tool_validation_failed",
    "deepgram_disconnected",
    "openai_failed",
    "unsupported_operation",
]


class AgentError(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    code: AgentErrorCode
    message: str
    retryable: bool = False
    details: dict[str, Any] | None = None


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


class PortalEndpointGeometry(BaseModel):
    x: float
    y: float
    r: float


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
        "cannon",
        "spikes",
        "portal_endpoint",
        "portal_pair",
    ]
    label: str
    role: Literal["platform", "cannon", "spikes", "portal_endpoint", "portal_pair", "unknown", "ignore", "decor"]
    behavior: Literal[
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
    ]


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
    role: Literal["platform", "cannon", "spikes", "portal_endpoint", "portal_pair", "unknown", "ignore", "decor"] = "platform"
    behavior: Literal[
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
    ] = "solid"
    confidence: float | None = None
    classifier: Literal["manual", "vlm", "deterministic"] = "manual"
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
    type: Literal["semantic_candidate"] = "semantic_candidate"
    status: Literal["needs_answer", "confirmed", "ignored", "decor"] = "needs_answer"
    semantic_type: Literal[
        "platform",
        "cannon",
        "spikes",
        "portal_endpoint",
        "portal_pair",
        "unknown",
    ] = Field(default="unknown", alias="semanticType")
    candidate_version: int = Field(default=1, alias="candidateVersion")
    classification: SemanticAnswer | None = None
    extractor: Literal["rectangle", "stroke", "grouped_strokes", "compact_glyph", "circle", "portal_pair", "stage_tool"]
    confidence: float
    geometry: SemanticGeometry
    portal_endpoints: list[PortalEndpointGeometry] = Field(default_factory=list, alias="portalEndpoints")
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


class VisualObservationHint(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    kind: Literal["platform", "cannon", "spikes", "portal_endpoint", "portal_pair", "hazard", "decor", "ignore", "unknown"]
    confidence: float
    description: str
    behavior: Literal[
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
    ] | None = None
    source_ids: list[str] = Field(default_factory=list, alias="sourceIds")
    geometry: SemanticGeometry | None = None


class VisualObservation(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["magicboard_visual_observation"] = "magicboard_visual_observation"
    status: Literal["pending", "ready", "missing_key", "error", "stale"]
    room_id: str = Field(alias="roomId")
    world_id: str | None = Field(default=None, alias="worldId")
    capture_version: int = Field(alias="captureVersion")
    job_id: str = Field(alias="jobId")
    model: str | None = None
    description: str = ""
    hints: list[VisualObservationHint] = Field(default_factory=list)
    latency_ms: int | None = Field(default=None, alias="latencyMs")
    errors: list[str] = Field(default_factory=list)
    updated_at: datetime = Field(alias="updatedAt")


class RoomCaptureResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    room_id: str = Field(alias="roomId")
    version: int
    capture: dict[str, Any] | None
    projection: dict[str, Any] | None
    semantic_draft: SemanticDraft | None = Field(default=None, alias="semanticDraft")
    visual_observation: VisualObservation | None = Field(default=None, alias="visualObservation")
    agent_turns: list["AgentTurn"] = Field(default_factory=list, alias="agentTurns")
    proposals: list["LevelEditProposal"] = Field(default_factory=list)
    permission_requests: list["PermissionRequest"] = Field(default_factory=list, alias="permissionRequests")
    semantic_objects: list[dict[str, Any]] = Field(default_factory=list, alias="semanticObjects")
    stage_reference: dict[str, Any] | None = Field(default=None, alias="stageReference")
    stage_reference_version: int = Field(default=0, alias="stageReferenceVersion")
    updated_at: datetime | None = Field(alias="updatedAt")
    recent_events: list[RecentEvent] = Field(alias="recentEvents")


class RoomSelectionRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    room_id: str = Field(alias="roomId")
    world_id: str | None = Field(default=None, alias="worldId")
    world_name: str | None = Field(default=None, alias="worldName")
    stage_reference: dict[str, Any] | None = Field(default=None, alias="stageReference")
    stage_reference_version: int | None = Field(default=None, alias="stageReferenceVersion")


class FinisherJobRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    attacker_id: str = Field(alias="attackerId")
    victim_id: str = Field(alias="victimId")
    victim_skin_hash: str = Field(alias="victimSkinHash")
    style: FinisherStyle = "Melt"
    image_data_url: str = Field(alias="imageDataUrl")


class FinisherJobResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    job_id: str = Field(alias="jobId")
    status: FinisherJobStatus
    video_url: str | None = Field(default=None, alias="videoUrl")
    error: str | None = None


class RoomSelectionResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    room_id: str | None = Field(default=None, alias="roomId")
    world_id: str | None = Field(default=None, alias="worldId")
    world_name: str | None = Field(default=None, alias="worldName")
    stage_reference: dict[str, Any] | None = Field(default=None, alias="stageReference")
    stage_reference_version: int = Field(default=0, alias="stageReferenceVersion")
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
        "cannon",
        "spikes",
        "portal_endpoint",
        "portal_pair",
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
    visual_observation: VisualObservation | None = Field(default=None, alias="visualObservation")
    agent_turns: list["AgentTurn"] = Field(default_factory=list, alias="agentTurns")
    proposals: list["LevelEditProposal"] = Field(default_factory=list)
    permission_requests: list["PermissionRequest"] = Field(default_factory=list, alias="permissionRequests")
    stage_reference: dict[str, Any] | None = Field(default=None, alias="stageReference")
    stage_reference_version: int = Field(default=0, alias="stageReferenceVersion")


class ProjectionUpdatedMessage(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["projection_updated"] = "projection_updated"
    room_id: str = Field(alias="roomId")
    version: int
    updated_at: datetime = Field(alias="updatedAt")
    projection: dict[str, Any]
    semantic_draft: SemanticDraft | None = Field(default=None, alias="semanticDraft")
    visual_observation: VisualObservation | None = Field(default=None, alias="visualObservation")
    proposals: list["LevelEditProposal"] = Field(default_factory=list)
    permission_requests: list["PermissionRequest"] = Field(default_factory=list, alias="permissionRequests")
    stage_reference: dict[str, Any] | None = Field(default=None, alias="stageReference")
    stage_reference_version: int = Field(default=0, alias="stageReferenceVersion")
    source_client_id: str | None = Field(default=None, alias="sourceClientId")


class ErrorMessage(BaseModel):
    type: Literal["error"] = "error"
    message: str
    error: AgentError | None = None


class SemanticDraftUpdatedMessage(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["semantic_draft_updated"] = "semantic_draft_updated"
    room_id: str = Field(alias="roomId")
    version: int
    semantic_draft: SemanticDraft = Field(alias="semanticDraft")
    source_client_id: str | None = Field(default=None, alias="sourceClientId")


class VisualObservationUpdatedMessage(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["visual_observation_updated"] = "visual_observation_updated"
    room_id: str = Field(alias="roomId")
    version: int
    visual_observation: VisualObservation = Field(alias="visualObservation")
    semantic_draft: SemanticDraft | None = Field(default=None, alias="semanticDraft")


class AgentToolCall(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    tool_call_id: str = Field(alias="toolCallId")
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    status: Literal["pending", "running", "succeeded", "failed", "rejected"] = "pending"
    result: dict[str, Any] | None = None
    error: AgentError | None = None


class AgentTurn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    turn_id: str = Field(alias="turnId")
    session_id: str | None = Field(default=None, alias="sessionId")
    room_id: str = Field(alias="roomId")
    user_transcript: str = Field(alias="userTranscript")
    normalized_intent: str | None = Field(default=None, alias="normalizedIntent")
    assistant_response: str = Field(default="", alias="assistantResponse")
    tool_calls: list[AgentToolCall] = Field(default_factory=list, alias="toolCalls")
    validation_results: list[dict[str, Any]] = Field(default_factory=list, alias="validationResults")
    status: Literal["thinking", "running_tool", "waiting_for_permission", "complete", "error"] = "thinking"
    error: AgentError | None = None
    created_at: datetime = Field(alias="createdAt")
    updated_at: datetime = Field(alias="updatedAt")


class LevelEditProposal(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    proposal_id: str = Field(alias="proposalId")
    room_id: str = Field(alias="roomId")
    world_id: str | None = Field(default=None, alias="worldId")
    session_id: str | None = Field(default=None, alias="sessionId")
    turn_id: str | None = Field(default=None, alias="turnId")
    patch: dict[str, Any]
    scene_plan: dict[str, Any] = Field(default_factory=dict, alias="scenePlan")
    validation_report: dict[str, Any] = Field(default_factory=dict, alias="validationReport")
    approval_state: Literal["draft", "pending_approval", "approved", "rejected", "applied"] = Field(
        default="pending_approval",
        alias="approvalState",
    )
    required_permissions: list[str] = Field(default_factory=list, alias="requiredPermissions")
    required_version_refs: dict[str, int] = Field(default_factory=dict, alias="requiredVersionRefs")
    created_at: datetime = Field(alias="createdAt")
    updated_at: datetime = Field(alias="updatedAt")


class PermissionRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    permission_request_id: str = Field(alias="permissionRequestId")
    room_id: str = Field(alias="roomId")
    session_id: str | None = Field(default=None, alias="sessionId")
    action: Literal[
        "apply_patch",
        "replace_generated",
        "remove_generated",
        "delete_manual_content",
    ]
    arguments: dict[str, Any] = Field(default_factory=dict)
    risk_summary: str = Field(alias="riskSummary")
    required_version_refs: dict[str, int] = Field(default_factory=dict, alias="requiredVersionRefs")
    status: Literal["pending", "approved", "denied", "expired"] = "pending"
    created_at: datetime = Field(alias="createdAt")
    updated_at: datetime = Field(alias="updatedAt")


class PermissionResolutionRequest(BaseModel):
    approved: bool


class ProposalResolutionRequest(BaseModel):
    approved: bool


class AgentCapabilityStatus(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: Literal["deterministic_semantic", "vlm_semantic"]
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
    modality: Literal["vlm", "llm"] = "vlm"
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
    modality: Literal["vlm", "llm"]
    status: Literal["stale", "stubbed_missing_key", "stubbed_ready", "unsupported"]
    required_env: list[str] = Field(default_factory=list, alias="requiredEnv")
    message: str
    client_id: str | None = Field(default=None, alias="clientId")
    created_at: datetime = Field(alias="createdAt")
