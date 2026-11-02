"""认证：账号会话令牌 + 旧版单令牌兼容。

优先级：
  1. Bearer 原文的 SHA-256 与 BACKUP_TOKEN_SHA256 相同 → 旧版令牌，映射 user_id=1；
  2. 否则按会话令牌查 sessions 表，返回账号 user_id。
"""

from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from fastapi import Header, HTTPException, Request


@dataclass
class AuthContext:
    user_id: int
    username: str
    kind: str                    # 'legacy' | 'session'
    session_id: int | None = None


def _bearer(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=401,
            detail="missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = authorization[len("Bearer "):].strip()
    if not token:
        raise HTTPException(status_code=401, detail="missing bearer token")
    return token


def _expired(value: Any) -> bool:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value <= datetime.now(timezone.utc)
    return True


def require_auth(
    request: Request,
    authorization: str | None = Header(default=None),
) -> AuthContext:
    settings = request.app.state.settings
    repo = request.app.state.repo
    token = _bearer(authorization)
    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()

    # 旧版单令牌：保留兼容，映射到 user_id=1（首次账号注册会接管这个用户）
    if settings.backup_token_sha256 and hmac.compare_digest(digest, settings.backup_token_sha256):
        user = repo.user_by_id(1) or {"id": 1, "username": "local"}
        return AuthContext(user_id=int(user["id"]), username=str(user["username"]), kind="legacy")

    session = repo.session_by_hash(digest)
    if not session:
        raise HTTPException(
            status_code=401,
            detail="invalid or expired session",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if _expired(session.get("expires_at")) or str(session.get("status") or "active") != "active":
        repo.delete_session(session["id"])
        raise HTTPException(
            status_code=401,
            detail="invalid or expired session",
            headers={"WWW-Authenticate": "Bearer"},
        )

    repo.touch_session(session["id"])
    return AuthContext(
        user_id=int(session["user_id"]),
        username=str(session["username"]),
        kind="session",
        session_id=int(session["id"]),
    )


# 兼容旧导入名；新代码请使用 require_auth
require_token = require_auth
