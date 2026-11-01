/* 兼容工作台分组与原有独立书签弹窗，导航不修改采集或书签业务状态。 */
(function (global) {
  'use strict';
  function open(name) {
    var panel = document.querySelector('#panel');
    document.body.classList.add('panel-open'); panel.setAttribute('aria-hidden', 'false');
    document.querySelectorAll('[data-workspace-view]').forEach(function (view) { view.hidden = view.dataset.workspaceView !== name; });
    document.querySelectorAll('[data-workspace-target]').forEach(function (button) {
      var active = button.dataset.workspaceTarget === name;
      button.classList.toggle('is-active', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
    });
    document.dispatchEvent(new CustomEvent('workspace:view', { detail: name }));
  }
  function close() { document.body.classList.remove('panel-open'); document.querySelector('#panel').setAttribute('aria-hidden', 'true'); }
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
