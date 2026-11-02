"""数据库增量迁移：为已有 jingmi_newtab 库补上账号与会话表。

只做加法，不删数据；可重复执行。
    MYSQL_ROOT_PASSWORD='***' python server/scripts/migrate_db.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pymysql

DB_NAME = os.environ.get("DB_NAME", "jingmi_newtab")
HOST = os.environ.get("MYSQL_HOST", "43.155.217.74")
PORT = int(os.environ.get("MYSQL_PORT", "3306"))
USER = os.environ.get("MYSQL_ROOT_USER", "root")
PASSWORD = os.environ.get("MYSQL_ROOT_PASSWORD", "")

USERS_COLUMNS = {
    "password_hash": "VARCHAR(255) NULL AFTER username",
    "status": "VARCHAR(16) NOT NULL DEFAULT 'active' AFTER password_hash",
    "rag_collection": "VARCHAR(80) NULL UNIQUE AFTER status",
    "rag_unlimited": "TINYINT(1) NOT NULL DEFAULT 0 AFTER rag_collection",
    "updated_at": "DATETIME(3) NULL AFTER created_at",
}

SESSIONS_SQL = """
CREATE TABLE IF NOT EXISTS sessions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  created_at DATETIME(3) NOT NULL,
  last_used_at DATETIME(3) NULL,
  expires_at DATETIME(3) NOT NULL,
  KEY idx_sessions_user (user_id),
  KEY idx_sessions_expires (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
"""


def main() -> int:
    if not PASSWORD:
        print("缺少 MYSQL_ROOT_PASSWORD 环境变量。", file=sys.stderr)
        return 2

    conn = pymysql.connect(
        host=HOST, port=PORT, user=USER, password=PASSWORD,
        database=DB_NAME, charset="utf8mb4", autocommit=True, connect_timeout=8,
    )
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.columns "
                "WHERE table_schema=%s AND table_name='users' AND column_name='username'",
                (DB_NAME,),
            )
            username_column = cur.fetchone()
            if username_column and username_column[0] < 254:
                cur.execute("ALTER TABLE users MODIFY COLUMN username VARCHAR(254) NOT NULL")
                print("已扩展 users.username，支持邮箱账号")

            for column, definition in USERS_COLUMNS.items():
                cur.execute(
                    "SELECT COUNT(*) FROM information_schema.columns "
                    "WHERE table_schema=%s AND table_name='users' AND column_name=%s",
                    (DB_NAME, column),
                )
                if cur.fetchone()[0]:
                    print(f"users.{column} 已存在，跳过")
                    continue
                cur.execute(f"ALTER TABLE users ADD COLUMN {column} {definition}")
                print(f"已添加 users.{column}")

            schema = (Path(__file__).resolve().parents[1] / "schema.sql").read_text()
            for table in ("rag_writes", "rag_daily"):
                statement = "CREATE TABLE IF NOT EXISTS " + table + schema.split("CREATE TABLE IF NOT EXISTS " + table, 1)[1].split(";", 1)[0]
                cur.execute(statement)
                print(f"{table} 表已就绪")
            cur.execute(SESSIONS_SQL)
            print("sessions 表已就绪")

            cur.execute("SELECT id, username, password_hash IS NOT NULL FROM users ORDER BY id")
            for row in cur.fetchall():
                print(f"  user {row[0]} {row[1]} password={'yes' if row[2] else 'no'}")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
