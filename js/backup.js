/* ============================================================
   backup.js —— 完整配置备份（本地文件 + 自建服务端）
   职责：
     1. 打包/校验/恢复用户配置（设置、标签、自动化规则）；
     2. 与自建 REST 服务端同步（PUT/GET + Bearer Token）；
     3. 自动备份的脏标记、退避与状态落库。
   边界：
     · 备份令牌自身永不进入 payload；壁纸图片与可重建缓存也不备份。
     · 页面和 Service Worker 共用本文件，不依赖 DOM。
   ============================================================ */
(function (global) {
  'use strict';

  var SCHEMA = 1;
  var DEFAULT_SERVER = 'https://api.jingmi.lllcnm.cn';
  var PAYLOAD_LIMIT = 2 * 1024 * 1024;
  var STATUS_KEY = 'newtab.backup.status.v1';
  var TAGS_KEY = 'newtab.tags.v1';
  var SETTINGS_KEY = 'newtab.settings.v1';
  var SUPPRESS_MS = 5 * 60 * 1000;
  var RETRY_BASE = 5 * 60 * 1000;
  var RETRY_MAX = 6 * 60 * 60 * 1000;
  var DAILY_MS = 24 * 60 * 60 * 1000;

  var META_KEYS = ['auto:rules', 'auto:config', 'enrich:config', 'historyOn', 'picks'];

  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

  function BackupError(code, message) {
    this.name = 'BackupError';
    this.code = code;
    this.message = message || code;
  }
  BackupError.prototype = Object.create(Error.prototype);

  function hasChrome() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  function readKey(key) {
    if (global.Profiles) return Profiles.read(key);
    return new Promise(function (resolve) {
      if (hasChrome()) {
        chrome.storage.local.get(key, function (res) { resolve(res && res[key]); });
        return;
      }
      try { resolve(JSON.parse(localStorage.getItem(key) || 'null')); }
      catch (e) { resolve(null); }
    });
  }

  function writeKey(key, value) {
    if (global.Profiles) return Profiles.write(key, value);
    if (hasChrome()) {
      var payload = {};
      payload[key] = value;
      return new Promise(function (resolve) { chrome.storage.local.set(payload, function () { resolve(); }); });
    }
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 静默 */ }
    return Promise.resolve();
  }

  function isConfigMeta(key) {
    key = String(key || '');
    if (META_KEYS.indexOf(key) >= 0) return true;
    return key.indexOf('doc:alias:') === 0 || key.indexOf('class:') === 0;
  }

  /** 备份出去的是“配置”，不含备份连接自身与可重建的壁纸历史 */
  function stripSettings(settings) {
    var out = clone(settings || {});
    delete out.backup;
    if (out.wallpaper) delete out.wallpaper.history;
    return out;
  }

  function canonicalJson(value) {
    if (value === undefined) return 'null';                 /* 数组里的 undefined 与 JSON.stringify 一致 */
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    return '{' + Object.keys(value).filter(function (k) {
      return value[k] !== undefined;                         /* 对象里的 undefined 直接省略 */
    }).sort().map(function (k) {
      return JSON.stringify(k) + ':' + canonicalJson(value[k]);
    }).join(',') + '}';
  }

  function byteLength(text) {
    try { return new TextEncoder().encode(text).length; }
    catch (e) { return unescape(encodeURIComponent(text)).length; }
  }

  function sha256Hex(text) {
    try {
      if (typeof crypto === 'undefined' || !crypto.subtle) return Promise.resolve('');
      var buf = new TextEncoder().encode(text);
      return crypto.subtle.digest('SHA-256', buf).then(function (hash) {
        return Array.prototype.map.call(new Uint8Array(hash), function (b) {
          return ('0' + b.toString(16)).slice(-2);
        }).join('');
      });
    } catch (e) { return Promise.resolve(''); }
  }

  function clientVersion() {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
        return chrome.runtime.getManifest().version || '0.0.0';
      }
    } catch (e) { /* ignore */ }
    return '0.0.0';
  }

  /** 纯函数：把三类数据组装成备份 payload，便于单测 */
  function buildPayload(input) {
    input = input || {};
    var meta = {};
    Object.keys(input.meta || {}).forEach(function (k) {
      if (isConfigMeta(k)) meta[k] = input.meta[k];
    });
    return {
      schema: SCHEMA,
      exportedAt: new Date(input.now || Date.now()).toISOString(),
      client: { version: clientVersion(), manifestVersion: 3 },
      settings: stripSettings(input.settings),
      tags: clone(input.tags || { version: 2, tags: [], dismissed: {}, used: {}, updatedAt: 0 }),
      meta: meta,
      omitted: [
        'settings.backup',
        'wallpaper.history',
        'newtab-media images',
        'dailyQuote*',
        'newtab.recentSearches.v1',
        'newtab.tag-suggest.v1',
        'pipeline:*', 'rag:sync:*', 'enrich:queue', 'auto:pending'
      ]
    };
  }

  function validatePayload(payload) {
    if (!payload || typeof payload !== 'object') throw new BackupError('invalid_payload', '备份文件不是有效 JSON');
    if (Number(payload.schema) !== SCHEMA) throw new BackupError('unsupported_schema', '备份版本不兼容');
    if (!payload.settings || typeof payload.settings !== 'object') throw new BackupError('invalid_payload', '缺少设置');
    if (!payload.tags || !Array.isArray(payload.tags.tags)) throw new BackupError('invalid_payload', '缺少标签');
    if (payload.meta && typeof payload.meta !== 'object') throw new BackupError('invalid_payload', '元数据格式错误');
    return payload;
  }

  /** 收集当前配置；超过上限时先丢弃可重建的 class:*，仍超限则报错 */
  async function collect() {
    var settings = await Settings.load();
    var tags = await readKey(TAGS_KEY);
    var meta = await AgentDB.getAllMeta();
    var payload = buildPayload({ settings: settings, tags: tags, meta: meta });
    var text = canonicalJson(payload);

    if (byteLength(text) > PAYLOAD_LIMIT) {
      Object.keys(payload.meta).forEach(function (k) {
        if (k.indexOf('class:') === 0) delete payload.meta[k];
      });
      payload.omitted.push('class:* (size limit)');
      text = canonicalJson(payload);
    }
    if (byteLength(text) > PAYLOAD_LIMIT) {
      throw new BackupError('too_large', '备份数据超过 2 MiB');
    }

    var sha = await sha256Hex(text);
    return { payload: payload, text: text, sizeBytes: byteLength(text), sha256: sha };
  }

  function originPattern(serverUrl) {
    try { return new URL(String(serverUrl || '').trim()).origin + '/*'; }
    catch (e) { return null; }
  }

  function baseOf(serverUrl) {
    var base = String(serverUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) throw new BackupError('bad_config', '请填写 http(s) 服务地址');
    return base;
  }

  async function request(cfg, method, path, body, options) {
    var base = baseOf(cfg && cfg.serverUrl);
    var needsAuth = !(options && options.auth === false);
    var token = String(cfg && cfg.token || '').trim();
    if (needsAuth && !token) throw new BackupError('bad_config', '请先登录或填写访问令牌');

    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 15000) : null;
    var headers = {};
    if (needsAuth) headers['Authorization'] = 'Bearer ' + token;
    var opts = { method: method, headers: headers, signal: ctrl ? ctrl.signal : undefined };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    var res;
    try {
      res = await fetch(base + path, opts);
    } catch (e) {
      throw new BackupError(e && e.name === 'AbortError' ? 'timeout' : 'network', '网络不通或服务不可达');
    } finally {
      if (timer) clearTimeout(timer);
    }

    var data = null;
    try { data = await res.json(); } catch (e) { /* 允许空响应 */ }
    if (!res.ok) {
      var code = data && data.error && data.error.code ? data.error.code : 'http_' + res.status;
      var msg = data && data.error && data.error.message ? data.error.message : '服务端返回 ' + res.status;
      throw new BackupError(code, msg);
    }
    return data;
  }

  function health(cfg) {
    return request(cfg, 'GET', '/health').then(function (data) {
      if (!data || !data.ok) throw new BackupError('bad_response', '这个地址不是备份服务');
      return data;
    });
  }

  function authData(res) {
    var data = res && (res.data || res);
    if (!res || !res.ok || !data || !data.token) {
      throw new BackupError('bad_response', '服务端返回的登录信息不完整');
    }
    return data;
  }

  function authRegister(cfg, username, password) {
    return request(cfg, 'POST', '/api/auth/register', {
      username: String(username || '').trim(),
      password: String(password || '')
    }, { auth: false }).then(authData);
  }

  function authLogin(cfg, username, password) {
    return request(cfg, 'POST', '/api/auth/login', {
      username: String(username || '').trim(),
      password: String(password || '')
    }, { auth: false }).then(authData);
  }

  function authMe(cfg) {
    return request(cfg, 'GET', '/api/auth/me').then(function (res) {
      var data = res && (res.data || res);
      if (!res || !res.ok || !data || !data.user) {
        throw new BackupError('bad_response', '登录状态无效');
      }
      return data;
    });
  }

  function authLogout(cfg) {
    return request(cfg, 'POST', '/api/auth/logout').then(function () { return true; })
      .catch(function () { return false; });
  }

  function meta(cfg) {
    var q = cfg && cfg.deviceId ? '?device_id=' + encodeURIComponent(cfg.deviceId) : '';
    return request(cfg, 'GET', '/api/backup/meta' + q);
  }

  async function push(cfg, prepared) {
    var pack = prepared || await collect();
    var body = {
      device_id: String(cfg.deviceId || 'default'),
      schema: SCHEMA,
      client_version: clientVersion(),
      created_at: new Date().toISOString(),
      sha256: pack.sha256 || undefined,
      payload: pack.payload
    };
    var res = await request(cfg, 'PUT', '/api/backup', body);
    var data = res && res.data || res || {};
    await updateStatus({
      lastAt: Date.now(),
      lastOkAt: Date.now(),
      attempts: 0,
      nextAt: 0,
      dirtyAt: 0,
      firstDirtyAt: 0,
      sizeBytes: pack.sizeBytes,
      errorCode: '',
      errorText: '',
      deviceId: body.device_id
    });
    return data;
  }

  async function pull(cfg) {
    var q = cfg && cfg.deviceId ? '?device_id=' + encodeURIComponent(cfg.deviceId) : '';
    var res = await request(cfg, 'GET', '/api/backup' + q);
    var data = res && res.data || res;
    if (!data || !data.payload) throw new BackupError('not_found', '服务器上还没有备份');
    return data.payload;
  }

  function mergeRestoreSettings(current, incoming) {
    var next = Settings.merge(Settings.DEFAULTS, incoming || {});
    next.backup = clone(current && current.backup || Settings.DEFAULTS.backup);
    return next;
  }

  /** 恢复：设置合并、标签整体替换、meta 白名单替换；完成后调用方 reload */
  async function apply(payload, options) {
    options = options || {};
    validatePayload(payload);
    var current = options.currentSettings || await Settings.load();
    var next = mergeRestoreSettings(current, payload.settings);

    if (next.bg && next.bg.mode === 'image' && next.bg.imageId != null && typeof ImageStore !== 'undefined') {
      var img = await ImageStore.get(next.bg.imageId).catch(function () { return null; });
      if (!img) {
        next.bg.mode = 'gradient';
        next.bg.imageId = null;
        next.bg.url = '';
      }
    }

    if (typeof QuickTags !== 'undefined' && QuickTags.restoreState) {
      await QuickTags.restoreState(payload.tags, { mode: 'replace' });
    } else {
      await writeKey(TAGS_KEY, payload.tags);
    }

    await AgentDB.replaceMeta(payload.meta || {}, isConfigMeta);
    await Settings.save(next);
    await updateStatus({ lastRestoreAt: Date.now(), dirtyAt: 0, firstDirtyAt: 0 });
    await AgentDB.setMeta('backup:suppressUntil', Date.now() + SUPPRESS_MS).catch(function () {});

    return {
      exportedAt: payload.exportedAt,
      tags: (payload.tags.tags || []).length,
      meta: Object.keys(payload.meta || {}).length
    };
  }

  async function exportFile(payload) {
    var data = payload || (await collect()).payload;
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'jingmi-newtab-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    return data;
  }

  function parseImport(text) {
    var data = null;
    try { data = typeof text === 'string' ? JSON.parse(text) : text; }
    catch (e) { throw new BackupError('invalid_json', '文件不是有效 JSON'); }
    return validatePayload(data);
  }

  /* ------------------------- 自动备份状态 ------------------------- */

  function normalizeStatus(raw) {
    raw = raw || {};
    return {
      lastAt: Number(raw.lastAt) || 0,
      lastOkAt: Number(raw.lastOkAt) || 0,
      lastRestoreAt: Number(raw.lastRestoreAt) || 0,
      attempts: Number(raw.attempts) || 0,
      nextAt: Number(raw.nextAt) || 0,
      dirtyAt: Number(raw.dirtyAt) || 0,
      firstDirtyAt: Number(raw.firstDirtyAt) || 0,
      sizeBytes: Number(raw.sizeBytes) || 0,
      deviceId: String(raw.deviceId || 'default'),
      errorCode: String(raw.errorCode || ''),
      errorText: String(raw.errorText || '')
    };
  }

  function readStatus() {
    return readKey(STATUS_KEY).then(normalizeStatus);
  }

  function updateStatus(patch) {
    return readStatus().then(function (current) {
      return writeKey(STATUS_KEY, Object.assign(current, patch));
    });
  }

  function signature(settings) {
    var s = clone(settings || {});
    delete s.backup;
    if (s.wallpaper) delete s.wallpaper.history;
    return canonicalJson(s);
  }

  async function markDirty() {
    var status = await readStatus();
    var now = Date.now();
    var patch = { dirtyAt: status.dirtyAt || now, firstDirtyAt: status.firstDirtyAt || now };
    await updateStatus(patch);
    scheduleDebounce(patch.firstDirtyAt);
  }

  function scheduleDebounce(firstDirtyAt) {
    try {
      if (typeof chrome === 'undefined' || !chrome.alarms) return;
      var now = Date.now();
      var when = Math.min(now + 2 * 60 * 1000, firstDirtyAt + 15 * 60 * 1000);
      chrome.alarms.create('backup:debounce', { when: Math.max(now + 30000, when) });
    } catch (e) { /* SW 未就绪时忽略 */ }
  }

  function ensureAlarms() {
    try {
      if (typeof chrome === 'undefined' || !chrome.alarms) return;
      chrome.alarms.get('backup:periodic', function (alarm) {
        if (!alarm) chrome.alarms.create('backup:periodic', { periodInMinutes: 360 });
      });
    } catch (e) { /* ignore */ }
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    if (changes[STATUS_KEY]) return;   /* 状态写入绝不触发下一次上传 */

    var tagsChanged = !!changes[TAGS_KEY];
    var settingsChanged = false;
    var sc = changes[SETTINGS_KEY];
    if (sc) {
      settingsChanged = signature(sc.oldValue) !== signature(sc.newValue);
    }
    if (tagsChanged || settingsChanged) markDirty().catch(function () {});
  }

  function retryDelay(attempts) {
    return Math.min(RETRY_MAX, RETRY_BASE * Math.pow(2, Math.max(0, attempts)));
  }

  function noRetry(code) {
    return [
      'auth', 'unauthorized', 'http_401', 'http_403',
      'too_large', 'http_413',
      'invalid_payload', 'http_422', 'sha_mismatch', 'unsupported_schema',
      'bad_config', 'permission_missing'
    ].indexOf(code) >= 0;
  }

  async function autoRun() {
    var settings = await Settings.load();
    var saved = settings.backup || {};
    /* 服务地址固定为后台地址；自动备份只要求账号会话存在 */
    var token = String(saved.authToken || saved.token || '').trim();
    var cfg = Object.assign({}, saved, { serverUrl: DEFAULT_SERVER, token: token, auto: true });
    if (!token) return { ok: false, skipped: 'config' };

    var status = await readStatus();
    var now = Date.now();
    /* 令牌错误/数据过大这类失败重试也不会变好，等用户在设置页改动后重置状态 */
    if (status.errorCode && noRetry(status.errorCode)) return { ok: false, skipped: 'no_retry' };
    if (status.nextAt && status.nextAt > now) return { ok: false, skipped: 'backoff' };
    if (status.lastRestoreAt && now - status.lastRestoreAt < SUPPRESS_MS) return { ok: false, skipped: 'restore' };
    if (!status.dirtyAt && status.lastOkAt && now - status.lastOkAt < DAILY_MS) return { ok: false, skipped: 'fresh' };

    var pattern = originPattern(cfg.serverUrl);
    if (pattern && typeof chrome !== 'undefined' && chrome.permissions && chrome.permissions.contains) {
      var granted = await chrome.permissions.contains({ origins: [pattern] }).catch(function () { return false; });
      if (!granted) {
        await updateStatus({ errorCode: 'permission_missing', errorText: '缺少备份服务地址的访问权限' });
        return { ok: false, error: 'permission_missing' };
      }
    }

    try {
      var pack = await collect();
      var data = await push(cfg, pack);
      try { if (chrome.alarms) chrome.alarms.clear('backup:debounce'); } catch (e) { /* ignore */ }
      return { ok: true, data: data, sizeBytes: pack.sizeBytes };
    } catch (err) {
      var code = err && err.code || 'network';
      var attempts = (status.attempts || 0) + 1;
      var patch = { errorCode: code, errorText: String(err && err.message || err), attempts: attempts };
      if (!noRetry(code)) patch.nextAt = Date.now() + retryDelay(attempts);
      await updateStatus(patch);
      if (patch.nextAt) {
        try { if (chrome.alarms) chrome.alarms.create('backup:debounce', { when: patch.nextAt }); } catch (e) { /* ignore */ }
      }
      return { ok: false, error: code, message: patch.errorText };
    }
  }

  global.Backup = {
    SCHEMA: SCHEMA,
    DEFAULT_SERVER: DEFAULT_SERVER,
    PAYLOAD_LIMIT: PAYLOAD_LIMIT,
    STATUS_KEY: STATUS_KEY,
    TAGS_KEY: TAGS_KEY,
    SETTINGS_KEY: SETTINGS_KEY,
    isConfigMeta: isConfigMeta,
    stripSettings: stripSettings,
    canonicalJson: canonicalJson,
    buildPayload: buildPayload,
    validatePayload: validatePayload,
    collect: collect,
    originPattern: originPattern,
    health: health,
    authRegister: authRegister,
    authLogin: authLogin,
    authMe: authMe,
    authLogout: authLogout,
    meta: meta,
    push: push,
    pull: pull,
    apply: apply,
    mergeRestoreSettings: mergeRestoreSettings,
    exportFile: exportFile,
    parseImport: parseImport,
    signature: signature,
    readStatus: readStatus,
    updateStatus: updateStatus,
    onStorageChanged: onStorageChanged,
    ensureAlarms: ensureAlarms,
    autoRun: autoRun,
    noRetry: noRetry,
    retryDelay: retryDelay,
    BackupError: BackupError
  };
})(typeof self !== 'undefined' ? self : window);
