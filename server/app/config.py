"""备份服务的环境配置。

所有敏感信息只从环境变量读取，不写入仓库。应用账号使用最小权限，
root 只用于 scripts/init_db.py 的一次性建库。
"""

from __future__ import annotations

import os
from dataclasses import dataclass


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    db_host: str
    db_port: int
    db_user: str
    db_password: str
    db_name: str
    backup_token_sha256: str
    register_code: str
    session_days: int
    rag_base_url: str
    rag_api_key: str
    rag_enabled: bool
    cors_origins: str
    max_payload_bytes: int
    retention_versions: int

    @property
    def cors_origin_list(self) -> list[str]:
        raw = (self.cors_origins or "*").strip()
        if raw == "*":
            return ["*"]
        return [item.strip() for item in raw.split(",") if item.strip()]


def load_settings() -> Settings:
    return Settings(
        db_host=os.environ.get("DB_HOST", "127.0.0.1"),
        db_port=_int("DB_PORT", 3306),
        db_user=os.environ.get("DB_USER", "jingmi_app"),
        db_password=os.environ.get("DB_PASSWORD", ""),
        db_name=os.environ.get("DB_NAME", "jingmi_newtab"),
        backup_token_sha256=os.environ.get("BACKUP_TOKEN_SHA256", "").lower(),
        register_code=os.environ.get("REGISTER_CODE", ""),
        session_days=_int("SESSION_DAYS", 90),
        rag_base_url=os.environ.get("RAG_BASE_URL", "https://rag.lllcnm.cn").rstrip("/"),
        rag_api_key=os.environ.get("RAG_API_KEY", ""),
        rag_enabled=os.environ.get("RAG_ENABLED", "1") not in ("0", "false", "False"),
        cors_origins=os.environ.get("CORS_ORIGINS", "*"),
        max_payload_bytes=_int("MAX_PAYLOAD_BYTES", 2 * 1024 * 1024),
        retention_versions=_int("RETENTION_VERSIONS", 10),
    )
