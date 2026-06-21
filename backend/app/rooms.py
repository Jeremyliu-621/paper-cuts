from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from fastapi import WebSocket

from .schemas import (
    CanvasCaptureMessage,
    ProjectionUpdatedMessage,
    RecentEvent,
    RoomCaptureResponse,
    RoomSelectionResponse,
)

MAX_RECENT_EVENTS = 20


@dataclass
class RoomState:
    room_id: str
    version: int = 0
    capture: dict[str, Any] | None = None
    projection: dict[str, Any] | None = None
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
        room.updated_at = datetime.now(UTC)
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

    def reset(self) -> None:
        self._rooms.clear()
        self._connections.clear()
        self._selection_connections.clear()
        self._selection = RoomSelectionResponse()


rooms = RoomRegistry()
