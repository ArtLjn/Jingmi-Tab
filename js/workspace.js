/* 兼容工作台分组与原有独立书签弹窗，导航不修改采集或书签业务状态。
   搜索分区由概览进入子页，原有业务节点与事件绑定保持稳定。 */
(function (global) {
  'use strict';

  var searchView = document.getElementById('workspace-search');
  var overview = document.getElementById('search-overview');
  var breadcrumb = document.getElementById('search-breadcrumb');
  var heading = searchView && searchView.querySelector('.view-heading');
  var currentSearchPage = 'overview';

  function openSearch(name, focus) {
    if (!overview) return;
    var page = searchView.querySelector('[data-search-page="' + name + '"]');
    if (name !== 'overview' && !page) return;
    var previous = currentSearchPage;
    currentSearchPage = name;
    overview.hidden = name !== 'overview';
    breadcrumb.hidden = name === 'overview';
    if (heading) heading.hidden = name !== 'overview';
    searchView.querySelectorAll('[data-search-page]').forEach(function (node) { node.hidden = node !== page; });
    if (page) {
      var entry = overview.querySelector('[data-search-target="' + name + '"]');
      var pageName = document.getElementById('search-page-name');
      pageName.textContent = page.dataset.pageTitle || (entry && entry.querySelector('strong').textContent) || '';
      pageName.setAttribute('aria-current', page.dataset.pageDetail ? 'false' : 'page');
      /* 状态列表作为子页挂在同一个功能下，面包屑保留上一级名称。 */
      var detailWrap = document.getElementById('search-page-detail-wrap');
      var detailName = document.getElementById('search-page-detail');
      var detail = page.dataset.pageDetail || '';
      if (detailWrap) detailWrap.hidden = !detail;
      if (detailName) {
        detailName.textContent = detail;
        if (detail) detailName.setAttribute('aria-current', 'page'); else detailName.removeAttribute('aria-current');
      }
      /* 次要设置默认保持折叠，避免展开内容挤占首屏主任务。 */
      page.querySelectorAll('details:not([data-collapsed])').forEach(function (details) { details.open = true; });
    }
    searchView.scrollTop = 0;
    if (focus) {
      var target = page ? breadcrumb.querySelector('button') : overview.querySelector('[data-search-target="' + previous + '"]');
      if (target) target.focus();
    }
    document.dispatchEvent(new CustomEvent('workspace:search-page', { detail: name }));
  }

  document.querySelectorAll('[data-search-target]').forEach(function (button) {
    button.addEventListener('click', function () { openSearch(button.dataset.searchTarget, true); });
  });

  /* 概览只镜像必要的状态；详细列表留在各自子页。 */
  [['rag', 'pipeline-status'], ['organize', 'auto-organize-status'], ['enrich', 'enrich-summary']].forEach(function (pair) {
    var source = document.getElementById(pair[1]);
    var target = document.querySelector('[data-search-status="' + pair[0] + '"]');
    if (!source || !target) return;
    function update() { target.textContent = source.textContent.split(' · ').slice(0, 2).join(' · '); }
    update();
    new MutationObserver(update).observe(source, { childList: true, characterData: true, subtree: true });
  });

  function open(name, subpage) {
    if (name === 'search') openSearch(subpage || 'overview', false);
    var panel = document.querySelector('#panel');
    document.body.classList.add('panel-open'); panel.setAttribute('aria-hidden', 'false');
    document.querySelectorAll('[data-workspace-view]').forEach(function (view) {
      var active = view.dataset.workspaceView === name;
      view.hidden = !active;
      /* 切页回到顶部，避免沿用上一页的滚动位置 */
      if (active && 'scrollTop' in view) view.scrollTop = 0;
    });
    document.querySelectorAll('[data-workspace-target]').forEach(function (button) {
      var active = button.dataset.workspaceTarget === name;
      button.classList.toggle('is-active', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
    });
    document.dispatchEvent(new CustomEvent('workspace:view', { detail: name }));
  }
  function close() {
    document.body.classList.remove('panel-open');
    document.querySelector('#panel').setAttribute('aria-hidden', 'true');
    document.dispatchEvent(new CustomEvent('workspace:close'));
  }
  document.querySelectorAll('[data-workspace-target]').forEach(function (button) {
    button.addEventListener('click', function () { open(button.dataset.workspaceTarget); });
    button.addEventListener('keydown', function (event) {
      if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].indexOf(event.key) < 0) return;
      var buttons = Array.from(document.querySelectorAll('[data-workspace-target]'));
      var direction = /Down|Right/.test(event.key) ? 1 : -1;
      var next = buttons[(buttons.indexOf(button) + direction + buttons.length) % buttons.length];
      event.preventDefault(); open(next.dataset.workspaceTarget); next.focus();
    });
  });

  global.Workspace = { open: open, close: close };
})(typeof self !== 'undefined' ? self : window);
