/* ============================================================
   quick-tags.js —— @ 快捷标签（Quick Jump）
   职责：
     1. 保存用户手动确认的标签（本机，不联网）；
     2. 从书签 + 常访站点实时生成自动候选（不落库、不漂移）；
     3. 提供 @ 面板需要的分组匹配结果。
   设计要点：
     · 只持久化「人的决定」：手动标签、候选隐藏次数、候选实际使用次数。
       自动候选每次打开新标签页即时重算——信号本来就是活的，
       存下来只会随时间腐坏，这也是自动方案"标签自己跑偏"的根因。
     · 不做拼音模糊纠错：@ 是跳转原语，猜错的代价高于没给。
     · 统一在纯函数层完成匹配与排序，便于 tests/quick-tags.test.js 直接验证。
   ============================================================ */
(function (global) {
  'use strict';

  var STORE_KEY = 'newtab.tags.v1';
  var MAX_MANUAL = 200;        // 手动标签上限，超出后拒绝新建
  var DISMISS_LIMIT = 3;       // 同一候选被隐藏 3 次后永久不再生成
  var RECENT_BM_DAYS = 120;    // 只看最近 120 天新增的书签做候选
  var MAX_CANDIDATES = 12;     // 候选池上限，面板只取前几条
  var PIN_LIMIT = 8;           // 固定区展示上限（与设计文档一致）
  var CAND_LIMIT = 3;          // 空查询时常用区槽位

  /* 搜索引擎与常见中转页：访问频次再高也不该占快捷位 */
  var NOISE_HOST_RE = /(^|\.)(bing|google|baidu|sogou|so|yandex|duckduckgo|sm)\.(com|cn|com\.cn|net|org)$/;
  var NOISE_URL_RE = /(utm_[a-z]+=|redirect=|goto=|sso\/login|\/search\?|\/login\?)/i;

  var state = { version: 1, tags: [], dismissed: {}, used: {}, updatedAt: 0 };
  var loaded = false;
  var loading = null;
  var saveTimer = null;

  /* ------------------------- 存储 ------------------------- */
  function hasChrome() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  function hasLocal() {
    try { return typeof localStorage !== 'undefined' && !!localStorage; } catch (e) { return false; }
  }

  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

  function readStore() {
    return new Promise(function (resolve) {
      if (hasChrome()) {
        chrome.storage.local.get(STORE_KEY, function (res) { resolve(res && res[STORE_KEY]); });
        return;
      }
      if (hasLocal()) {
        try { resolve(JSON.parse(localStorage.getItem(STORE_KEY) || 'null')); }
        catch (e) { resolve(null); }
        return;
      }
      resolve(null);   // 单测环境：无存储，退回内存态
    });
  }

  function writeStore() {
    state.updatedAt = Date.now();
    if (hasChrome()) {
      var payload = {};
      payload[STORE_KEY] = clone(state);
      return new Promise(function (resolve) { chrome.storage.local.set(payload, function () { resolve(); }); });
    }
    if (hasLocal()) {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* 配额满时静默，内存态仍可用 */ }
    }
    return Promise.resolve();
  }

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { writeStore(); }, 200);
  }

  /* ------------------------- 工具 ------------------------- */
  function newId() {
    return 'tag_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /** 允许用户只输入 example.com 或 ip:port，统一补协议 */
  function normalizeUrl(input) {
    var s = String(input || '').trim();
    if (!s) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      if (!/^[\w-]+(\.[\w-]+)+/.test(s) && !/^localhost(:\d+)?/i.test(s) && !/^\d+\.\d+\.\d+\.\d+/.test(s)) return '';
      s = 'http://' + s;
    }
    try {
      var u = new URL(s);
      if (!/^https?:$/.test(u.protocol)) return '';
      return u.href;
    } catch (e) { return ''; }
  }

  function hostOf(url) {
    /* 用 host 而不是 hostname：内网系统常靠端口区分（8.145.50.4:8000） */
    try { return new URL(url).host.toLowerCase(); } catch (e) { return ''; }
  }

  /**
   * 词首缩写：GitHub → gh，YS 应收 → ys，Chrome 扩展 → 空（中文需拼音表，留到 v1.11）。
   * 这是"缩写"而不是"纠错"——用户就是按首字母记站点的，@gh 打不开 GitHub 会被判定为坏了。
   */
  function abbrOf(label) {
    var parts = String(label || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean);

    if (parts.length >= 2) {
      var out = '';
      parts.forEach(function (p) {
        var m = p.match(/[A-Za-z0-9]/);
        if (m) out += m[0].toLowerCase();
      });
      return out.length >= 2 ? out : '';
    }
    /* 单个全大写词组本身就是缩写：YS、OA、ERP */
    if (parts.length === 1 && /^[A-Z]{2,5}$/.test(parts[0])) return parts[0].toLowerCase();
    return '';
  }

  /** 命中 SITE_MAP 的站点名（GitHub / 飞书 / YonSuite…）；未命中返回空 */
  function knownSite(host) {
    if (!host || !global.Bookmarks || !Bookmarks.siteOf) return '';
    var site = '';
    try { site = Bookmarks.siteOf(host); } catch (e) { return ''; }
    var fallback = host.replace(/^www\./, '').split('.')[0];
    return site && site !== fallback ? site : '';
  }

  /**
   * 候选展示名：已知站点 > 足够短的页面标题 > 域名。
   * 页面标题常常是"XX系统 - 统一身份认证"，超过 14 字就不用了。
   */
  function labelFor(host, title) {
    var known = knownSite(host);
    if (known) return known;
    var t = String(title || '').trim();
    if (t && t.length <= 14 && !/^https?:/i.test(t)) return t;
    return host.replace(/^www\./, '');
  }

  function isNoise(url, host) {
    if (!host) return true;
    if (NOISE_HOST_RE.test(host)) return true;
    if (/^(chrome|chrome-extension|about|edge|file|data|javascript):/i.test(url)) return true;
    if (NOISE_URL_RE.test(url)) return true;
    return false;
  }

  function normalize(raw) {
    var out = { version: 1, tags: [], dismissed: {}, used: {}, updatedAt: 0 };
    if (!raw || typeof raw !== 'object') return out;

    (Array.isArray(raw.tags) ? raw.tags : []).forEach(function (t) {
      if (!t || !t.url) return;
      var url = normalizeUrl(t.url);
      if (!url) return;
      out.tags.push({
        id: String(t.id || newId()),
        label: String(t.label || labelFor(hostOf(url))).slice(0, 40),
        url: url,
        host: hostOf(url),
        aliases: Array.isArray(t.aliases) ? t.aliases.map(String) : [],
        pin: Number.isFinite(t.pin) ? t.pin : out.tags.length,
        hits: Number(t.hits) || 0,
        lastUsed: Number(t.lastUsed) || 0,
        createdAt: Number(t.createdAt) || 0
      });
    });

    out.dismissed = raw.dismissed && typeof raw.dismissed === 'object' ? raw.dismissed : {};
    out.used = raw.used && typeof raw.used === 'object' ? raw.used : {};
    out.updatedAt = Number(raw.updatedAt) || 0;
    return out;
  }

  function load() {
    if (loaded) return Promise.resolve(state);
    if (loading) return loading;
    loading = readStore().then(function (saved) {
      state = normalize(saved);
      loaded = true;
      loading = null;
      return state;
    });
    return loading;
  }

  /* ------------------------- 匹配 ------------------------- */
  function entryOf(tag) {
    return {
      id: tag.id,
      kind: 'manual',
      label: tag.label,
      url: tag.url,
      host: tag.host,
      pin: tag.pin,
      hits: tag.hits,
      lastUsed: tag.lastUsed,
      abbr: abbrOf(tag.label),
      hay: (tag.label + ' ' + tag.host + ' ' + (tag.aliases || []).join(' ')).toLowerCase()
    };
  }

  /** 三级匹配：名称前缀 > 词首缩写 > 名称包含 > 域名前缀 > 域名包含 > 别名 */
  function scoreMatch(entry, q) {
    if (!q) return 1;
    var label = entry.label.toLowerCase();
    var host = entry.host.toLowerCase();
    if (label === q) return 120;
    if (label.indexOf(q) === 0) return 100;
    if (entry.abbr && entry.abbr === q) return 90;
    if (entry.abbr && entry.abbr.indexOf(q) === 0) return 85;
    if (label.indexOf(q) > 0) return 70;
    if (host.indexOf(q) === 0) return 60;
    if (host.indexOf(q) > 0) return 50;
    if (entry.hay.indexOf(q) >= 0) return 30;
    return 0;
  }

  /** 候选最近被真正用过的，往前排（30 天窗口，避免永久霸榜） */
  function usedBoost(host) {
    var u = state.used[host];
    if (!u) return 0;
    if ((Date.now() - (Number(u.t) || 0)) / 864e5 > 30) return 0;
    return Math.min(24, (Number(u.n) || 0) * 4);
  }

  /**
   * 自动候选：常访站点 + 最近书签。
   * 每次调用即时重算，不读库、不累积；同一域名只出一条，且让位给手动标签。
   */
  function buildCandidates(ctx) {
    ctx = ctx || {};
    var out = [];
    var seen = {};
    state.tags.forEach(function (t) { seen[t.host] = 1; });

    (ctx.topSites || []).forEach(function (item, i) {
      var url = normalizeUrl(item && item.url);
      var host = hostOf(url);
      if (!url || !host || seen[host] || isNoise(url, host)) return;
      seen[host] = 1;
      var label = labelFor(host, item.title);
      out.push({
        id: 'auto_' + host,
        kind: 'auto',
        label: label,
        url: url,
        host: host,
        source: 'top',
        score: 90 - i * 3 + usedBoost(host),
        abbr: abbrOf(label),
        hay: (label + ' ' + host).toLowerCase()
      });
    });

    var since = Date.now() - RECENT_BM_DAYS * 864e5;
    var rows = (ctx.rows || []).filter(function (r) {
      return r && r.url && (!r.added || r.added >= since) && !seen[r.host] && !isNoise(r.url, r.host);
    }).sort(function (a, b) { return (b.added || 0) - (a.added || 0); });

    rows.forEach(function (r, j) {
      if (seen[r.host]) return;
      seen[r.host] = 1;
      var label = knownSite(r.host) || r.site || labelFor(r.host);
      out.push({
        id: 'auto_' + r.host,
        kind: 'auto',
        label: label,
        url: r.url,
        host: r.host,
        source: 'bookmark',
        score: 60 - j * 2 + usedBoost(r.host),
        abbr: abbrOf(label),
        hay: ((r.title || '') + ' ' + label + ' ' + r.host).toLowerCase()
      });
    });

    return out
      .filter(function (e) { return (Number(state.dismissed[e.host]) || 0) < DISMISS_LIMIT; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, MAX_CANDIDATES);
  }

  /**
   * @ 面板的唯一数据入口。
   * 空查询：固定区按手写顺序，常用区给 3 个槽位；
   * 有查询：按匹配分排序，固定区与常用区各自放宽条数。
   */
  function search(q, ctx) {
    var query = String(q || '').trim().toLowerCase();

    var pinned = state.tags.map(entryOf).map(function (e) {
      e.match = scoreMatch(e, query);
      return e;
    }).filter(function (e) { return e.match > 0; });

    pinned.sort(function (a, b) {
      if (query && b.match !== a.match) return b.match - a.match;
      if (a.pin !== b.pin) return a.pin - b.pin;             // 手写顺序优先，最近使用只在同序位内微调
      return (b.lastUsed || 0) - (a.lastUsed || 0);
    });
    pinned = pinned.slice(0, PIN_LIMIT);

    var candidates = buildCandidates(ctx).map(function (e) {
      e.match = scoreMatch(e, query);
      return e;
    }).filter(function (e) { return e.match > 0; }).sort(function (a, b) {
      if (b.match !== a.match) return b.match - a.match;
      return b.score - a.score;
    });
    candidates = candidates.slice(0, query ? PIN_LIMIT - 2 : CAND_LIMIT);

    return { pinned: pinned, candidates: candidates, total: state.tags.length };
  }

  /* ------------------------- 写操作 ------------------------- */
  function add(input) {
    input = input || {};
    var url = normalizeUrl(input.url);
    if (!url) return { ok: false, error: 'url' };
    var host = hostOf(url);

    var exist = state.tags.filter(function (t) { return t.url === url; })[0];
    if (exist) return { ok: true, tag: exist, existed: true };
    if (state.tags.length >= MAX_MANUAL) return { ok: false, error: 'full' };

    var label = String(input.label || '').trim();
    /* 显式 pin 用于撤销删除时插回原位；默认排到末尾，与手写顺序一致 */
    var wanted = Number.isFinite(input.pin) ? input.pin : state.tags.length;
    var tag = {
      id: newId(),
      label: (label || labelFor(host, input.title)).slice(0, 40),
      url: url,
      host: host,
      aliases: Array.isArray(input.aliases) ? input.aliases.map(String) : [],
      pin: wanted,
      hits: 0,
      lastUsed: 0,
      createdAt: Date.now()
    };
    state.tags.push(tag);
    /* 插回原位时先把后面的顺延，避免同 pin 时被 createdAt 排到末尾 */
    if (Number.isFinite(input.pin)) {
      state.tags.forEach(function (t) { if (t !== tag && t.pin >= wanted) t.pin += 1; });
    }
    state.tags.sort(function (a, b) { return a.pin - b.pin; });
    state.tags.forEach(function (t, i) { t.pin = i; });

    /* 新建的标签接管该域名，候选里不再重复出现 */
    delete state.dismissed[host];
    persist();
    return { ok: true, tag: tag };
  }

  function remove(id) {
    var before = state.tags.length;
    state.tags = state.tags.filter(function (t) { return t.id !== id; });
    if (state.tags.length === before) return false;
    state.tags.forEach(function (t, i) { t.pin = i; });   // 保持序号连续
    persist();
    return true;
  }

  function rename(id, label) {
    var tag = state.tags.filter(function (t) { return t.id === id; })[0];
    if (!tag) return false;
    var next = String(label || '').trim().slice(0, 40);
    if (!next) return false;
    tag.label = next;
    persist();
    return true;
  }

  function reorder(ids) {
    var map = {};
    (ids || []).forEach(function (id, i) { map[id] = i; });
    state.tags.forEach(function (t) { if (map[t.id] !== undefined) t.pin = map[t.id]; });
    state.tags.sort(function (a, b) { return a.pin - b.pin; });
    state.tags.forEach(function (t, i) { t.pin = i; });
    persist();
  }

  /** 命中即回写：手动标签记命中，自动候选记"这条真被用过" */
  function touch(entry) {
    if (!entry) return;
    if (entry.kind === 'manual') {
      var tag = state.tags.filter(function (t) { return t.id === entry.id; })[0];
      if (!tag) return;
      tag.hits = (Number(tag.hits) || 0) + 1;
      tag.lastUsed = Date.now();
      persist();
      return;
    }
    var host = entry.host;
    if (!host) return;
    var u = state.used[host] || { n: 0, t: 0 };
    state.used[host] = { n: (Number(u.n) || 0) + 1, t: Date.now() };
    persist();
  }

  /** 隐藏候选：累计到阈值后永久不再生成；手动标签不走这里 */
  function dismiss(entry) {
    if (!entry || entry.kind !== 'auto') return 0;
    var host = entry.host;
    state.dismissed[host] = (Number(state.dismissed[host]) || 0) + 1;
    persist();
    return state.dismissed[host];
  }

  /** 清空自动学习数据：隐藏记录与实际使用次数，手动标签保留 */
  function resetLearned() {
    state.dismissed = {};
    state.used = {};
    persist();
  }

  /* ------------------------- 管理页支持 ------------------------- */

  /** 上移 / 下移一位：管理页用按钮而不是拖拽，键盘也能操作 */
  function move(id, delta) {
    var ordered = list();
    var i = -1;
    for (var k = 0; k < ordered.length; k++) if (ordered[k].id === id) { i = k; break; }
    var j = i + delta;
    if (i < 0 || j < 0 || j >= ordered.length) return false;
    var moved = ordered.splice(i, 1)[0];
    ordered.splice(j, 0, moved);
    state.tags = ordered;
    ordered.forEach(function (t, index) { t.pin = index; });
    persist();
    return true;
  }

  /** 恢复被忽略的站点：清掉隐藏计数，下次候选重新出现 */
  function restore(host) {
    if (!host || state.dismissed[host] === undefined) return false;
    delete state.dismissed[host];
    persist();
    return true;
  }

  /** 已忽略列表：带累计次数，按次数降序 */
  function ignored() {
    return Object.keys(state.dismissed).map(function (host) {
      return { host: host, count: Number(state.dismissed[host]) || 0 };
    }).sort(function (a, b) { return b.count - a.count || a.host.localeCompare(b.host); });
  }

  /** 导出只带固定标签：学习数据是本地行为记录，换机器没有意义 */
  function exportData() {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      tags: list().map(function (t) {
        return { label: t.label, url: t.url, aliases: t.aliases || [], pin: t.pin };
      })
    };
  }

  /** 导入：按 url 去重，保留原有顺序，超出上限的部分记为跳过 */
  function importData(text) {
    var data = null;
    try { data = typeof text === 'string' ? JSON.parse(text) : text; }
    catch (e) { return { ok: false, error: 'json', added: 0, skipped: 0 }; }
    if (!data || !Array.isArray(data.tags)) return { ok: false, error: 'shape', added: 0, skipped: 0 };

    var added = 0, skipped = 0;
    data.tags.forEach(function (item) {
      if (!item || !normalizeUrl(item.url)) { skipped++; return; }
      var res = add({ url: item.url, label: item.label, aliases: item.aliases });
      if (res.ok && !res.existed) added++; else skipped++;
    });
    return { ok: true, added: added, skipped: skipped };
  }

  function list() {
    return state.tags.slice().sort(function (a, b) { return a.pin - b.pin; });
  }

  function countOf(host) { return Number(state.dismissed[host]) || 0; }

  global.QuickTags = {
    load: load,
    search: search,
    add: add,
    remove: remove,
    rename: rename,
    reorder: reorder,
    touch: touch,
    dismiss: dismiss,
    resetLearned: resetLearned,
    move: move,
    restore: restore,
    ignored: ignored,
    exportData: exportData,
    importData: importData,
    list: list,
    countOf: countOf,
    normalizeUrl: normalizeUrl,
    hostOf: hostOf,
    abbrOf: abbrOf,
    labelFor: labelFor,
    isNoise: isNoise,
    buildCandidates: buildCandidates,
    /* 仅测试用：注入状态，避免依赖真实存储 */
    _inject: function (raw) { state = normalize(raw); loaded = true; return state; },
    _state: function () { return state; },
    LIMITS: { MAX_MANUAL: MAX_MANUAL, DISMISS_LIMIT: DISMISS_LIMIT, PIN_LIMIT: PIN_LIMIT, CAND_LIMIT: CAND_LIMIT }
  };
})(typeof self !== 'undefined' ? self : window);
