"""REST 契约：认证、往返、校验、去重、设备隔离与 CORS。"""

from __future__ import annotations

import hashlib
import json

from conftest import TOKEN


def payload(name="ok"):
    return {
        "schema": 1,
        "exportedAt": "2026-11-01T00:00:00Z",
        "settings": {"ai": {"apiKey": "sk-ai"}},
        "tags": {"version": 2, "tags": [{"label": name, "url": "https://a.com/"}]},
        "meta": {"auto:rules": {"a": 1}},
    }


def sha_of(value):
    text = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def auth():
    return {"Authorization": "Bearer " + TOKEN}


def put_body(device="default", value=None, **extra):
    data = value if value is not None else payload()
    body = {"device_id": device, "schema": 1, "payload": data}
    body.update(extra)
    return body


def test_health_无需认证(client):
    http, _ = client
    res = http.get("/health")
    assert res.status_code == 200
    assert res.json()["ok"] is True


def test_缺少或错误令牌返回401(client):
    http, _ = client
    assert http.get("/api/backup").status_code == 401
    res = http.get("/api/backup", headers={"Authorization": "Bearer wrong"})
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "unauthorized"


def test_上传与拉取往返(client):
    http, _ = client
    body = put_body()
    res = http.put("/api/backup", json=body, headers=auth())
    assert res.status_code == 200, res.text
    assert res.json()["data"]["deduped"] is False

    res = http.get("/api/backup", headers=auth())
    assert res.status_code == 200
    data = res.json()["data"]
    assert data["payload"]["tags"]["tags"][0]["label"] == "ok"
    assert data["payload"]["settings"]["ai"]["apiKey"] == "sk-ai"
    assert data["schema"] == 1

    meta = http.get("/api/backup/meta", headers=auth()).json()["data"]
    assert meta["history_count"] == 1
    assert meta["last_backup_at"]


def test_没有备份返回404(client):
    http, _ = client
    res = http.get("/api/backup", headers=auth())
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "not_found"


def test_schema错误与未知字段返回422(client):
    http, _ = client
    assert http.put("/api/backup", json={"schema": 9, "payload": {}}, headers=auth()).status_code == 422
    body = put_body()
    body["unexpected"] = 1
    assert http.put("/api/backup", json=body, headers=auth()).status_code == 422


def test_sha不一致返回422(client):
    http, _ = client
    body = put_body()
    body["sha256"] = "0" * 64
    res = http.put("/api/backup", json=body, headers=auth())
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "invalid_payload"


def test_相同内容去重(client):
    http, _ = client
    body = put_body()
    body["sha256"] = sha_of(payload())
    first = http.put("/api/backup", json=body, headers=auth()).json()["data"]
    second = http.put("/api/backup", json=body, headers=auth()).json()["data"]
    assert second["deduped"] is True
    assert second["id"] == first["id"]


def test_设备隔离且省略device取最新(client):
    http, _ = client
    http.put("/api/backup", json=put_body(device="pc-a", value=payload("A")), headers=auth())
    http.put("/api/backup", json=put_body(device="pc-b", value=payload("B")), headers=auth())

    a = http.get("/api/backup?device_id=pc-a", headers=auth()).json()["data"]
    b = http.get("/api/backup?device_id=pc-b", headers=auth()).json()["data"]
    assert a["payload"]["tags"]["tags"][0]["label"] == "A"
    assert b["payload"]["tags"]["tags"][0]["label"] == "B"

    latest = http.get("/api/backup", headers=auth()).json()["data"]
    assert latest["device_id"] == "pc-b"


def test_超过大小上限返回413():
    from fastapi.testclient import TestClient
    from conftest import base_settings
    from server.app.main import create_app
    from conftest import FakeRepo

    app = create_app(base_settings(max_payload_bytes=100), FakeRepo())
    http = TestClient(app)
    res = http.put("/api/backup", json=put_body(), headers=auth())
    assert res.status_code == 413
    assert res.json()["error"]["code"] == "payload_too_large"


def test_CORS预检允许扩展来源(client):
    http, _ = client
    res = http.options(
        "/api/backup",
        headers={
            "Origin": "chrome-extension://abcdef",
            "Access-Control-Request-Method": "PUT",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    assert res.status_code == 200
    assert res.headers.get("access-control-allow-origin") == "*"
