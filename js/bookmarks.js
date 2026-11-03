/* ============================================================
   bookmarks.js —— 书签解析与检索
   职责：把 chrome.bookmarks 的树拍平成可检索的行，并提供打分。
   设计要点：
     1. 书签本身没有正文，信息量集中在「标题 / URL 路径 / 文件夹路径」三处，
        所以这三者都要拆成独立字段参与打分，而不是只搜标题。
     2. 中文不分词，用 bigram 切分解决「财务接口」搜不到「财务系统接口文档」。
     3. 时间衰减 + 访问频次，用来回答「上周存的那个」这类模糊描述。
   ============================================================ */
(function (global) {
  'use strict';

  /* 常见站点名映射：让 open.feishu.cn 在三周后仍然能被认成「飞书」 */
  var SITE_MAP = {
    'github.com': 'GitHub',
    'gitlab.com': 'GitLab',
    'gitee.com': 'Gitee',
    'feishu.cn': '飞书',
    'larksuite.com': '飞书',
    'docs.qq.com': '腾讯文档',
    'docs.google.com': 'Google 文档',
    'developer.mozilla.org': 'MDN',
    'stackoverflow.com': 'Stack Overflow',
    'npmjs.com': 'npm',
    'juejin.cn': '掘金',
    'zhihu.com': '知乎',
    'bilibili.com': '哔哩哔哩',
    'youtube.com': 'YouTube',
    'notion.so': 'Notion',
    'yuque.com': '语雀',
    'aliyun.com': '阿里云',
    'cloud.tencent.com': '腾讯云',
    'atlassian.net': 'Jira',
    'yonbip.com': 'YonSuite',
    'chanjet.com': '畅捷通',
    'chatgpt.com': 'ChatGPT',
    'openai.com': 'OpenAI',
    'deepseek.com': 'DeepSeek',
    'csdn.net': 'CSDN',
    'jianshu.com': '简书',
    'sspai.com': '少数派',
    'xiaohongshu.com': '小红书'
  };

  /* URL 里无检索价值的泛用词 */
  var STOP = {
    'www': 1, 'com': 1, 'cn': 1, 'net': 1, 'org': 1, 'io': 1, 'co': 1,
    'http': 1, 'https': 1, 'html': 1, 'htm': 1, 'index': 1, 'default': 1,
    'en': 1, 'zh': 1, 'm': 1, 'amp': 1, 'jsp': 1, 'php': 1
  };

  function siteOf(host) {
    if (!host) return '';
    var parts = host.split('.');
    for (var i = 0; i < parts.length - 1; i++) {
      var key = parts.slice(i).join('.');
      if (SITE_MAP[key]) return SITE_MAP[key];
    }
    /* IP 和 IPv6 没有“主域名”：保留完整地址，否则 8.145.50.4 会变成 8。 */
    if (/^\d+(\.\d+){3}$/.test(host) || host.indexOf(':') >= 0) return host;
    return host.replace(/^www\./, '').split('.')[0];
  }

  function splitWords(s) {
    return s.split(/[-_.\/\s]+/).filter(function (t) {
      return t.length > 1 && !STOP[t];
    });
  }

  /** 拆 URL：拿回 host / 站点名 / 路径语义片段 */
  function parseUrl(url) {
    var host = '';
    var segs = [];
    try {
      var u = new URL(url);
      host = u.hostname.toLowerCase();
      u.pathname.split('/').forEach(function (p) {
        if (!p) return;
        var dec = '';
        try { dec = decodeURIComponent(p); } catch (e) { dec = p; }
        dec = dec.replace(/\.(html?|php|aspx?|jsp|md)$/i, '');
        segs = segs.concat(splitWords(dec.toLowerCase()));
      });
    } catch (e) { /* 非标准 URL（如 chrome://）直接忽略 */ }
    return { host: host, site: siteOf(host), segs: segs.slice(0, 12) };
  }

  /**
   * 把书签树拍平成索引行。
   * 文件夹本身不出现在结果里，但它的名字会拼进 folder 字段——
   * 这是「工作 / 虹迪 / A19财务」这类查询能命中的唯一来源。
   */
  function flatten(tree, histMap) {
    var rows = [];
    histMap = histMap || {};

    (function walk(nodes, path, blocked) {
      nodes.forEach(function (n) {
        if (n.url) {
          var p = parseUrl(n.url);
          var h = histMap[n.url] || null;
          var title = n.title || p.site || n.url;
          var folder = path.join(' / ');
          rows.push({
            id: n.id,
            parentId: n.parentId,
            index: n.index,
            unmodifiable: blocked || !!n.unmodifiable,
            title: title,
            url: n.url,
            host: p.host,
            site: p.site,
            segs: p.segs,
            folder: folder,
            added: n.dateAdded || 0,
            visits: h ? (h.v || 0) : 0,
            lastVisit: h ? (h.t || 0) : 0,
            hay: (title + ' ' + n.url + ' ' + folder + ' ' + p.segs.join(' ') + ' ' + p.site).toLowerCase()
          });
        } else if (n.children) {
          /* 根节点 title 为空，不追加到路径里 */
          walk(n.children, n.title ? path.concat(n.title) : path, blocked || !!n.unmodifiable);
        }
      });
    })(tree, []);

    return rows;
  }

  /**
   * 查询串切分：
   *   中文连续串 → bigram（"财务接口" → 财务 / 务接 / 接口）
   *   英文数字 → 整体保留（"a19" / "manifest"）
   * 这样 "a19财务" 能拆成 [a19, 财务]，避免中英混排整串匹配失败。
   */
  function termsOf(q) {
    var raw = String(q || '').trim().toLowerCase();
    /* IP、带端口的主机和完整网址整体保留：拆成 8/145/50/4 会让几乎所有收藏都命中。 */
    if (/^\d{1,3}(?:\.\d{1,3}){1,3}(?::\d{1,5})?$/.test(raw)) return [raw];
    if (/^[a-z0-9.-]+:\d{1,5}$/.test(raw)) return [raw];
    if (/^(?:https?:\/\/|www\.)\S+$/.test(raw)) return [raw];
    var out = [];
    var re = /[\u4e00-\u9fa5]+|[a-z0-9]+/gi;
    var m;
    while ((m = re.exec(q))) {
      var s = m[0].toLowerCase();
      if (/^[\u4e00-\u9fa5]+$/.test(s) && s.length > 2) {
        for (var i = 0; i < s.length - 1; i++) out.push(s.substr(i, 2));
      } else {
        out.push(s);
      }
    }
    return out.length ? out : [q.toLowerCase()];
  }

  /* 字段权重，后续调优只动这里 */
  var W = {
    titleExact: 12,
    urlExact: 6,
    hostExact: 10,
    hostPrefix: 5,
    folderExact: 5,
    contentExact: 5,
    termTitle: 3.5,
    termFolder: 2.5,
    termAny: 1.5,
    timeDecay: 3,
    timeHalfLife: 90,
    visit: 0.8,
    recentBoost: 1.2
  };

  function score(row, q, now) {
    var ql = q.normalize('NFKC').toLowerCase();
    var title = (row.title || '').toLowerCase();
    var folder = (row.folder || '').toLowerCase();
    var url = (row.url || '').toLowerCase();
    var host = (row.host || '').toLowerCase();
    var hay = row.hay || '';
    var s = 0;
    if (String(row.personalNote || '').normalize('NFKC').toLowerCase().includes(ql)) s += 3;
    if ((row.personalNames || []).some(function (v) { return String(v).normalize('NFKC').toLowerCase() === ql; })) s += 24;

    if (title.indexOf(ql) !== -1) s += W.titleExact;
    if (url.indexOf(ql) !== -1) s += W.urlExact;
    if (host && host === ql) s += W.hostExact;
    else if (host && ql.indexOf('.') !== -1 && host.indexOf(ql) === 0) s += W.hostPrefix;
    if (folder.indexOf(ql) !== -1) s += W.folderExact;
    if ([row.pageTitle, row.desc, row.text].join(' ').toLowerCase().indexOf(ql) !== -1) s += W.contentExact;

    var terms = termsOf(ql);
    var hit = 0;
    var sum = 0;
    terms.forEach(function (t) {
      var w = 0;
      if (title.indexOf(t) !== -1) w = W.termTitle;
      else if (folder.indexOf(t) !== -1) w = W.termFolder;
      else if (hay.indexOf(t) !== -1) w = W.termAny;
      if (w) hit++;
      sum += w;
    });

    if (terms.length) {
      var cover = hit / terms.length;
      s += sum * (0.4 + 0.6 * cover);
      if (cover < 0.5) s *= 0.5;   /* 只命中一小部分词，多半是噪声 */
    }

    if (row.added) {
      s += W.timeDecay * Math.exp(-(now - row.added) / 864e5 / W.timeHalfLife);
    }
    if (row.visits) s += Math.log1p(row.visits) * W.visit;
    if (row.lastVisit) {
      s += W.recentBoost * Math.exp(-(now - row.lastVisit) / 864e5 / 30);
    }
    return s;
  }

  /**
   * 相关性闸门。
   * 必须解决这个问题：时间衰减分会单独让「最近收藏的」通过阈值，
   * 导致搜「python 教程」也返回四条无关书签。所以进候选前先要求
   * 至少有一个词真正命中，时间与频次只能给命中项加分，不能凭空造结果。
   */
  function matchesQuery(row, terms) {
    var hay = row.hay || '';
    for (var i = 0; i < terms.length; i++) {
      if (hay.indexOf(terms[i]) !== -1) return true;
    }
    return false;
  }

  function query(rows, q, limit, now) {
    now = now || Date.now();
    var ql = (q || '').normalize('NFKC').trim().toLowerCase();
    if (!ql || !rows || !rows.length) return [];

    var terms = termsOf(ql);
    var out = [];

    for (var i = 0; i < rows.length; i++) {
      if (!matchesQuery(rows[i], terms)) continue;
      var s = score(rows[i], ql, now);
      if (s >= 2) out.push({ row: rows[i], score: s });
    }

    out.sort(function (a, b) {
      return b.score - a.score || (b.row.added || 0) - (a.row.added || 0);
    });
    return out.slice(0, limit || 30);
  }

  /** 多路查询按名次融合，避免不同长度关键词的分数直接比较。 */
  function recall(rows, queries, limit) {
    var merged = new Map();
    Array.from(new Set(queries.filter(Boolean))).forEach(function (q) {
      query(rows, q, 40).forEach(function (hit, rank) {
        var entry = merged.get(hit.row.id) || { row: hit.row, score: 0 };
        entry.score += 1 / (20 + rank);
        merged.set(hit.row.id, entry);
      });
    });
    return Array.from(merged.values()).sort(function (a, b) {
      return b.score - a.score || b.row.added - a.row.added;
    }).slice(0, limit || 30);
  }

  /** 展示命中位置附近的真实内容，也用于给模型提供相关证据。 */
  function snippet(row, q) {
    var text = row.retrievedText || [row.desc, row.text].filter(Boolean).join(' ');
    if (!text) return '';
    var lower = text.toLowerCase();
    var terms = [String(q || '').toLowerCase()].concat(termsOf(q || '')).filter(Boolean);
    var pos = -1;
    terms.some(function (term) { pos = lower.indexOf(term); return pos !== -1; });
    var start = Math.max(0, pos - 35);
    return (start ? '…' : '') + text.slice(start, start + 160) + (text.length > start + 160 ? '…' : '');
  }

  /** 检索结果按网页身份去重；保留首条入口和更完整证据，不改动浏览器索引。 */
  function uniquePages(hits) {
    var pages = new Map();
    (hits || []).forEach(function (hit) {
      var row = hit.row || hit;
      var key = 'id:' + row.id;
      try {
        if (global.Documents) key = Documents.identity(row.url).key;
        else {
          var url = new URL(row.url);
          Array.from(url.searchParams.keys()).forEach(function (name) { if (/^utm_|^(fbclid|gclid)$/i.test(name)) url.searchParams.delete(name); });
          url.searchParams.sort(); key = url.href;
        }
      } catch (e) { /* 没有有效网址时按收藏 id 区分。 */ }
      var previous = pages.get(key);
      if (!previous) { pages.set(key, Object.assign({}, hit.row ? hit : {}, { row: Object.assign({}, row) })); return; }
      var restricted = ['invalid', 'excluded', 'metadata'];
      if (restricted.includes(previous.row.admissionState) || restricted.includes(row.admissionState)) return;
      ['text', 'retrievedText', 'desc'].forEach(function (field) {
        if (String(row[field] || '').length > String(previous.row[field] || '').length) previous.row[field] = row[field];
      });
    });
    return Array.from(pages.values());
  }

  global.Bookmarks = {
    SITE_MAP: SITE_MAP,
    parseUrl: parseUrl,
    siteOf: siteOf,
    flatten: flatten,
    termsOf: termsOf,
    score: score,
    query: query,
    recall: recall,
    snippet: snippet,
    uniquePages: uniquePages
  };
})(typeof self !== 'undefined' ? self : window);
