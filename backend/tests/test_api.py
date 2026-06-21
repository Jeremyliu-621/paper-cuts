from __future__ import annotations

import os
import time

from fastapi.testclient import TestClient

from app.main import app
from app.rooms import rooms


def setup_function() -> None:
    os.environ.pop("OPENAI_API_KEY", None)
    os.environ.pop("MAGICBOARD_VLM_MODEL", None)
    rooms.reset()


def projection() -> dict:
    return {
        "type": "magicboard_projection",
        "version": 1,
        "coordinateSpace": {"type": "game_view", "width": 1920, "height": 1080},
        "strokes": [{"id": "stroke-1", "points": [{"x": 10, "y": 20}, {"x": 80, "y": 40}], "width": 6}],
        "shapes": [],
        "labels": [],
    }


def test_health() -> None:
    client = TestClient(app)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"ok": True, "version": "0.1.0"}


def test_agent_status_reports_stubbed_cold_path_without_required_keys(monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)
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
    assert capabilities["voice"]["status"] == "missing_key"
    assert capabilities["voice"]["requiredEnv"] == ["DEEPGRAM_API_KEY"]


def test_empty_room_capture() -> None:
    client = TestClient(app)

    response = client.get("/rooms/demo/capture")

    assert response.status_code == 200
    assert response.json() == {
        "roomId": "demo",
        "version": 0,
        "capture": None,
        "projection": None,
        "semanticDraft": None,
        "visualObservation": None,
        "updatedAt": None,
        "recentEvents": [],
    }


def test_current_selection_starts_empty() -> None:
    client = TestClient(app)

    response = client.get("/selection/current")

    assert response.status_code == 200
    assert response.json() == {
        "roomId": None,
        "worldId": None,
        "worldName": None,
        "selectedAt": None,
    }


def test_current_selection_tracks_desktop_preview_room() -> None:
    client = TestClient(app)

    response = client.post(
        "/selection/current",
        json={"roomId": "world-demo", "worldId": "world-demo", "worldName": "Demo World"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["roomId"] == "world-demo"
    assert body["worldId"] == "world-demo"
    assert body["worldName"] == "Demo World"
    assert body["selectedAt"]
    assert client.get("/selection/current").json() == body
    assert client.get("/rooms/world-demo/capture").json()["roomId"] == "world-demo"


def test_selection_websocket_receives_desktop_selection_updates() -> None:
    client = TestClient(app)

    with client.websocket_connect("/ws/selection") as websocket:
        assert websocket.receive_json() == {
            "type": "selection_hello",
            "roomId": None,
            "worldId": None,
            "worldName": None,
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

    def fake_observation(*, projection: dict) -> dict:
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

    with client.websocket_connect("/ws/rooms/vlm-ready") as websocket:
        websocket.receive_json()
        websocket.send_json({"type": "canvas_capture", "capture": {"ok": True}, "projection": projection()})
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

    def fake_observation(*, projection: dict) -> dict:
        calls["count"] += 1
        if calls["count"] == 1:
            time.sleep(0.05)
        return {"description": f"observation {calls['count']}", "hints": []}

    monkeypatch.setattr("app.agent_runtime._request_openai_visual_observation", fake_observation)
    client = TestClient(app)
    first = projection()
    second = projection()
    second["strokes"][0]["id"] = "stroke-2"
    second["strokes"][0]["sourceId"] = "stroke-2"

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


def test_voice_agent_job_is_explicitly_deferred() -> None:
    client = TestClient(app)

    response = client.post(
        "/rooms/voice-agent/agent/jobs",
        json={
            "type": "agent_semantic_review",
            "idempotencyKey": "voice-job",
            "captureVersion": 0,
            "modality": "voice",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "unsupported"
    assert body["requiredEnv"] == ["DEEPGRAM_API_KEY"]
    assert "deferred" in body["message"].lower()
