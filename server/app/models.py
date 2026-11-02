"""请求/响应模型。"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


def normalize_account(value: str) -> str:
    """邮箱账号统一大小写；保留旧用户名的登录方式。"""
    if not isinstance(value, str):
        return value
    value = value.strip()
    return value.lower() if "@" in value else value


class BackupPut(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    device_id: str = Field(default="default", pattern=r"^[A-Za-z0-9._-]{1,64}$")
    schema_version: int = Field(ge=1, le=1, alias="schema")
    client_version: str | None = Field(default=None, max_length=32)
    created_at: str | None = Field(default=None, max_length=40)
    sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    payload: dict[str, Any]


class RegisterIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=8, max_length=128)
    invite_code: str = Field(default="", max_length=128)

    _normalize_username = field_validator("username", mode="before")(normalize_account)


class LoginIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str = Field(min_length=1, max_length=254)
    password: str = Field(min_length=1, max_length=128)

    _normalize_username = field_validator("username", mode="before")(normalize_account)
