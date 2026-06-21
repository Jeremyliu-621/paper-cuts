from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
import hashlib
from typing import Any

from fastapi import WebSocket

from .schemas import (
    AgentJobRequest,
    AgentJobResponse,
    AgentTurn,
    CanvasCaptureMessage,
    ClarificationAnswerMessage,
    LevelEditProposal,
    PermissionRequest,
    ProjectionUpdatedMessage,
    RecentEvent,
    RoomCaptureResponse,
    RoomSelectionResponse,
    SemanticAnswer,
    SemanticDraft,
    SemanticDraftUpdatedMessage,
    StageEditMessage,
    StageEditUpdatedMessage,
    VisualObservation,
    VisualObservationUpdatedMessage,
)
from .agent_runtime import initial_visual_observation, make_stub_job, stale_visual_observation
from .semantic import bind_answer, build_semantic_draft

MAX_RECENT_EVENTS = 20


def _clone_dict(value: dict[str, Any] | None) -> dict[str, Any]:
    import copy

    return copy.deepcopy(value or {})


def _stage_item_id(kind: str, item: dict[str, Any], index: int) -> str:
    explicit = item.get("editorId") or item.get("id")
    if explicit:
        return str(explicit)
    source = item.get("source") if isinstance(item.get("source"), dict) else None
    if source and source.get("candidateId"):
        return f"{kind}-candidate-{source['candidateId']}"
    if kind == "portal":
        return f"portal-{index}-{round(float(item.get('x', 0)))}-{round(float(item.get('y', 0)))}-{round(float(item.get('r', 0)))}"
    return (
        f"platform-{index}-{round(float(item.get('x', 0)))}-{round(float(item.get('y', 0)))}-"
        f"{round(float(item.get('w', 0)))}-{round(float(item.get('h', 0)))}"
    )


def _with_editor_ids(stage_reference: dict[str, Any]) -> dict[str, Any]:
    for kind, key in (("platform", "platforms"), ("portal", "portals")):
        items = stage_reference.get(key)
        if not isinstance(items, list):
            stage_reference[key] = []
            continue
        for index, item in enumerate(items):
            if isinstance(item, dict) and not item.get("editorId"):
                item["editorId"] = _stage_item_id(kind, item, index)
    return stage_reference


def _finite_number(value: Any, fallback: float) -> float:
    return value if isinstance(value, (int, float)) and value == value else fallback


def _apply_patch_to_item(item: dict[str, Any], patch: dict[str, Any], allowed: set[str]) -> None:
    for key, value in patch.items():
        if key in allowed and isinstance(value, (int, float)) and value == value:
            item[key] = round(value)


