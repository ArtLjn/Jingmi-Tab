"""账号注册、登录、会话与按账号隔离。"""

from __future__ import annotations

import json
from unittest.mock import patch

import httpx
import pytest
from conftest import TOKEN, INVITE, FakeRepo, base_settings
from fastapi.testclient import TestClient

from server.app.main import create_app


class FakeAsyncClient:
    calls = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def request(self, method, url, content=None, headers=None):
        FakeAsyncClient.calls.append({"method": method, "url": url, "content": content, "headers": headers})
        return httpx.Response(200, json={"code": "OK", "data": {"ok": True}})


def payload(name="ok"):
    return {
        "schema": 1,
        "exportedAt": "2026-11-01T00:00:00Z",
        "settings": {"ai": {"apiKey": "sk-" + name}},
        "tags": {"version": 2, "tags": [{"label": name, "url": "https://a.com/"}]},
        "meta": {},
    }


def put_body(value):
    return {"device_id": "default", "schema": 1, "payload": value}


def register(http, username, password="pass12345", invite=INVITE, legacy=""):
    if isinstance(username, str) and "@" not in username and not legacy:
        username += "@example.com"
    return http.post("/api/auth/register", json={
        "username": username, "password": password, "invite_code": invite, "legacy_token": legacy
    })


def login(http, username, password="pass12345"):
    if "@" not in username:
        username += "@example.com"
    return http.post("/api/auth/login", json={"username": username, "password": password})


def auth(token):
    return {"Authorization": "Bearer " + token}


def test_注册需要有效邀请码(client):
    http, _ = client
    res = register(http, "alice", invite="wrong")
    assert res.status_code == 403
    assert res.json()["error"]["code"] == "invalid_invite"


def test_有效邀请码邮箱注册不继承旧备份(client):
    http, repo = client
    assert http.put("/api/backup", json=put_body(payload("legacy")), headers=auth(TOKEN)).status_code == 200
    res = http.post("/api/auth/register", json={"username": " Alice@Example.COM ", "password": "pass12345", "invite_code": INVITE})
    assert res.status_code == 200, res.text
    data = res.json()["data"]
    assert data["user"]["username"] == "alice@example.com"
    assert data["user"]["id"] != 1
    assert repo.users[1]["password_hash"] is None
    assert http.get("/api/backup", headers=auth(data["token"])).status_code == 404
    assert login(http, "ALICE@EXAMPLE.COM").status_code == 200
    assert register(http, "alice@example.com", invite=INVITE).status_code == 409


def test_邮箱注册不能跳过服务端邀请码(client):
    http = TestClient(create_app(base_settings(register_code="old-code"), FakeRepo()))
    assert register(http, "new@example.com", invite="").status_code == 403


@pytest.mark.parametrize("username,password", [
    ("not-an-email", "pass12345"), ("a@b", "pass12345"),
    ("a b@example.com", "pass12345"), ("a@@example.com", "pass12345"),
    ("a@example.com", "short"), ("a@example.com", "a" * 129),
    ("a" * 243 + "@example.com", "pass12345"), (None, "pass12345"),
])
def test_邮箱注册校验格式与密码(client, username, password):
    http, _ = client
    assert http.post("/api/auth/register", json={"username": username, "password": password, "invite_code": INVITE}).status_code == 422


def test_长邮箱可以注册登录且新账号相互隔离(client):
    http, _ = client
    email = "long.account.name.over.thirty.two.characters@example.com"
    a = register(http, email, invite=INVITE).json()["data"]
    b = register(http, "other@example.com", invite=INVITE).json()["data"]
    assert login(http, email).status_code == 200
    assert http.put("/api/backup", json=put_body(payload("A")), headers=auth(a["token"])).status_code == 200
    assert http.get("/api/backup", headers=auth(b["token"])).status_code == 404


