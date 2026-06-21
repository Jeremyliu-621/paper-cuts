from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.rooms import rooms


def setup_function() -> None:
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


def test_empty_room_capture() -> None:
    client = TestClient(app)

    response = client.get("/rooms/demo/capture")

    assert response.status_code == 200
    assert response.json() == {
        "roomId": "demo",
        "version": 0,
        "capture": None,
        "projection": None,
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
    assert client.get("/rooms/desktop-saved/capture").json()["capture"] == capture


def test_websocket_capture_updates_room_and_http_capture() -> None:
    client = TestClient(app)
    capture = {"store": {"shape:one": {"typeName": "shape", "x": 10}}}
    projected = projection()

    with client.websocket_connect("/ws/rooms/demo") as websocket:
        hello = websocket.receive_json()
        assert hello["type"] == "hello"
        assert hello["projection"] is None
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
    assert update["sourceClientId"] == "ipad"

    response = client.get("/rooms/demo/capture")
    body = response.json()
    assert body["version"] == 1
    assert body["capture"] == capture
    assert body["projection"] == projected
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

    with client.websocket_connect("/ws/rooms/demo") as websocket:
        websocket.receive_json()
        websocket.send_json({"type": "canvas_capture", "capture": {"ok": True}, "projection": projected})
        websocket.receive_json()

    with client.websocket_connect("/ws/rooms/demo") as websocket:
        hello = websocket.receive_json()
        assert hello["type"] == "hello"
        assert hello["version"] == 1
        assert hello["projection"] == projected


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
