---
title: 自建服务端备份设计
status: active
last_updated: 2026-11-01
---

# 自建服务端备份设计

> 版本 v1.16 · 适用于「静谧新标签页」MV3 扩展与 `server/` 备份服务

## 1. 为什么需要服务端

Chrome 在卸载扩展时会清空该扩展的 `chrome.storage.local`、IndexedDB 与 localStorage，`chrome.storage.sync` 的扩展数据也会随卸载删除。扩展本身不能直接连接 MySQL；浏览器扩展没有裸 TCP 能力。

因此要做到「卸载重装后恢复配置」，只有两条路：

1. 导出/导入本地 JSON 文件（手动兜底）；
2. 把配置上传到自建 HTTP 服务，由服务端写入 MySQL（自动恢复）。

本设计同时实现两者，共用同一个 payload。

## 2. 数据边界

### 2.1 包含

- `settings`：完整设置，除了 `settings.backup` 整棵子树与 `wallpaper.history`。
  - 包含 AI Key、Pexels/Unsplash/Pixabay Key、哲风 Token（用户已确认）。
  - RAG 地址/Key 不再由扩展保存；旧版本留下的值会在后台 RAG 配置可用后自动清空。
- `tags`：`newtab.tags.v1` 的完整状态（tags / dismissed / used / version / updatedAt），保证恢复后频率排序不丢。
- `meta` 白名单：
  - `auto:rules`、`auto:config`（自动归档）
  - `enrich:config`（收藏补全）
  - `historyOn`（历史加权开关）
  - `picks`（AI 检索选择记忆）
  - `doc:alias:*`（文档身份别名）
  - `class:*`（已确认的分类/标签元数据）

### 2.2 排除

- `settings.backup`：尤其 `token`，任何情况下都不序列化；避免自引用与令牌泄露。
- `wallpaper.history`、每日一言缓存、`newtab.recentSearches.v1`、`newtab.tag-suggest.v1`。
- 壁纸图片 `newtab-media`、页面正文缓存 `pages`、文档正文、同步队列、租约、错误日志、`pipeline:*`、`rag:sync:*`、`ai:foreground`、`builtAt/count` 等可重建或运行时数据。
- Chrome 书签本体由浏览器保存，扩展只重建索引。

### 2.3 大小

- payload 规范 JSON（key 排序、无空格、UTF-8）上限 **2 MiB**。
- 超过时先丢弃可重建的 `class:*`；仍超限则报错，不截断关键配置。

## 3. Payload

```json
{
  "schema": 1,
  "exportedAt": "2026-11-01T08:00:00.000Z",
  "client": { "version": "1.16.0", "manifestVersion": 3 },
  "settings": { "ai": {}, "rag": {}, "wallpaper": {}, "bg": {}, "tags": {} },
  "tags": { "version": 2, "tags": [], "dismissed": {}, "used": {}, "updatedAt": 0 },
  "meta": { "auto:rules": {}, "auto:config": {}, "class:1": {} },
  "omitted": ["settings.backup", "wallpaper.history", "newtab-media images"]
}
```

服务端请求体在 payload 外包一层：

```json
{
  "device_id": "default",
  "schema": 1,
  "client_version": "1.16.0",
  "created_at": "2026-11-01T08:00:00Z",
  "sha256": "<payload 规范 JSON 的 SHA-256，可选>",
  "payload": {}
}
```

## 4. REST 契约

服务地址在扩展设置里填写为 **base URL**（例如 `https://api.jingmi.lllcnm.cn`），扩展自动追加以下路径。

认证：

