from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from fastapi import WebSocket

from .schemas import (
    AgentJobRequest,
    AgentJobResponse,
    CanvasCaptureMessage,
    ClarificationAnswerMessage,
    ProjectionUpdatedMessage,
    RecentEvent,
    RoomCaptureResponse,
    RoomSelectionResponse,
    SemanticAnswer,
    SemanticDraft,
    SemanticDraftUpdatedMessage,
)
from .agent_runtime import make_stub_job
from .semantic import bind_answer, build_semantic_draft

MAX_RECENT_EVENTS = 20


@dataclass
class RoomState:
    room_id: str
    version: int = 0
    capture: dict[str, Any] | None = None
    projection: dict[str, Any] | None = None
    semantic_draft: SemanticDraft | None = None
    semantic_answers: list[SemanticAnswer] = field(default_factory=list)
    agent_jobs: dict[str, AgentJobResponse] = field(default_factory=dict)
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
            updatedAt=room.updated_at,
            recentEvents=list(room.recent_events),
        )

    def select_room(
        self,
        room_id: str,
        world_id: str | None = None,
        world_name: str | None = None,
    ) -> RoomSelectionResponse:
        self.get_room(room_id)
        self.get_room(room_id).world_id = world_id
        self._selection = RoomSelectionResponse(
            roomId=room_id,
            worldId=world_id,
            worldName=world_name,
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
            **self._selection.model_dump(mode="json", by_alias=True),
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
            sourceClientId=message.client_id,
        )

    def semantic_draft(self, room_id: str) -> SemanticDraft | None:
        return self.get_room(room_id).semantic_draft

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

    def reset(self) -> None:
        self._rooms.clear()
        self._connections.clear()
        self._selection_connections.clear()
        self._selection = RoomSelectionResponse()


rooms = RoomRegistry()
