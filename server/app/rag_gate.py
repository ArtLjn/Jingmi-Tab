"""RAG 写入门禁：稳定身份、内容指纹及结果不确定时的隔离。"""
from __future__ import annotations

import hashlib
import json
from urllib.parse import urlsplit

from fastapi import HTTPException


def describe(form) -> tuple[str, str, dict]:
    try:
        metadata = json.loads(str(form.get("metadata_json", "{}")))
        url = str(metadata["canonical_url"])
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password:
            raise ValueError("无效网页身份")
        text = str(form["text"])
        if not text or len(text) > 300_000 or len(text.encode("utf-8")) > 2_000_000:
            raise ValueError("正文超出允许范围")
        stable = {k: v for k, v in metadata.items() if k not in ("client_id", "captured_at", "source_updated_at")}
        # 书签 ID 由本机分配，不作为跨安装的内容版本依据。
        stable["bookmarks"] = [{k: v for k, v in r.items() if k != "id"} for r in metadata.get("bookmarks", [])]
        signature = json.dumps([text, stable, {"category": form.get("category")}], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(url.encode()).hexdigest(), hashlib.sha256(signature.encode()).hexdigest(), metadata
    except (KeyError, ValueError, TypeError, AttributeError):
        raise HTTPException(status_code=422, detail="RAG 写入缺少有效网页身份或正文")
