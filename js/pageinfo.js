/* 公开页面采集：不带 Cookie，提取描述和有限正文；缓存由内容索引统一管理。 */
(function (global) {
  'use strict';

  var CONCURRENCY = 4;
  var TIMEOUT = 5000;
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
    out.desc = out.desc.slice(0, DESC_MAX);
    out.coverage = out.text ? 'html' : 'metadata';
    return out;
  }

  async function fetchOne(url) {
    if (!ContentIndex.isWeb(url)) return { url: url, status: 'fail', reason: 'unsupported', fetchedAt: Date.now(), version: ContentIndex.VERSION };
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT);
    var now = Date.now();

    try {
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
      } finally {
        await reader.cancel().catch(function () {});
      }
      var info = extract(body);
      info.truncated = !!info.truncated || bytes >= HTML_MAX;
      if (LOGIN_HINT.test(info.title)) {
        return { url: url, status: 'fail', reason: 'login_wall', fetchedAt: now };
      }
      var shell = (info.text || '').replace(/\s+/g, ' ').trim();
      if (shell.length < 180 && /^(?:loading[. …]*|加载中[.。 …]*|正在加载[.。 …]*|please (?:enable|turn on) javascript[\s\S]*|you need to enable javascript[\s\S]*|请启用\s*javascript[\s\S]*)$/i.test(shell)) {
        return { url: url, status: 'fail', reason: 'dynamic_shell', title: info.title, fetchedAt: now };
      }
      if (!info.desc && !info.text) {
        return { url: url, status: 'fail', reason: 'no_content', title: info.title, fetchedAt: now };
      }
      return Object.assign(info, { url: url, status: 'ok', source: 'public',
        version: ContentIndex.VERSION, fetchedAt: now });
    } catch (e) {
      return {
        url: url,
        status: 'fail',
        reason: (e && e.name === 'AbortError') ? 'timeout' : 'network',
        fetchedAt: now
      };
    } finally {
      clearTimeout(timer);
    }
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
      var row = await fetchOne(u);
      row.version = ContentIndex.VERSION;
      /* 更新失败时保留已有内容，同时记录失败原因供后续重试。 */
      if (row.status !== 'ok' && cached[u] && cached[u].status === 'ok') {
        row = Object.assign({}, cached[u], { checkedAt: now, version: ContentIndex.VERSION, refreshError: row.reason });
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
