/* 内容索引：缓存合并与有效期。页面和后台共用，不包含界面逻辑。 */
(function (global) {
  'use strict';

  var VERSION = 4;
  var OK_TTL = 30 * 864e5;
  var FAIL_TTL = 864e5;

  function normUrl(url) {
    try { return new URL(url).href; } catch (e) { return ''; }
  }

  function isWeb(url) {
    try { return /^https?:$/.test(new URL(url).protocol); } catch (e) { return false; }
  }

  function fresh(page, now) {
    if (!page) return false;
    if (page.source === 'capture' && page.status === 'ok') return true;
    if (page.version !== VERSION) return false;
    var transient = /^(timeout|network|http_(408|429|500|502|503|504))$/.test(page.refreshError || page.reason || '');
    var ttl = page.status === 'ok' && !page.refreshError ? (page.partial ? 3600e3 : OK_TTL) : transient ? 5 * 60e3 : FAIL_TTL;
    return (now || Date.now()) - (page.checkedAt || page.fetchedAt) <
      ttl;
  }

  function apply(rows, pages) {
    rows.forEach(function (row) {
      var page = pages[normUrl(row.url)];
      if (!page) return;
      row.desc = page && page.status === 'ok' ? page.desc || '' : '';
      row.text = page && page.status === 'ok' ? page.text || '' : '';
      row.pageTitle = page && page.status === 'ok' ? page.title || '' : '';
      row.contentStatus = row.text ? '正文' : row.desc ? '摘要' : '仅标题';
      row.contentAt = page ? page.fetchedAt : 0;
      /* 重建字段，避免重复合并把正文无限追加。 */
      row.hay = [row.title, row.url, row.folder, row.site, row.pageTitle, row.desc, row.text].join(' ').toLowerCase();
    });
    return rows;
  }

  async function hydrate(rows) {
    var pages = await AgentDB.getPages(rows.map(function (r) { return normUrl(r.url); }));
    apply(rows, pages);
    return typeof Documents !== 'undefined' ? Documents.hydrate(rows) : rows;
  }

  global.ContentIndex = { VERSION: VERSION, normUrl: normUrl, isWeb: isWeb,
    fresh: fresh, apply: apply, hydrate: hydrate };
})(typeof self !== 'undefined' ? self : window);
