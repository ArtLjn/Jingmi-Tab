"""账号、会话与备份仓库。

备份按 user_id 隔离；旧版单令牌固定映射 DEFAULT_USER_ID=1，
首次账号注册会接管这个用户，从而继承已有的单令牌备份。
"""

from __future__ import annotations

import json
import secrets
from datetime import datetime, timezone
from typing import Any

from .config import Settings
from .db import ping, transaction

DEFAULT_USER_ID = 1


def new_rag_collection() -> str:
    """每个账号一个不可编辑的 RAG 集合名，满足 chrome_tab_ 前缀。"""
    return "chrome_tab_" + secrets.token_hex(6)


def _iso(value: Any) -> str:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat().replace("+00:00", "Z")
    return str(value)


class BackupRepository:
    def __init__(self, settings: Settings):
        self.settings = settings

    def ping(self) -> bool:
        return ping(self.settings)

    # ------------------------- 账号 -------------------------

    def user_by_id(self, user_id: int) -> dict[str, Any] | None:
        with transaction(self.settings) as cursor:
            cursor.execute(
                "SELECT id, username, password_hash, status, rag_collection, created_at "
                "FROM users WHERE id=%s",
                (user_id,),
            )
            return cursor.fetchone()

    def user_by_username(self, username: str) -> dict[str, Any] | None:
        with transaction(self.settings) as cursor:
            cursor.execute(
                "SELECT id, username, password_hash, status, rag_collection, created_at "
                "FROM users WHERE username=%s",
                (username,),
            )
            return cursor.fetchone()

    def count_password_users(self) -> int:
        with transaction(self.settings) as cursor:
            cursor.execute("SELECT COUNT(*) AS total FROM users WHERE password_hash IS NOT NULL")
            row = cursor.fetchone() or {}
            return int(row.get("total") or 0)

    def create_user(self, username: str, password_hash: str) -> dict[str, Any]:
        collection = new_rag_collection()
        with transaction(self.settings) as cursor:
            now = datetime.now(timezone.utc)
            cursor.execute(
                "INSERT INTO users (username, password_hash, status, rag_collection, created_at, updated_at) "
                "VALUES (%s, %s, 'active', %s, %s, %s)",
                (username, password_hash, collection, now, now),
            )
            return {"id": int(cursor.lastrowid), "username": username, "rag_collection": collection}

    def claim_user(self, user_id: int, username: str, password_hash: str) -> dict[str, Any] | None:
        """把还没有密码的旧用户（默认 id=1）改造成账号，继承其已有备份。"""
        collection = new_rag_collection()
        with transaction(self.settings) as cursor:
            now = datetime.now(timezone.utc)
            cursor.execute(
                "UPDATE users SET username=%s, password_hash=%s, "
                "rag_collection=COALESCE(rag_collection, %s), updated_at=%s "
                "WHERE id=%s AND password_hash IS NULL",
                (username, password_hash, collection, now, user_id),
            )
            if cursor.rowcount != 1:
                return None
            cursor.execute("SELECT rag_collection FROM users WHERE id=%s", (user_id,))
            row = cursor.fetchone() or {}
            return {"id": user_id, "username": username, "rag_collection": row.get("rag_collection")}

    def rag_unlimited(self, user_id: int) -> bool:
        """仅由数据库运维设置的账号采集额度豁免。"""
        with transaction(self.settings) as cursor:
            cursor.execute("SELECT rag_unlimited FROM users WHERE id=%s", (user_id,))
            row = cursor.fetchone()
            return bool(row and row["rag_unlimited"])

    def rag_collection(self, user_id: int) -> str:
        """读取账号的 RAG 集合；旧账号没有时生成一次并固定。"""
        with transaction(self.settings) as cursor:
            cursor.execute("SELECT rag_collection FROM users WHERE id=%s", (user_id,))
            row = cursor.fetchone()
            if not row:
                raise ValueError("user not found")
            if row.get("rag_collection"):
                return str(row["rag_collection"])
            collection = new_rag_collection()
            cursor.execute(
                "UPDATE users SET rag_collection=%s WHERE id=%s AND rag_collection IS NULL",
                (collection, user_id),
            )
            cursor.execute("SELECT rag_collection FROM users WHERE id=%s", (user_id,))
            row = cursor.fetchone() or {}
            return str(row.get("rag_collection") or collection)

    # ------------------------- 会话 -------------------------

    def create_session(self, user_id: int, token_hash: str, expires_at: datetime) -> dict[str, Any]:
        with transaction(self.settings) as cursor:
            now = datetime.now(timezone.utc)
            cursor.execute("DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP(3)")
            cursor.execute(
                "INSERT INTO sessions (user_id, token_hash, created_at, last_used_at, expires_at) "
                "VALUES (%s, %s, %s, %s, %s)",
                (user_id, token_hash, now, now, expires_at),
            )
            return {
                "id": int(cursor.lastrowid),
                "user_id": user_id,
                "expires_at": _iso(expires_at),
            }

    def session_by_hash(self, token_hash: str) -> dict[str, Any] | None:
        with transaction(self.settings) as cursor:
            cursor.execute(
                "SELECT s.id, s.user_id, s.expires_at, u.username, u.status "
                "FROM sessions s JOIN users u ON u.id = s.user_id "
                "WHERE s.token_hash=%s",
                (token_hash,),
            )
            return cursor.fetchone()

    def touch_session(self, session_id: int) -> None:
        with transaction(self.settings) as cursor:
            cursor.execute(
                "UPDATE sessions SET last_used_at=UTC_TIMESTAMP(3) "
                "WHERE id=%s AND (last_used_at IS NULL OR last_used_at < UTC_TIMESTAMP(3) - INTERVAL 5 MINUTE)",
                (session_id,),
            )

    def delete_session(self, session_id: int) -> None:
        with transaction(self.settings) as cursor:
            cursor.execute("DELETE FROM sessions WHERE id=%s", (session_id,))

    # ------------------------- 备份 -------------------------

    def latest(self, user_id: int = DEFAULT_USER_ID, device_id: str | None = None) -> dict[str, Any] | None:
        sql = (
            "SELECT id, user_id, device_id, schema_version, client_version, payload, "
            "size_bytes, sha256, created_at FROM backups WHERE user_id=%s"
        )
        params: list[Any] = [user_id]
        if device_id:
            sql += " AND device_id=%s"
            params.append(device_id)
        sql += " ORDER BY id DESC LIMIT 1"

        with transaction(self.settings) as cursor:
            cursor.execute(sql, params)
            row = cursor.fetchone()

        if not row:
            return None
        row["created_at"] = _iso(row["created_at"])
        row["payload"] = json.loads(row["payload"])
        return row

    def latest_meta(self, user_id: int = DEFAULT_USER_ID, device_id: str | None = None) -> dict[str, Any] | None:
        latest = self.latest(user_id, device_id)
        if not latest:
            return None

        sql = "SELECT COUNT(*) AS total FROM backups WHERE user_id=%s"
        params: list[Any] = [user_id]
        if device_id:
            sql += " AND device_id=%s"
            params.append(device_id)
        with transaction(self.settings) as cursor:
            cursor.execute(sql, params)
            row = cursor.fetchone() or {}

        return {
            "last_backup_at": latest["created_at"],
            "size_bytes": latest["size_bytes"],
            "sha256": latest["sha256"],
            "schema": latest["schema_version"],
            "device_id": latest["device_id"],
            "history_count": int(row.get("total") or 0),
        }

    def insert(
        self,
        device_id: str,
        schema_version: int,
        client_version: str | None,
        payload: dict[str, Any],
        payload_json: str,
        size_bytes: int,
        sha256: str,
        user_id: int = DEFAULT_USER_ID,
    ) -> dict[str, Any]:
        with transaction(self.settings) as cursor:
            cursor.execute(
                "SELECT id, sha256 FROM backups WHERE user_id=%s AND device_id=%s "
                "ORDER BY id DESC LIMIT 1",
                (user_id, device_id),
            )
            last = cursor.fetchone()
            if last and last["sha256"] == sha256:
                return {
                    "id": last["id"],
                    "device_id": device_id,
                    "created_at": None,
                    "size_bytes": size_bytes,
                    "sha256": sha256,
                    "deduped": True,
                }

            created_at = datetime.now(timezone.utc)
            cursor.execute(
                "INSERT INTO backups "
                "(user_id, device_id, schema_version, client_version, payload, size_bytes, sha256, created_at) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    user_id,
                    device_id,
                    schema_version,
                    client_version,
                    payload_json,
                    size_bytes,
                    sha256,
                    created_at,
                ),
            )
            new_id = cursor.lastrowid
            self._prune(cursor, user_id, device_id)

        return {
            "id": new_id,
            "device_id": device_id,
            "created_at": _iso(created_at),
            "size_bytes": size_bytes,
            "sha256": sha256,
            "deduped": False,
        }

    def _prune(self, cursor, user_id: int, device_id: str) -> None:
        keep = max(1, int(self.settings.retention_versions))
        cursor.execute(
            "DELETE FROM backups "
            "WHERE user_id=%s AND device_id=%s AND id NOT IN ("
            "  SELECT id FROM ("
            "    SELECT id FROM backups WHERE user_id=%s AND device_id=%s "
            "    ORDER BY id DESC LIMIT %s"
            "  ) AS keep_rows"
            ")",
            (user_id, device_id, user_id, device_id, keep),
        )

    def reserve_rag_write(self, user_id: int, page_key: str, payload_hash: str, requested_id: str) -> dict:
        """在同一事务中锁定页面和日额度；未知结果不允许自动接管。"""
        with transaction(self.settings) as cursor:
            cursor.execute(
                "INSERT IGNORE INTO rag_writes (user_id,page_key,updated_at) VALUES (%s,%s,UTC_TIMESTAMP(3))",
                (user_id, page_key),
            )
            cursor.execute("SELECT * FROM rag_writes WHERE user_id=%s AND page_key=%s FOR UPDATE", (user_id, page_key))
            row = cursor.fetchone()
            doc_id = row["doc_id"] or requested_id
            if row["state"] == "succeeded" and row["payload_hash"] == payload_hash:
                return {"action": "skip", "doc_id": doc_id}
            if row["state"] in ("pending", "uncertain"):
                return {"action": "blocked", "doc_id": doc_id}
            cursor.execute("INSERT IGNORE INTO rag_daily (user_id,usage_day) VALUES (%s,UTC_DATE())", (user_id,))
            cursor.execute("SELECT writes FROM rag_daily WHERE user_id=%s AND usage_day=UTC_DATE() FOR UPDATE", (user_id,))
            used = cursor.fetchone()["writes"]
            cursor.execute("SELECT rag_unlimited FROM users WHERE id=%s", (user_id,))
            user = cursor.fetchone()
            if used >= 500 and not (user and user["rag_unlimited"]):
                return {"action": "limited", "doc_id": doc_id}
            cursor.execute("UPDATE rag_daily SET writes=writes+1 WHERE user_id=%s AND usage_day=UTC_DATE()", (user_id,))
            cursor.execute(
                "UPDATE rag_writes SET payload_hash=%s,doc_id=%s,state='pending',updated_at=UTC_TIMESTAMP(3) "
                "WHERE user_id=%s AND page_key=%s", (payload_hash, doc_id, user_id, page_key),
            )
            return {"action": "write", "doc_id": doc_id, "replace": True}

    def finish_rag_write(self, user_id: int, page_key: str, payload_hash: str, succeeded: bool) -> None:
        with transaction(self.settings) as cursor:
            cursor.execute(
                "UPDATE rag_writes SET state=%s,updated_at=UTC_TIMESTAMP(3) "
                "WHERE user_id=%s AND page_key=%s AND payload_hash=%s AND state='pending'",
                ("succeeded" if succeeded else "uncertain", user_id, page_key, payload_hash),
            )

    def reserve_rag_delete(self, user_id: int, doc_id: str) -> bool:
        with transaction(self.settings) as cursor:
            cursor.execute("SELECT state FROM rag_writes WHERE user_id=%s AND doc_id=%s FOR UPDATE", (user_id, doc_id))
            row = cursor.fetchone()
            if row and row["state"] in ("pending", "uncertain"):
                return False
            cursor.execute("UPDATE rag_writes SET state='pending',updated_at=UTC_TIMESTAMP(3) WHERE user_id=%s AND doc_id=%s", (user_id, doc_id))
            return True

    def finish_rag_delete(self, user_id: int, doc_id: str, succeeded: bool) -> None:
        with transaction(self.settings) as cursor:
            cursor.execute("UPDATE rag_writes SET state=%s,updated_at=UTC_TIMESTAMP(3) WHERE user_id=%s AND doc_id=%s AND state='pending'", ("new" if succeeded else "uncertain", user_id, doc_id))