def _apply_stage_edit(stage_reference: dict[str, Any] | None, operation: dict[str, Any]) -> dict[str, Any]:
    reference = _with_editor_ids(_clone_dict(stage_reference))
    reference.setdefault("view", {"w": 1920, "h": 1080})
    reference.setdefault("platforms", [])
    reference.setdefault("portals", [])
    reference.setdefault("spawns", [])
    reference.setdefault("decor", [])

    op_type = operation.get("type")
    target_id = str(operation.get("targetId") or "")
    platforms = reference["platforms"]
    portals = reference["portals"]

    if op_type == "add_platform":
        platform = _clone_dict(operation.get("platform") if isinstance(operation.get("platform"), dict) else {})
        platform.setdefault("x", 760)
        platform.setdefault("y", 720)
        platform.setdefault("w", 300)
        platform.setdefault("h", 40)
        platform.setdefault("kind", "wood")
        platform.setdefault("pass", True)
        platform.setdefault("editorId", f"platform-ipad-{datetime.now(UTC).timestamp():.6f}")
        platforms.append(platform)
    elif op_type == "update_platform":
        patch = operation.get("patch") if isinstance(operation.get("patch"), dict) else {}
        for index, platform in enumerate(platforms):
            if isinstance(platform, dict) and _stage_item_id("platform", platform, index) == target_id:
                _apply_patch_to_item(platform, patch, {"x", "y", "w", "h"})
                break
    elif op_type == "delete_platform":
        reference["platforms"] = [
            platform
            for index, platform in enumerate(platforms)
            if not isinstance(platform, dict) or _stage_item_id("platform", platform, index) != target_id
        ]
    elif op_type == "add_portal_pair":
        pair = operation.get("portalPair") if isinstance(operation.get("portalPair"), dict) else {}
        a = _clone_dict(pair.get("a") if isinstance(pair.get("a"), dict) else {})
        b = _clone_dict(pair.get("b") if isinstance(pair.get("b"), dict) else {})
        stamp = f"ipad-{datetime.now(UTC).timestamp():.6f}"
        a.setdefault("id", f"{stamp}-a")
        b.setdefault("id", f"{stamp}-b")
        a.setdefault("link", b["id"])
        b.setdefault("link", a["id"])
        a.setdefault("editorId", a["id"])
        b.setdefault("editorId", b["id"])
        a.setdefault("x", 700)
        a.setdefault("y", 600)
        b.setdefault("x", 1220)
        b.setdefault("y", 600)
        a.setdefault("r", 74)
        b.setdefault("r", 74)
        a.setdefault("col", "#3f6fa0")
        b.setdefault("col", a["col"])
        portals.extend([a, b])
    elif op_type == "update_portal":
        patch = operation.get("patch") if isinstance(operation.get("patch"), dict) else {}
        for index, portal in enumerate(portals):
            if isinstance(portal, dict) and _stage_item_id("portal", portal, index) == target_id:
                _apply_patch_to_item(portal, patch, {"x", "y", "r"})
                break
    elif op_type == "delete_portal_pair":
        linked_ids: set[str] = set()
        for index, portal in enumerate(portals):
            if isinstance(portal, dict) and _stage_item_id("portal", portal, index) == target_id:
                linked_ids.update(str(value) for value in (portal.get("id"), portal.get("link"), portal.get("editorId")) if value)
                break
        reference["portals"] = [
            portal
            for portal in portals
            if not isinstance(portal, dict)
            or not ({str(value) for value in (portal.get("id"), portal.get("link"), portal.get("editorId")) if value} & linked_ids)
        ]
    else:
        raise ValueError("unsupported stage edit operation")

    return _with_editor_ids(reference)


def selection_payload(selection: RoomSelectionResponse) -> dict[str, Any]:
    payload = selection.model_dump(mode="json", by_alias=True)
    if payload.get("stageReference") is None:
        payload.pop("stageReference", None)
    return payload


@dataclass
class RoomState:
    room_id: str
    version: int = 0
    capture: dict[str, Any] | None = None
    projection: dict[str, Any] | None = None
    semantic_draft: SemanticDraft | None = None
    visual_observation: VisualObservation | None = None
    semantic_answers: list[SemanticAnswer] = field(default_factory=list)
    agent_jobs: dict[str, AgentJobResponse] = field(default_factory=dict)
    agent_turns: list[AgentTurn] = field(default_factory=list)
    semantic_objects: list[dict[str, Any]] = field(default_factory=list)
    proposals: dict[str, LevelEditProposal] = field(default_factory=dict)
    permission_requests: dict[str, PermissionRequest] = field(default_factory=dict)
    stage_reference: dict[str, Any] | None = None
    stage_reference_version: int = 0
    world_id: str | None = None
    updated_at: datetime | None = None
    recent_events: list[RecentEvent] = field(default_factory=list)


