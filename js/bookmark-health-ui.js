/* 书签空间体检报告。 */
(function (global) {
  'use strict';

  function mount() {
    var details = document.getElementById('bookmark-health');
    if (!details) return;
    var summary = document.getElementById('bookmark-health-summary');
    var body = document.getElementById('bookmark-health-body');
    var loading = false;
    var limit = 60;

    async function refresh() {
      if (!details.open || loading) return;
      loading = true;
      summary.textContent = '书签体检 · 正在检查';
      try {
        var issues = await BookmarkHealth.report();
        body.replaceChildren();
        summary.textContent = '书签体检 · ' + issues.length + ' 项待查看';
        if (!issues.length) {
          var empty = document.createElement('p');
          empty.className = 'auto-empty'; empty.textContent = '当前未发现需处理的问题。'; body.append(empty);
        }
        issues.slice(0, limit).forEach(function (issue) {
          var row = document.createElement('div'); row.className = 'enrich-item';
          var main = document.createElement('div'); main.className = 'enrich-main';
          var title = document.createElement(issue.url ? 'a' : 'span');
          title.className = 'enrich-current'; title.textContent = issue.title;
          if (issue.url) { title.href = issue.url; title.target = '_blank'; title.rel = 'noopener noreferrer'; }
          var detail = document.createElement('p'); detail.className = 'enrich-summary';
          detail.textContent = issue.kind + ' · ' + issue.detail;
          main.append(title, detail); row.append(main); body.append(row);
        });
        if (issues.length > limit) {
          var more = document.createElement('button'); more.type = 'button'; more.className = 'btn-ghost'; more.textContent = '查看更多体检结果';
          more.addEventListener('click', function () { limit += 60; refresh(); }); body.append(more);
        }
      } catch (e) { summary.textContent = '书签体检 · 读取失败'; }
      finally { loading = false; }
    }
    details.addEventListener('toggle', refresh);
    document.addEventListener('workspace:view', function (event) {
      if (event.detail === 'bookmarks' || event.detail === 'search') refresh();
    });
  }

  global.BookmarkHealthUI = { mount: mount };
})(typeof self !== 'undefined' ? self : window);
