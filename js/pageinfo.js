/* 公开页面采集：不带 Cookie，提取描述和有限正文；缓存由内容索引统一管理。 */
(function (global) {
  'use strict';
  var inFlight = new Map();

  var CONCURRENCY = 4;
  var TIMEOUT = 5000;
  var RETRY_TIMEOUT = 8000;
  var DESC_MAX = 180;
  var TITLE_MAX = 80;
  var HTML_MAX = 1000000;
  var TEXT_MAX = 250000;

  /* 抓回来是登录页，说明这条书签在墙后面，摘要没有意义 */
  var LOGIN_HINT = /^(?:(?:登录|登陆)(?:\s|[-|·—]|$)|sign\s?in\b|log\s?in\b|请先登录|扫码登录)/i;

  function clean(s) {
    return String(s || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[\u200b-\u200d\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* 只识别短提示，避免误伤讨论登录或浏览器兼容性的文章。 */
  function placeholder(text) {
    return /^(?:loading[. …]*|加载中[.。 …]*|正在加载[.。 …]*|please (?:enable|turn on) javascript[\s\S]*|you need to enable javascript[\s\S]*|请启用\s*javascript[\s\S]*|(?:your |this )?browser (?:is (?:not supported|unsupported)|not supported)[\s\S]*|unsupported browser[\s\S]*|(?:当前|您的)?浏览器不(?:受支持|支持)[\s\S]*|just a moment[. …]*|checking your browser[\s\S]*|access denied[\s\S]*)$/i.test(text);
  }

  /** 解析为独立文档，绝不把外部 HTML 插入扩展界面。 */
  function extract(html) {
    var out = { title: '', desc: '', text: '' };
    if (!html) return out;

    var m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (m) out.title = clean(m[1]).slice(0, TITLE_MAX);

    var metas = html.match(/<meta\b[^>]*>/gi) || [];
    for (var i = 0; i < metas.length; i++) {
      var tag = metas[i];
      var n = tag.match(/(?:name|property)\s*=\s*["']([^"']+)["']/i);
      var c = tag.match(/content\s*=\s*["']([^"']*)["']/i);
      if (!n || !c) continue;

      var key = n[1].toLowerCase();
      var val = clean(c[1]);

      if (key === 'description' || key === 'og:description' || key === 'twitter:description') {
        if (val.length > out.desc.length) out.desc = val;
      } else if ((key === 'og:title' || key === 'twitter:title') && !out.title) {
        out.title = val.slice(0, TITLE_MAX);
      }
    }

    if (typeof DOMParser !== 'undefined') {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      out.title = (doc.title || out.title).trim().slice(0, TITLE_MAX);
      out.desc = '';
      doc.querySelectorAll('meta').forEach(function (meta) {
        var name = (meta.getAttribute('name') || meta.getAttribute('property') || '').toLowerCase();
        var value = meta.getAttribute('content') || '';
        if (/^(description|og:description|twitter:description)$/.test(name) && value.length > out.desc.length) out.desc = value;
      });
      doc.querySelectorAll('script, style, noscript, template, nav, header, footer, aside, form, svg, [hidden], [aria-hidden="true"]').forEach(function (node) { node.remove(); });
      var main = doc.querySelector('article') || doc.querySelector('main') || doc.querySelector('[role="main"]') || doc.body;
      if (main) main.querySelectorAll('p, div, h1, h2, h3, li, pre, br').forEach(function (node) { node.appendChild(doc.createTextNode(' ')); });
      var text = main ? String(main.textContent || '').replace(/\s+/g, ' ').trim() : '';
      out.headings = Array.from(main ? main.querySelectorAll('h1,h2,h3,h4') : []).map(function (node) { return node.textContent.trim(); }).filter(Boolean).slice(0, 80);
      out.text = text.slice(0, TEXT_MAX); out.truncated = text.length > TEXT_MAX;
    } else {
      /* 后台没有 DOMParser，仅用于后台采集的兼容路径。 */
      var body = html.match(/<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)>/i)
        || html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
      out.text = body ? clean(body[1].replace(/<(nav|header|footer|aside|form|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')).slice(0, TEXT_MAX) : '';
    }
    /* SPA 或图片站常把有效描述放在 JSON-LD 中；仅取明确字段，不执行脚本。 */
    var scripts = html.match(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
    var visited = 0;
    function structured(value, depth) {
      if (!value || typeof value !== 'object' || depth > 6 || ++visited > 200) return;
      if (Array.isArray(value)) { value.forEach(function (item) { structured(item, depth + 1); }); return; }
      if (!out.title && typeof (value.headline || value.name) === 'string') out.title = clean(value.headline || value.name).slice(0, TITLE_MAX);
      if ((!out.desc || placeholder(out.desc)) && typeof value.description === 'string') out.desc = clean(value.description);
      if (value['@graph']) structured(value['@graph'], depth + 1);
      if (value.mainEntity) structured(value.mainEntity, depth + 1);
    }
    scripts.forEach(function (script) {
      try { structured(JSON.parse(script.replace(/^<script\b[^>]*>/i, '').replace(/<\/script>$/i, '')), 0); } catch (e) { /* 忽略损坏的结构化数据 */ }
    });
    out.desc = clean(out.desc).slice(0, DESC_MAX);
    out.coverage = out.text ? 'html' : 'metadata';
    return out;
  }

  async function fetchAttempt(url, timeout) {
    if (!ContentIndex.isWeb(url)) return { url: url, status: 'fail', reason: 'unsupported', fetchedAt: Date.now(), version: ContentIndex.VERSION };
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeout);
    var now = Date.now();

    try {
      if (global.ResourceGate) await ResourceGate.reserve('capture');
      var res = await fetch(url, {
        credentials: 'omit',
        redirect: 'follow',
        signal: ctrl.signal
      });

      if (!res.ok) {
        return { url: url, status: 'fail', reason: 'http_' + res.status, fetchedAt: now };
      }

      var ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct && ct.indexOf('html') === -1) {
        return { url: url, status: 'fail', reason: 'not_html', fetchedAt: now };
      }

      /* 流式限制响应大小，避免先下载完整的大文件再截断。 */
      var reader = res.body.getReader();
      var decoder = null;
      var body = '';
      var readError = null;
      var bytes = 0;
      try {
        while (bytes < HTML_MAX) {
          var part = await reader.read();
          if (part.done) break;
          if (!decoder) {
            var headerCharset = ct.match(/charset\s*=\s*["']?([^;"'\s]+)/i);
            var first = new TextDecoder('windows-1252').decode(part.value.subarray(0, 4096));
            var metaCharset = first.match(/charset\s*=\s*["']?([^;"'\s/>]+)/i);
            try { decoder = new TextDecoder((headerCharset && headerCharset[1]) || (metaCharset && metaCharset[1]) || 'utf-8'); }
            catch (e) { decoder = new TextDecoder(); }
          }
          var remaining = HTML_MAX - bytes;
          bytes += part.value.byteLength;
          body += decoder.decode(part.value.subarray(0, remaining), { stream: true });
        }
        if (decoder) body += decoder.decode();
      } catch (e) {
        readError = e;
        if (decoder) body += decoder.decode();
      } finally {
        reader.cancel().catch(function () {});
      }
      var info = extract(body);
      info.truncated = !!info.truncated || bytes >= HTML_MAX;
      if (LOGIN_HINT.test(info.title)) {
        return { url: url, status: 'fail', reason: 'login_wall', fetchedAt: now };
      }
      var shell = (info.text || '').replace(/\s+/g, ' ').trim();
      var isShell = shell.length < 600 && placeholder(shell);
      if (isShell) info.text = '';
      if (placeholder(info.desc)) info.desc = '';
      if (!info.desc && !info.text) {
        return { url: url, status: 'fail', reason: readError ? (ctrl.signal.aborted ? 'timeout' : 'network') : isShell ? 'dynamic_shell' : 'no_content', title: info.title, fetchedAt: now };
      }
      info.coverage = info.text ? 'html' : 'metadata';
      if (readError) { info.truncated = true; info.partial = true; }
      return Object.assign(info, { url: url, status: 'ok', source: 'public',
        version: ContentIndex.VERSION, fetchedAt: now });
    } catch (e) {
      return {
        url: url,
        status: 'fail',
        reason: e && /ERR_BLOCKED_BY_CLIENT/.test(e.message || '') ? 'client_blocked' : e && e.code === 'daily_limit' ? 'daily_limit' : (e && e.name === 'AbortError') ? 'timeout' : 'network',
        fetchedAt: now
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /* 仅临时网络故障及服务器故障重试一次；不重试登录墙和权限拒绝。 */
  async function fetchOne(url) {
    if (global.NetworkStatus && await NetworkStatus.waiting()) return { url: url, status: 'fail', reason: 'network_suspected', source: 'public', fetchedAt: Date.now(), operation: 'capture', requestSource: 'local' };
    var row = await fetchAttempt(url, TIMEOUT);
    if (row.status !== 'ok' && /^(timeout|network|http_(408|500|502|503|504))$/.test(row.reason)) {
      row = await fetchAttempt(url, RETRY_TIMEOUT);
      row.attempts = 2;
    }
    row.operation = 'capture'; row.requestSource = 'local';
    if (global.NetworkStatus) await NetworkStatus.observe(url, row.reason);
    return row;
  }

  /** 固定并发跑任务，避免同时打开几十个连接 */
  async function mapLimit(items, limit, fn) {
    var out = new Array(items.length);
    var cursor = 0;

    async function worker() {
      while (cursor < items.length) {
        var i = cursor++;
        out[i] = await fn(items[i], i);
      }
    }

    var workers = [];
    var n = Math.min(limit, items.length);
    for (var k = 0; k < n; k++) workers.push(worker());
    await Promise.all(workers);
    return out;
  }

  /**
   * 批量取摘要：先查缓存，未命中的再抓。
   * @param {string[]} urls
   * @param {Function} [onProgress] (done, total) => void
   * @returns {Promise<Object>} { [normalizedUrl]: row }
   */
  async function getMany(urls, onProgress, options) {
    options = options || {};
    var uniq = [];
    var seen = {};

    (urls || []).forEach(function (u) {
      var n = ContentIndex.normUrl(u);
      if (!ContentIndex.isWeb(n) || seen[n]) return;
      seen[n] = 1;
      uniq.push(n);
    });

    if (!uniq.length) return {};

    var cached = (typeof AgentDB !== 'undefined')
      ? await AgentDB.getPages(uniq)
      : {};

    var map = {};
    var missing = [];
    var now = Date.now();

    uniq.forEach(function (u) {
      var c = cached[u];
      var fresh = c && c.source === 'capture' || (!options.force && ContentIndex.fresh(c, now));
      if (fresh) map[u] = c;
      else missing.push(u);
    });

    if (!missing.length) {
      if (onProgress) onProgress(uniq.length, uniq.length);
      return map;
    }

    var done = 0;
    await mapLimit(missing, CONCURRENCY, async function (u) {
      var key = u + ':' + !!options.force;
      var task = inFlight.get(key);
      if (!task) { task = fetchOne(u); inFlight.set(key, task); }
      var row;
      try { row = await task; } finally { if (inFlight.get(key) === task) inFlight.delete(key); }
      row = Object.assign({}, row);
      row.version = ContentIndex.VERSION;
      /* 更新失败时保留已有内容，同时记录失败原因供后续重试。 */
      if (row.status !== 'ok' && cached[u] && cached[u].status === 'ok') {
        row = Object.assign({}, cached[u], { checkedAt: now, version: ContentIndex.VERSION, refreshError: row.reason, refreshCheckedAt: row.fetchedAt });
      }
      map[u] = row;
      done++;
      if (onProgress) onProgress(done, missing.length);
      if (typeof AgentDB !== 'undefined') await AgentDB.putPage(row);
    });

    return map;
  }

  global.PageInfo = {
    getMany: getMany,
    normUrl: ContentIndex.normUrl,
    extract: extract,
    clean: clean,
    fetchOne: fetchOne
  };
})(typeof self !== 'undefined' ? self : window);