class RoomRegistry:
    def __init__(self) -> None:
        self._rooms: dict[str, RoomState] = {}
        self._connections: dict[str, set[WebSocket]] = {}
        self._selection_connections: set[WebSocket] = set()
        self._selection = RoomSelectionResponse()

    def get_room(self, room_id: str) -> RoomState:
        if room_id not in self._rooms:
            self._rooms[room_id] = RoomState(room_id=room_id)
        return self._rooms[room_id]

    def capture_response(self, room_id: str) -> RoomCaptureResponse:
        room = self.get_room(room_id)
        return RoomCaptureResponse(
            roomId=room.room_id,
            version=room.version,
            capture=room.capture,
            projection=room.projection,
            semanticDraft=room.semantic_draft,
            visualObservation=room.visual_observation,
            agentTurns=room.agent_turns[-10:],
            proposals=list(room.proposals.values()),
            permissionRequests=list(room.permission_requests.values()),
            semanticObjects=room.semantic_objects,
            stageReference=room.stage_reference,
            stageReferenceVersion=room.stage_reference_version,
            updatedAt=room.updated_at,
            recentEvents=list(room.recent_events),
        )

    def select_room(
        self,
        room_id: str,
        world_id: str | None = None,
        world_name: str | None = None,
        stage_reference: dict[str, Any] | None = None,
        stage_reference_version: int | None = None,
    ) -> RoomSelectionResponse:
        room = self.get_room(room_id)
        room.world_id = world_id
        if stage_reference is not None:
            room.stage_reference = stage_reference
            room.stage_reference_version = (
                stage_reference_version if isinstance(stage_reference_version, int) and stage_reference_version > 0
                else room.stage_reference_version + 1
            )
        self._selection = RoomSelectionResponse(
            roomId=room_id,
            worldId=world_id,
            worldName=world_name,
            stageReference=stage_reference or room.stage_reference,
            stageReferenceVersion=room.stage_reference_version,
            selectedAt=datetime.now(UTC),
        )
        return self._selection

    def current_selection(self) -> RoomSelectionResponse:
        return self._selection

    def clear_selection(self) -> RoomSelectionResponse:
        self._selection = RoomSelectionResponse()
        return self._selection

    def connect_selection(self, websocket: WebSocket) -> None:
        self._selection_connections.add(websocket)

    def disconnect_selection(self, websocket: WebSocket) -> None:
        self._selection_connections.discard(websocket)

    async def broadcast_selection(self) -> None:
        stale: list[WebSocket] = []
        payload = {
            "type": "selection_updated",
            **selection_payload(self._selection),
        }
        for websocket in list(self._selection_connections):
            try:
                await websocket.send_json(payload)
            except Exception:
                stale.append(websocket)
        for websocket in stale:
            self.disconnect_selection(websocket)

    def connect(self, room_id: str, websocket: WebSocket) -> None:
        self.get_room(room_id)
        self._connections.setdefault(room_id, set()).add(websocket)

    def disconnect(self, room_id: str, websocket: WebSocket) -> None:
        connections = self._connections.get(room_id)
        if not connections:
            return
        connections.discard(websocket)
        if not connections:
            self._connections.pop(room_id, None)

    def store_capture(self, room_id: str, message: CanvasCaptureMessage) -> ProjectionUpdatedMessage:
        room = self.get_room(room_id)
        room.version += 1
        room.capture = message.capture
        room.projection = message.projection
        room.world_id = message.world_id or room.world_id or (
            self._selection.world_id if self._selection.room_id == room_id else None
        )
        room.updated_at = datetime.now(UTC)
        room.semantic_draft = build_semantic_draft(
            room_id=room.room_id,
            world_id=room.world_id,
            capture_version=room.version,
            projection=room.projection,
            client_id=message.client_id,
            prior_answers=room.semantic_answers,
        )
        room.visual_observation = initial_visual_observation(
            room_id=room.room_id,
            world_id=room.world_id,
            capture_version=room.version,
        )
        event = RecentEvent(
            version=room.version,
            updatedAt=room.updated_at,
            clientId=message.client_id,
            sentAt=message.sent_at,
        )
        room.recent_events.append(event)
        room.recent_events = room.recent_events[-MAX_RECENT_EVENTS:]
        return ProjectionUpdatedMessage(
            roomId=room.room_id,
            version=room.version,
            updatedAt=room.updated_at,
            projection=message.projection,
            semanticDraft=room.semantic_draft,
            visualObservation=room.visual_observation,
            proposals=list(room.proposals.values()),
            permissionRequests=list(room.permission_requests.values()),
            stageReference=room.stage_reference,
            stageReferenceVersion=room.stage_reference_version,
            sourceClientId=message.client_id,
        )

    def store_stage_edit(self, room_id: str, message: StageEditMessage) -> StageEditUpdatedMessage:
        room = self.get_room(room_id)
        room.version += 1
        room.stage_reference = _apply_stage_edit(room.stage_reference, message.operation)
        room.stage_reference_version += 1
        room.world_id = message.world_id or room.world_id or (
            self._selection.world_id if self._selection.room_id == room_id else None
        )
        room.updated_at = datetime.now(UTC)
        if self._selection.room_id == room_id:
            self._selection = self._selection.model_copy(
                update={
                    "world_id": room.world_id,
                    "stage_reference": room.stage_reference,
                    "stage_reference_version": room.stage_reference_version,
                    "selected_at": room.updated_at,
                }
            )
        return StageEditUpdatedMessage(
            roomId=room.room_id,
            version=room.version,
            stageReference=room.stage_reference,
            stageReferenceVersion=room.stage_reference_version,
            operation=message.operation,
            worldId=room.world_id,
            sourceClientId=message.client_id,
        )

    def semantic_draft(self, room_id: str) -> SemanticDraft | None:
        return self.get_room(room_id).semantic_draft

    def visual_observation(self, room_id: str) -> VisualObservation | None:
        return self.get_room(room_id).visual_observation

    def _stable_id(self, prefix: str, *parts: object) -> str:
        raw = "|".join(str(part) for part in parts) + "|" + datetime.now(UTC).isoformat()
        return prefix + "-" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]

    def upsert_agent_turn(self, room_id: str, turn: AgentTurn) -> AgentTurn:
        room = self.get_room(room_id)
        room.agent_turns = [existing for existing in room.agent_turns if existing.turn_id != turn.turn_id]
        room.agent_turns.append(turn)
        room.agent_turns = room.agent_turns[-50:]
        return turn

    def store_proposal(self, room_id: str, proposal: LevelEditProposal) -> LevelEditProposal:
        room = self.get_room(room_id)
        room.proposals[proposal.proposal_id] = proposal
        return proposal

    def get_proposal(self, room_id: str, proposal_id: str) -> LevelEditProposal | None:
        return self.get_room(room_id).proposals.get(proposal_id)

    def resolve_proposal(self, room_id: str, proposal_id: str, approved: bool) -> LevelEditProposal | None:
        room = self.get_room(room_id)
        proposal = room.proposals.get(proposal_id)
        if proposal is None:
            return None
        now = datetime.now(UTC)
        proposal = proposal.model_copy(
            update={"approval_state": "approved" if approved else "rejected", "updated_at": now}
        )
        room.proposals[proposal_id] = proposal
        return proposal

    def mark_proposal_applied(self, room_id: str, proposal_id: str) -> LevelEditProposal | None:
        room = self.get_room(room_id)
        proposal = room.proposals.get(proposal_id)
        if proposal is None:
            return None
        proposal = proposal.model_copy(update={"approval_state": "applied", "updated_at": datetime.now(UTC)})
        room.proposals[proposal_id] = proposal
        return proposal

    def store_permission_request(self, room_id: str, request: PermissionRequest) -> PermissionRequest:
        room = self.get_room(room_id)
        room.permission_requests[request.permission_request_id] = request
        return request

    def resolve_permission_request(self, room_id: str, permission_request_id: str, approved: bool) -> PermissionRequest | None:
        room = self.get_room(room_id)
        request = room.permission_requests.get(permission_request_id)
        if request is None:
            return None
        request = request.model_copy(
            update={"status": "approved" if approved else "denied", "updated_at": datetime.now(UTC)}
        )
        room.permission_requests[permission_request_id] = request
        return request

    def enqueue_agent_job(self, room_id: str, request: AgentJobRequest) -> AgentJobResponse:
        room = self.get_room(room_id)
        existing = room.agent_jobs.get(request.idempotency_key)
        if existing is not None:
            return existing
        job = make_stub_job(room_id=room_id, current_capture_version=room.version, request=request)
        room.agent_jobs[request.idempotency_key] = job
        return job

    def store_answer(self, room_id: str, message: ClarificationAnswerMessage) -> SemanticDraftUpdatedMessage:
        room = self.get_room(room_id)
        answer = bind_answer(draft=room.semantic_draft, message=message, room_id=room_id)
        room.semantic_answers = [
            existing
            for existing in room.semantic_answers
            if not (
                existing.candidate_id == answer.candidate_id
                and existing.geometry_hash == answer.geometry_hash
                and sorted(existing.source_ids) == sorted(answer.source_ids)
            )
        ]
        room.semantic_answers.append(answer)
        room.semantic_draft = build_semantic_draft(
            room_id=room.room_id,
            world_id=answer.world_id or room.world_id,
            capture_version=room.version,
            projection=room.projection,
            client_id=message.client_id,
            prior_answers=room.semantic_answers,
        )
        return SemanticDraftUpdatedMessage(
            roomId=room.room_id,
            version=room.version,
            semanticDraft=room.semantic_draft,
            sourceClientId=message.client_id,
        )

    def store_visual_observation(
        self,
        room_id: str,
        observation: VisualObservation,
    ) -> VisualObservationUpdatedMessage | None:
        room = self.get_room(room_id)
        current = room.visual_observation
        if observation.capture_version != room.version:
            if current and current.job_id == observation.job_id:
                room.visual_observation = stale_visual_observation(observation)
                return VisualObservationUpdatedMessage(
                    roomId=room.room_id,
                    version=room.version,
                    visualObservation=room.visual_observation,
                )
            return None
        if current and current.job_id != observation.job_id:
            return None
        room.visual_observation = observation
        if observation.status == "ready":
            room.semantic_draft = build_semantic_draft(
                room_id=room.room_id,
                world_id=observation.world_id or room.world_id,
                capture_version=room.version,
                projection=room.projection,
                client_id=room.semantic_draft.client_id if room.semantic_draft else None,
                prior_answers=room.semantic_answers,
                visual_hints=observation.hints,
            )
        return VisualObservationUpdatedMessage(
            roomId=room.room_id,
            version=room.version,
            visualObservation=room.visual_observation,
            semanticDraft=room.semantic_draft,
        )

    async def broadcast(self, room_id: str, update: ProjectionUpdatedMessage) -> None:
        stale: list[WebSocket] = []
        payload = update.model_dump(mode="json", by_alias=True)
        for websocket in list(self._connections.get(room_id, set())):
            try:
                await websocket.send_json(payload)
            except Exception:
                stale.append(websocket)
        for websocket in stale:
            self.disconnect(room_id, websocket)

    async def broadcast_semantic(self, room_id: str, update: SemanticDraftUpdatedMessage) -> None:
        stale: list[WebSocket] = []
        payload = update.model_dump(mode="json", by_alias=True)
        for websocket in list(self._connections.get(room_id, set())):
            try:
                await websocket.send_json(payload)
            except Exception:
                stale.append(websocket)
        for websocket in stale:
            self.disconnect(room_id, websocket)

    async def broadcast_visual(self, room_id: str, update: VisualObservationUpdatedMessage) -> None:
        stale: list[WebSocket] = []
        payload = update.model_dump(mode="json", by_alias=True)
        for websocket in list(self._connections.get(room_id, set())):
            try:
                await websocket.send_json(payload)
            except Exception:
                stale.append(websocket)
        for websocket in stale:
            self.disconnect(room_id, websocket)

    async def broadcast_stage_edit(self, room_id: str, update: StageEditUpdatedMessage) -> None:
        stale: list[WebSocket] = []
        payload = update.model_dump(mode="json", by_alias=True)
        for websocket in list(self._connections.get(room_id, set())):
            try:
                await websocket.send_json(payload)
            except Exception:
                stale.append(websocket)
        for websocket in stale:
            self.disconnect(room_id, websocket)

    def reset(self) -> None:
        self._rooms.clear()
        self._connections.clear()
        self._selection_connections.clear()
        self._selection = RoomSelectionResponse()


rooms = RoomRegistry()