def test_首次用旧令牌注册接管user1并继承已有备份(client):
    http, repo = client
    # 旧令牌先写入一条备份（user_id=1）
    assert http.put("/api/backup", json=put_body(payload("legacy")), headers=auth(TOKEN)).status_code == 200

    res = register(http, "alice", legacy=TOKEN)
    assert res.status_code == 200, res.text
    data = res.json()["data"]
    assert data["user"]["id"] == 1
    assert data["user"]["username"] == "alice"
    assert repo.users[1]["password_hash"]

    # 登录后的会话能看到旧备份
    got = http.get("/api/backup", headers=auth(data["token"]))
    assert got.status_code == 200
    assert got.json()["data"]["payload"]["tags"]["tags"][0]["label"] == "legacy"

    # 旧令牌仍然可用
    assert http.get("/api/backup", headers=auth(TOKEN)).status_code == 200


def test_注册重名返回409(client):
    http, _ = client
    assert register(http, "bob").status_code == 200
    assert register(http, "bob").status_code == 409


def test_登录_me_登出(client):
    http, _ = client
    token = register(http, "carol").json()["data"]["token"]

    me = http.get("/api/auth/me", headers=auth(token))
    assert me.status_code == 200
    assert me.json()["data"]["user"]["username"] == "carol@example.com"

    logged = login(http, "carol")
    assert logged.status_code == 200
    token2 = logged.json()["data"]["token"]
    assert token2 != token

    assert http.post("/api/auth/logout", headers=auth(token2)).status_code == 200
    assert http.get("/api/auth/me", headers=auth(token2)).status_code == 401

    # 另一个会话不受影响
    assert http.get("/api/auth/me", headers=auth(token)).status_code == 200


def test_错误密码与失败限速(client):
    http, _ = client
    register(http, "dave")
    for _ in range(5):
        assert login(http, "dave", "wrong-pass").status_code == 401
    res = login(http, "dave", "wrong-pass")
    assert res.status_code == 429
    assert res.json()["error"]["code"] == "rate_limited"


def test_按账号隔离备份(client):
    http, _ = client
    a = register(http, "user-a").json()["data"]
    b = register(http, "user-b").json()["data"]
    assert a["user"]["id"] != b["user"]["id"]

    assert http.put("/api/backup", json=put_body(payload("A")), headers=auth(a["token"])).status_code == 200
    assert http.put("/api/backup", json=put_body(payload("B")), headers=auth(b["token"])).status_code == 200

    a_got = http.get("/api/backup", headers=auth(a["token"])).json()["data"]
    b_got = http.get("/api/backup", headers=auth(b["token"])).json()["data"]
    assert a_got["payload"]["tags"]["tags"][0]["label"] == "A"
    assert b_got["payload"]["tags"]["tags"][0]["label"] == "B"


def test_注册邀请码模式(client):
    repo = FakeRepo()
    app = create_app(base_settings(register_code="invite-me"), repo)
    http = TestClient(app)
    assert register(http, "erin", invite="wrong").status_code == 403
    res = register(http, "erin", invite="invite-me")
    assert res.status_code == 200, res.text
    # 没有旧令牌接管，创建新用户
    assert res.json()["data"]["user"]["id"] != 1


def test_旧令牌可读取已接管账号的备份(client):
    http, _ = client
    assert http.put("/api/backup", json=put_body(payload("legacy2")), headers=auth(TOKEN)).status_code == 200
    token = register(http, "frank", legacy=TOKEN).json()["data"]["token"]
    session_got = http.get("/api/backup", headers=auth(token)).json()["data"]
    legacy_got = http.get("/api/backup", headers=auth(TOKEN)).json()["data"]
    assert session_got["payload"] == legacy_got["payload"]


def test_无令牌访问备份返回401(client):
    http, _ = client
    assert http.get("/api/backup").status_code == 401
    assert http.put("/api/backup", json=put_body(payload())).status_code == 401


