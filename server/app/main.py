"""静谧新标签页备份服务（FastAPI + PyMySQL）。

认证：账号登录返回会话令牌；Authorization: Bearer <token>。
旧版单令牌仍兼容，映射到 user_id=1；首次用旧令牌注册会把该用户升级为账号，
从而继承已有的单令牌备份。
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
from threading import Lock
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import pymysql
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from .auth import AuthContext, require_auth
from .rag_gate import describe
from .config import Settings, load_settings
from .models import BackupPut, LoginIn, RegisterIn
from .repository import DEFAULT_USER_ID, BackupRepository
from .security import hash_password, hash_token, new_session_token, verify_password

logger = logging.getLogger("jingmi.backup")
logging.basicConfig(level=logging.INFO)

DEVICE_PATTERN = r"^[A-Za-z0-9._-]{1,64}$"

# 单进程内的登录失败限速；workers>1 时每个进程独立计数，个人部署足够。
LOGIN_FAILS: dict[tuple[str, str], list[datetime]] = {}
LOGIN_WINDOW = timedelta(minutes=10)
LOGIN_MAX_FAILS = 5


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"ok": False, "error": {"code": code, "message": message}})


def _canonical_json(value: Any) -> str:
    """与扩展端 canonicalJson 对齐：key 排序、无空格、UTF-8 原样输出。"""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _iso(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat().replace("+00:00", "Z")


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else ""


def _too_many_fails(key: tuple[str, str]) -> bool:
    now = datetime.now(timezone.utc)
    recent = [t for t in LOGIN_FAILS.get(key, []) if now - t < LOGIN_WINDOW]
    LOGIN_FAILS[key] = recent
    return len(recent) >= LOGIN_MAX_FAILS


def _record_fail(key: tuple[str, str]) -> None:
    LOGIN_FAILS.setdefault(key, []).append(datetime.now(timezone.utc))


def create_app(settings: Settings | None = None, repository: BackupRepository | None = None) -> FastAPI:
    settings = settings or load_settings()
    repo = repository or BackupRepository(settings)

    app = FastAPI(title="jingmi-newtab-backup", version="1.1.0")
    app.state.settings = settings
    app.state.repo = repo
    register_attempts: dict[str, list[datetime]] = {}
    register_lock = Lock()

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException) -> JSONResponse:
        code = {
            401: "unauthorized",
            403: "forbidden",
            404: "not_found",
            409: "conflict",
            413: "payload_too_large",
            422: "invalid_payload",
            429: "rate_limited",
            500: "server_error",
            502: "rag_unreachable",
            503: "rag_disabled",
        }.get(exc.status_code, "error")
        return _error(exc.status_code, code, str(exc.detail))

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        return _error(422, "invalid_payload", "请求格式不正确")

    @app.middleware("http")
    async def limit_body(request: Request, call_next):
        length = request.headers.get("content-length")
        if length:
            try:
                if int(length) > settings.max_payload_bytes + 1024 * 1024:
                    return _error(413, "payload_too_large", "请求体超过上限")
            except ValueError:
                return _error(400, "invalid_payload", "Content-Length 不合法")
        return await call_next(request)

    def issue_session(user: dict[str, Any]) -> dict[str, Any]:
        token = new_session_token()
        expires = datetime.now(timezone.utc) + timedelta(days=max(1, settings.session_days))
        repo.create_session(int(user["id"]), hash_token(token), expires)
        return {
            "ok": True,
            "data": {
                "token": token,
                "expires_at": _iso(expires),
                "user": {"id": int(user["id"]), "username": str(user["username"])},
            },
        }

    # ------------------------- 健康检查 -------------------------

    @app.get("/health")
    def health(deep: int = 0) -> dict[str, Any]:
        result: dict[str, Any] = {"ok": True, "service": "jingmi-newtab-backup", "version": "1.1.0"}
        if deep:
            result["db"] = "up" if repo.ping() else "down"
        return result

    # ------------------------- 账号 -------------------------

    @app.post("/api/auth/register")
    def register(body: RegisterIn, request: Request) -> Any:
        # 只使用 ASGI 已确认的来源地址，不直接信任调用方伪造的转发头。
        ip = request.client.host if request.client else "unknown"
        now = datetime.now(timezone.utc)
        with register_lock:
            for old_ip in list(register_attempts):
                register_attempts[old_ip] = [t for t in register_attempts[old_ip] if now - t < LOGIN_WINDOW]
                if not register_attempts[old_ip]:
                    del register_attempts[old_ip]
            recent = register_attempts.setdefault(ip, [])
            if len(recent) >= LOGIN_MAX_FAILS:
                return _error(429, "registration_rate_limited", "注册尝试过于频繁，请 10 分钟后再试")
            recent.append(now)
        configured = settings.register_code.strip()
        if not configured:
            return _error(403, "registration_closed", "暂未开放邀请注册，请联系维护者")
        code = body.invite_code.strip()
        if not code:
            return _error(403, "invite_required", "注册需要邀请码，请联系维护者获取")
        if not hmac.compare_digest(hash_token(code), hash_token(configured)):
            return _error(403, "invalid_invite", "邀请码无效，请联系维护者确认")

        username = body.username.strip()
        legacy_code = body.legacy_token.strip()
        legacy_ok = bool(legacy_code and settings.backup_token_sha256) and hmac.compare_digest(
            hash_token(legacy_code), settings.backup_token_sha256
        )
        if legacy_code and not legacy_ok:
            raise HTTPException(status_code=403, detail="旧数据迁移凭据无效")
        if not legacy_code and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", username):
            raise HTTPException(status_code=422, detail="请输入有效的邮箱地址")
        if legacy_code and not re.fullmatch(r"[A-Za-z0-9_.@+\-]+", username):
            raise HTTPException(status_code=422, detail="账号格式不正确")
        if repo.user_by_username(username):
            raise HTTPException(status_code=409, detail="该账号已注册，请直接登录")

        password_hash = hash_password(body.password)
        if legacy_ok:
            # 迁移凭据与邀请码分开；迁移只能接管一次，不能变成通用注册口令。
            legacy = repo.user_by_id(DEFAULT_USER_ID)
            if not legacy or legacy.get("password_hash"):
                raise HTTPException(status_code=409, detail="旧账号已迁移，请直接登录")
            user = repo.claim_user(DEFAULT_USER_ID, username, password_hash)
            if not user:
                raise HTTPException(status_code=409, detail="旧账号已迁移，请直接登录")
        else:
            try:
                user = repo.create_user(username, password_hash)
            except pymysql.err.IntegrityError:
                raise HTTPException(status_code=409, detail="该账号已注册，请直接登录")
        return issue_session(user)

    @app.post("/api/auth/login")
    def login(body: LoginIn, request: Request) -> Any:
        username = body.username.strip()
        key = (username, _client_ip(request))
        if _too_many_fails(key):
            return _error(429, "rate_limited", "登录失败次数过多，请稍后再试")

        user = repo.user_by_username(username)
        if (
            not user
            or str(user.get("status") or "active") != "active"
            or not verify_password(body.password, user.get("password_hash"))
        ):
            _record_fail(key)
            return _error(401, "invalid_credentials", "账号或密码错误")

        LOGIN_FAILS.pop(key, None)
        return issue_session(user)

    @app.get("/api/auth/me")
    def me(auth: AuthContext = Depends(require_auth)) -> dict[str, Any]:
        return {
            "ok": True,
            "data": {
                "user": {"id": auth.user_id, "username": auth.username},
                "kind": auth.kind,
            },
        }

    @app.post("/api/auth/logout")
    def logout(auth: AuthContext = Depends(require_auth)) -> dict[str, Any]:
        if auth.kind == "session" and auth.session_id:
            repo.delete_session(auth.session_id)
        return {"ok": True, "data": {"loggedOut": True}}

    # ------------------------- RAG 代理 -------------------------

    def rag_ready() -> bool:
        return bool(settings.rag_enabled and settings.rag_base_url and settings.rag_api_key)

    @app.get("/api/rag/config")
    def rag_config(auth: AuthContext = Depends(require_auth)) -> dict[str, Any]:
        if auth.kind != "session":
            raise HTTPException(status_code=403, detail="请先登录账号")
        try:
            collection = repo.rag_collection(auth.user_id)
            unlimited = repo.rag_unlimited(auth.user_id)
        except Exception:
            logger.exception("读取 RAG 集合失败")
            raise HTTPException(status_code=500, detail="读取 RAG 集合失败")
        return {"ok": True, "data": {"enabled": rag_ready(), "collection": collection, "unlimited": unlimited}}

    @app.api_route(
        "/api/rag/{path:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    )
    async def rag_proxy(path: str, request: Request, auth: AuthContext = Depends(require_auth)) -> Response:
        if auth.kind != "session":
            raise HTTPException(status_code=403, detail="请先登录账号")
        if not rag_ready():
            raise HTTPException(status_code=503, detail="RAG 尚未在后台配置")
        if ".." in path.split("/"):
            raise HTTPException(status_code=400, detail="非法路径")

        try:
            collection = repo.rag_collection(auth.user_id)
        except Exception:
            logger.exception("读取 RAG 集合失败")
            raise HTTPException(status_code=500, detail="读取 RAG 集合失败")

        if request.method in ("PUT", "PATCH") or request.method == "POST" and path not in ("ingest", "retrieve", "collections"):
            raise HTTPException(status_code=403, detail="不支持的 RAG 写入入口")
        parts = path.split("/")
        if request.method == "DELETE" and not (len(parts) == 4 and parts[0] == "collections" and parts[2] == "documents"):
            raise HTTPException(status_code=403, detail="仅允许删除单篇文档")
        if len(parts) >= 2 and parts[0] == "collections":
            parts[1] = collection
            path = "/".join(parts)

        body = await request.body()
        content_type = request.headers.get("content-type", "")
        if body and "application/json" in content_type and path in ("retrieve", "collections"):
            try:
                payload = json.loads(body)
            except json.JSONDecodeError:
                raise HTTPException(status_code=422, detail="RAG 请求体不是有效 JSON")
            if path == "retrieve":
                payload["collection"] = collection
            else:
                payload["name"] = collection
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        reservation = None
        page_key = payload_hash = ""
        if path == "ingest":
            if request.method != "POST" or "multipart/form-data" not in content_type:
                raise HTTPException(status_code=422, detail="RAG 写入只接受表单 POST")
            if len(body) > 3_000_000:
                raise HTTPException(status_code=413, detail="RAG 写入过大")
            form = await request.form()
            if any(not isinstance(value, str) for _, value in form.multi_items()):
                raise HTTPException(status_code=422, detail="RAG 仅接受文本字段")
            page_key, payload_hash, metadata = describe(form)
            requested_id = str(form.get("doc_id", ""))
            if not re.fullmatch(r"[a-zA-Z0-9_-]{1,160}", requested_id):
                raise HTTPException(status_code=422, detail="无效文档 ID")
            reservation = repo.reserve_rag_write(auth.user_id, page_key, payload_hash, requested_id)
            if reservation["action"] == "skip":
                return JSONResponse({"code": "OK", "data": {"doc_id": reservation["doc_id"], "unchanged": True}})
            if reservation["action"] == "limited":
                raise HTTPException(status_code=429, detail="今日 RAG 写入额度已用完")
            if reservation["action"] == "blocked":
                raise HTTPException(status_code=409, detail="上次入库结果待核验，已停止重复写入")
            # 重建白名单表单，不透传文件或调用方指定的账号集合。
            fields = {key: str(form[key]) for key in ("text", "file_type", "source", "category", "chunk_size", "chunk_overlap", "metadata_json") if key in form}
            fields.update(collection=collection, doc_id=reservation["doc_id"], file_type="txt", source=metadata["canonical_url"], chunk_size="1000", chunk_overlap="160")
            body = fields

        deleting = request.method == "DELETE"
        if deleting and not repo.reserve_rag_delete(auth.user_id, parts[3]):
            raise HTTPException(status_code=409, detail="文档写入待核验，暂不执行删除")
        target = settings.rag_base_url.rstrip("/") + "/" + path
        if request.url.query:
            target += "?" + request.url.query
        headers = {
            "Authorization": "Bearer " + settings.rag_api_key,
            "Content-Type": content_type or "application/json",
            "Accept": request.headers.get("accept", "application/json"),
        }

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                if reservation:
                    if reservation.get("replace"):
                        removed = await client.request("DELETE", settings.rag_base_url.rstrip("/") + "/collections/" + collection + "/documents/" + reservation["doc_id"], headers={"Authorization": headers["Authorization"]})
                        if removed.status_code != 404:
                            removed.raise_for_status()
                            if removed.json().get("code") != "OK":
                                raise httpx.HTTPError("旧版本删除未确认")
                    headers.pop("Content-Type", None)
                    upstream = await client.request("POST", target, files={k: (None, v) for k, v in body.items()}, headers=headers)
                    succeeded = upstream.status_code < 300 and upstream.json().get("code") == "OK" and not upstream.json().get("error_code")
                    repo.finish_rag_write(auth.user_id, page_key, payload_hash, succeeded)
                    if succeeded:
                        data = upstream.json()
                        data.setdefault("data", {})["doc_id"] = reservation["doc_id"]
                        return JSONResponse(data)
                else:
                    upstream = await client.request(request.method, target, content=body, headers=headers)
        except (httpx.HTTPError, ValueError):
            if reservation:
                repo.finish_rag_write(auth.user_id, page_key, payload_hash, False)
            if deleting:
                repo.finish_rag_delete(auth.user_id, parts[3], False)
            logger.exception("RAG 上游不可达")
            raise HTTPException(status_code=502, detail="RAG 服务不可达")

        if deleting:
            confirmed = upstream.status_code == 404 or upstream.status_code < 300 and upstream.json().get("code") == "OK"
            repo.finish_rag_delete(auth.user_id, parts[3], confirmed)
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            headers={"content-type": upstream.headers.get("content-type", "application/json")},
        )

    # ------------------------- 备份 -------------------------

    @app.put("/api/backup")
    def put_backup(body: BackupPut, auth: AuthContext = Depends(require_auth)) -> dict[str, Any]:
        payload_json = _canonical_json(body.payload)
        size_bytes = len(payload_json.encode("utf-8"))
        if size_bytes > settings.max_payload_bytes:
            raise HTTPException(status_code=413, detail="payload exceeds 2 MiB")

        sha256 = hashlib.sha256(payload_json.encode("utf-8")).hexdigest()
        if body.sha256 and body.sha256 != sha256:
            raise HTTPException(status_code=422, detail="sha256 mismatch")

        try:
            data = repo.insert(
                device_id=body.device_id,
                schema_version=body.schema_version,
                client_version=body.client_version,
                payload=body.payload,
                payload_json=payload_json,
                size_bytes=size_bytes,
                sha256=sha256,
                user_id=auth.user_id,
            )
        except pymysql.MySQLError:
            logger.exception("写入备份失败")
            raise HTTPException(status_code=500, detail="数据库写入失败")
        return {"ok": True, "data": data}

    @app.get("/api/backup")
    def get_backup(
        device_id: str | None = Query(default=None, pattern=DEVICE_PATTERN),
        auth: AuthContext = Depends(require_auth),
    ) -> dict[str, Any]:
        try:
            row = repo.latest(auth.user_id, device_id)
        except pymysql.MySQLError:
            logger.exception("读取备份失败")
            raise HTTPException(status_code=500, detail="数据库读取失败")
        if not row:
            raise HTTPException(status_code=404, detail="no backup yet")
        return {
            "ok": True,
            "data": {
                "id": row["id"],
                "device_id": row["device_id"],
                "schema": row["schema_version"],
                "client_version": row.get("client_version"),
                "created_at": row["created_at"],
                "size_bytes": row["size_bytes"],
                "sha256": row["sha256"],
                "payload": row["payload"],
            },
        }

    @app.get("/api/backup/meta")
    def get_meta(
        device_id: str | None = Query(default=None, pattern=DEVICE_PATTERN),
        auth: AuthContext = Depends(require_auth),
    ) -> dict[str, Any]:
        try:
            meta = repo.latest_meta(auth.user_id, device_id)
        except pymysql.MySQLError:
            logger.exception("读取备份元信息失败")
            raise HTTPException(status_code=500, detail="数据库读取失败")
        return {"ok": True, "data": meta}

    return app


app = create_app()
