"""一次性建库脚本：创建 jingmi_newtab、专用账号和表。

用法（root 密码只从环境变量读取，不会出现在命令行与仓库）：
    MYSQL_ROOT_PASSWORD='***' APP_DB_HOST='%' python server/scripts/init_db.py

如果 APP_DB_PASSWORD 未设置，会自动生成一个强随机密码并打印一次，
请把它写入服务器上的 /etc/jingmi-backup.env，不要提交到仓库。
"""

from __future__ import annotations

import os
import re
import secrets
import sys
from pathlib import Path

import pymysql

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_FILE = ROOT / "schema.sql"
IDENT_RE = re.compile(r"^[A-Za-z0-9_]+$")


def statements() -> list[str]:
    text = SCHEMA_FILE.read_text(encoding="utf-8")
    lines = [line for line in text.splitlines() if not line.strip().startswith("--")]
    return [part.strip() for part in "\n".join(lines).split(";") if part.strip()]


def main() -> int:
    host = os.environ.get("MYSQL_HOST", "43.155.217.74")
    port = int(os.environ.get("MYSQL_PORT", "3306"))
    root_user = os.environ.get("MYSQL_ROOT_USER", "root")
    root_password = os.environ.get("MYSQL_ROOT_PASSWORD", "")
    db_name = os.environ.get("DB_NAME", "jingmi_newtab")
    app_user = os.environ.get("APP_DB_USER", "jingmi_app")
    app_password = os.environ.get("APP_DB_PASSWORD") or secrets.token_urlsafe(24)
    app_host = os.environ.get("APP_DB_HOST", "%")

    if not root_password:
        print("缺少 MYSQL_ROOT_PASSWORD 环境变量。", file=sys.stderr)
        return 2
    if not IDENT_RE.match(db_name) or not IDENT_RE.match(app_user):
        print("库名/应用账号只能包含字母、数字和下划线。", file=sys.stderr)
        return 2

    print(f"连接 MySQL {host}:{port} 作为 {root_user}…")
    conn = pymysql.connect(
        host=host,
        port=port,
        user=root_user,
        password=root_password,
        charset="utf8mb4",
        autocommit=True,
        connect_timeout=8,
    )
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"CREATE DATABASE IF NOT EXISTS `{db_name}` "
                "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
            )
            cur.execute(
                "CREATE USER IF NOT EXISTS %s@%s IDENTIFIED BY %s",
                (app_user, app_host, app_password),
            )
            cur.execute("ALTER USER %s@%s IDENTIFIED BY %s", (app_user, app_host, app_password))
            cur.execute(
                f"GRANT SELECT, INSERT, UPDATE, DELETE ON `{db_name}`.* TO %s@%s",
                (app_user, app_host),
            )
        conn.select_db(db_name)
        with conn.cursor() as cur:
            for sql in statements():
                cur.execute(sql)
    finally:
        conn.close()

    print("\n完成：数据库与表已创建。")
    print(f"  DB_HOST={host}")
    print(f"  DB_PORT={port}")
    print(f"  DB_NAME={db_name}")
    print(f"  DB_USER={app_user}")
    print(f"  DB_PASSWORD={app_password}")
    print("\n请把上面的 DB_PASSWORD 写入 /etc/jingmi-backup.env，并设置权限 600。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