- 账号注册 / 登录后返回会话令牌，扩展只保存令牌，**密码不落盘**；
- 服务端存令牌的 SHA-256，默认 90 天过期；
- 旧版单令牌 `BACKUP_TOKEN_SHA256` 继续可用，映射到 `user_id=1`；
- 普通注册为邮箱、密码、确认密码，无需邀请码，注册后自动登录并创建独立数据空间；兼容接口显式携带有效旧令牌才可迁移 `user_id=1` 的备份。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 无认证；`?deep=1` 检查数据库 |
| POST | `/api/auth/register` | 邮箱 + 密码注册，返回会话令牌 |
| POST | `/api/auth/login` | 邮箱或旧用户名 + 密码，返回会话令牌 |
| GET | `/api/auth/me` | 当前账号 |
| POST | `/api/auth/logout` | 注销当前会话 |
| PUT | `/api/backup` | 上传备份；按 `(user_id, device_id)` 保留最近 10 版 |
| GET | `/api/backup?device_id=` | 取当前账号最新完整 payload；省略 device_id 取最近一版 |
| GET | `/api/backup/meta?device_id=` | 上次时间、大小、sha、版本数；不返回 payload |
| GET | `/api/rag/config` | 当前账号的 RAG 是否就绪与只读集合名；不返回 Key/地址 |
| ANY | `/api/rag/{path}` | 服务端代理 QuillRAG；注入后台 Key，强制使用当前账号集合 |

数据隔离：`backups.user_id` 来自认证上下文；账号 A 的 `GET/PUT` 永远只作用于 A 的数据。
旧版令牌固定映射 `user_id=1`，仅显式提供有效旧令牌的兼容注册会继承该用户下的历史备份。

- 成功统一 `{"ok": true, "data": ...}`；失败 `{"ok": false, "error": {"code","message"}}`。
- 错误码：401 `unauthorized`、404 `not_found`、413 `payload_too_large`、422 `invalid_payload` / `sha_mismatch`、500 `server_error`。
- 最新一版 sha 相同则去重，不新增版本。
- CORS：`allow_origins=["*"]`，允许 `GET/PUT/OPTIONS` 与 `Authorization/Content-Type`。CORS 不是认证，Bearer token 才是。

## 5. 恢复语义

`Backup.apply(payload)`：

1. 校验 schema / settings / tags / meta 类型；
2. `Settings.merge(DEFAULTS, payload.settings)` 后用**本机** `settings.backup` 覆盖，保留服务地址与令牌；
3. 若 `bg.mode === 'image'` 且图片不存在，回退 `gradient`、清空 `imageId`；
4. `QuickTags.restoreState(payload.tags, {mode:'replace'})` 整体替换标签；
5. `AgentDB.replaceMeta(payload.meta, isConfigMeta)`：白名单 key 先删后写，缓存 key 保留；
6. `Settings.save(next)`；
7. 写 `lastRestoreAt`、清 dirty，5 分钟内禁止自动上传，避免刚恢复就覆盖服务器；
8. 页面 `location.reload()`。

恢复不会恢复：备份令牌（必须本机重填）、壁纸图片、页面正文缓存、同步队列。恢复前 UI 两步确认，并建议先导出当前配置。

## 6. 自动备份

### 6.1 触发

- `chrome.storage.onChanged` 监听 `newtab.tags.v1` 与 `newtab.settings.v1`。
- settings 使用 `signature()` 比较：排除 `backup` 与 `wallpaper.history`，避免改令牌/设备名触发上传。
- 状态写入独立的 `newtab.backup.status.v1`，监听器忽略该 key，切断「上传 → 写状态 → 再上传」循环。
- 首次变更后 2 分钟触发；连续变更最迟 15 分钟必须执行。
- 另有 6 小时周期 alarm；无变更时至少每 24 小时上传一次。
- 备份服务不可用或断网时指数退避：`min(6h, 5min * 2^attempts)`。
- 401/403/413/权限缺失不自动重试，设置页展示原因。

### 6.2 状态

```json
{
  "lastAt": 0,
  "lastOkAt": 0,
  "lastRestoreAt": 0,
  "attempts": 0,
  "nextAt": 0,
  "dirtyAt": 0,
  "firstDirtyAt": 0,
  "sizeBytes": 0,
  "deviceId": "default",
  "errorCode": "",
  "errorText": ""
}
```

### 6.3 权限

