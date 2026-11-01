/* 内容同步链路：一个自动开关、一个立即执行入口，采集与索引是内部步骤。 */
(function (global) {
  'use strict';
  function mount(options) {
    var $ = function (id) { return document.getElementById(id); };
    var auto = $('rag-enabled'); var status = $('rag-status'); var progress = $('pipeline-status');
    function read(enable) {
      var cfg = options.settings().rag;
      Object.assign(cfg, { baseUrl: $('rag-url').value.trim(), apiKey: $('rag-key').value.trim(), collection: $('rag-collection').value.trim(),
        includePrivate: $('rag-private').checked, refreshDays: Math.max(1, Math.min(90, Number($('rag-refresh').value) || 7)),
        autoSync: auto.checked, autoCapture: true, enabled: cfg.enabled || auto.checked || !!enable });
      return cfg;
    }
    async function send(type, extra) {
      var result = await chrome.runtime.sendMessage(Object.assign({ type: type }, extra));
      if (!result || !result.ok) throw new Error(result && result.error || '后台未响应，请重新加载扩展');
      return result.data;
    }
    function permission(cfg, capture) {
      var url = new URL(cfg.baseUrl);
      var origins = [url.origin + '/*']; if (capture) origins.push('http://*/*', 'https://*/*');
      return chrome.permissions.request({ origins: origins });
    }
    async function save() { await Settings.save(options.settings()); options.persist(); }
    auto.addEventListener('change', function () {
      var cfg = read(false);
      if (!auto.checked) { save().then(function () { return send('pipeline:pause'); }).then(poll).catch(function (e) { progress.textContent = e.message; }); return; }
      try {
        if (!Rag.available(cfg)) throw new Error('请展开连接设置，填写 RAG 地址和密钥');
        var granted = permission(cfg, true);
        granted.then(async function (yes) { if (!yes) throw new Error('未授权网页访问，请允许后重试'); await save(); await send('pipeline:start'); await poll(); }).catch(function (e) { progress.textContent = e.message; });
      } catch (e) { auto.checked = false; cfg.autoSync = false; progress.textContent = e.message; $('rag-connection').open = true; }
    });
    ['rag-url', 'rag-key', 'rag-collection', 'rag-private', 'rag-refresh'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        read(false); save().then(function () { return send('pipeline:changed'); }).catch(function (e) { status.textContent = e.message; });
      });
    });
    function start(retry) {
      var cfg = read(true);
      try {
        if (!Rag.available(cfg)) throw new Error('请展开连接设置，填写 RAG 地址和密钥');
        var granted = permission(cfg, true); progress.textContent = '正在提交同步任务…';
        granted.then(async function (yes) { if (!yes) throw new Error('未授权网页访问，请允许后重试'); await save(); await send(retry ? 'pipeline:retry-failed' : 'pipeline:start'); await poll(); }).catch(function (e) { progress.textContent = e.message; });
      } catch (e) { progress.textContent = e.message; $('rag-connection').open = true; }
    }
    $('pipeline-start').addEventListener('click', function () { start(false); });
    $('pipeline-retry').addEventListener('click', function () { start(true); });
    $('pipeline-pause').addEventListener('click', function () { send('pipeline:pause').then(poll).catch(function (e) { progress.textContent = e.message; }); });
    $('rag-test').addEventListener('click', function () {
      var cfg = read(false);
      try {
        if (!cfg.apiKey) throw new Error('请填写密钥');
        var granted = permission(cfg, false); status.textContent = '正在测试连接…';
        granted.then(async function (yes) { if (!yes) throw new Error('未授权访问 RAG'); await save(); await Rag.request(cfg, '/collections'); status.textContent = '连接正常'; }).catch(function (e) { status.textContent = e.message; });
      } catch (e) { status.textContent = e.message; }
    });
    async function bind() {
      var cfg = options.settings().rag;
      if (!cfg.collection) { cfg.collection = await Rag.defaultCollection(); options.persist(); }
      auto.checked = !!cfg.enabled && cfg.autoSync !== false;
      $('rag-url').value = cfg.baseUrl; $('rag-key').value = cfg.apiKey; $('rag-collection').value = cfg.collection;
      $('rag-private').checked = cfg.includePrivate; $('rag-refresh').value = cfg.refreshDays || 7;
    }
    async function poll() {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
      try {
        var state = await send('pipeline:status'); if (!state) return;
        var cfg = options.settings().rag;
        var mode = state.queuePaused ? '已暂停' : cfg.enabled && cfg.autoSync !== false ? '自动同步已开启' : state.manual ? '正在执行本次同步' : '自动同步未开启';
        progress.textContent = state.error || mode + ' · 已入库 ' + state.indexed + '/' + state.documents + ' 页，待处理 ' + state.jobs.pending + '，处理中 ' + state.jobs.running + '，待打开/授权 ' + state.jobs.paused + '，失败 ' + state.jobs.failed;
        $('pipeline-retry').hidden = !(state.jobs.failed || state.jobs.paused || state.error);
      } catch (e) { progress.textContent = e.message; }
    }
    setInterval(function () { if (!document.hidden) poll(); }, 4000); poll();
    return { bind: bind };
  }
  global.RagSettings = { mount: mount };
})(typeof self !== 'undefined' ? self : window);