def test_每个账号的RAG集合唯一且只读(client):
    http, _ = client
    a = register(http, "rag-a").json()["data"]
    b = register(http, "rag-b").json()["data"]
    ca = http.get("/api/rag/config", headers=auth(a["token"])).json()["data"]
    cb = http.get("/api/rag/config", headers=auth(b["token"])).json()["data"]
    assert ca["enabled"] is True
    assert ca["collection"].startswith("chrome_tab_")
    assert ca["collection"] != cb["collection"]

    # 配置接口只返回 collection，不返回 RAG Key/地址
    body = http.get("/api/rag/config", headers=auth(a["token"])).text
    assert "rag-key" not in body
    assert "rag.test" not in body


def test_RAG不限额仅由数据库配置且账号隔离(client):
    http, repo = client
    a = register(http, "unlimited-a").json()["data"]
    b = register(http, "unlimited-b").json()["data"]
    repo.users[a["user"]["id"]]["rag_unlimited"] = True
    assert http.get("/api/rag/config", headers=auth(a["token"])).json()["data"]["unlimited"] is True
    assert http.get("/api/rag/config", headers=auth(b["token"])).json()["data"]["unlimited"] is False


def test_RAG代理注入后台Key并强制账号集合(client):
    http, _ = client
    token = register(http, "rag-proxy").json()["data"]["token"]
    FakeAsyncClient.calls.clear()

    with patch("server.app.main.httpx.AsyncClient", FakeAsyncClient):
        res = http.post(
            "/api/rag/retrieve",
            json={"collection": "someone_else", "query": "应收凭证"},
            headers=auth(token),
        )
    assert res.status_code == 200
    call = FakeAsyncClient.calls[-1]
    assert call["url"] == "https://rag.test/retrieve"
    assert call["headers"]["Authorization"] == "Bearer rag-key"
    assert json.loads(call["content"].decode("utf-8"))["collection"] == "chrome_tab_test_2"


def test_RAG未配置时返回503():
    from conftest import base_settings
    from server.app.main import create_app

    http = TestClient(create_app(base_settings(rag_api_key=""), FakeRepo()))
    token = register(http, "rag-off").json()["data"]["token"]
    res = http.post("/api/rag/retrieve", json={"query": "x"}, headers=auth(token))
    assert res.status_code == 503
    assert res.json()["error"]["code"] == "rag_disabled"


@pytest.mark.parametrize("code", [None, "", "   ", "wrong", TOKEN])
def test_直接调用注册接口也不能绕过邀请码(client, code):
    http, repo = client
    body = {"username": "blocked@example.com", "password": "pass12345", "legacy_token": TOKEN}
    if code is not None:
        body["invite_code"] = code
    response = http.post('/api/auth/register', json=body)
    assert response.status_code == 403
    assert len(repo.users) == 1
    assert repo.sessions == {}
    assert repo.users[1]['password_hash'] is None


def test_未配置邀请码关闭注册但已有账号仍能登录():
    repo = FakeRepo()
    enabled = TestClient(create_app(base_settings(), repo))
    assert register(enabled, 'existing@example.com').status_code == 200
    closed = TestClient(create_app(base_settings(register_code=''), repo))
    response = register(closed, 'new@example.com')
    assert response.status_code == 403
    assert response.json()['error']['code'] == 'registration_closed'
    assert login(closed, 'existing@example.com').status_code == 200


def test_注册限频不信任调用方伪造的转发头(client):
    http, repo = client
    for i in range(5):
        response = http.post('/api/auth/register', json={"username": f"try{i}@example.com", "password": "pass12345", "invite_code": "wrong"}, headers={'x-forwarded-for': f'192.0.2.{i}'})
        assert response.status_code == 403
    response = register(http, 'blocked@example.com')
    assert response.status_code == 429
    assert response.json()['error']['code'] == 'registration_rate_limited'
    assert len(repo.users) == 1


def test_旧迁移令牌与邀请注册分离且不能重复接管(client):
    http, repo = client
    first = register(http, 'first', legacy=TOKEN)
    assert first.status_code == 200
    original = repo.users[1]['password_hash']
    assert register(http, 'second', legacy=TOKEN).status_code == 409
    assert repo.users[1]['password_hash'] == original
    assert register(http, 'normal@example.com').json()['data']['user']['id'] != 1
