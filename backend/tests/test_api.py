from __future__ import annotations

import os
import time
from datetime import UTC, datetime

from fastapi.testclient import TestClient

from app.main import app
from app.finishers import reset_finisher_jobs
from app.orchestrator import AgentOrchestrator
from app.rooms import rooms
from app.schemas import VisualObservation, VisualObservationHint


def setup_function() -> None:
    os.environ.pop("OPENAI_API_KEY", None)
    os.environ.pop("FAL_KEY", None)
    os.environ.pop("MAGICBOARD_VLM_MODEL", None)
    rooms.reset()
    reset_finisher_jobs()


def projection() -> dict:
    return {
        "type": "magicboard_projection",
        "version": 1,
        "coordinateSpace": {"type": "game_view", "width": 1920, "height": 1080},
        "strokes": [{"id": "stroke-1", "points": [{"x": 10, "y": 20}, {"x": 80, "y": 40}], "width": 6}],
        "shapes": [],
        "labels": [],
    }


def stage_reference() -> dict:
    return {
        "view": {"w": 1920, "h": 1080, "x": 0, "y": 0},
        "bounds": {"x0": 0, "y0": 0, "x1": 1920, "y1": 1080},
        "platforms": [{"x": 100, "y": 860, "w": 440, "h": 42}],
        "portals": [{"id": "portal-a", "x": 320, "y": 520, "r": 44}],
        "spawns": [{"x": 260, "y": 780}, {"x": 1660, "y": 780}],
    }


def test_health() -> None:
    client = TestClient(app)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"ok": True, "version": "0.1.0"}


def finisher_payload(style: str = "Melt") -> dict:
    return {
        "attackerId": "Sprout",
        "victimId": "Acorn",
        "victimSkinHash": "skin-abc",
        "style": style,
        "imageDataUrl": "data:image/png;base64,iVBORw0KGgo=",
    }


def test_finisher_job_reports_missing_key(monkeypatch) -> None:
    monkeypatch.delenv("FAL_KEY", raising=False)
    client = TestClient(app)

    response = client.post("/finishers/jobs", json=finisher_payload())

    assert response.status_code == 200
    body = response.json()
    assert body["jobId"].startswith("finisher-job-")
    assert body["status"] == "missing_key"
    assert body["videoUrl"] is None
    assert body["error"] == "missing FAL_KEY"


def test_finisher_job_rejects_invalid_style() -> None:
    client = TestClient(app)

    response = client.post("/finishers/jobs", json=finisher_payload("Vaporize"))

    assert response.status_code == 422


def test_finisher_job_creates_cached_local_record(monkeypatch) -> None:
    monkeypatch.setenv("FAL_KEY", "test-fal-key")

    async def fake_submit(request):
        return {"request_id": "fal-123"}

    monkeypatch.setattr("app.finishers._submit_fal_job", fake_submit)
    client = TestClient(app)

    first = client.post("/finishers/jobs", json=finisher_payload("Explode"))
    second = client.post("/finishers/jobs", json=finisher_payload("Explode"))

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["jobId"] == second.json()["jobId"]
    assert first.json()["status"] == "queued"


def test_finisher_job_poll_transitions_to_ready(monkeypatch) -> None:
    monkeypatch.setenv("FAL_KEY", "test-fal-key")

    async def fake_submit(request):
        return {"request_id": "fal-ready"}

    async def fake_status(job):
        return {"status": "COMPLETED"}

    async def fake_result(job):
        return {"video": {"url": "https://cdn.example/finisher.mp4"}}

    monkeypatch.setattr("app.finishers._submit_fal_job", fake_submit)
    monkeypatch.setattr("app.finishers._fal_status", fake_status)
    monkeypatch.setattr("app.finishers._fal_result", fake_result)
    client = TestClient(app)

    created = client.post("/finishers/jobs", json=finisher_payload()).json()
    response = client.get(f"/finishers/jobs/{created['jobId']}")

    assert response.status_code == 200
    assert response.json()["status"] == "ready"
    assert response.json()["videoUrl"] == "https://cdn.example/finisher.mp4"


