/* 内容同步链路：RAG 地址/Key 由后台代理持有，前台只保留同步开关与隐私选项。 */
(function (global) {
  'use strict';
  function mount(options) {
    var $ = function (id) { return document.getElementById(id); };
    var auto = $('rag-enabled'); var status = $('rag-status'); var progress = $('pipeline-status');
    var recordLimit = 20;
    var lastPipelineError = '';
    var labels = { pending: '排队', running: '处理中' };
    function setState(label, tone) {
      var el = $('rag-state'); if (!el) return;
      el.textContent = label; el.dataset.tone = tone;
    }
    function renderStats(collection) {
      var stats = $('rag-stats'); if (!stats) return;
      if (!collection) { stats.hidden = true; return; }
      stats.hidden = false;
      ['collected', 'uncollected', 'failed', 'queue'].forEach(function (key) {
        var value = Number(collection[key]) || 0;
        var valueEl = $('rag-stat-' + key); if (valueEl) valueEl.textContent = value;
        var stat = stats.querySelector('[data-stat="' + key + '"]');
        if (stat) { stat.classList.toggle('is-zero', !value); stat.classList.toggle('is-danger', key === 'failed' && value > 0); }
      });
      var breakdown = CollectionStats.breakdown(collection);
      var summary = '收录概况。' + CollectionStats.format(collection) + (breakdown ? '。' + breakdown : '');
      stats.setAttribute('aria-label', summary); stats.title = summary;
    }
    function renderRecords(records) {
      var body = $('pipeline-records');
      if (!body) return;
      body.replaceChildren();
      var abnormal = records.filter(function (item) { return item.status === 'failed' || item.status === 'paused'; }).length;
      var heading = document.createElement('p'); heading.className = 'pipeline-head';
      var headingLabel = document.createElement('strong'); headingLabel.textContent = '采集与同步明细';
      var headingCount = document.createElement('em'); headingCount.textContent = records.length + ' 页' + (abnormal ? ' · ' + abnormal + ' 项异常' : '');
      heading.append(headingLabel, headingCount); body.append(heading);
      if (!records.length) { var empty = document.createElement('p'); empty.className = 'auto-empty'; empty.textContent = '暂无处理记录，同步后会在这里显示。'; body.append(empty); }
      records.slice(0, recordLimit).forEach(function (item) {
        var rowStatus = item.status || 'pending';
        var row = document.createElement('div'); row.className = 'pipeline-record auto-archive-record'; row.dataset.status = rowStatus;
        var dot = document.createElement('span'); dot.className = 'pipeline-dot'; dot.setAttribute('aria-hidden', 'true');
        var main = document.createElement('div'); main.className = 'pipeline-main';
        var title = document.createElement('p'); title.className = 'pipeline-title'; title.textContent = item.title; title.title = item.title;
        var meta = document.createElement('p'); meta.className = 'pipeline-meta';
        var capture = document.createElement('span'); capture.textContent = item.capture || '未采集正文';
        var divider = document.createElement('i'); divider.setAttribute('aria-hidden', 'true'); divider.textContent = '·';
        var sync = document.createElement('span'); sync.textContent = item.sync === 'synced' ? '已入库' : '未入库';
        meta.append(capture, divider, sync);
        /* 失败与待授权已由采集状态、状态点和错误行表达，不再重复贴标签。 */
        if (rowStatus === 'pending' || rowStatus === 'running') { var chip = document.createElement('span'); chip.className = 'pipeline-chip'; chip.textContent = labels[rowStatus] || '待处理'; meta.append(chip); }
        main.append(title, meta);
        if (item.error) {
          var error = document.createElement('p'); error.className = 'pipeline-error';
          error.textContent = item.error; error.title = item.error; main.append(error);
        }
        row.append(dot, main);
        if (item.error && item.policy && item.policy.allowManual && item.id) {
          var retry = document.createElement('button'); retry.type = 'button'; retry.className = 'pipeline-retry';
          retry.textContent = '重试'; retry.title = '检查后重试此项'; retry.setAttribute('aria-label', '检查后重试此项：' + item.title);
          retry.addEventListener('click', function () { send('pipeline:retry', { documentId: item.id }).then(poll).catch(function (e) { status.textContent = e.message; }); });
          row.append(retry);
        }
        body.append(row);
      });
      if (records.length > recordLimit) {
        var more = document.createElement('button'); more.type = 'button'; more.className = 'btn-ghost pipeline-more'; more.textContent = '查看更多处理记录';
        more.addEventListener('click', function () { recordLimit += 20; renderRecords(records); }); body.append(more);
      }
    }
    function read(enable) {
      var settings = options.settings();
      var cfg = Rag.withAuth(settings.rag, settings.backup);
      cfg.includePrivate = $('rag-private').checked;
      cfg.refreshDays = Math.max(1, Math.min(90, Number($('rag-refresh').value) || 7));
      cfg.autoSync = auto.checked;
      cfg.autoCapture = true;
      cfg.enabled = cfg.enabled || auto.checked || !!enable;

      /* 同步回 settings.rag，poll() 与后台都读同一份开关状态 */
      settings.rag.includePrivate = cfg.includePrivate;
      settings.rag.refreshDays = cfg.refreshDays;
      settings.rag.autoSync = cfg.autoSync;
      settings.rag.autoCapture = true;
      settings.rag.enabled = cfg.enabled;
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
    function ensureReady(cfg) {
      if (!Rag.available(cfg)) throw new Error('请先在左下角登录账号，并确认后台已配置 RAG');
    }
    auto.addEventListener('change', function () {
      var cfg = read(false);
      if (!auto.checked) { setState('未开启', 'off'); save().then(function () { return send('pipeline:pause'); }).then(poll).catch(function (e) { status.textContent = e.message; }); return; }
      try {
        ensureReady(cfg);
        setState('同步中', 'busy');
        var granted = permission(cfg, true);
        granted.then(async function (yes) { if (!yes) throw new Error('未授权网页访问，请允许后重试'); await save(); await send('pipeline:start'); await poll(); }).catch(function (e) { auto.checked = false; setState('未开启', 'off'); status.textContent = e.message; });
      } catch (e) { auto.checked = false; cfg.autoSync = false; setState('未开启', 'off'); status.textContent = e.message; }
    });
    ['rag-private', 'rag-refresh'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        read(false); save().then(function () { return send('pipeline:changed'); }).catch(function (e) { status.textContent = e.message; });
      });
    });
    function start(retry) {
      var cfg = read(true);
      try {
        ensureReady(cfg);
        status.textContent = ''; setState('同步中', 'busy');
        var granted = permission(cfg, true);
        granted.then(async function (yes) { if (!yes) throw new Error('未授权网页访问，请允许后重试'); await save(); await send(retry ? 'pipeline:retry-failed' : 'pipeline:start'); await poll(); }).catch(function (e) { status.textContent = e.message; poll(); });
      } catch (e) { status.textContent = e.message; poll(); }
    }
    $('pipeline-start').addEventListener('click', function () { start(false); });
    $('pipeline-retry').addEventListener('click', function () { start(true); });
    $('pipeline-pause').addEventListener('click', function () { send('pipeline:pause').then(poll).catch(function (e) { status.textContent = e.message; }); });
    async function bind() {
      var settings = options.settings();
      var cfg = settings.rag;
      var token = settings.backup && (settings.backup.authToken || settings.backup.token);
      var ready = Rag.available(Rag.withAuth(cfg, settings.backup));
      auto.checked = !!cfg.enabled && cfg.autoSync !== false && ready;
      $('rag-private').checked = cfg.includePrivate;
      $('rag-refresh').value = cfg.refreshDays || 7;

      /* 集合由后台按账号生成、只读；登录后同步回本机 */
      if (!token) { status.textContent = '登录账号后启用后台 RAG'; return; }
      try {
        var conf = await Rag.config(token);
        cfg.collection = conf.collection;
        if (conf.enabled === false) {
          status.textContent = '后台尚未配置 RAG 服务';
        } else {
          /* 后台接管后清掉本机旧 Key/地址，避免仍可绕过代理直连 */
          settings.rag.baseUrl = '';
          settings.rag.apiKey = '';
          status.textContent = '';
        }
        options.persist();
        await Settings.save(settings);
      } catch (e) {
        status.textContent = e.message;
      }
    }
    async function poll() {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
      try {
        var state = await send('pipeline:status'); if (!state) return;
        var settings = options.settings();
        var cfg = settings.rag;
        var ready = Rag.available(Rag.withAuth(cfg, settings.backup));
        var autoOn = ready && cfg.enabled && cfg.autoSync !== false;
        var running = !!state.manual || !!(state.jobs && (state.jobs.running || state.jobs.pending));
        var mode = state.queuePaused ? '已暂停' : autoOn ? '自动同步已开启' : state.manual ? '正在执行本次同步' : '自动同步未开启';
        progress.textContent = state.collection ? mode + ' · ' + CollectionStats.format(state.collection) : '正在读取收藏收录状态…';
        progress.title = mode + (state.error ? ' · ' + state.error : '') + '。统计按收藏条目计算；总数＝已收录＋未收录；队列跨采集补全和 RAG 按收藏去重。';
        setState(state.queuePaused ? '已暂停' : running ? '同步中' : autoOn ? '已开启' : '未开启', state.queuePaused ? 'paused' : running ? 'busy' : autoOn ? 'on' : 'off');
        renderStats(state.collection);
        if (state.error) status.textContent = state.error;
        else if (lastPipelineError && status.textContent === lastPipelineError) status.textContent = '';
        lastPipelineError = state.error || '';
        $('pipeline-retry').hidden = !(state.retryableJobs || state.error);
        renderRecords(state.records || []);
      } catch (e) { status.textContent = e.message; }
    }
    setInterval(function () { if (!document.hidden) poll(); }, 4000); poll();
    document.addEventListener('workspace:search-page', function (event) { if (event.detail === 'rag') poll(); });
    return { bind: bind };
  }
  global.RagSettings = { mount: mount };
})(typeof self !== 'undefined' ? self : window);
