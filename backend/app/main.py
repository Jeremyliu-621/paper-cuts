from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError

from .config import load_backend_env
from .agent_runtime import agent_status, run_visual_observation
from .finishers import create_finisher_job, get_finisher_job
from .orchestrator import AgentOrchestrator
from .rooms import rooms, selection_payload
from .schemas import (
    AgentJobRequest,
    BACKEND_VERSION,
    CanvasCaptureMessage,
    ClarificationAnswerMessage,
    ErrorMessage,
    FinisherJobRequest,
    HelloMessage,
    RoomSelectionRequest,
    StageEditMessage,
)

load_backend_env()

app = FastAPI(title="Magic Board Backend", version=BACKEND_VERSION)
orchestrator = AgentOrchestrator(rooms)

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


@app.post("/finishers/jobs")
async def create_finisher(request: FinisherJobRequest) -> dict[str, Any]:
    response = await create_finisher_job(request)
    return response.model_dump(mode="json", by_alias=True)


@app.get("/finishers/jobs/{job_id}")
async def get_finisher(job_id: str) -> dict[str, Any]:
    response = await get_finisher_job(job_id)
    if response is None:
        raise HTTPException(status_code=404, detail="finisher job not found")
    return response.model_dump(mode="json", by_alias=True)


async def _run_visual_job(
    room_id: str,
    capture_version: int,
    job_id: str,
    world_id: str | None,
    projection: dict[str, Any],
    candidates: list[dict[str, Any]],
) -> None:
    observation = await run_visual_observation(
        room_id=room_id,
        world_id=world_id,
        capture_version=capture_version,
        job_id=job_id,
        projection=projection,
        candidates=candidates,
    )
    update = rooms.store_visual_observation(room_id, observation)
    if update is not None:
        await rooms.broadcast_visual(room_id, update)


def _schedule_visual_observation(room_id: str) -> None:
    room = rooms.get_room(room_id)
    observation = room.visual_observation
    if not observation or observation.status != "pending" or not room.projection:
        return
    candidates = [
        candidate.model_dump(mode="json", by_alias=True)
        for candidate in (room.semantic_draft.candidates if room.semantic_draft else [])
        if candidate.status == "needs_answer"
    ]
    asyncio.create_task(
        _run_visual_job(
            room_id=room.room_id,
            capture_version=observation.capture_version,
            job_id=observation.job_id,
            world_id=room.world_id,
            projection=room.projection,
            candidates=candidates,
        )
    )


@app.post("/rooms/{room_id}/capture")
async def save_room_capture(room_id: str, capture: CanvasCaptureMessage) -> dict[str, Any]:
    update = rooms.store_capture(room_id, capture)
    await rooms.broadcast(room_id, update)
    _schedule_visual_observation(room_id)
    return rooms.capture_response(room_id).model_dump(mode="json", by_alias=True)


@app.get("/rooms/{room_id}/semantic-draft")
async def get_semantic_draft(room_id: str) -> dict[str, Any] | None:
    draft = rooms.semantic_draft(room_id)
    return None if draft is None else draft.model_dump(mode="json", by_alias=True)


@app.get("/rooms/{room_id}/visual-observation")
async def get_visual_observation(room_id: str) -> dict[str, Any] | None:
    observation = rooms.visual_observation(room_id)
    return None if observation is None else observation.model_dump(mode="json", by_alias=True)


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
    return selection_payload(rooms.current_selection())


@app.post("/selection/current")
async def set_current_selection(selection: RoomSelectionRequest) -> dict[str, Any]:
    current = rooms.select_room(
        room_id=selection.room_id,
        world_id=selection.world_id,
        world_name=selection.world_name,
        stage_reference=selection.stage_reference,
        stage_reference_version=selection.stage_reference_version,
    )
    await rooms.broadcast_selection()
    return selection_payload(current)


@app.delete("/selection/current")
async def clear_current_selection() -> dict[str, Any]:
    current = rooms.clear_selection()
    await rooms.broadcast_selection()
    return selection_payload(current)


@app.websocket("/ws/selection")
async def selection_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    rooms.connect_selection(websocket)
    await websocket.send_json(
        {
            "type": "selection_hello",
            **selection_payload(rooms.current_selection()),
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
    await websocket.send_json(ErrorMessage(message=message).model_dump(exclude_none=True))


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
            visualObservation=room.visual_observation,
            stageReference=room.stage_reference,
            stageReferenceVersion=room.stage_reference_version,
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
            if message_type not in {"canvas_capture", "clarification_answer", "stage_edit"}:
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
                _schedule_visual_observation(room_id)
            elif message_type == "clarification_answer":
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
            else:
                try:
                    edit = StageEditMessage.model_validate(data)
                    update = rooms.store_stage_edit(room_id, edit)
                except ValidationError as error:
                    await _send_error(websocket, _validation_message(error))
                    continue
                except ValueError as error:
                    await _send_error(websocket, str(error))
                    continue
                await rooms.broadcast_stage_edit(room_id, update)
                await rooms.broadcast_selection()
    except WebSocketDisconnect:
        pass
    finally:
        rooms.disconnect(room_id, websocket)