def test_finisher_job_poll_transitions_to_failed(monkeypatch) -> None:
    monkeypatch.setenv("FAL_KEY", "test-fal-key")

    async def fake_submit(request):
        return {"request_id": "fal-fail"}

    async def fake_status(job):
        return {"status": "FAILED", "error": {"message": "bad image"}}

    monkeypatch.setattr("app.finishers._submit_fal_job", fake_submit)
    monkeypatch.setattr("app.finishers._fal_status", fake_status)
    client = TestClient(app)

    created = client.post("/finishers/jobs", json=finisher_payload()).json()
    response = client.get(f"/finishers/jobs/{created['jobId']}")

    assert response.status_code == 200
    assert response.json()["status"] == "failed"
    assert response.json()["error"] == "bad image"


def test_agent_status_reports_stubbed_cold_path_without_required_keys(monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    client = TestClient(app)

    response = client.get("/agent/status")

    assert response.status_code == 200
    body = response.json()
    assert body["type"] == "magicboard_agent_status"
    capabilities = {capability["id"]: capability for capability in body["capabilities"]}
    assert capabilities["deterministic_semantic"]["status"] == "enabled"
    assert capabilities["deterministic_semantic"]["hotPath"] is False
    assert capabilities["vlm_semantic"]["status"] == "missing_key"
    assert capabilities["vlm_semantic"]["requiredEnv"] == ["OPENAI_API_KEY"]
    assert set(capabilities) == {"deterministic_semantic", "vlm_semantic"}


def test_empty_room_capture() -> None:
    client = TestClient(app)

    response = client.get("/rooms/demo/capture")

    assert response.status_code == 200
    body = response.json()
    assert body["roomId"] == "demo"
    assert body["version"] == 0
    assert body["capture"] is None
    assert body["projection"] is None
    assert body["semanticDraft"] is None
    assert body["visualObservation"] is None
    assert body["agentTurns"] == []
    assert body["proposals"] == []
    assert body["permissionRequests"] == []
    assert body["updatedAt"] is None
    assert body["recentEvents"] == []


def test_current_selection_starts_empty() -> None:
    client = TestClient(app)

    response = client.get("/selection/current")

    assert response.status_code == 200
    assert response.json() == {
        "roomId": None,
        "worldId": None,
        "worldName": None,
        "stageReferenceVersion": 0,
        "selectedAt": None,
    }


def test_current_selection_tracks_desktop_preview_room() -> None:
    client = TestClient(app)
    reference = stage_reference()

    response = client.post(
        "/selection/current",
        json={
            "roomId": "world-demo",
            "worldId": "world-demo",
            "worldName": "Demo World",
            "stageReference": reference,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["roomId"] == "world-demo"
    assert body["worldId"] == "world-demo"
    assert body["worldName"] == "Demo World"
    assert body["stageReference"] == reference
    assert body["stageReferenceVersion"] == 1
    assert body["selectedAt"]
    assert client.get("/selection/current").json() == body
    room = client.get("/rooms/world-demo/capture").json()
    assert room["roomId"] == "world-demo"
    assert room["stageReference"] == reference
    assert room["stageReferenceVersion"] == 1


def test_selection_websocket_receives_desktop_selection_updates() -> None:
    client = TestClient(app)

    with client.websocket_connect("/ws/selection") as websocket:
        assert websocket.receive_json() == {
            "type": "selection_hello",
            "roomId": None,
            "worldId": None,
            "worldName": None,
            "stageReferenceVersion": 0,
            "selectedAt": None,
        }

        response = client.post(
            "/selection/current",
            json={"roomId": "world-live", "worldId": "world-live", "worldName": "Live World"},
        )
        assert response.status_code == 200

        update = websocket.receive_json()
        assert update["type"] == "selection_updated"
        assert update["roomId"] == "world-live"
        assert update["worldId"] == "world-live"
        assert update["worldName"] == "Live World"
        assert update["selectedAt"]

        response = client.delete("/selection/current")
        assert response.status_code == 200

        cleared = websocket.receive_json()
        assert cleared == {
            "type": "selection_updated",
            "roomId": None,
            "worldId": None,
            "worldName": None,
            "stageReferenceVersion": 0,
            "selectedAt": None,
        }


def test_http_capture_save_updates_room_capture() -> None:
    client = TestClient(app)
    capture = {"store": {"shape:desktop": {"typeName": "shape", "x": 22}}}
    projected = projection()

    response = client.post(
        "/rooms/desktop-saved/capture",
        json={
            "type": "canvas_capture",
            "capture": capture,
            "projection": projected,
            "clientId": "desktop-save",
            "sentAt": "2026-06-20T12:00:00.000Z",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["roomId"] == "desktop-saved"
    assert body["version"] == 1
    assert body["capture"] == capture
    assert body["projection"] == projected
    assert body["semanticDraft"]["roomId"] == "desktop-saved"
    assert body["visualObservation"]["status"] == "missing_key"
    assert body["visualObservation"]["captureVersion"] == 1
    assert client.get("/rooms/desktop-saved/capture").json()["capture"] == capture


def test_websocket_capture_updates_room_and_http_capture() -> None:
    client = TestClient(app)
    capture = {"store": {"shape:one": {"typeName": "shape", "x": 10}}}
    projected = projection()

    with client.websocket_connect("/ws/rooms/demo") as websocket:
        hello = websocket.receive_json()
        assert hello["type"] == "hello"
        assert hello["projection"] is None
        assert hello["visualObservation"] is None
        assert hello["stageReference"] is None
        assert hello["stageReferenceVersion"] == 0
        websocket.send_json(
            {
                "type": "canvas_capture",
                "capture": capture,
                "projection": projected,
                "clientId": "ipad",
                "sentAt": "2026-06-20T12:00:00.000Z",
            }
        )
        update = websocket.receive_json()

    assert update["type"] == "projection_updated"
    assert update["roomId"] == "demo"
    assert update["version"] == 1
    assert update["projection"] == projected
    assert update["semanticDraft"]["captureVersion"] == 1
    assert update["visualObservation"]["status"] == "missing_key"
    assert update["stageReference"] is None
    assert update["stageReferenceVersion"] == 0
    assert update["sourceClientId"] == "ipad"

    response = client.get("/rooms/demo/capture")
    body = response.json()
    assert body["version"] == 1
    assert body["capture"] == capture
    assert body["projection"] == projected
    assert body["semanticDraft"]["captureVersion"] == 1
    assert body["visualObservation"]["status"] == "missing_key"
    assert body["updatedAt"]
    assert body["recentEvents"] == [
        {
            "type": "canvas_capture",
            "version": 1,
            "updatedAt": body["updatedAt"],
            "clientId": "ipad",
            "sentAt": "2026-06-20T12:00:00.000Z",
        }
    ]


def test_new_connection_receives_latest_projection_in_hello() -> None:
    client = TestClient(app)
    projected = projection()
    reference = stage_reference()
    client.post(
        "/selection/current",
        json={"roomId": "demo", "worldId": "world-demo", "worldName": "Demo World", "stageReference": reference},
    )
    projected["shapes"].append(
        {"id": "shape-platform", "sourceId": "shape-platform", "kind": "rectangle", "x": 100, "y": 820, "w": 480, "h": 48}
    )

    with client.websocket_connect("/ws/rooms/demo") as websocket:
        websocket.receive_json()
        websocket.send_json({"type": "canvas_capture", "capture": {"ok": True}, "projection": projected})
        websocket.receive_json()

    with client.websocket_connect("/ws/rooms/demo") as websocket:
        hello = websocket.receive_json()
        assert hello["type"] == "hello"
        assert hello["version"] == 1
        assert hello["projection"] == projected
        assert hello["stageReference"] == reference
        assert hello["stageReferenceVersion"] == 1
        assert hello["semanticDraft"]["candidates"][0]["question"]["prompt"] == "What should this platform do?"
        assert hello["visualObservation"]["status"] == "missing_key"


def test_malformed_messages_return_errors_without_closing_socket() -> None:
    client = TestClient(app)

    with client.websocket_connect("/ws/rooms/demo") as websocket:
        assert websocket.receive_json()["type"] == "hello"
        websocket.send_text("{")
        assert websocket.receive_json() == {"type": "error", "message": "invalid JSON"}
        websocket.send_json({"capture": {}, "projection": projection()})
        assert websocket.receive_json() == {"type": "error", "message": "missing type"}
        websocket.send_json({"type": "canvas_snapshot"})
        assert websocket.receive_json() == {"type": "error", "message": "unknown type: canvas_snapshot"}
        websocket.send_json({"type": "canvas_capture", "capture": [], "projection": projection()})
        error = websocket.receive_json()
        assert error["type"] == "error"
        assert "capture" in error["message"]

        websocket.send_json({"type": "canvas_capture", "capture": {"ok": True}, "projection": projection()})
        assert websocket.receive_json()["type"] == "projection_updated"

    assert client.get("/rooms/demo/capture").json()["version"] == 1


def test_disconnect_removes_socket_and_reconnect_receives_current_version() -> None:
    client = TestClient(app)

    with client.websocket_connect("/ws/rooms/demo") as websocket:
        assert websocket.receive_json()["version"] == 0
        websocket.send_json({"type": "canvas_capture", "capture": {"first": True}, "projection": projection()})
        assert websocket.receive_json()["version"] == 1

    with client.websocket_connect("/ws/rooms/demo") as websocket:
        hello = websocket.receive_json()
        assert hello["type"] == "hello"
        assert hello["version"] == 1
        websocket.send_json({"type": "canvas_capture", "capture": {"second": True}, "projection": projection()})
        assert websocket.receive_json()["version"] == 2

    body = client.get("/rooms/demo/capture").json()
    assert body["version"] == 2
    assert body["capture"] == {"second": True}


def test_semantic_draft_extracts_rectangles_and_thick_horizontal_strokes() -> None:
    client = TestClient(app)
    projected = projection()
    projected["strokes"] = [
        {
            "id": "stroke-thick",
            "sourceId": "stroke-thick",
            "points": [{"x": 140, "y": 700}, {"x": 380, "y": 706}, {"x": 620, "y": 702}],
            "width": 18,
        }
    ]
    projected["shapes"] = [
        {"id": "rect-one", "sourceId": "rect-one", "kind": "rectangle", "x": 80, "y": 840, "w": 360, "h": 42}
    ]

    response = client.post(
        "/rooms/semantic/capture",
        json={"type": "canvas_capture", "capture": {"ok": True}, "projection": projected, "clientId": "ipad"},
    )

    assert response.status_code == 200
    draft = response.json()["semanticDraft"]
    assert draft["type"] == "magicboard_semantic_draft"
    assert draft["roomId"] == "semantic"
    assert draft["captureVersion"] == 1
    assert len(draft["candidates"]) == 2
    assert {candidate["extractor"] for candidate in draft["candidates"]} == {"rectangle", "stroke"}
    assert len(draft["questions"]) == 2
    assert all(question["prompt"] == "What should this platform do?" for question in draft["questions"])


def test_visual_observation_classifies_existing_semantic_candidates() -> None:
    client = TestClient(app)
    projected = projection()
    projected["shapes"] = [
        {
            "id": "doodle-cannon",
            "sourceId": "doodle-cannon",
            "kind": "rectangle",
            "x": 820,
            "y": 700,
            "w": 160,
            "h": 68,
        },
    ]

    response = client.post(
        "/rooms/vlm-classifies/capture",
        json={"type": "canvas_capture", "capture": {"ok": True}, "projection": projected, "clientId": "ipad"},
    )

    assert response.status_code == 200
    draft = response.json()["semanticDraft"]
    assert draft["questions"]
    assert draft["candidates"][0]["status"] == "needs_answer"

    update = rooms.store_visual_observation(
        "vlm-classifies",
        VisualObservation(
            status="ready",
            roomId="vlm-classifies",
            worldId=None,
            captureVersion=1,
            jobId=response.json()["visualObservation"]["jobId"],
            model="gpt-test",
            description="The doodle is intended as a cannon.",
            hints=[
                VisualObservationHint(
                    kind="platform",
                    confidence=0.91,
                    description="cannon platform doodle",
                    behavior="cannon",
                    sourceIds=["doodle-cannon"],
                )
            ],
            updatedAt=datetime.now(UTC),
        ),
    )

    assert update is not None
    draft = update.model_dump(mode="json", by_alias=True)["semanticDraft"]
    assert draft["questions"] == []
    assert draft["candidates"][0]["extractor"] == "rectangle"
    assert draft["candidates"][0]["status"] == "confirmed"
    assert draft["candidates"][0]["answer"]["behavior"] == "cannon"


def test_semantic_draft_extracts_conservative_grouped_strokes() -> None:
    client = TestClient(app)
    projected = projection()
    projected["strokes"] = [
        {
            "id": "stroke-a",
            "sourceId": "stroke-a",
            "points": [{"x": 180, "y": 650}, {"x": 310, "y": 652}],
            "width": 5,
        },
        {
            "id": "stroke-b",
            "sourceId": "stroke-b",
            "points": [{"x": 330, "y": 656}, {"x": 520, "y": 654}],
            "width": 5,
        },
    ]
    projected["shapes"] = []

    response = client.post(
        "/rooms/grouped/capture",
        json={"type": "canvas_capture", "capture": {"ok": True}, "projection": projected},
    )

    assert response.status_code == 200
    draft = response.json()["semanticDraft"]
    assert len(draft["candidates"]) == 1
    assert draft["candidates"][0]["extractor"] == "grouped_strokes"
    assert draft["candidates"][0]["sourceIds"] == ["stroke-a", "stroke-b"]


def test_semantic_draft_extracts_portal_endpoint_and_pair_candidates() -> None:
    client = TestClient(app)
    projected = projection()
    projected["strokes"] = []
    projected["shapes"] = [
        {"id": "portal-a", "sourceId": "portal-a", "kind": "ellipse", "x": 180, "y": 420, "w": 92, "h": 104},
        {"id": "portal-b", "sourceId": "portal-b", "kind": "ellipse", "x": 1480, "y": 680, "w": 96, "h": 88},
    ]

    response = client.post(
        "/rooms/portals/capture",
        json={"type": "canvas_capture", "capture": {"ok": True}, "projection": projected},
    )

    assert response.status_code == 200
    draft = response.json()["semanticDraft"]
    extractors = [candidate["extractor"] for candidate in draft["candidates"]]
    assert extractors == ["circle", "circle", "portal_pair"]
    pair = draft["candidates"][2]
    assert pair["semanticType"] == "portal_pair"
    assert pair["sourceIds"] == ["portal-a", "portal-b"]
    assert len(pair["portalEndpoints"]) == 2


def test_semantic_draft_extracts_freehand_portal_pair_and_vlm_confirms_pair() -> None:
    client = TestClient(app)
    projected = projection()
    projected["strokes"] = [
        {
            "id": "loop-a",
            "sourceId": "loop-a",
            "points": [
                {"x": 180, "y": 520},
                {"x": 220, "y": 480},
                {"x": 270, "y": 505},
                {"x": 280, "y": 560},
                {"x": 240, "y": 605},
                {"x": 190, "y": 585},
                {"x": 170, "y": 540},
                {"x": 180, "y": 520},
            ],
            "width": 6,
        },
        {
            "id": "loop-b",
            "sourceId": "loop-b",
            "points": [
                {"x": 1480, "y": 520},
                {"x": 1525, "y": 480},
                {"x": 1580, "y": 510},
                {"x": 1585, "y": 565},
                {"x": 1540, "y": 610},
                {"x": 1490, "y": 585},
                {"x": 1470, "y": 540},
                {"x": 1480, "y": 520},
            ],
            "width": 6,
        },
    ]
    projected["shapes"] = []

    response = client.post(
        "/rooms/freehand-portals/capture",
        json={"type": "canvas_capture", "capture": {"ok": True}, "projection": projected},
    )
    assert response.status_code == 200
    draft = response.json()["semanticDraft"]
    assert [candidate["extractor"] for candidate in draft["candidates"]] == ["circle", "circle", "portal_pair"]

    update = rooms.store_visual_observation(
        "freehand-portals",
        VisualObservation(
            status="ready",
            roomId="freehand-portals",
            worldId=None,
            captureVersion=1,
            jobId=response.json()["visualObservation"]["jobId"],
            model="gpt-test",
            description="The two loops are linked portals.",
            hints=[
                VisualObservationHint(
                    kind="portal_endpoint",
                    confidence=0.6,
                    description="two linked portal loops",
                    behavior="pass",
                    sourceIds=["loop-a", "loop-b"],
                )
            ],
            updatedAt=datetime.now(UTC),
        ),
    )

    assert update is not None
    confirmed_pair = update.model_dump(mode="json", by_alias=True)["semanticDraft"]["candidates"][2]
    assert confirmed_pair["status"] == "confirmed"
    assert confirmed_pair["answer"]["role"] == "portal_pair"
    assert len(confirmed_pair["portalEndpoints"]) == 2


def test_semantic_answer_binds_to_current_candidate_and_confirms_behavior() -> None:
    client = TestClient(app)
    projected = projection()
    projected["shapes"] = [
        {"id": "rect-one", "sourceId": "rect-one", "kind": "rectangle", "x": 80, "y": 840, "w": 360, "h": 42}
    ]
    room = client.post(
        "/rooms/answer/capture",
        json={"type": "canvas_capture", "capture": {"ok": True}, "projection": projected, "worldId": "world-answer"},
    ).json()
    candidate = room["semanticDraft"]["candidates"][0]

    response = client.post(
        "/rooms/answer/clarifications",
        json={
            "type": "clarification_answer",
            "questionId": candidate["questionId"],
            "candidateId": candidate["candidateId"],
            "choiceId": "bouncy",
            "captureVersion": candidate["captureVersion"],
            "sourceIds": candidate["sourceIds"],
            "geometryHash": candidate["geometryHash"],
            "worldId": "world-answer",
            "clientId": "ipad",
        },
    )

    assert response.status_code == 200
    draft = response.json()
    assert draft["questions"] == []
    confirmed = draft["candidates"][0]
    assert confirmed["status"] == "confirmed"
    assert confirmed["answer"]["choiceId"] == "bouncy"
    assert confirmed["answer"]["behavior"] == "bounce"


def test_redraw_invalidates_prior_answer_and_asks_again() -> None:
    client = TestClient(app)
    projected = projection()
    projected["shapes"] = [
        {"id": "rect-one", "sourceId": "rect-one", "kind": "rectangle", "x": 80, "y": 840, "w": 360, "h": 42}
    ]
    room = client.post(
        "/rooms/redraw/capture",
        json={"type": "canvas_capture", "capture": {"ok": True}, "projection": projected},
    ).json()
    candidate = room["semanticDraft"]["candidates"][0]
    answer_payload = {
        "type": "clarification_answer",
        "questionId": candidate["questionId"],
        "candidateId": candidate["candidateId"],
        "choiceId": "normal",
        "captureVersion": candidate["captureVersion"],
        "sourceIds": candidate["sourceIds"],
        "geometryHash": candidate["geometryHash"],
    }
    assert client.post("/rooms/redraw/clarifications", json=answer_payload).status_code == 200

    moved = projection()
    moved["shapes"] = [
        {"id": "rect-one", "sourceId": "rect-one", "kind": "rectangle", "x": 160, "y": 840, "w": 360, "h": 42}
    ]
    redraw = client.post(
        "/rooms/redraw/capture",
        json={"type": "canvas_capture", "capture": {"ok": True}, "projection": moved},
    ).json()["semanticDraft"]

    assert redraw["candidates"][0]["status"] == "needs_answer"
    assert redraw["questions"][0]["candidateId"] == redraw["candidates"][0]["candidateId"]
    assert redraw["staleAnswers"][0]["geometryHash"] == candidate["geometryHash"]
    stale_response = client.post("/rooms/redraw/clarifications", json=answer_payload)
    assert stale_response.status_code == 409
    assert stale_response.json()["detail"] == "stale captureVersion"


def test_websocket_accepts_clarification_answer_and_broadcasts_semantic_update() -> None:
    client = TestClient(app)
    projected = projection()
    projected["shapes"] = [
        {"id": "rect-one", "sourceId": "rect-one", "kind": "rectangle", "x": 80, "y": 840, "w": 360, "h": 42}
    ]

    with client.websocket_connect("/ws/rooms/live-answer") as websocket:
        websocket.receive_json()
        websocket.send_json({"type": "canvas_capture", "capture": {"ok": True}, "projection": projected})
        update = websocket.receive_json()
        candidate = update["semanticDraft"]["candidates"][0]
        websocket.send_json(
            {
                "type": "clarification_answer",
                "questionId": candidate["questionId"],
                "candidateId": candidate["candidateId"],
                "choiceId": "pass_through",
                "captureVersion": candidate["captureVersion"],
                "sourceIds": candidate["sourceIds"],
                "geometryHash": candidate["geometryHash"],
                "clientId": "ipad",
            }
        )
        semantic_update = websocket.receive_json()

    assert semantic_update["type"] == "semantic_draft_updated"
    assert semantic_update["semanticDraft"]["candidates"][0]["status"] == "confirmed"
    assert semantic_update["semanticDraft"]["candidates"][0]["answer"]["behavior"] == "pass"


def test_visual_observation_endpoint_reports_missing_key(monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    client = TestClient(app)

    client.post(
        "/rooms/no-key/capture",
        json={"type": "canvas_capture", "capture": {"ok": True}, "projection": projection()},
    )

    response = client.get("/rooms/no-key/visual-observation")

    assert response.status_code == 200
    body = response.json()
    assert body["type"] == "magicboard_visual_observation"
    assert body["status"] == "missing_key"
    assert body["captureVersion"] == 1
    assert body["errors"] == ["missing OPENAI_API_KEY"]


def test_mocked_vlm_response_stores_and_broadcasts_observation(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("MAGICBOARD_VLM_MODEL", "gpt-test")

    def fake_observation(*, projection: dict, candidates: list[dict]) -> dict:
        assert [candidate["sourceIds"] for candidate in candidates] == [["stroke-1"]]
        return {
            "description": "A single horizontal platform is drawn near the bottom.",
            "hints": [
                {
                    "kind": "platform",
                    "confidence": 0.91,
                    "description": "wide ledge",
                    "behavior": "solid",
                    "sourceIds": ["stroke-1"],
                }
            ],
        }

    monkeypatch.setattr("app.agent_runtime._request_openai_visual_observation", fake_observation)
    client = TestClient(app)
    projected = projection()
    projected["strokes"] = []
    projected["shapes"] = [
        {"id": "stroke-1", "sourceId": "stroke-1", "kind": "rectangle", "x": 120, "y": 780, "w": 360, "h": 44}
    ]

    with client.websocket_connect("/ws/rooms/vlm-ready") as websocket:
        websocket.receive_json()
        websocket.send_json({"type": "canvas_capture", "capture": {"ok": True}, "projection": projected})
        projection_update = websocket.receive_json()
        visual_update = websocket.receive_json()

    assert projection_update["visualObservation"]["status"] == "pending"
    assert visual_update["type"] == "visual_observation_updated"
    assert visual_update["visualObservation"]["status"] == "ready"
    assert visual_update["visualObservation"]["model"] == "gpt-test"
    assert visual_update["visualObservation"]["description"] == "A single horizontal platform is drawn near the bottom."
    assert visual_update["visualObservation"]["hints"][0]["sourceIds"] == ["stroke-1"]
    assert client.get("/rooms/vlm-ready/visual-observation").json()["status"] == "ready"


def test_coalesced_vlm_jobs_only_latest_capture_becomes_current(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    calls = {"count": 0}

    def fake_observation(*, projection: dict, candidates: list[dict]) -> dict:
        assert candidates
        calls["count"] += 1
        if calls["count"] == 1:
            time.sleep(0.05)
        return {"description": f"observation {calls['count']}", "hints": []}

    monkeypatch.setattr("app.agent_runtime._request_openai_visual_observation", fake_observation)
    client = TestClient(app)
    first = projection()
    first["strokes"] = []
    first["shapes"] = [
        {"id": "shape-1", "sourceId": "shape-1", "kind": "rectangle", "x": 120, "y": 780, "w": 360, "h": 44}
    ]
    second = projection()
    second["strokes"] = []
    second["shapes"] = [
        {"id": "shape-2", "sourceId": "shape-2", "kind": "rectangle", "x": 160, "y": 720, "w": 420, "h": 44}
    ]

    with client.websocket_connect("/ws/rooms/coalesce") as websocket:
        websocket.receive_json()
        websocket.send_json({"type": "canvas_capture", "capture": {"first": True}, "projection": first})
        assert websocket.receive_json()["version"] == 1
        websocket.send_json({"type": "canvas_capture", "capture": {"second": True}, "projection": second})
        assert websocket.receive_json()["version"] == 2
        visual_update = websocket.receive_json()

    assert visual_update["type"] == "visual_observation_updated"
    assert visual_update["version"] == 2
    assert visual_update["visualObservation"]["captureVersion"] == 2
    assert client.get("/rooms/coalesce/visual-observation").json()["captureVersion"] == 2


def test_agent_job_is_stubbed_idempotent_and_not_in_hot_path(monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    client = TestClient(app)
    client.post(
        "/rooms/agent-room/capture",
        json={"type": "canvas_capture", "capture": {"ok": True}, "projection": projection()},
    )
    payload = {
        "type": "agent_semantic_review",
        "idempotencyKey": "job-key-1",
        "captureVersion": 1,
        "worldId": "world-agent",
        "modality": "vlm",
        "prompt": "look for platforms",
        "clientId": "desktop",
    }

    first = client.post("/rooms/agent-room/agent/jobs", json=payload)
    second = client.post("/rooms/agent-room/agent/jobs", json=payload)

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json() == second.json()
    body = first.json()
    assert body["type"] == "agent_job"
    assert body["roomId"] == "agent-room"
    assert body["worldId"] == "world-agent"
    assert body["captureVersion"] == 1
    assert body["currentCaptureVersion"] == 1
    assert body["status"] == "stubbed_missing_key"
    assert body["requiredEnv"] == ["OPENAI_API_KEY"]


def test_agent_job_rejects_stale_capture_version_before_cold_path_work() -> None:
    client = TestClient(app)
    client.post(
        "/rooms/stale-agent/capture",
        json={"type": "canvas_capture", "capture": {"ok": True}, "projection": projection()},
    )

    response = client.post(
        "/rooms/stale-agent/agent/jobs",
        json={
            "type": "agent_semantic_review",
            "idempotencyKey": "stale-job",
            "captureVersion": 0,
            "modality": "vlm",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "stale"
    assert body["captureVersion"] == 0
    assert body["currentCaptureVersion"] == 1
    assert body["requiredEnv"] == []


def test_agent_tool_rejects_stale_version_refs() -> None:
    rooms.select_room("agent-tools", world_id="world-tools", stage_reference={"platforms": []})
    orchestrator = AgentOrchestrator(rooms)

    stale_capture = orchestrator._run_tool("agent-tools", None, "turn-1", "validate_level_patch", {
        "patch": {"type": "magicboard_world_patch", "version": 1, "target": {"mapId": "world-tools"}, "operations": []},
        "requiredVersionRefs": {"captureVersion": 99},
    })
    stale_stage = orchestrator._run_tool("agent-tools", None, "turn-1", "validate_level_patch", {
        "patch": {"type": "magicboard_world_patch", "version": 1, "target": {"mapId": "world-tools"}, "operations": []},
        "requiredVersionRefs": {"stageReferenceVersion": 99},
    })

    assert stale_capture["error"]["code"] == "stale_capture"
    assert stale_stage["error"]["code"] == "stale_stage_reference"
