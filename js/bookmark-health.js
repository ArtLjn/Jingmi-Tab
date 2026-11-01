/* 书签体检只读分析，所有结论都来自本机书签树和已采集状态。 */
(function (global) {
  'use strict';

  function inspect(tree, rows, pages, now) {
    now = now || Date.now();
    var issues = [];
    var seenUrls = new Map();
    var seenContent = new Map();
    var byId = new Map((rows || []).map(function (row) { return [String(row.id), row]; }));

    function add(kind, row, detail) {
      issues.push({ kind: kind, id: String(row.id), title: row.title || row.url || '未命名目录',
        url: row.url || '', detail: detail || '' });
    }

    (rows || []).forEach(function (row) {
      if (!ContentIndex.isWeb(row.url)) return;
      var url = ContentIndex.normUrl(row.url);
      var page = pages[url];
      if (seenUrls.has(url)) add('重复网址', row, '与「' + seenUrls.get(url).title + '」地址相同');
      else seenUrls.set(url, row);
      if (page && page.status === 'fail' && (page.reason === 'http_404' || page.reason === 'http_410')) {
        add('失效链接', row, '最近采集返回 ' + page.reason.slice(5));
      }
      if (page && page.status === 'ok' && page.text && page.contentHash) {
        var previous = seenContent.get(page.contentHash);
        if (previous && previous.url !== row.url) add('重复内容', row, '正文与「' + previous.title + '」相同');
        else seenContent.set(page.contentHash, row);
      }
      if (row.added && now - row.added > 180 * 864e5 && !row.visits && !row.lastVisit) {
        add('长期未读', row, '收藏超过 180 天，未记录到访问');
      }
      if (!page || page.status !== 'ok' || !page.text) add('无正文', row, '可补采正文');
    });

    function walk(nodes, blocked) {
      (nodes || []).forEach(function (node) {
        var locked = blocked || !!node.unmodifiable;
        if (!node.children) return;
        if (node.title && !locked) {
          if (!node.children.length) add('空目录', node, '目录没有收藏');
          else if (node.children.length === 1 && node.children[0].url && byId.has(String(node.children[0].id))) {
            var only = byId.get(String(node.children[0].id));
            if (!only.lastVisit && only.added && now - only.added > 180 * 864e5) {
              add('单条目录', node, '仅有一条长期未读收藏');
            }
          }
        }
        walk(node.children, locked);
      });
    }
    walk(tree, false);
    return issues;
  }

  async function report() {
    var tree = await chrome.bookmarks.getTree();
    var rows = Bookmarks.flatten(tree);
    var pages = await AgentDB.getPages(rows.map(function (row) { return ContentIndex.normUrl(row.url); }));
    return inspect(tree, rows, pages);
  }

  global.BookmarkHealth = { inspect: inspect, report: report };
})(typeof self !== 'undefined' ? self : window);
