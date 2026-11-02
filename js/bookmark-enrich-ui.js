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
    var filters = document.getElementById('enrich-filters');
    var busy = false;
    var filter = 'pending';
    var filterTouched = false;
    var lastState = null;
    var FILTERS = [
      { key: 'pending', label: '待确认' },
      { key: 'failures', label: '补全异常' },
      { key: 'recent', label: '最近成功' }
    ];
    var detailWrap = document.getElementById('search-page-detail-wrap');
    var detailName = document.getElementById('search-page-detail');
    var pageName = document.getElementById('search-page-name');
    var enrichPage = document.querySelector('[data-search-page="enrich"]');

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

    function countsOf(state) {
      var failures = state.failures || [];
      return {
        pending: Math.max(Number(state.totalPending) || 0, (state.pending || []).length),
        failures: Math.max(Number(state.totalFailed) || 0, failures.length),
        recent: (state.recent || []).length
      };
    }

    function pickFilter(counts) {
      if (counts.pending) return 'pending';
      if (counts.failures) return 'failures';
      if (counts.recent) return 'recent';
      return 'pending';
    }

    function activeFilterLabel() {
      for (var i = 0; i < FILTERS.length; i++) if (FILTERS[i].key === filter) return FILTERS[i].label;
      return FILTERS[0].label;
    }

    /* 补全页的第三个面包屑段表示当前列表；离开本页时交给 workspace 管理。 */
    function syncBreadcrumb() {
      if (!detailWrap || !detailName) return;
      if (!enrichPage || enrichPage.hidden) return;
      detailWrap.hidden = false;
      detailName.textContent = activeFilterLabel();
      detailName.setAttribute('aria-current', 'page');
      if (pageName) pageName.removeAttribute('aria-current');
    }

    function renderFilters(state) {
      if (!filters) return;
      var counts = countsOf(state);
      var total = counts.pending + counts.failures + counts.recent;
      filters.hidden = !total;
      filters.replaceChildren();
      if (!total) return;
      FILTERS.forEach(function (meta) {
        var button = el('button', '', 'enrich-filter' + (filter === meta.key ? ' is-active' : ''));
        button.type = 'button';
        button.dataset.filter = meta.key;
        button.setAttribute('aria-pressed', String(filter === meta.key));
        button.setAttribute('aria-controls', 'enrich-body');
        button.append(el('span', meta.label), el('em', String(counts[meta.key])));
        filters.append(button);
      });
    }

    /* 补全异常同时包含“未收录异常”和“已收录后的后续异常”，在列表顶部拆开口径。 */
    function failureScope(state) {
      var c = state.collection;
      if (!c || !c.states || !c.updates) return '';
      var uncollected = (Number(c.states.failed) || 0) + (Number(c.states.manual) || 0) + (Number(c.states.paused) || 0);
      var updates = Number(c.updates.failed) || 0;
      var total = Number(state.totalFailed) || 0;
      if (!uncollected || !updates || uncollected + updates !== total) return '';
      return total + ' 条中：未收录异常 ' + uncollected + ' · 已收录后续异常 ' + updates;
    }

    function failureInfo(item) {
      var manual = ['http_401', 'http_403', 'dynamic_shell', 'login_wall', 'no_content'].includes(item.code);
      var reason = item.code === 'private' ? '已保存页面正文；生成建议前需确认发送片段给 AI'
        : manual ? '公开抓取无法读取正文；打开页面后点击扩展图标采集'
          : item.reason;
      if (item.code === 'daily_limit') reason = '今日采集额度已用完，明日恢复；手动重试不会重置额度';
      var policy = item.policy || RetryPolicy.classify(item.code, item.attempts);
      var tone = policy.kind === 'retryable' ? 'retryable'
        : policy.kind === 'paused' ? 'paused'
          : policy.kind === 'manual' ? 'manual' : 'stopped';
      var label = policy.kind === 'retryable' ? (policy.auto ? '可自动重试' : '自动重试已达上限')
        : policy.kind === 'paused' ? '已暂停'
          : policy.kind === 'manual' ? '需人工处理' : '已停止';
      /* 重试类补充策略说明；人工/暂停类的原因已经写清楚，不再拼接重复文案。 */
      var detail = policy.kind === 'retryable' || policy.kind === 'stopped' ? ' · ' + policy.message : '';
      return { manual: manual, policy: policy, reason: reason + detail, tone: tone, label: label,
        category: RetryPolicy.category(item.code) };
    }

    function failureTagSummary(state) {
      var tags = Array.isArray(state.failureTags) ? state.failureTags : [];
      if (!tags.length) return '';
      return '类型：' + tags.map(function (tag) { return tag.label + ' ' + tag.count; }).join(' · ');
    }

    function renderFailure(item) {
      var info = failureInfo(item);
      var row = el('div', '', 'enrich-item');
      var main = el('div', '', 'enrich-main');
      var head = el('div', '', 'enrich-item-head');
      var tags = el('span', '', 'enrich-item-tags');
      tags.append(el('span', info.category.label, 'enrich-cat-chip'),
        el('span', info.label, 'enrich-status-chip is-' + info.tone));
      head.append(el('p', item.title || item.url || item.id, 'enrich-current'), tags);
      main.append(head, el('p', info.reason, 'enrich-summary'));
      var action = null;
      if (item.code === 'private') {
        action = el('button', '发送正文给 AI', 'auto-action');
        action.type = 'button';
        action.dataset.enrichPrivate = item.id;
      } else if (info.manual && item.url) {
        action = el('a', '打开页面', 'auto-action');
        action.href = item.url;
        action.target = '_blank';
        action.rel = 'noopener noreferrer';
      } else if (info.policy.allowManual) {
        action = el('button', info.policy.auto ? '重新抓取' : '检查后重试', 'auto-action');
        action.type = 'button';
        action.dataset.enrichRetry = item.id;
      }
      row.append(main);
      if (action) row.append(action);
      return row;
    }

    function renderRecent(item) {
      var row = el('div', '', 'enrich-item');
      var main = el('div', '', 'enrich-main');
      var link = el('a', item.title || item.url || '收藏摘要', 'enrich-current');
      link.href = item.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      main.append(link, el('p', item.summary || '', 'enrich-summary'));
      if (item.facts && item.facts.length) main.append(el('p', item.facts.join(' · '), 'enrich-summary'));
      row.append(main);
      return row;
    }

    function renderToolbar(state, selected) {
      var toolbar = el('div', '', 'enrich-toolbar');
      if ((selected === 'failures') && state.retryableFailed > 0) {
        var retryAll = el('button', '重试可重试项', 'btn-ghost');
        retryAll.type = 'button';
        retryAll.id = 'enrich-retry-unsuccessful';
        toolbar.append(retryAll);
      }
      if (selected === 'pending' && (state.pending || []).length > 1) {
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
      return toolbar.childNodes.length ? toolbar : null;
    }

    function render(state) {
      if (!state) return;
      lastState = state;
      toggle.checked = !!state.enabled;
      var counts = countsOf(state);
      if (!filterTouched) filter = pickFilter(counts);
      var pending = state.pending || [];
      var failures = state.failures || [];
      var recent = state.recent || [];
      status.textContent = state.collection ? CollectionStats.format(state.collection) : '正在读取补全状态…';
      var accounting = document.getElementById('enrich-accounting');
      if (!accounting) { accounting = el('p', '', 'enrich-summary'); accounting.id = 'enrich-accounting'; status.after(accounting); }
      accounting.textContent = state.collection ? CollectionStats.breakdown(state.collection) : '';
      status.title = '总书签＝已收录＋未收录；未收录明细按书签逐条统计。下方补全任务按任务单独计数。';
      summary.textContent = 'AI 建议待确认 ' + counts.pending + ' · 采集补全异常 ' + counts.failures;
      renderFilters(state);
      syncBreadcrumb();
      body.replaceChildren();

      var toolbar = renderToolbar(state, filter);
      if (!counts.pending && !counts.failures && !counts.recent) {
        if (toolbar) body.append(toolbar);
        body.append(el('p', '暂无需要你处理的内容，完成的项目会自动从这里移除。', 'auto-empty'));
        return;
      }

      if (filter === 'pending') {
        if (counts.pending > pending.length) body.append(el('p', '当前展示最近 ' + pending.length + ' 条待确认建议。', 'enrich-summary'));
        if (toolbar) body.append(toolbar);
        if (pending.length) pending.forEach(function (item) { body.append(renderItem(item)); });
        else body.append(el('p', '暂无待确认建议。', 'auto-empty'));
        return;
      }

      if (filter === 'failures') {
        var scope = failureScope(state);
        var scopeBox = el('div', '', 'enrich-scope');
        scopeBox.append(el('p', '补全 = 生成标题、摘要和标签。已入库书签的后续更新失败也会出现在这里，但仍可正常检索。', 'enrich-scope-line'));
        if (scope) scopeBox.append(el('p', scope, 'enrich-scope-line is-count'));
        var tagSummary = failureTagSummary(state);
        if (tagSummary) scopeBox.append(el('p', tagSummary, 'enrich-scope-line is-count'));
        body.append(scopeBox);
        if (counts.failures > failures.length) body.append(el('p', '当前展示最近 ' + failures.length + ' 条，批量重试仅处理可重试项，跳过需人工处理和已停止项。', 'enrich-summary'));
        if (toolbar) body.append(toolbar);
        if (failures.length) failures.forEach(function (item) { body.append(renderFailure(item)); });
        else body.append(el('p', counts.failures ? '异常项正在读取，请稍后刷新。' : '暂无采集补全异常。', 'auto-empty'));
        return;
      }

      if (toolbar) body.append(toolbar);
      if (recent.length) recent.forEach(function (item) { body.append(renderRecent(item)); });
      else body.append(el('p', '还没有成功生成的摘要。', 'auto-empty'));
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

    if (filters) filters.addEventListener('click', function (event) {
      var button = event.target.closest('[data-filter]');
      if (!button || !lastState) return;
      var next = button.dataset.filter;
      if (next === filter) return;
      filter = next;
      filterTouched = true;
      render(lastState);
      var selected = filters.querySelector('[data-filter="' + filter + '"]');
      if (selected) selected.focus();
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
    document.addEventListener('workspace:search-page', function () { syncBreadcrumb(); });
    document.addEventListener('workspace:view', function (event) {
      if (event.detail === 'search') { syncBreadcrumb(); refresh(); }
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
