/* 智能归档面板：展示域名记忆与待确认建议，承接开关、学习和确认操作。 */
(function (global) {
  'use strict';

  function mount() {
    var card = document.getElementById('auto-organize-card');
    if (!card) return { refresh: function () {} };
    var toggle = document.getElementById('auto-organize-enabled');
    var status = document.getElementById('auto-organize-status');
    var summary = document.getElementById('auto-organize-summary');
    var body = document.getElementById('auto-organize-body');
    var relearn = document.getElementById('auto-organize-relearn');
    var details = document.getElementById('auto-organize-details');
    var history = document.getElementById('auto-organize-history');
    var historyLimit = 20;
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

    var SOURCE_LABEL = { manual: '手动', confirmed: '已确认', learned: '学习' };

    function renderRules(rules) {
      var block = el('section', '', 'auto-block');
      var head = el('div', '', 'auto-block-head');
      head.append(el('span', '归档规则'), el('span', rules.length + ' 条'));
      var list = el('div', '', 'auto-rule-list');
      if (!rules.length) {
        list.append(el('p', '确认 AI 建议或手动选择目录后，会记住该站点内对应页面范围；历史学习仅供推荐参考。', 'auto-empty'));
      }
      rules.forEach(function (rule) {
        var row = el('div', '', 'auto-rule');
        row.append(el('span', rule.key, 'auto-rule-domain'));
        row.append(el('span', '→', 'auto-rule-arrow'));
        row.append(el('span', rule.stale ? '目录已失效' : rule.path, 'auto-rule-folder' + (rule.stale ? ' is-stale' : '')));
        row.append(el('span', SOURCE_LABEL[rule.source] || '规则', 'auto-rule-source'));
        var remove = el('button', '移除', 'auto-rule-remove');
        remove.type = 'button';
        remove.dataset.autoRule = rule.key;
        remove.setAttribute('aria-label', '移除 ' + rule.key + ' 的归档规则');
        row.append(remove);
        list.append(row);
      });
      block.append(head, list);
      return block;
    }

    function renderPending(pending) {
      var block = el('section', '', 'auto-block');
      var head = el('div', '', 'auto-block-head');
      head.append(el('span', '待确认'), el('span', pending.length + ' 条'));
      var list = el('div', '', 'auto-pending-list');
      pending.forEach(function (item) {
        var row = el('div', '', 'auto-suggestion');
        var main = el('div', '', 'auto-suggestion-main');
        main.append(el('strong', item.title || item.host, 'auto-suggestion-title'));
        var meta = el('p', '', 'auto-suggestion-meta');
        meta.textContent = item.host + (item.path ? '  →  ' + item.path
          : item.analyzed ? '  ·  AI 暂未给出建议，收藏保留原位' : '  ·  AI 正在分析目录…');
        if (item.why) meta.textContent += '（' + item.why + '）';
        main.append(meta);
        var actions = el('div', '', 'auto-suggestion-actions');
        if (item.folderId) {
          var adopt = el('button', '归档', 'auto-action adopt');
          adopt.type = 'button';
          adopt.dataset.autoAdopt = item.id;
          actions.append(adopt);
        }
        var dismiss = el('button', '忽略', 'auto-action');
        dismiss.type = 'button';
        dismiss.dataset.autoDismiss = item.id;
        actions.append(dismiss);
        row.append(main, actions);
        list.append(row);
      });
      block.append(head, list);
      return block;
    }

    function render(state) {
      if (!state) return;
      toggle.checked = !!state.enabled;
      if (state.enabled && !state.aiReady) {
        status.textContent = '已启用 · 已确认规则照常归档；配置 AI 后可分析待整理收藏';
      } else if (state.enabled) {
        var line = state.totalRules
          ? '已启用 · 记住 ' + state.totalRules + ' 条归档规则 · 已自动归档 ' + state.filed + ' 条'
          : '已启用 · 暂无规则，可整理“其他书签”获取建议';
        status.textContent = line;
      } else {
        status.textContent = '已暂停 · 新收藏保持原位置，规则仍会继续记录';
      }
      summary.textContent = '归档规则 ' + state.totalRules + (state.pending.length ? ' · 待确认 ' + state.pending.length : '');
      body.replaceChildren();
      if (state.pending.length) body.append(renderPending(state.pending));
      body.append(renderRules(state.rules));
      if (history) {
        history.replaceChildren();
        var records = state.archiveRecords || [];
        var head = el('div', '', 'auto-block-head');
        head.append(el('span', '归档记录'), el('span', '最近 ' + records.length + ' 条'));
        history.append(head);
        if (!records.length) history.append(el('p', '暂无归档记录，成功归档后会显示在这里。', 'auto-empty'));
        records.slice(0, historyLimit).forEach(function (item) {
          var row = el('div', '', 'auto-archive-record');
          var title = el('div', '', 'auto-archive-title');
          title.append(el('strong', item.title || '未命名书签'));
          title.append(el('span', item.state === 'restored' ? '已撤销' : '已归档', 'auto-rule-source'));
          row.append(title, el('p', item.from + ' → ' + item.to, 'auto-archive-path'));
          if (item.why) row.append(el('p', item.why === 'domain-rule' ? '命中已确认的归档规则' : item.why === 'confirmed' ? '已确认归档建议' : item.why, 'auto-suggestion-meta'));
          if (item.movedAt) {
            var time = el('time', new Date(item.movedAt).toLocaleString('zh-CN', { hour12: false }), 'auto-archive-time');
            time.dateTime = new Date(item.movedAt).toISOString(); row.append(time);
          }
          history.append(row);
        });
        if (records.length > historyLimit) {
          var more = el('button', '查看更多记录', 'btn-ghost');
          more.type = 'button';
          more.addEventListener('click', function () { historyLimit += 20; render(state); });
          history.append(more);
        }
      }
    }

    async function refresh() {
      try {
        render(await send('auto:status'));
      } catch (e) {
        status.textContent = e.message;
      }
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
      act(function () { return send('auto:toggle', { enabled: toggle.checked }); });
    });

    document.getElementById('auto-organize-scan').addEventListener('click', function () {
      act(function () { return send('auto:scan'); });
    });

    relearn.addEventListener('click', function () {
      if (busy) return;
      status.textContent = '正在从现有书签学习域名归属…';
      act(function () { return send('auto:relearn'); });
    });

    body.addEventListener('click', function (event) {
      var rule = event.target.closest('[data-auto-rule]');
      if (rule) { act(function () { return send('auto:rule:remove', { key: rule.dataset.autoRule }); }); return; }
      var adopt = event.target.closest('[data-auto-adopt]');
      if (adopt) { act(function () { return send('auto:adopt', { id: adopt.dataset.autoAdopt }); }); return; }
      var dismiss = event.target.closest('[data-auto-dismiss]');
      if (dismiss) { act(function () { return send('auto:dismiss', { id: dismiss.dataset.autoDismiss }); }); }
    });

    details.addEventListener('toggle', function () { if (details.open) refresh(); });
    document.addEventListener('workspace:view', function (event) {
      if (event.detail === 'search') refresh();
    });
    document.addEventListener('workspace:search-page', function (event) {
      if (event.detail === 'organize') refresh();
    });
    if (chrome.runtime.onMessage) chrome.runtime.onMessage.addListener(function (message) {
      if (message.type === 'auto:updated') refresh();
    });
    refresh();
    return { refresh: refresh };
  }

  global.AutoOrganizerUI = { mount: mount };
})(typeof self !== 'undefined' ? self : window);
