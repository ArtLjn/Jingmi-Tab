/* 书签空间只浏览原有目录和内容状态；旧版整理仅保留用户主动撤销。 */
(function (global) {
  'use strict';

  /* 原生 select 的长下拉无法限制高度；保留 select 作为数据源，显示层使用可筛选弹层。 */
  function mountFolderPicker(select) {
    var wrapper = select.parentElement;
    wrapper.classList.add('has-folder-picker');
    select.setAttribute('aria-hidden', 'true');
    select.tabIndex = -1;

    var trigger = document.createElement('button');
    trigger.type = 'button'; trigger.className = 'folder-picker-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', '浏览原有书签目录');
    var triggerText = document.createElement('span'); trigger.append(triggerText);

    var popover = document.createElement('div'); popover.className = 'folder-picker-popover'; popover.hidden = true;
    var search = document.createElement('input'); search.type = 'search'; search.className = 'folder-picker-search';
    search.placeholder = '筛选目录'; search.setAttribute('aria-label', '筛选书签目录');
    var optionsList = document.createElement('div'); optionsList.className = 'folder-picker-options';
    optionsList.setAttribute('role', 'listbox'); optionsList.setAttribute('aria-label', '书签目录列表');
    popover.append(search, optionsList); wrapper.append(trigger, popover);

    function close(focus) {
      popover.hidden = true; trigger.setAttribute('aria-expanded', 'false');
      if (focus) trigger.focus();
    }
    function renderOptions() {
      var text = search.value.trim().toLowerCase(); optionsList.replaceChildren();
      var options = Array.from(select.options).filter(function (option) { return !text || option.textContent.toLowerCase().includes(text); });
      if (!options.length) {
        var empty = document.createElement('p'); empty.className = 'folder-picker-empty'; empty.textContent = '没有匹配的目录';
        optionsList.append(empty); return;
      }
      options.forEach(function (option) {
        var button = document.createElement('button'); button.type = 'button'; button.className = 'folder-picker-option';
        button.textContent = option.textContent; button.title = option.textContent;
        button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(option.value === select.value));
        button.addEventListener('click', function () {
          select.value = option.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          triggerText.textContent = option.textContent; close(true);
        });
        optionsList.append(button);
      });
    }
    function sync() {
      var selected = select.options[select.selectedIndex];
      triggerText.textContent = selected ? selected.textContent : '全部书签';
      if (!popover.hidden) renderOptions();
    }
    function open() {
      search.value = ''; renderOptions(); sync(); popover.hidden = false;
      trigger.setAttribute('aria-expanded', 'true'); search.focus();
    }

    trigger.addEventListener('click', function () { if (popover.hidden) open(); else close(false); });
    trigger.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown') { event.preventDefault(); open(); }
    });
    search.addEventListener('input', renderOptions);
    popover.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
      if (!/^(ArrowDown|ArrowUp)$/.test(event.key)) return;
      event.preventDefault();
      var buttons = Array.from(optionsList.querySelectorAll('button'));
      if (!buttons.length) return;
      var index = buttons.indexOf(document.activeElement);
      var next = event.key === 'ArrowDown' ? Math.min(index + 1, buttons.length - 1) : Math.max(index < 0 ? 0 : index - 1, 0);
      buttons[next].focus();
    });
    document.addEventListener('click', function (event) { if (!wrapper.contains(event.target)) close(false); });
    select.addEventListener('change', sync);
    new MutationObserver(sync).observe(select, { childList: true });
    sync();
  }

  function mount(options) {
    var dialog = document.querySelector('#organizer-dialog');
    var list = document.querySelector('#organizer-list');
    var status = document.querySelector('#organizer-status');
    var folder = document.querySelector('#organizer-folder');
    mountFolderPicker(folder);
    var query = document.querySelector('#organizer-query');
    var undo = document.querySelector('#organizer-undo');
    var rows = []; var folders = []; var limit = 50; var busy = false; var refreshing = false;
    function el(tag, text, className) {
      var n = document.createElement(tag); if (text) n.textContent = text; if (className) n.className = className; return n;
    }
    async function send(type) {
      var result = await chrome.runtime.sendMessage({ type: type });
      if (!result || !result.ok) throw new Error(result && result.error || '后台未响应，请重新加载扩展');
      return result.data;
    }
    function indexFolders(tree) {
      var out = [];
      function walk(node, path) {
        if (node.url) return new Set([String(node.id)]);
        var names = node.title ? path.concat(node.title) : path;
        var entry = { id: node.id, title: names.join(' / ') || '全部书签', ids: new Set() };
        if (node.title) out.push(entry);
        (node.children || []).forEach(function (child) { walk(child, names).forEach(function (id) { entry.ids.add(id); }); });
        return entry.ids;
      }
      tree.forEach(function (root) { walk(root, []); });
      return out;
    }
    function render() {
      var current = folders.find(function (f) { return f.id === folder.value; });
      var data = current ? rows.filter(function (r) { return current.ids.has(String(r.id)); }) : rows;
      var text = query.value.trim().toLowerCase();
      var filtered = data.filter(function (r) { return !text || [r.title, r.url, r.folder, r.desc, r.text].join(' ').toLowerCase().includes(text); });
      document.querySelector('#organizer-count').textContent = rows.length + ' 条书签';
      document.querySelector('#organizer-pending').textContent = '最新收藏优先';
      document.querySelector('#organizer-list-title').textContent = current ? current.title : '全部书签';
      document.querySelector('#organizer-list-count').textContent = filtered.length + ' 条';
      list.replaceChildren();
      if (!filtered.length) list.append(el('p', '此目录没有匹配的书签，可以切换目录或搜索关键词。', 'organizer-empty'));
      filtered.slice(0, limit).forEach(function (row) {
        var item = el('article', '', 'organizer-item'); var host = '本地书签';
        try { host = new URL(row.url).hostname.replace(/^www\./, '') || host; } catch (e) { /* 特殊协议保留通用标识。 */ }
        var avatar = el('span', host.charAt(0).toUpperCase(), 'organizer-favicon');
        avatar.setAttribute('aria-hidden', 'true');
        avatar.dataset.tone = String(Array.from(host).reduce(function (sum, char) { return sum + char.charCodeAt(0); }, 0) % 5);
        var body = el('div', '', 'organizer-item-body');
        var title = el('div', '', 'organizer-title-row'); var link = el('a', row.title || row.url, 'organizer-link');
        if (ContentIndex.isWeb(row.url)) { link.href = row.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
        title.append(link); body.append(title, el('p', host + '  /  ' + (row.folder || '未命名目录'), 'organizer-source'));
        var badges = el('div', '', 'organizer-badges');
        [row.contentStatus || '仅标题', row.syncStatus || '未入库'].forEach(function (label) { badges.append(el('span', label, 'organizer-badge')); });
        body.append(badges);
        var detail = [row.captureNote, row.contentAt ? '采集于 ' + new Date(row.contentAt).toLocaleDateString('zh-CN') : ''].filter(Boolean).join(' · ');
        if (detail) body.append(el('p', detail, 'organizer-note'));
        item.append(avatar, body); list.append(item);
      });
      if (filtered.length > limit) {
        var more = el('button', '再显示 50 条', 'btn-ghost organizer-more'); more.type = 'button';
        more.addEventListener('click', function () { limit += 50; render(); }); list.append(more);
      }
    }
    async function refresh() {
      if (refreshing) return;
      refreshing = true;
      try {
        var tree = await chrome.bookmarks.getTree(); var selected = folder.value;
        rows = Bookmarks.flatten(tree);
        /* 默认按收藏时间从新到旧排列；目录只用于筛选，不改变时间顺序。 */
        rows.sort(function (a, b) { return (b.added || 0) - (a.added || 0); });
        await ContentIndex.hydrate(rows);
        var classes = await Organizer.records(rows);
        rows.forEach(function (row) { if (classes[row.id] && classes[row.id].tags) row.hay += ' ' + classes[row.id].tags.join(' ').toLowerCase(); });
        if (typeof BookmarkEnrich !== 'undefined') await BookmarkEnrich.applySummaries(rows);
        folders = indexFolders(tree);
        folder.replaceChildren();
        var all = el('option', '全部书签'); all.value = ''; folder.append(all);
        folders.forEach(function (f) { var option = el('option', f.title + '（' + f.ids.size + '）'); option.value = f.id; folder.append(option); });
        folder.value = folders.some(function (f) { return f.id === selected; }) ? selected : '';
        render();
        var history = await send('organizer:status');
        document.querySelector('#organizer-recovery').hidden = !(history && history.canUndo);
        undo.disabled = busy;
      } finally { refreshing = false; }
    }
    document.querySelector('#organizer-open').addEventListener('click', function () { Workspace.open('bookmarks'); });
    document.querySelector('#organizer-close').addEventListener('click', function () { Workspace.close(); });
    document.querySelector('#organizer-sync-settings').addEventListener('click', function () {
      Workspace.open('search');
      var section = document.querySelector('#workspace-search .settings-section');
      if (section) section.scrollIntoView({ block: 'start' });
    });
    document.addEventListener('workspace:view', function (event) {
      if (event.detail === 'bookmarks') refresh().catch(function () { status.textContent = '无法读取书签，请在扩展页面使用'; });
    });
    folder.addEventListener('change', function () { limit = 50; render(); });
    query.addEventListener('input', function () { limit = 50; render(); });
    undo.addEventListener('click', async function () {
      if (busy) return; busy = true; undo.disabled = true;
      try {
        var journal = await send('organizer:undo');
        var restored = journal.items.filter(function (i) { return i.state === 'restored'; }).length;
        var errors = journal.items.filter(function (i) { return i.error; });
        status.textContent = '已恢复 ' + restored + ' 条。' + errors.map(function (i) { return i.title + '：' + i.error; }).join('；');
        options.changed();
      } catch (e) { status.textContent = e.message; }
      finally { busy = false; await refresh().catch(function () {}); }
    });
    setInterval(function () {
      if (!dialog.hidden && document.body.classList.contains('panel-open') && !busy && !/^(INPUT|SELECT)$/.test(document.activeElement.tagName)) refresh().catch(function () {});
    }, 4000);
    return { refresh: refresh };
  }
  global.OrganizerUI = { mount: mount };
})(typeof self !== 'undefined' ? self : window);
