"""服务端测试：不依赖真实 MySQL，用内存 fake repository。"""

from __future__ import annotations

import hashlib
import sys
from dataclasses import replace
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from server.app.config import Settings  # noqa: E402
from server.app.main import create_app  # noqa: E402

TOKEN = "test-token"
TOKEN_SHA = hashlib.sha256(TOKEN.encode()).hexdigest()


class FakeRepo:
    def __init__(self):
        self.users = {
            1: {"id": 1, "username": "local", "password_hash": None, "status": "active",
                "rag_collection": "chrome_tab_legacy"},
        }
        self.sessions: dict[str, dict] = {}
        self.rows: dict[tuple[int, str], list[dict]] = {}
        self._next_user = 2
        self._next_session = 1

    def ping(self) -> bool:
        return True

    # ---- 账号 ----
    def user_by_id(self, user_id):
        return self.users.get(int(user_id))

    def user_by_username(self, username):
        for user in self.users.values():
            if user["username"] == username:
                return user
        return None

    def count_password_users(self):
        return sum(1 for u in self.users.values() if u.get("password_hash"))

    def create_user(self, username, password_hash):
        user = {"id": self._next_user, "username": username, "password_hash": password_hash,
                "status": "active", "rag_collection": "chrome_tab_test_" + str(self._next_user)}
        self.users[self._next_user] = user
        self._next_user += 1
        return user

    def claim_user(self, user_id, username, password_hash):
        user = self.users.get(user_id)
        if not user or user.get("password_hash"):
            return None
        user["username"] = username
        user["password_hash"] = password_hash
        user.setdefault("rag_collection", "chrome_tab_legacy")
        return user

    def rag_collection(self, user_id):
        user = self.users.get(int(user_id))
        if not user:
            raise ValueError("user not found")
        if not user.get("rag_collection"):
            user["rag_collection"] = "chrome_tab_test_" + str(user_id)
        return user["rag_collection"]

    # ---- 会话 ----
    def create_session(self, user_id, token_hash, expires_at):
        row = {
            "id": self._next_session,
            "user_id": user_id,
            "token_hash": token_hash,
            "expires_at": expires_at,
        }
        self.sessions[token_hash] = row
        self._next_session += 1
        return row

    def session_by_hash(self, token_hash):
        row = self.sessions.get(token_hash)
        if not row:
            return None
        user = self.users.get(row["user_id"]) or {}
        return {
            "id": row["id"],
            "user_id": row["user_id"],
            "expires_at": row["expires_at"],
            "username": user.get("username", ""),
            "status": user.get("status", "active"),
        }

    def touch_session(self, session_id):
        return None

    def delete_session(self, session_id):
        for key, row in list(self.sessions.items()):
            if row["id"] == session_id:
                del self.sessions[key]

    # ---- 备份 ----
    def latest(self, user_id=1, device_id=None):
        rows = []
        for (uid, dev), items in self.rows.items():
            if uid != user_id:
                continue
            if device_id and dev != device_id:
                continue
            rows.extend(items)
        if not rows:
            return None
        return max(rows, key=lambda row: row["id"])

    def latest_meta(self, user_id=1, device_id=None):
        latest = self.latest(user_id, device_id)
        if not latest:
            return None
        count = sum(
            1
            for (uid, dev), items in self.rows.items()
            if uid == user_id and (not device_id or dev == device_id)
            for _ in items
        )
        return {
            "last_backup_at": latest["created_at"],
            "size_bytes": latest["size_bytes"],
            "sha256": latest["sha256"],
            "schema": latest["schema_version"],
            "device_id": latest["device_id"],
            "history_count": count,
        }

    def insert(self, device_id, schema_version, client_version, payload, payload_json, size_bytes, sha256, user_id=1):
        items = self.rows.setdefault((user_id, device_id), [])
        if items and items[-1]["sha256"] == sha256:
            last = dict(items[-1])
            last["deduped"] = True
            return last
        row = {
            "id": 1 + sum(len(v) for v in self.rows.values()),
            "device_id": device_id,
            "schema_version": schema_version,
            "client_version": client_version,
            "payload": payload,
            "size_bytes": size_bytes,
            "sha256": sha256,
            "created_at": "2026-11-01T08:00:00Z",
            "deduped": False,
        }
        items.append(row)
        del items[:-10]
        return row


def base_settings(**overrides):
    settings = Settings(
        db_host="127.0.0.1",
        db_port=3306,
        db_user="jingmi_app",
        db_password="x",
        db_name="jingmi_newtab",
        backup_token_sha256=TOKEN_SHA,
        register_code="",
        session_days=90,
        rag_base_url="https://rag.test",
        rag_api_key="rag-key",
        rag_enabled=True,
        cors_origins="*",
        max_payload_bytes=2 * 1024 * 1024,
        retention_versions=10,
    )
    return replace(settings, **overrides) if overrides else settings


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient

    repo = FakeRepo()
    app = create_app(base_settings(), repo)
    return TestClient(app), repo
