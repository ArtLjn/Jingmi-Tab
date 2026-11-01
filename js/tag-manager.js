/* ============================================================
   tag-manager.js —— 工作台「快捷标签」管理页
   职责：把 QuickTags 的数据暴露成可操作的界面，只做四件事：
         固定标签（改名 / 排序 / 删除）、系统推荐（固定 / 忽略）、
         已忽略（恢复）、数据（导出 / 导入 / 清空学习记录）。
   设计要点：
     · 全部用 DOM API 建节点，用户输入的标签名不走 innerHTML。
     · 删除保留一次撤销；清空学习数据用两步确认，不弹原生 confirm。
     · 排序用上移/下移按钮而不是拖拽：键盘可达，也省掉一套指针逻辑。
   ============================================================ */
(function (global) {
  'use strict';

  var DOT_COLORS = ['#5b9cf5', '#3fb99a', '#a78bfa', '#e0a34a', '#e07a8b', '#4fb3c9'];
  var UNDO_MS = 8000;
  var COLLAPSED_ROWS = 6;      // 折叠时每张卡显示的行数，避免长列表把卡片撑高

  var els = {};
  var opts = null;
  var lastDeleted = null;     // { tag, timer }
  var confirmResetUntil = 0;  // 两步确认的时间窗
  var expanded = { pinned: false, cand: false, ignored: false };

  function $(sel) { return document.querySelector(sel); }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function dotColor(seed) {
    var s = String(seed || '');
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return DOT_COLORS[h % DOT_COLORS.length];
  }

  function setStatus(text, undoTag) {
    if (!els.status) return;
    els.status.replaceChildren();
    if (!text) return;
    els.status.append(el('span', null, text));
    if (undoTag) {
      var undo = el('button', 'tag-undo', '撤销');
      undo.type = 'button';
      undo.addEventListener('click', function () { undoDelete(); });
      els.status.append(undo);
    }
    els.status.hidden = !text;
  }

  function clearUndo() {
    if (lastDeleted && lastDeleted.timer) clearTimeout(lastDeleted.timer);
    lastDeleted = null;
  }

  function undoDelete() {
    if (!lastDeleted) return;
    var tag = lastDeleted.tag;
    clearUndo();
    var res = global.QuickTags.add({ url: tag.url, label: tag.label, aliases: tag.aliases, pin: tag.pin });
    setStatus(res.ok ? '已恢复「' + tag.label + '」' : '恢复失败');
    refresh();
  }

  /* ------------------------- 渲染 ------------------------- */

  /**
   * 列表折叠：默认只显示前 6 行，其余收进「展开全部」。
   * 光靠 max-height + 滚动不够——macOS 的浮层滚动条默认不可见，用户不会知道还有内容。
   */
  function renderMore(container, key, total) {
    container.replaceChildren();
    if (!container || total <= COLLAPSED_ROWS) return;
    var open = !!expanded[key];
    var btn = el('button', 'tag-more-btn', open ? '收起' : '展开其余 ' + (total - COLLAPSED_ROWS) + ' 个');
    btn.type = 'button';
    btn.addEventListener('click', function () {
      expanded[key] = !open;
      refresh();
    });
    container.append(btn);
  }

  /** 折叠时行数受限、高度自然；展开后才限高滚动，避免把卡片撑爆 */
  function visibleRows(container, list, key) {
    var open = !!expanded[key];
    container.classList.toggle('is-scroll', open && list.length > COLLAPSED_ROWS);
    return open ? list : list.slice(0, COLLAPSED_ROWS);
  }

  function renderPinned(pinned) {
    els.pinned.replaceChildren();
    els.pinnedEmpty.hidden = pinned.length > 0;
    renderMore(els.pinnedMore, 'pinned', pinned.length);

    var shownPinned = visibleRows(els.pinned, pinned, 'pinned');
    shownPinned.forEach(function (tag, i) {
      var row = el('div', 'tag-row');

      var dot = el('span', 'tag-dot');
      dot.style.background = dotColor(tag.host);
      row.append(dot);

      var main = el('div', 'tag-main');
      var name = el('button', 'tag-name', tag.label);
      name.type = 'button';
      name.title = '点击改名';
      name.addEventListener('click', function () { startRename(tag.id, name); });
      main.append(name);
      main.append(el('span', 'tag-host', tag.host + (tag.hits ? ' · 用过 ' + tag.hits + ' 次' : '')));
      row.append(main);

      var ops = el('div', 'tag-ops');
      ops.append(opButton('↑', '上移', i === 0, function () { act('up', tag.id); }));
      ops.append(opButton('↓', '下移', i === shownPinned.length - 1 && pinned.length === shownPinned.length, function () { act('down', tag.id); }));
      ops.append(opButton('删除', '删除这个标签', false, function () { act('del', tag.id); }, 'is-danger'));
      row.append(ops);

      els.pinned.append(row);
    });
  }

  function renderCandidates(cands) {
    els.cand.replaceChildren();
    els.candEmpty.hidden = cands.length > 0;
    renderMore(els.candMore, 'cand', cands.length);

    visibleRows(els.cand, cands, 'cand').forEach(function (cand) {
      var row = el('div', 'tag-row');

      var dot = el('span', 'tag-dot');
      dot.style.background = dotColor(cand.host);
      row.append(dot);

      var main = el('div', 'tag-main');
      main.append(el('span', 'tag-name is-static', cand.label));
      main.append(el('span', 'tag-host', cand.host + (cand.source === 'bookmark' ? ' · 来自书签' : ' · 来自常访站点')));
      row.append(main);

      var ops = el('div', 'tag-ops');
      ops.append(opButton('固定', '设为固定标签', false, function () { act('pin', cand.id); }, 'is-primary'));
      ops.append(opButton('忽略', '不再推荐', false, function () { act('ignore', cand.id); }));
      row.append(ops);

      els.cand.append(row);
    });
  }

  function renderIgnored(list) {
    els.ignored.replaceChildren();
    els.ignoredEmpty.hidden = list.length > 0;
    renderMore(els.ignoredMore, 'ignored', list.length);

    visibleRows(els.ignored, list, 'ignored').forEach(function (item) {
      var row = el('div', 'tag-row');
      var main = el('div', 'tag-main');
      main.append(el('span', 'tag-name is-static', item.host));
      main.append(el('span', 'tag-host',
        item.count >= 3 ? '已拉黑 · 不再推荐' : '已隐藏 ' + item.count + '/3'));
      row.append(main);

      var ops = el('div', 'tag-ops');
      ops.append(opButton('恢复', '重新参与推荐', false, function () { act('restore', item.host); }));
      row.append(ops);

      els.ignored.append(row);
    });
  }

  function opButton(text, title, disabled, handler, extraClass) {
    var btn = el('button', 'tag-op' + (extraClass ? ' ' + extraClass : ''), text);
    btn.type = 'button';
    btn.title = title;
    btn.disabled = !!disabled;
    btn.addEventListener('click', handler);
    return btn;
  }

  /* ------------------------- 交互 ------------------------- */
  function act(kind, id) {
    var tags = global.QuickTags;

    if (kind === 'up' || kind === 'down') {
      if (tags.move(id, kind === 'up' ? -1 : 1)) setStatus('顺序已更新');
      refresh();
      return;
    }

    if (kind === 'del') {
      var tag = tags.list().filter(function (t) { return t.id === id; })[0];
      if (!tag) return;
      var snapshot = { url: tag.url, label: tag.label, aliases: tag.aliases, pin: tag.pin };
      if (!tags.remove(id)) return;
      clearUndo();
      lastDeleted = { tag: snapshot, timer: setTimeout(function () { lastDeleted = null; setStatus(''); }, UNDO_MS) };
      setStatus('已删除「' + snapshot.label + '」', true);
      refresh();
      return;
    }

    if (kind === 'pin' || kind === 'ignore') {
      var entry = (global.QuickTags.buildCandidates(ctxOf()) || []).filter(function (c) { return c.id === id; })[0];
      if (!entry) { refresh(); return; }
      if (kind === 'pin') {
        var res = tags.add({ url: entry.url, label: entry.label });
        setStatus(res.ok ? '已固定「' + entry.label + '」' : '这个地址无法设为标签');
      } else {
        var n = tags.dismiss(entry);
        setStatus(n >= 3 ? '「' + entry.host + '」已拉黑，不再推荐' : '已忽略，累计 ' + n + '/3 次后不再推荐');
      }
      refresh();
      return;
    }

    if (kind === 'restore') {
      if (tags.restore(id)) setStatus('已恢复「' + id + '」');
      refresh();
    }
  }

  function startRename(id, nameEl) {
    var tag = global.QuickTags.list().filter(function (t) { return t.id === id; })[0];
    if (!tag) return;

    var input = el('input', 'tag-name-input');
    input.type = 'text';
    input.value = tag.label;
    input.maxLength = 40;
    input.setAttribute('aria-label', '标签名称');
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    var done = false;
    function commit(save) {
      if (done) return;
      done = true;
      var value = input.value.trim();
      if (save && value && value !== tag.label) {
        global.QuickTags.rename(id, value);
        setStatus('已改名为「' + value + '」');
      }
      refresh();
    }
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
      if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
    });
    input.addEventListener('blur', function () { commit(true); });
  }

  function ctxOf() {
    return opts && opts.ctx ? opts.ctx() : { rows: [], topSites: [] };
  }

  function refresh() {
    if (!global.QuickTags) return;
    var pinned = global.QuickTags.list();
    var cands = global.QuickTags.buildCandidates(ctxOf());
    var ignored = global.QuickTags.ignored();

    renderPinned(pinned);
    renderCandidates(cands);
    renderIgnored(ignored);

    if (els.count) els.count.textContent = pinned.length ? pinned.length + ' 个固定' : '还没有固定标签';
    if (els.candCount) els.candCount.textContent = cands.length + ' 个候选';
    if (els.ignoredCount) els.ignoredCount.textContent = ignored.length ? ignored.length + ' 个' : '';
  }

  /* ------------------------- 导入导出 ------------------------- */
  function exportFile() {
    var data = global.QuickTags.exportData();
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'quick-tags-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    setStatus('已导出 ' + data.tags.length + ' 个固定标签');
  }

  function importFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var res = global.QuickTags.importData(String(reader.result || ''));
      setStatus(res.ok
        ? '导入完成：新增 ' + res.added + ' 个，跳过 ' + res.skipped + ' 个'
        : '导入失败：文件不是有效的标签 JSON');
      refresh();
    };
    reader.onerror = function () { setStatus('读取文件失败'); };
    reader.readAsText(file);
  }

  function resetLearned() {
    var now = Date.now();
    if (now > confirmResetUntil) {
      confirmResetUntil = now + 4000;
      if (els.resetBtn) {
        els.resetBtn.textContent = '确认清空？';
        setTimeout(function () {
          if (els.resetBtn && Date.now() > confirmResetUntil) els.resetBtn.textContent = '清空学习数据';
        }, 4000);
      }
      setStatus('会清空忽略记录与使用次数，固定标签不受影响');
      return;
    }
    confirmResetUntil = 0;
    if (els.resetBtn) els.resetBtn.textContent = '清空学习数据';
    global.QuickTags.resetLearned();
    setStatus('学习数据已清空');
    refresh();
  }

  /* ------------------------- 挂载 ------------------------- */
  function bind() {
    els.importBtn.addEventListener('click', function () { els.importFile.click(); });
    els.importFile.addEventListener('change', function () {
      importFile(els.importFile.files && els.importFile.files[0]);
      els.importFile.value = '';
    });
    els.exportBtn.addEventListener('click', exportFile);
    els.resetBtn.addEventListener('click', resetLearned);
  }

  function mount(options) {
    opts = options || {};
    els = {
      view: $('#workspace-tags'),
      count: $('#tag-count'),
      candCount: $('#tag-cand-count'),
      ignoredCount: $('#tag-ignored-count'),
      pinned: $('#tag-pinned-list'),
      pinnedMore: $('#tag-pinned-more'),
      pinnedEmpty: $('#tag-pinned-empty'),
      cand: $('#tag-cand-list'),
      candMore: $('#tag-cand-more'),
      candEmpty: $('#tag-cand-empty'),
      ignored: $('#tag-ignored-list'),
      ignoredMore: $('#tag-ignored-more'),
      ignoredEmpty: $('#tag-ignored-empty'),
      exportBtn: $('#tag-export'),
      importBtn: $('#tag-import'),
      importFile: $('#tag-import-file'),
      resetBtn: $('#tag-reset'),
      status: $('#tag-status')
    };
    if (!els.view || !els.pinned) return null;

    bind();
    document.addEventListener('workspace:view', function (ev) {
      if (ev.detail === 'tags') refresh();
    });
    return { refresh: refresh };
  }

  global.TagManager = { mount: mount };
})(typeof self !== 'undefined' ? self : window);
