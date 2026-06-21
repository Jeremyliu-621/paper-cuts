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


class RoomCaptureResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    room_id: str = Field(alias="roomId")
    version: int
    capture: dict[str, Any] | None
    projection: dict[str, Any] | None
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
    client_id: str | None = Field(default=None, alias="clientId")
    sent_at: str | None = Field(default=None, alias="sentAt")


class HelloMessage(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["hello"] = "hello"
    room_id: str = Field(alias="roomId")
    version: int
    backend_version: str = Field(default=BACKEND_VERSION, alias="backendVersion")
    projection: dict[str, Any] | None = None


class ProjectionUpdatedMessage(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["projection_updated"] = "projection_updated"
    room_id: str = Field(alias="roomId")
    version: int
    updated_at: datetime = Field(alias="updatedAt")
    projection: dict[str, Any]
    source_client_id: str | None = Field(default=None, alias="sourceClientId")


class ErrorMessage(BaseModel):
    type: Literal["error"] = "error"
    message: str