- 备份地址使用 `optional_host_permissions`（`http://*/*`、`https://*/*`）。
- 只在设置页点击「测试连接 / 立即备份 / 从服务器恢复 / 开启自动备份」时，在用户手势的同步栈里调用 `chrome.permissions.request`。
- Service Worker 只 `contains`，不发起权限请求。

## 6.4 RAG 后台代理

- 扩展不再保存 RAG 地址/API Key/集合；账号登录后只拿会话令牌。
- 服务端环境变量：`RAG_BASE_URL`、`RAG_API_KEY`、`RAG_ENABLED`；Key 永不下发。
- 每个账号在 `users.rag_collection` 有一个唯一集合（`chrome_tab_` + 12 位随机），首次使用时生成，只读不可编辑。
- `GET /api/rag/config` 只返回 `{enabled, collection}`。
- 其他 `/api/rag/*` 请求由服务端转发到 QuillRAG，并：
  - 注入 `Authorization: Bearer RAG_API_KEY`；
  - 路径 `/collections/<name>/...` 与 JSON `retrieve`/`collections` 请求体强制替换为当前账号集合；
  - `/ingest` multipart 里的 `collection` 字段强制替换；
  - 不把浏览器传来的 Authorization 继续转给上游。
- 账号会话过期时代理返回 401，扩展提示重新登录；后台未配置 Key 时返回 503，扩展显示「后台尚未配置 RAG 服务」。
- 旧版本的直连 RAG 配置仅用于迁移与测试；后台 RAG 就绪后，扩展会清空本机旧 Key/地址。

## 7. 安全与威胁模型

| 风险 | 应对 |
|---|---|
| 备份令牌泄露 | 令牌只存本机 settings；payload、日志、数据库不出现；服务端只存 SHA-256；HTTPS |
| HTTP 明文 | 设置页警告；部署强制 Caddy/Nginx HTTPS；不建议裸 HTTP |
| MySQL root 暴露 | root 只用于一次性 bootstrap；应用用 `jingmi_app` 最小权限；3306 限源；轮换 root |
| 备份含 API Key | 用户已确认包含；数据库与导出文件需限权；UI 在导出时提示 |
| 恢复覆盖本机 | 两步确认；服务端保留 10 版；建议恢复前导出 |
| 自动上传循环 | 状态独立 key；signature 排除 backup；恢复后 5 分钟抑制 |
| 服务端不可达 | 指数退避；状态展示；文件导出兜底 |
| 旧版本数据 | tags `version` 升到 2，`normalize()` 兼容 v1；payload `schema` 校验 |

## 8. 部署

见 [`server/README.md`](../../server/README.md)：

1. `server/scripts/init_db.py` 创建 `jingmi_newtab`、`jingmi_app` 与表；已有库执行 `server/scripts/migrate_db.py` 补账号字段与 `sessions` 表；
2. 生成 token 与 SHA-256，写入 `/etc/jingmi-backup.env`；首次注册可用该原始 token 作为邀请码，接管 `user_id=1`；
3. `uvicorn app.main:app --host 127.0.0.1 --port 8787`；
4. Caddy/Nginx 反代到 `api.jingmi.lllcnm.cn`，自动 HTTPS；
5. 扩展服务地址固定为 `https://api.jingmi.lllcnm.cn`，新用户通过「设置 → 左下角登录账号」进行邮箱注册。

## 9. 验收

1. `@localhost:5173` 回车创建并跳转，重开新标签页标签仍在。
2. 固定区按使用频率排序；同频回落手写顺序。
3. AI 推荐首次请求只含标题/域名；reload 后缓存命中、不重复请求。
4. 注册账号后登录成功；立即备份的请求体不含密码与会话令牌；数据库记录归属该账号。
5. 账号 A 与账号 B 的备份互相不可见。
6. 修改本机 AI Key 后从服务器恢复，Key 回到备份值，本机账号/令牌保留。
7. 退出后密码错误提示「账号或密码错误」；重新登录成功。
8. 停服后自动备份进入退避并展示错误；错误令牌/会话不再重试。
