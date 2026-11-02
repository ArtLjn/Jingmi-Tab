/* 收藏补全面板：正文采集进度与标题建议的确认、批量应用。 */
(function (global) {
  'use strict';

  function mount() {
    var card = document.getElementById('enrich-card');
    if (!card) return { refresh: function () {} };
    var toggle = document.getElementById('enrich-enabled');
    var status = document.getElementById('enrich-status');
    var summary = document.getElementById('enrich-summary');
    var body = document.getElementById('enrich-body');
    var scan = document.getElementById('enrich-scan');
    var capture = document.getElementById('enrich-capture');
    var details = document.getElementById('enrich-details');
    var busy = false;

    function el(tag, text, className) {
      var node = document.createElement(tag);
      if (text) node.textContent = text;
      if (className) node.className = className;
      return node;
    }

    async function send(type, extra) {
      var result = await chrome.runtime.sendMessage(Object.assign({ type: type }, extra));
      if (!result || !result.ok) throw new Error(result && result.error || '后台未响应，请重新加载扩展');
      return result.data;
    }

    function renderItem(item) {
      var row = el('div', '', 'enrich-item');
      var main = el('div', '', 'enrich-main');
      main.append(el('p', item.currentTitle || item.url, 'enrich-current'));
      if (item.title) main.append(el('p', '→ ' + item.title, 'enrich-suggest'));
      if (item.summary) main.append(el('p', item.summary, 'enrich-summary'));
      if (item.tags && item.tags.length) {
        main.append(el('p', item.tags.map(function (tag) { return '#' + tag; }).join('  '), 'enrich-tags'));
      }
      if (item.facts && item.facts.length) main.append(el('p', item.facts.join(' · '), 'enrich-summary'));
      main.append(el('p', item.host || '', 'enrich-host'));

      var actions = el('div', '', 'enrich-actions');
      if (item.title || (item.tags && item.tags.length)) {
        var apply = el('button', '应用', 'auto-action adopt');
        apply.type = 'button';
        apply.dataset.enrichApply = item.id;
        actions.append(apply);
      }
      var dismiss = el('button', '忽略', 'auto-action');
      dismiss.type = 'button';
      dismiss.dataset.enrichDismiss = item.id;
      actions.append(dismiss);
      row.append(main, actions);
      return row;
    }

    function render(state) {
      if (!state) return;
      toggle.checked = !!state.enabled;
      var pending = state.pending || [];
      var failures = state.failures || [];
      status.textContent = state.collection ? CollectionStats.format(state.collection) : '正在读取收藏收录状态…';
      var accounting = document.getElementById('enrich-accounting');
      if (!accounting) { accounting = el('p', '', 'enrich-summary'); accounting.id = 'enrich-accounting'; status.after(accounting); }
      accounting.textContent = state.collection ? CollectionStats.breakdown(state.collection) : '';
      status.title = '总数＝已收录＋未收录；未收录＝队列＋失败＋需人工处理＋暂停＋待安排，各类互斥。已收录的后续更新单独列出，不计入未收录队列与失败。';
      summary.textContent = 'AI 建议待确认 ' + (state.totalPending || 0) + ' · 采集补全异常 ' + (state.totalFailed || 0);
      body.replaceChildren();
      if (!pending.length && !failures.length) {
        body.append(el('p', '暂无需要你处理的内容，完成的项目会自动从这里移除。', 'auto-empty'));
      }

      var toolbar = el('div', '', 'enrich-toolbar');
      if (state.retryableFailed > 0) {
        var retryAll = el('button', '重试可重试项', 'btn-ghost');
        retryAll.type = 'button';
        retryAll.id = 'enrich-retry-unsuccessful';
        toolbar.append(retryAll);
      }
      if (pending.length > 1) {
        var all = el('button', '全部应用', 'btn-ghost enrich-all');
        all.type = 'button';
        all.id = 'enrich-apply-all';
        toolbar.append(all);
      }
      if (state.undoable) {
        var undo = el('button', '撤销上次应用', 'btn-ghost');
        undo.type = 'button';
        undo.id = 'enrich-undo';
        toolbar.append(undo);
      }
      if ((state.totalFailed || 0) > failures.length) body.append(el('p', '当前展示最近 ' + failures.length + ' 条，批量重试仅处理可重试项，跳过需人工处理和已停止项。', 'enrich-summary'));
      if (toolbar.childNodes.length) body.append(toolbar);
      pending.forEach(function (item) { body.append(renderItem(item)); });
      if (state.recent && state.recent.length) {
        body.append(el('p', '最近生成的摘要', 'enrich-current'));
        state.recent.forEach(function (item) {
          var row = el('div', '', 'enrich-item');
          var main = el('div', '', 'enrich-main');
          var link = el('a', item.title || item.url || '收藏摘要', 'enrich-current');
          link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
          main.append(link, el('p', item.summary || '', 'enrich-summary'));
          if (item.facts && item.facts.length) main.append(el('p', item.facts.join(' · '), 'enrich-summary'));
          row.append(main); body.append(row);
        });
      }
      if (state.failures && state.failures.length) {
        body.append(el('p', '采集补全异常（与 RAG 入库状态分别记录）', 'enrich-current'));
        state.failures.forEach(function (item) {
          var row = el('div', '', 'enrich-item');
          var main = el('div', '', 'enrich-main');
          main.append(el('p', item.title || item.url || item.id, 'enrich-current'));
          var manual = ['http_401', 'http_403', 'dynamic_shell', 'login_wall', 'no_content'].includes(item.code);
          var reason = item.code === 'private' ? '已保存页面正文；生成建议前需确认发送片段给 AI'
            : manual ? '公开抓取无法读取正文；打开页面后点击扩展图标采集'
              : item.reason;
          if (item.code === 'daily_limit') reason = '今日采集额度已用完，明日恢复；手动重试不会重置额度';
          var policy = item.policy || RetryPolicy.classify(item.code, item.attempts);
          reason += ' · ' + policy.message;
          main.append(el('p', reason, 'enrich-summary'));
          if (item.code === 'private') {
            var consent = el('button', '发送正文给 AI', 'auto-action');
            consent.type = 'button';
            consent.dataset.enrichPrivate = item.id;
            row.append(main, consent);
          } else if (manual && item.url) {
            var open = el('a', '打开页面', 'auto-action');
            open.href = item.url;
            open.target = '_blank';
            open.rel = 'noopener noreferrer';
            row.append(main, open);
          } else if (policy.allowManual) {
            var retry = el('button', policy.auto ? '重新抓取' : '检查后重试', 'auto-action');
            retry.type = 'button';
            retry.dataset.enrichRetry = item.id;
            row.append(main, retry);
          } else { row.append(main); }
          body.append(row);
        });
      }
    }

    async function refresh() {
      try { render(await send('enrich:status')); }
      catch (e) { status.textContent = e.message; }
    }

    async function act(fn) {
      if (busy) return;
      busy = true;
      try {
        var state = await fn();
        if (state) render(state);
      } catch (e) {
        status.textContent = e.message;
      } finally {
        busy = false;
      }
    }

    toggle.addEventListener('change', function () {
      act(function () { return send('enrich:toggle', { enabled: toggle.checked }); });
    });

    async function scanInto(type, limit, message) {
      if (busy) return;
      busy = true;
      status.textContent = message;
      try { await send(type, { limit: limit }); }
      catch (e) { status.textContent = e.message; }
      finally { busy = false; await refresh(); }
    }

    scan.addEventListener('click', function () { scanInto('enrich:scan', null, '正在登记全部现有书签…'); });
    capture.addEventListener('click', function () { scanInto('enrich:capture', null, '正在登记全部缺失或过期正文…'); });

    body.addEventListener('click', function (event) {
      if (event.target.closest('#enrich-retry-unsuccessful')) { scanInto('enrich:retry-failed', null, '正在登记全部失败项…'); return; }
      var apply = event.target.closest('[data-enrich-apply]');
      if (apply) { act(function () { return send('enrich:apply', { id: apply.dataset.enrichApply }); }); return; }
      var dismiss = event.target.closest('[data-enrich-dismiss]');
      if (dismiss) { act(function () { return send('enrich:dismiss', { id: dismiss.dataset.enrichDismiss }); }); return; }
      var retry = event.target.closest('[data-enrich-retry]');
      if (retry) { act(function () { return send('enrich:retry', { id: retry.dataset.enrichRetry }); }); return; }
      var consent = event.target.closest('[data-enrich-private]');
      if (consent) { act(function () { return send('enrich:suggest-private', { id: consent.dataset.enrichPrivate }); }); return; }
      if (event.target.closest('#enrich-apply-all')) {
        act(function () { return send('enrich:apply-all'); });
        return;
      }
      if (event.target.closest('#enrich-undo')) {
        act(function () { return send('enrich:undo'); });
      }
    });

    details.addEventListener('toggle', function () { if (details.open) refresh(); });
    document.addEventListener('workspace:view', function (event) {
      if (event.detail === 'search') refresh();
    });
    setInterval(function () {
      var search = document.getElementById('workspace-search');
      if (!search || search.hidden || !document.body.classList.contains('panel-open')) return;
      refresh();
    }, 5000);

    refresh();
    return { refresh: refresh };
  }

  global.BookmarkEnrichUI = { mount: mount };
})(typeof self !== 'undefined' ? self : window);
