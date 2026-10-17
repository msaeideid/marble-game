from fastapi.testclient import TestClient

from app.main import app


def test_health_ok():
    with TestClient(app) as client:  # the context manager runs the app lifespan (starts the room)
        r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["tickRate"] == 30
    assert body["players"] == 0
