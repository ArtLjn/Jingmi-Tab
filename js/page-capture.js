/* 用户主动采集时运行在目标页隔离环境，遍历虚拟滚动正文并恢复原位置。 */
(function (global) {
  'use strict';
  async function collect(options) {
    options = options || {};
    var startUrl = location.href;
    var root = document.querySelector('[data-editor-content]') || document.querySelector('[role="document"]')
      || document.querySelector('main') || document.querySelector('[role="main"]') || document.querySelector('article') || document.body;
    var explicit = '[data-block-id], [data-item-id]';
    var semantic = 'h1,h2,h3,h4,p,li,pre,blockquote,td,th';
    var selector = explicit + ',' + semantic;
    if (!root.querySelector(selector)) selector += ',div';
    var blocks = new Map();
    var done = false;
    var stopped = false;
    var overlay = document.createElement('div');
    overlay.setAttribute('data-jingmi-capture', 'true');
    overlay.style.cssText = 'position:fixed;right:20px;bottom:24px;z-index:2147483647;padding:12px 16px;background:#18212f;color:#fff;border-radius:12px;font:13px system-ui;box-shadow:0 8px 32px #0006';
    var label = document.createElement('span'); label.textContent = '正在采集页面正文…';
    var cancel = document.createElement('button'); cancel.textContent = '停止'; cancel.style.marginLeft = '12px';
    cancel.addEventListener('click', function () { stopped = true; }); overlay.append(label, cancel); document.body.append(overlay);
    function scroller() {
      var candidate = root.querySelector(selector) || root;
      while (candidate && candidate !== document.documentElement) {
        if (candidate.scrollHeight > candidate.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(candidate).overflowY)) return candidate;
        candidate = candidate.parentElement;
      }
      return document.scrollingElement || document.documentElement;
    }
    var scroll = scroller(); var original = scroll.scrollTop;
    var total = 0;
    function readBlocks() {
      root.querySelectorAll(selector).forEach(function (node) {
        if (node.closest('nav, header, footer, aside, form, [hidden], [aria-hidden="true"], [data-jingmi-capture]')) return;
        var isExplicit = node.matches(explicit);
        var parentBlock = node.parentElement && node.parentElement.closest(explicit);
        if (!isExplicit && parentBlock && root.contains(parentBlock)) return;
        if (isExplicit ? node.querySelector(explicit) : node.querySelector(semantic)) return;
        if (getComputedStyle(node).display === 'none' || getComputedStyle(node).visibility === 'hidden') return;
        var text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
        /* DOM 槽位可能被虚拟列表重复使用，内容也参与标识，防止后段覆盖前段。 */
        var key = (node.getAttribute('data-block-id') || node.getAttribute('data-item-id') || node.id || '') + ':' + text;
        if (text && !blocks.has(key) && total < 500000) { total += text.length; blocks.set(key, text); }
      });
    }
    try {
      var traversed = scroll.scrollHeight > scroll.clientHeight + 50 && !!root.querySelector(selector);
      if (traversed) {
        scroll.scrollTop = 0;
        var stable = 0; var previous = -1;
        for (var i = 0; i < 100 && !stopped && total < 500000; i++) {
          await new Promise(function (resolve) { setTimeout(resolve, options.interval === undefined ? 180 : options.interval); });
          if (location.href !== startUrl) throw new Error('页面已跳转，请重试');
          readBlocks();
          label.textContent = '正在收集正文，已读取 ' + blocks.size + ' 个内容块';
          var bottom = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 12;
          stable = bottom && previous === blocks.size ? stable + 1 : 0;
          if (stable >= 3) { done = true; break; }
          previous = blocks.size;
          scroll.scrollTop += Math.max(200, scroll.clientHeight * 0.7);
        }
      }
      overlay.remove();
      var info = PageInfo.extract(root.outerHTML);
      if (traversed && blocks.size) info.text = Array.from(blocks.values()).join('\n\n').slice(0, 500000);
      if (!info.title) info.title = document.title;
      if (location.href !== startUrl) throw new Error('页面已跳转，请重试');
      info.source = 'capture'; info.private = true; info.coverage = 'rendered'; info.captureState = 'partial';
      info.captureNote = stopped ? '采集中止，已保存已读取的部分正文' : traversed ? (done ? '已遍历当前页面可见正文；未验证嵌入内容、附件与隐藏段落' : '遍历达到上限，仅保存已读取正文') : '采集当前已渲染正文；动态未加载部分、附件和嵌入对象可能缺失';
      info.blocksRead = blocks.size; info.truncated = stopped || total >= 500000 || (traversed && !done);
      return { url: startUrl, info: info };
    } finally { scroll.scrollTop = original; overlay.remove(); }
  }
  global.PageCapture = { collect: collect };
})(typeof self !== 'undefined' ? self : window);
