/* ============================================================
   search-suggest.js —— 搜索框实时联想（全网）

   职责：
     1. 调用当前搜索引擎的联想接口，把返回归一成字符串数组；
     2. 提供打分 / 高亮切段 / 最近搜索等本地纯函数；
     3. Session 负责防抖、竞态与状态机（loading / ready / empty / error）。

   与 `/` 书签检索的分工：
     · 普通输入 = 全网联想，输入会发给对应搜索引擎的联想接口；
     · `/` = 纯本地书签检索，不联网。
   ============================================================ */
(function (global) {
  'use strict';

  var LIMITS = {
    items: 8,        // 面板最多展示的候选数
    recent: 60,      // 最近搜索保留条数
    cache: 60        // 查询缓存条数
  };

  var TIMEOUT = 2500;

  function norm(s) {
    return String(s == null ? '' : s).trim().toLowerCase();
  }

  function terms(text) {
    return norm(text).split(/\s+/).filter(Boolean);
  }

  function reEsc(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function looksLikeUrl(text) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(text);
  }

  /* ------------------------- 各引擎的联想接口 ------------------------- */

  function enc(q) {
    return encodeURIComponent(q);
  }

  /** Bing / Google 都是 OpenSearch 格式：["原始词", ["建议1", "建议2"]] */
  function pickOpenSearch(data) {
    return Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];
  }

  var ENGINES = {
    bing: {
      build: function (q) { return 'https://api.bing.com/osjson.aspx?query=' + enc(q) + '&language=zh-CN'; },
      pick: pickOpenSearch
    },
    baidu: {
      build: function (q) { return 'https://www.baidu.com/sugrec?prod=pc&wd=' + enc(q); },
      pick: function (data) {
        return data && Array.isArray(data.g) ? data.g.map(function (row) { return row && row.q; }).filter(Boolean) : [];
      }
    },
    google: {
      build: function (q) { return 'https://suggestqueries.google.com/complete/search?client=firefox&hl=zh-CN&q=' + enc(q); },
      pick: pickOpenSearch
    },
    sogou: {
      /* 搜狗返回 GBK 编码的 window.sogou.sug([...])，需要先解码再剥壳 */
      gbk: true,
      wrapper: true,
      build: function (q) { return 'https://sor.html5.qq.com/api/getsug?key=' + enc(q); },
      pick: pickOpenSearch
    }
  };

  function engineConfig(name) {
    return ENGINES[name] || ENGINES.bing;
  }

  /** 把接口原文解析成建议词数组；格式不认识时返回空数组，不抛异常 */
  function parse(engine, text) {
    var body = String(text == null ? '' : text).trim();
    if (!body) return [];

    var cfg = engineConfig(engine);
    if (cfg.wrapper) {
      var m = body.match(/^[^(]*\(([\s\S]*)\)\s*;?$/);
      if (!m) return [];
      body = m[1];
    }

    var data;
    try { data = JSON.parse(body); } catch (e) { return []; }

    var list = cfg.pick(data);
    var seen = Object.create(null);
    var out = [];
    list.forEach(function (item) {
      var text2 = String(item == null ? '' : item).trim();
      if (!text2) return;
      var key = text2.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push(text2);
    });
    return out;
  }

  /**
   * 请求联想词。fetch 可注入，方便测试；超时与失败统一 reject，
   * 由调用方决定降级（换引擎或提示「联想不可用」）。
   */
  function request(opts) {
    opts = opts || {};
    var engine = opts.engine || 'bing';
    var q = String(opts.query == null ? '' : opts.query).trim();
    if (!q) return Promise.resolve([]);

    var fetchFn = opts.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!fetchFn) return Promise.reject(new Error('fetch_unavailable'));

    var cfg = engineConfig(engine);
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = null;
    if (controller) {
      timer = setTimeout(function () {
        try { controller.abort(); } catch (e) { /* 已结束 */ }
      }, opts.timeout || TIMEOUT);
    }

    var done = function () { if (timer) { clearTimeout(timer); timer = null; } };

    return Promise.resolve(fetchFn(cfg.build(q), {
      signal: controller ? controller.signal : undefined,
      credentials: 'omit'
    })).then(function (res) {
      if (!res || !res.ok) throw new Error('http_' + (res && res.status));
      return cfg.gbk && res.arrayBuffer
        ? res.arrayBuffer().then(function (buf) { return new TextDecoder('gbk').decode(buf); })
        : res.text();
    }).then(function (text) {
      done();
      return parse(engine, text).slice(0, LIMITS.items);
    }, function (err) {
      done();
      throw err;
    });
  }

  /* ------------------------- 本地打分与高亮 ------------------------- */

  /** 词首缩写：GitHub Docs → ghd；中文不参与缩写，交给子串匹配 */
  function initials(text) {
    return String(text || '')
      .split(/[\s\-_./·|:：()（）\[\]]+/)
      .filter(Boolean)
      .map(function (w) { return w.charAt(0); })
      .join('')
      .toLowerCase();
  }

  function oneWord(text, word) {
    if (!text || !word) return 0;
    if (text === word) return 100;
    if (text.indexOf(word) === 0) return 78;
    if (text.split(/[\s\-_./·|:：()（）]+/).some(function (w) { return w && w.indexOf(word) === 0; })) return 62;
    if (text.indexOf(word) > -1) return 44;
    if (word.length > 1 && initials(text).indexOf(word) === 0) return 30;
    return 0;
  }

  /** 最近搜索排序用：完全相等 > 前缀 > 词首 > 包含 */
  function score(text, q) {
    var t = norm(text);
    var list = terms(q);
    if (!t || !list.length) return 0;

    var total = 0;
    for (var i = 0; i < list.length; i++) {
      var s = oneWord(t, list[i]);
      if (!s) return 0;
      total += s;
    }
    var out = total / list.length;
    if (t.indexOf(norm(q)) === 0) out += 8;
    return out + Math.max(0, 6 - Math.floor(t.length / 16));
  }

  /**
   * 把文本按命中词切成段落，供 UI 逐段转义后再包 <mark>。
   * 返回 [{ text, hit }]，拼起来等于原文，不会丢字也不会重复转义。
   */
  function segments(text, q) {
    var t = String(text == null ? '' : text);
    var list = terms(q).sort(function (a, b) { return b.length - a.length; });
    if (!t || !list.length) return [{ text: t, hit: false }];

    var re;
    try { re = new RegExp(list.map(reEsc).join('|'), 'gi'); }
    catch (e) { return [{ text: t, hit: false }]; }

    var out = [];
    var last = 0;
    var m;
    while ((m = re.exec(t)) !== null) {
      if (!m[0]) { re.lastIndex++; continue; }
      if (m.index > last) out.push({ text: t.slice(last, m.index), hit: false });
      out.push({ text: m[0], hit: true });
      last = m.index + m[0].length;
    }
    if (last < t.length) out.push({ text: t.slice(last), hit: false });
    return out.length ? out : [{ text: t, hit: false }];
  }

  /* ------------------------- 最近搜索（空输入时展示） ------------------------- */

  function recency(ts) {
    if (!ts) return 0;
    var days = (Date.now() - ts) / 864e5;
    if (days < 1) return 10;
    if (days < 7) return 6;
    if (days < 30) return 3;
    if (days < 180) return 1;
    return 0;
  }

  function fromRecent(entries, q, limit) {
    var list = Array.isArray(entries) ? entries : [];
    var ql = norm(q);
    var out = [];

    list.forEach(function (entry) {
      var text = String((entry && entry.text) || '').trim();
      if (!text) return;
      var s = ql ? score(text, ql) : 40;
      if (!s) return;
      s += Math.min(10, Math.log((entry.hits || 1) + 1) * 4) + recency(entry.ts);
      out.push({
        kind: 'query',
        id: 'recent:' + text.toLowerCase(),
        text: text,
        source: 'recent',
        hits: entry.hits || 1,
        ts: entry.ts || 0,
        score: s
      });
    });

    out.sort(ql
      ? function (a, b) { return b.score - a.score || (b.ts || 0) - (a.ts || 0); }
      /* 空查询就是「最近搜索」：先按时间倒序，同一时刻再比使用次数 */
      : function (a, b) { return (b.ts || 0) - (a.ts || 0) || (b.hits || 0) - (a.hits || 0); });
    return out.slice(0, limit || 5);
  }

  /* 用户自己搜过的词最贴近意图，接口建议次之 */
  var SOURCE_WEIGHT = { recent: 1.3, web: 1 };

  /** 多来源合并：先按来源内名次折算，再叠加打分尾数，最后去重 */
  function merge(groups, limit) {
    var seen = Object.create(null);
    var pool = [];

    (groups || []).forEach(function (group) {
      var weight = SOURCE_WEIGHT[group.id] || 1;
      (group.items || []).forEach(function (item, rank) {
        if (!item) return;
        var key = item.kind === 'url' ? 'url:' + String(item.url || '') : 'q:' + norm(item.text);
        if (key === 'q:' || seen[key]) return;
        seen[key] = true;
        pool.push({ item: item, rank: weight / (rank + 2) + (item.score || 0) / 1000 });
      });
    });

    pool.sort(function (a, b) { return b.rank - a.rank; });
    return pool.slice(0, limit || LIMITS.items).map(function (entry) { return entry.item; });
  }

  /* ------------------------- 查询状态机 ------------------------- */

  function Session(opts) {
    opts = opts || {};
    this.delay = typeof opts.delay === 'number' ? opts.delay : 130;
    this.minChars = typeof opts.minChars === 'number' ? opts.minChars : 1;
    this.limit = opts.limit || LIMITS.items;
    this.providers = opts.providers || [];
    this.onState = typeof opts.onState === 'function' ? opts.onState : function () {};
    this.seq = 0;                 // 输入序号：只有最后一次的结果能落地
    this.timer = null;
    this.version = 0;             // 数据版本：换引擎后整体作废缓存
    this.cache = new Map();
    this.state = { status: 'idle', query: '', items: [] };
  }

  Session.prototype.key = function (q) {
    return this.version + '|' + norm(q);
  };

  Session.prototype.emit = function (state) {
    this.state = state;
    try { this.onState(state); } catch (e) { /* 渲染异常不能打断输入 */ }
  };

  /**
   * 输入入口：同步给出 loading（有缓存则直接出结果），防抖到点才真正查询。
   * 结束态：ready / empty（没有建议词）/ error（来源全部失败）/ idle（空输入）。
   */
  Session.prototype.update = function (raw) {
    var q = String(raw == null ? '' : raw).trim();
    var self = this;

    this.seq++;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }

    if (!q) { this.emit({ status: 'idle', query: '', items: [] }); return this; }
    if (q.length < this.minChars) { this.emit({ status: 'idle', query: q, items: [] }); return this; }

    var cached = this.cache.get(this.key(q));
    if (cached) { this.emit(cached); return this; }

    var seq = this.seq;
    this.emit({ status: 'loading', query: q, items: [] });
    this.timer = setTimeout(function () {
      self.timer = null;
      self.run(q, seq);
    }, this.delay);
    return this;
  };

  Session.prototype.run = function (q, seq) {
    var self = this;

    var tasks = this.providers.map(function (provider) {
      return Promise.resolve()
        .then(function () { return provider.run(q); })
        .then(
          function (items) { return { id: provider.id, items: items || [] }; },
          function () { return { id: provider.id, items: [], failed: true }; }
        );
    });

    return Promise.all(tasks).then(function (groups) {
      if (seq !== self.seq) return null;        /* 用户已经继续输入，这轮作废 */

      var failed = groups.filter(function (group) { return group.failed; }).length;
      var items = merge(groups, self.limit);
      var state = {
        status: items.length ? 'ready' : (groups.length && failed === groups.length ? 'error' : 'empty'),
        query: q,
        items: items,
        partial: failed > 0 && failed < groups.length
      };

      /* 失败结果不进缓存，网络恢复后同一个词还能重试 */
      if (state.status !== 'error') {
        if (self.cache.size >= LIMITS.cache) self.cache.clear();
        self.cache.set(self.key(q), state);
      }
      self.emit(state);
      return state;
    });
  };

  /** 跳过防抖立即查询（键盘唤回面板时用） */
  Session.prototype.flush = function (raw) {
    var q = String(raw == null ? '' : raw).trim();
    this.seq++;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }

    if (!q) { this.emit({ status: 'idle', query: '', items: [] }); return Promise.resolve(null); }

    var cached = this.cache.get(this.key(q));
    if (cached) { this.emit(cached); return Promise.resolve(cached); }

    this.emit({ status: 'loading', query: q, items: [] });
    return this.run(q, this.seq);
  };

  /** 收起面板：作废在途请求，但不回调 UI（调用方自己已清空） */
  Session.prototype.cancel = function () {
    this.seq++;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.state = { status: 'idle', query: '', items: [] };
    return this;
  };

  /** 换引擎、改设置后调用，避免继续吃旧缓存 */
  Session.prototype.invalidate = function () {
    this.version++;
    this.seq++;
    this.cache.clear();
    return this;
  };

  /* ------------------------- 最近搜索存储 ------------------------- */

  function Recent(storage, key, cap) {
    this.storage = storage || null;
    this.key = key || 'newtab.recentSearches.v1';
    this.cap = cap || LIMITS.recent;
    this.entries = this.load();
  }

  Recent.prototype.load = function () {
    try {
      var raw = this.storage && this.storage.getItem(this.key);
      var list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list)) return [];
      var cap = this.cap;
      return list.filter(function (e) { return e && e.text; }).slice(0, cap);
    } catch (e) {
      return [];     /* 存储损坏时当作没有历史，不影响搜索 */
    }
  };

  Recent.prototype.save = function () {
    try {
      if (this.storage) this.storage.setItem(this.key, JSON.stringify(this.entries));
    } catch (e) { /* 隐私模式或配额满：内存里仍然可用 */ }
    return this;
  };

  Recent.prototype.list = function () {
    return this.entries.slice();
  };

  /** 记录一次搜索：同词去重、次数累加、置顶；URL 不算搜索词 */
  Recent.prototype.record = function (text) {
    var value = String(text == null ? '' : text).trim();
    if (!value || value.length > 120 || looksLikeUrl(value)) return this.list();

    var key = value.toLowerCase();
    var hits = 0;
    this.entries = this.entries.filter(function (entry) {
      if (String(entry.text).toLowerCase() === key) { hits = entry.hits || 1; return false; }
      return true;
    });
    this.entries.unshift({ text: value, hits: hits + 1, ts: Date.now() });
    this.entries = this.entries.slice(0, this.cap);
    this.save();
    return this.list();
  };

  Recent.prototype.remove = function (text) {
    var key = norm(text);
    this.entries = this.entries.filter(function (entry) { return norm(entry.text) !== key; });
    this.save();
    return this.list();
  };

  Recent.prototype.clear = function () {
    this.entries = [];
    this.save();
    return this.list();
  };

  global.SearchSuggest = {
    LIMITS: LIMITS,
    ENGINES: Object.keys(ENGINES),
    normalize: norm,
    terms: terms,
    score: score,
    segments: segments,
    fromRecent: fromRecent,
    merge: merge,
    parse: parse,
    request: request,
    looksLikeUrl: looksLikeUrl,
    createSession: function (opts) { return new Session(opts); },
    createRecent: function (storage, key, cap) { return new Recent(storage, key, cap); }
  };
})(typeof self !== 'undefined' ? self : window);
