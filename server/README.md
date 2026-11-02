# 静谧新标签页 · 备份服务

FastAPI + PyMySQL，为扩展提供「自建服务端备份」。扩展通过 HTTP 访问本服务，浏览器本身不连接 MySQL。

## 1. 接口

认证：

- 账号登录返回会话令牌，扩展保存令牌，**密码不落盘**；
- 兼容旧版单令牌 `BACKUP_TOKEN_SHA256`，映射到 `user_id=1`；
- 会话令牌与服务端只保存 SHA-256，默认 90 天过期。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查，无需认证；`?deep=1` 额外检查数据库 |
| POST | `/api/auth/register` | 邮箱 + 密码注册，直接返回会话；兼容旧令牌迁移 |
| POST | `/api/auth/login` | 账号（邮箱或旧用户名）+ 密码，返回会话令牌 |
| GET | `/api/auth/me` | 当前账号（需认证） |
| POST | `/api/auth/logout` | 注销当前会话 |
| PUT | `/api/backup` | 上传备份，保留最近 10 版 |
| GET | `/api/backup?device_id=` | 拉取当前账号的最新备份（省略 device_id 取最近一版） |
| GET | `/api/backup/meta?device_id=` | 上次备份时间/大小/版本数，不含 payload |
| GET | `/api/rag/config` | 当前账号 RAG 是否就绪 + 只读集合名（不返回 Key/地址） |
| ANY | `/api/rag/{path}` | 代理 QuillRAG；注入后台 Key，强制使用账号集合 |

普通注册无需邀请码或邮箱验证码：扩展「注册账号」填写邮箱、密码、确认密码，成功后自动登录。
邮箱作为账号保存到 `username`（统一转为小写，最长 254 字符）；密码为 8～128 位，确认密码由前端校验。旧用户名仍可登录。
普通新账号创建独立数据空间，不会继承 `user_id=1` 的历史备份。

兼容旧客户端：请求中显式提供 `invite_code` 时，仍校验 `REGISTER_CODE` 或旧版访问令牌；只有有效旧令牌允许接管未设置密码的 `user_id=1`。

首次安装直接进入新标签页，本地搜索与设置可直接使用，不强制登录；AI/RAG 初始关闭。
通过「设置 → 左下角登录账号」登录或注册。登录后显示备份/恢复操作，恢复仍需两次确认。

请求体：

```json
{
  "device_id": "default",
  "schema": 1,
  "client_version": "1.16.0",
  "created_at": "2026-11-01T08:00:00Z",
  "sha256": "<可选>",
  "payload": {}
}
```

- payload 规范 JSON 后上限 2 MiB；超过返回 413。
- 服务端重算 SHA-256；与客户端提供的不一致返回 422。
- 最新一版 sha 相同会去重，不新增版本。

## 2. 建库

在能访问 MySQL 的主机上执行（root 密码只从环境变量读取）：

```bash
cd server
MYSQL_HOST=43.155.217.74 \
MYSQL_ROOT_PASSWORD='***' \
APP_DB_HOST='%' \
python scripts/init_db.py
```

脚本会创建：

- 库 `jingmi_newtab`（utf8mb4）
- 应用账号 `jingmi_app`（仅 SELECT/INSERT/UPDATE/DELETE 该库）
- 表 `users`、`backups`

如果 `APP_DB_PASSWORD` 未设置，脚本会生成随机密码并打印一次。把它写入服务器上的 `/etc/jingmi-backup.env`，不要提交到仓库。

已有库升级（补账号字段、`sessions` 表，并将 `username` 扩展到 254 字符）：

```bash
MYSQL_ROOT_PASSWORD='***' python server/scripts/migrate_db.py
```

> 生产环境建议把 `APP_DB_HOST` 收窄到应用服务器 IP；MySQL 3306 只对应用机开放。root 只用于这次 bootstrap，之后可以轮换密码。

## 3. 生成备份令牌

```bash
TOKEN="$(openssl rand -hex 32)"
printf '%s' "$TOKEN" | shasum -a 256 | awk '{print $1}'   # macOS
# 或 Linux: printf '%s' "$TOKEN" | sha256sum | awk '{print $1}'
```

把哈希写入 `BACKUP_TOKEN_SHA256`。该配置仅用于兼容旧客户端和旧备份迁移；新用户邮箱注册不需要此令牌。
如需继承旧备份，可通过兼容接口显式提交原始令牌为 `invite_code`，成功后 `user_id=1` 升级为账号；普通邮箱注册不执行此迁移。

## 3.1 RAG 后台代理

扩展不再保存 RAG 地址/Key/集合，统一在 `/etc/jingmi-backup.env` 配置：

```dotenv
RAG_BASE_URL=https://rag.lllcnm.cn
RAG_API_KEY=你的 QuillRAG Key
RAG_ENABLED=1
```

每个账号的集合由服务端自动生成（`chrome_tab_` + 随机串），唯一且不可编辑。
如果 `RAG_API_KEY` 为空，`/api/rag/config` 会返回 `enabled:false`，扩展显示「后台尚未配置 RAG 服务」。

## 4. 配置与启动

生产部署在 `43.155.217.74` 的 `/root/workspace/jingmi-backup`（代码在 `/root` 内，systemd 以 root 运行，未启用 `ProtectHome`）。服务只监听 `127.0.0.1:8790`——该机器的 `8787` 已被其他服务占用，换机器时可用 8787，但要同步 Caddyfile。

