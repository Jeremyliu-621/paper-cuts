from __future__ import annotations

import json
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError

from .agent_runtime import agent_status
from .rooms import rooms
from .schemas import (
    AgentJobRequest,
    BACKEND_VERSION,
    CanvasCaptureMessage,
    ClarificationAnswerMessage,
    ErrorMessage,
    HelloMessage,
    RoomSelectionRequest,
)

app = FastAPI(title="Magic Board Backend", version=BACKEND_VERSION)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, bool | str]:
    return {"ok": True, "version": BACKEND_VERSION}


@app.get("/agent/status")
async def get_agent_status() -> dict[str, Any]:
    return agent_status().model_dump(mode="json", by_alias=True)


@app.get("/rooms/{room_id}/capture")
async def get_room_capture(room_id: str) -> dict[str, Any]:
    return rooms.capture_response(room_id).model_dump(mode="json", by_alias=True)


@app.post("/rooms/{room_id}/capture")
async def save_room_capture(room_id: str, capture: CanvasCaptureMessage) -> dict[str, Any]:
    update = rooms.store_capture(room_id, capture)
    await rooms.broadcast(room_id, update)
    return rooms.capture_response(room_id).model_dump(mode="json", by_alias=True)


@app.get("/rooms/{room_id}/semantic-draft")
async def get_semantic_draft(room_id: str) -> dict[str, Any] | None:
    draft = rooms.semantic_draft(room_id)
    return None if draft is None else draft.model_dump(mode="json", by_alias=True)


@app.post("/rooms/{room_id}/clarifications")
async def answer_clarification(room_id: str, answer: ClarificationAnswerMessage) -> dict[str, Any]:
    try:
        update = rooms.store_answer(room_id, answer)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    await rooms.broadcast_semantic(room_id, update)
    return update.semantic_draft.model_dump(mode="json", by_alias=True)


@app.post("/rooms/{room_id}/agent/jobs")
async def enqueue_agent_job(room_id: str, request: AgentJobRequest) -> dict[str, Any]:
    return rooms.enqueue_agent_job(room_id, request).model_dump(mode="json", by_alias=True)


@app.get("/selection/current")
async def get_current_selection() -> dict[str, Any]:
    return rooms.current_selection().model_dump(mode="json", by_alias=True)


@app.post("/selection/current")
async def set_current_selection(selection: RoomSelectionRequest) -> dict[str, Any]:
    current = rooms.select_room(
        room_id=selection.room_id,
        world_id=selection.world_id,
        world_name=selection.world_name,
    )
    await rooms.broadcast_selection()
    return current.model_dump(mode="json", by_alias=True)


@app.delete("/selection/current")
async def clear_current_selection() -> dict[str, Any]:
    current = rooms.clear_selection()
    await rooms.broadcast_selection()
    return current.model_dump(mode="json", by_alias=True)


@app.websocket("/ws/selection")
async def selection_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    rooms.connect_selection(websocket)
    await websocket.send_json(
        {
            "type": "selection_hello",
            **rooms.current_selection().model_dump(mode="json", by_alias=True),
        }
    )
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        rooms.disconnect_selection(websocket)


def _validation_message(error: ValidationError) -> str:
    first = error.errors()[0] if error.errors() else {}
    loc = ".".join(str(part) for part in first.get("loc", ()))
    reason = first.get("msg", "invalid message")
    return f"{loc}: {reason}" if loc else reason


async def _send_error(websocket: WebSocket, message: str) -> None:
    await websocket.send_json(ErrorMessage(message=message).model_dump())


@app.websocket("/ws/rooms/{room_id}")
async def room_socket(websocket: WebSocket, room_id: str) -> None:
    await websocket.accept()
    rooms.connect(room_id, websocket)
    room = rooms.get_room(room_id)
    await websocket.send_json(
        HelloMessage(
            roomId=room_id,
            version=room.version,
            projection=room.projection,
            semanticDraft=room.semantic_draft,
        ).model_dump(mode="json", by_alias=True)
    )

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await _send_error(websocket, "invalid JSON")
                continue

            if not isinstance(data, dict):
                await _send_error(websocket, "message must be a JSON object")
                continue

            message_type = data.get("type")
            if message_type is None:
                await _send_error(websocket, "missing type")
                continue
            if message_type not in {"canvas_capture", "clarification_answer"}:
                await _send_error(websocket, f"unknown type: {message_type}")
                continue

            if message_type == "canvas_capture":
                try:
                    message = CanvasCaptureMessage.model_validate(data)
                except ValidationError as error:
                    await _send_error(websocket, _validation_message(error))
                    continue

                update = rooms.store_capture(room_id, message)
                await rooms.broadcast(room_id, update)
            else:
                try:
                    answer = ClarificationAnswerMessage.model_validate(data)
                    update = rooms.store_answer(room_id, answer)
                except ValidationError as error:
                    await _send_error(websocket, _validation_message(error))
                    continue
                except ValueError as error:
                    await _send_error(websocket, str(error))
                    continue
                await rooms.broadcast_semantic(room_id, update)
    except WebSocketDisconnect:
        pass
    finally:
        rooms.disconnect(room_id, websocket)
