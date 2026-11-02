"""MySQL 连接。

数据量很小，按请求建立连接即可；不引入连接池，减少依赖。
所有 SQL 都由 repository 使用参数化查询，禁止字符串拼接用户输入。
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

import pymysql
from pymysql.cursors import DictCursor

from .config import Settings


def connect(settings: Settings) -> pymysql.connections.Connection:
    return pymysql.connect(
        host=settings.db_host,
        port=settings.db_port,
        user=settings.db_user,
        password=settings.db_password,
        database=settings.db_name,
        charset="utf8mb4",
        cursorclass=DictCursor,
        autocommit=False,
        connect_timeout=5,
        read_timeout=10,
        write_timeout=10,
    )


@contextmanager
def transaction(settings: Settings) -> Iterator[DictCursor]:
    conn = connect(settings)
    try:
        with conn.cursor() as cursor:
            yield cursor
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def ping(settings: Settings) -> bool:
    try:
        conn = connect(settings)
        try:
            with conn.cursor() as cursor:
                cursor.execute("SELECT 1 AS ok")
                return cursor.fetchone() is not None
        finally:
            conn.close()
    except Exception:
        return False