```bash
# 在服务器上
sudo mkdir -p /root/workspace/jingmi-backup
sudo rsync -a server/ /root/workspace/jingmi-backup/server/
sudo python3 -m venv /root/workspace/jingmi-backup/.venv
sudo /root/workspace/jingmi-backup/.venv/bin/pip install -r /root/workspace/jingmi-backup/server/requirements.txt

sudo cp server/.env.example /etc/jingmi-backup.env
sudo chmod 600 /etc/jingmi-backup.env
sudo editor /etc/jingmi-backup.env   # 填 DB_PASSWORD / BACKUP_TOKEN_SHA256 / RAG_API_KEY

sudo cp server/deploy/jingmi-backup.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jingmi-backup
curl -s http://127.0.0.1:8790/health
curl -s "http://127.0.0.1:8790/health?deep=1"   # db: up 表示数据库连通
```

`api.jingmi.lllcnm.cn` 的 A 记录已指向 `43.155.217.74`，Caddy 会自动申请证书。主 Caddyfile 里已有 `import conf.d/*.caddy`，所以加站点不要动主文件：

```bash
sudo cp server/deploy/Caddyfile /etc/caddy/conf.d/jingmi-backup.caddy
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
curl -s https://api.jingmi.lllcnm.cn/health
```

如果这个域名已经给其他 API（比如 AI 网关）使用，给备份加一个路径前缀即可，不必新开子域：

```caddyfile
api.jingmi.lllcnm.cn {
    handle_path /backup/* {
        reverse_proxy 127.0.0.1:8790
    }
    # 原有的其他路由保持不变
}
```

此时扩展设置里的服务地址填 `https://api.jingmi.lllcnm.cn/backup`。

systemd 与反向代理示例见 `deploy/jingmi-backup.service`、`deploy/Caddyfile`、`deploy/nginx.conf`。扩展设置页的默认服务地址是 `https://api.jingmi.lllcnm.cn`，把该域名解析到服务器并让 Caddy 申请证书即可。

生产环境务必通过 HTTPS 暴露，否则令牌与 API Key 会明文传输。

## 5. 验证

```bash
BASE=http://127.0.0.1:8790
curl -s "$BASE/health?deep=1"

# 账号登录拿会话令牌（推荐）
TOKEN=$(curl -s -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"你的邮箱或旧用户名","password":"你的密码"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["token"])')

curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/auth/me"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/backup/meta"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/rag/config"

curl -s -X PUT "$BASE/api/backup" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"device_id":"default","schema":1,"payload":{"schema":1,"exportedAt":"2026-11-01T00:00:00Z","settings":{},"tags":{"tags":[]}}}'
```

旧版访问令牌仍然可用：把 `$TOKEN` 换成原始令牌即可。

## 6. 账号与多用户

- `users` 表：`username` 唯一，密码用标准库 scrypt 哈希（`scrypt$N$r$p$salt$digest`）。
- `users.rag_collection`：每个账号一个唯一 `chrome_tab_` 集合，首次使用时生成，只读不可编辑。
- `sessions` 表：会话令牌只存 SHA-256，默认 90 天过期，可在请求中自动续用。
- `backups` 按 `user_id` + `device_id` 隔离；不同账号互相看不到备份。
- 普通邮箱注册开放，无需邀请码；邮箱仅作为登录账号，不进行邮箱验证。`REGISTER_CODE` 仅兼容旧客户端。
- 旧版单令牌继续可用，固定映射 `user_id=1`；首次用旧令牌注册会接管该用户。
- 登录失败限速：同一用户名 + IP 10 分钟内 5 次失败后返回 429（多 worker 时每进程独立计数）。

## 7. 安全清单

- 使用 HTTPS（Caddy 自动证书或 Nginx + 证书）。
- 密码最少 8 位，服务端用 scrypt 哈希；会话令牌 90 天过期，登出即失效。
- 新用户以邮箱注册并创建独立账号；只有显式提供有效旧令牌的兼容请求可以迁移旧备份。
- 账号建好后如需收紧：从 `/etc/jingmi-backup.env` 删除 `BACKUP_TOKEN_SHA256` 并重启服务，旧令牌立即失效，已有账号会话不受影响。
- 应用账号只授予 `jingmi_newtab` 的增删改查。
- 3306 不对公网开放，或至少限制来源 IP。
- `.env` 权限 600，不要提交仓库。
- 备份包含 AI/壁纸 API Key；数据库备份与磁盘访问也要限权。
- RAG Key 只放在 `/etc/jingmi-backup.env` 的 `RAG_API_KEY`，不会下发到浏览器；RAG 集合按账号生成，不可从前端修改。
- root 密码一旦在聊天/日志中出现，建议轮换。


### RAG 写入门禁迁移

新版 `schema.sql` 和 `scripts/migrate_db.py` 增加 `rag_writes`、`rag_daily` 两张表。更新时先安装 `requirements.txt` 中的 `python-multipart`，使用现有数据库运维方式执行增量迁移，再发布新版服务；本次实现未操作线上数据库。

账号每天最多预扣 500 次写入（UTC 日切），重复指纹复用结果且不扣新额度。所有 ingest 请求都强制账号集合和已登记的文档 ID，限制正文大小及分块参数；未知写入路由和整集合删除被拒绝。MySQL 行锁序列化同一网页的写入，日额度在同一事务内预扣。数据库不可用或缺表会停止写入，不退回无门禁代理。

`pending` 表示已预留并可能正在调用上游，`uncertain` 表示响应或操作结果未确认；两者都不自动解除。上游超时后，必须先核验对应账号集合、文档 ID 和内容版本，才能由运维决定是否恢复，不能直接批量把状态重置为 `new`。已确认的版本更新会先删除旧文档再 ingest，若中间失败，远端内容可能暂时缺失。显式文档删除同样与写入互斥，已确认删除后允许重新入库。

本机 IndexedDB 丢失后，新请求仍按账号和 canonical URL 找到已登记文档 ID。升级前未登记的历史孤立文档不在该去重保证内，需单独审计；不要自动删除未知历史记录。
