/* 内容同步链路：RAG 地址/Key 由后台代理持有，前台只保留同步开关与隐私选项。 */
(function (global) {
  'use strict';
  function mount(options) {
    var $ = function (id) { return document.getElementById(id); };
    var auto = $('rag-enabled'); var status = $('rag-status'); var progress = $('pipeline-status');
    var recordLimit = 20;
    var failureLimit = 20;
    var bookmarkLimit = 40;
    var activeTab = 'processing';
    var bookmarkFilter = 'all';
    var latestCollection = null;
    var lastPipelineError = '';
    var retrying = false;
    var starting = false;
    var deleting = false;
    var selectedFailures = new Set();
    var latestFailures = [];
    var failureFilter = 'all';
    var labels = { pending: '排队', running: '处理中', waiting: '计划等待' };
    function setState(label, tone) {
      var el = $('rag-state'); if (!el) return;
      el.textContent = label; el.dataset.tone = tone;
    }
    function renderStats(collection, records) {
      var stats = $('rag-stats'); if (!stats) return;
      if (!collection) { stats.hidden = true; return; }
      stats.hidden = false;
      var values = Object.assign({}, collection, { failed: records.filter(isFailure).length, queue: records.filter(isProcessing).length });
      ['total', 'collected', 'uncollected', 'failed', 'queue'].forEach(function (key) {
        var value = Number(values[key]) || 0;
        var valueEl = $('rag-stat-' + key); if (valueEl) valueEl.textContent = value;
        var stat = stats.querySelector('[data-stat="' + key + '"]');
        if (stat) { stat.classList.toggle('is-zero', !value); stat.classList.toggle('is-danger', key === 'failed' && value > 0); }
      });
      var breakdown = CollectionStats.breakdown(collection);
      var summary = '收录概况。' + CollectionStats.format(collection) + (breakdown ? '。' + breakdown : '');
      stats.setAttribute('aria-label', summary); stats.title = summary;
      latestCollection = collection;
      $('rag-collected-count').textContent = collection.collected;
      $('rag-uncollected-count').textContent = collection.uncollected;
      if (activeTab === 'collected' || activeTab === 'uncollected') renderBookmarks();
    }
    function renderBookmarks() {
      var collected = activeTab === 'collected';
      var collection = latestCollection || {};
      var source = collected ? collection.collectedItems : collection.uncollectedItems;
      var items = source || [];
      $('rag-bookmarks-panel').setAttribute('aria-labelledby', collected ? 'rag-collected-tab' : 'rag-uncollected-tab');
      $('rag-bookmark-description').textContent = collected ? '这些书签的内容已入库，可以检索。最近更新失败时，已有内容仍会保留。' : '这些书签尚未入库。请按具体原因处理：未取得正文不等于网络失败，需要打开网页后采集正文。';
      $('rag-bookmark-filter-label').hidden = collected;
      if (!Array.isArray(source) && (collected ? collection.collected : collection.uncollected) > 0) {
        $('rag-bookmark-status').textContent = '后台列表尚未更新，请在扩展管理页重新加载扩展后打开此页。';
        $('rag-bookmark-records').replaceChildren();
        return;
      }
      var filter = $('rag-bookmark-filter');
      var reasons = new Map();
      items.forEach(function (item) { var key = item.reasonKey || item.state || 'other'; var value = reasons.get(key) || { label: item.reasonLabel || '其他', count: 0 }; value.count++; reasons.set(key, value); });
      filter.replaceChildren();
      var all = document.createElement('option'); all.value = 'all'; all.textContent = '全部原因（' + items.length + '）'; filter.append(all);
      if (bookmarkFilter !== 'all' && !reasons.has(bookmarkFilter)) reasons.set(bookmarkFilter, { label: '当前原因', count: 0 });
      reasons.forEach(function (value, key) { var option = document.createElement('option'); option.value = key; option.textContent = value.label + '（' + value.count + '）'; filter.append(option); });
      filter.value = bookmarkFilter;
      var visible = items.filter(function (item) { return collected || bookmarkFilter === 'all' || (item.reasonKey || item.state || 'other') === bookmarkFilter; });
      $('rag-bookmark-status').textContent = (collected ? '已收录' : '未收录') + '共 ' + (collected ? collection.collected || 0 : collection.uncollected || 0) + ' 个书签 · 当前筛选 ' + visible.length + ' 个';
      var body = $('rag-bookmark-records'); body.replaceChildren();
      visible.slice(0, bookmarkLimit).forEach(function (item) {
        var row = document.createElement('div'); row.className = 'pipeline-record';
        var main = document.createElement(/^https?:\/\//i.test(item.url) ? 'a' : 'div'); main.className = 'pipeline-main';
        if (main.tagName === 'A') { main.href = item.url; main.target = '_blank'; main.rel = 'noopener noreferrer'; }
        var title = document.createElement('p'); title.className = 'pipeline-title'; title.textContent = item.title; title.title = item.url;
        var reason = document.createElement('p'); reason.className = 'pipeline-meta'; reason.textContent = (item.reasonLabel || (collected ? '已收录' : '尚未收录')) + ' · ' + item.reason;
        var url = document.createElement('p'); url.className = 'pipeline-meta'; url.textContent = item.url;
        main.append(title, reason, url); row.append(main); body.append(row);
      });
      if (!visible.length) { var empty = document.createElement('p'); empty.className = 'auto-empty'; empty.textContent = '当前列表暂无书签。'; body.append(empty); }
      if (visible.length > bookmarkLimit) { var more = document.createElement('button'); more.type = 'button'; more.className = 'btn-ghost pipeline-more'; more.textContent = '查看更多书签'; more.addEventListener('click', function () { bookmarkLimit += 40; renderBookmarks(); }); body.append(more); }
    }
    $('rag-bookmark-filter').addEventListener('change', function () { bookmarkFilter = this.value; bookmarkLimit = 40; renderBookmarks(); $('rag-bookmark-records').scrollTop = 0; });
    /* 重试已重新排队时以当前任务为准，避免旧同步状态阻止它返回处理列表。 */
    function isFailure(item) {
      return CollectionStats.taskKind(item) === 'failed';
    }
    function isProcessing(item) { return CollectionStats.taskKind(item) === 'queue'; }
    function category(item) { return item.errorCategory || { key: 'other', label: '其他' }; }
    function selectable(item) { return !!item.id && !!item.selectableRetry && !item.outcomeUnknown; }
    function filteredFailures() { return latestFailures.filter(function (item) { return failureFilter === 'all' || category(item).key === failureFilter; }); }
    function updateSelection() {
      var visible = filteredFailures();
      var selectedItems = visible.filter(function (item) { return selectedFailures.has(item.id); });
      var retryable = selectedItems.filter(selectable).length;
      var all = $('rag-failure-select-all');
      all.checked = visible.length > 0 && selectedItems.length === visible.length;
      all.indeterminate = selectedItems.length > 0 && selectedItems.length < visible.length;
      all.disabled = retrying || deleting || !visible.length;
      var retry = $('pipeline-retry');
      retry.disabled = retrying || starting || deleting || !retryable;
      retry.textContent = retrying ? '正在重试…' : '重试所选' + (retryable ? '（' + retryable + '）' : '');
      var remove = $('pipeline-delete-selected');
      if (remove) {
        remove.disabled = retrying || starting || deleting || !selectedItems.length;
        remove.textContent = deleting ? '正在删除…' : '删除所选' + (selectedItems.length ? '（' + selectedItems.length + '）' : '');
      }
      $('rag-failure-filter').disabled = retrying || deleting;
      document.querySelectorAll('#rag-failure-records .pipeline-select').forEach(function (check) { check.disabled = retrying || deleting; });
      $('pipeline-retry-hint').textContent = '已选 ' + selectedItems.length + ' 项，其中可重试 ' + retryable + ' 项；删除会移除所选全部收藏，切换筛选会清空选择。';
    }
    $('rag-failure-filter').addEventListener('change', function () {
      failureFilter = this.value; selectedFailures.clear(); failureLimit = 20; renderFailureRecords(latestFailures);
    });
    $('rag-failure-select-all').addEventListener('change', function () {
      var checked = this.checked;
      filteredFailures().forEach(function (item) { if (checked) selectedFailures.add(item.id); else selectedFailures.delete(item.id); });
      renderFailureRecords(latestFailures);
    });

    function selectTab(name, focus) {
      activeTab = name; bookmarkFilter = 'all'; bookmarkLimit = 40;
      document.querySelectorAll('[data-rag-tab]').forEach(function (tab) {
        var active = tab.dataset.ragTab === name;
        tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
        if (active && focus) tab.focus();
      });
      $('rag-processing-panel').hidden = name !== 'processing';
      $('rag-failures-panel').hidden = name !== 'failures';
      $('rag-bookmarks-panel').hidden = name !== 'collected' && name !== 'uncollected';
      if (name === 'collected' || name === 'uncollected') { renderBookmarks(); $('rag-bookmark-records').scrollTop = 0; }
      var page = $('rag-flow-card').closest('[data-search-page]');
      page.dataset.pageDetail = { processing: '处理任务', failures: '失败任务', collected: '已收录', uncollected: '未收录' }[name];
      if (!page.hidden && $('search-page-detail')) $('search-page-detail').textContent = page.dataset.pageDetail;
    }
    document.querySelectorAll('[data-rag-tab]').forEach(function (tab) {
      tab.addEventListener('click', function () { selectTab(tab.dataset.ragTab); poll(); });
      tab.addEventListener('keydown', function (event) {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(event.key) < 0) return;
        event.preventDefault();
        var names = ['processing', 'failures', 'collected', 'uncollected'];
        var index = names.indexOf(tab.dataset.ragTab);
        selectTab(event.key === 'Home' ? names[0] : event.key === 'End' ? names[names.length - 1] : names[(index + (event.key === 'ArrowLeft' ? -1 : 1) + names.length) % names.length], true);
      });
    });

    function createRecordRow(item, selection) {
      var rowStatus = item.status || 'pending';
      var row = document.createElement('div'); row.className = 'pipeline-record auto-archive-record'; row.dataset.status = rowStatus;
      if (selection) {
        var check = document.createElement('input'); check.type = 'checkbox'; check.className = 'pipeline-select';
        check.setAttribute('aria-label', '选择任务：' + item.title); check.dataset.documentId = item.id;
        check.disabled = retrying || deleting; check.checked = selectedFailures.has(item.id);
        check.title = selectable(item) ? '选择此任务（可重试，也可删除）' : '选择此任务（不可重试，但可删除）';
        check.addEventListener('change', function () { if (check.checked) selectedFailures.add(item.id); else selectedFailures.delete(item.id); updateSelection(); }); row.append(check);
      }
      var dot = document.createElement('span'); dot.className = 'pipeline-dot'; dot.setAttribute('aria-hidden', 'true');
      var main = document.createElement(item.url ? 'a' : 'div'); main.className = 'pipeline-main';
      if (item.url) {
        main.href = item.url; main.target = '_blank'; main.rel = 'noopener noreferrer';
        main.title = '打开原网页：' + (item.title || item.url);
      }
      var title = document.createElement('p'); title.className = 'pipeline-title'; title.textContent = item.title; title.title = item.title;
      var meta = document.createElement('p'); meta.className = 'pipeline-meta';
      var capture = document.createElement('span'); capture.textContent = item.capture || '未采集正文';
      var divider = document.createElement('i'); divider.setAttribute('aria-hidden', 'true'); divider.textContent = '·';
      var sync = document.createElement('span'); sync.textContent = item.syncLabel || (item.sync === 'synced' ? '已入库' : '未入库');
      meta.append(capture, divider, sync);
      /* 失败与待授权已由采集状态、状态点和错误行表达，不再重复贴标签。 */
      if (labels[rowStatus]) { var chip = document.createElement('span'); chip.className = 'pipeline-chip'; chip.textContent = labels[rowStatus]; meta.append(chip); }
      if (selection) { var kind = document.createElement('span'); kind.className = 'pipeline-chip'; kind.textContent = category(item).label; meta.append(kind); }
      main.append(title, meta);
      if (item.error) {
        var error = document.createElement('p'); error.className = 'pipeline-error';
        error.textContent = item.error; error.title = item.error; main.append(error);
      }
      if (item.dueAt && item.dueAt > Date.now()) { var due = document.createElement('p'); due.className = 'hint'; due.textContent = '计划复核：' + new Date(item.dueAt).toLocaleString('zh-CN') + '（需浏览器运行）'; main.append(due); }
      var actions = document.createElement('div'); actions.className = 'pipeline-actions';
      if (item.admission && !item.outcomeUnknown && (item.admission !== 'eligible' || item.sync === 'failed')) { var captureAgain = document.createElement('button'); captureAgain.type = 'button'; captureAgain.className = 'pipeline-retry'; captureAgain.textContent = '重新采集'; captureAgain.addEventListener('click', function () { send('pipeline:recapture', { documentId: item.id }).then(poll).catch(function (e) { status.textContent = e.message; }); }); actions.append(captureAgain); }
      if (item.outcomeUnknown) { var verify = document.createElement('button'); verify.type = 'button'; verify.className = 'pipeline-retry'; verify.textContent = '核验写入结果'; verify.addEventListener('click', function () { send('pipeline:verify', { documentId: item.id }).then(poll).catch(function (e) { status.textContent = e.message; }); }); actions.append(verify); }
      row.append(dot, main);
      if (!item.admission && item.error && item.policy && item.policy.allowManual && item.id) {
        var retry = document.createElement('button'); retry.type = 'button'; retry.className = 'pipeline-retry';
        retry.textContent = '重试'; retry.title = '检查后重试此项'; retry.setAttribute('aria-label', '检查后重试此项：' + item.title);
        retry.addEventListener('click', function () { send('pipeline:retry', { documentId: item.id }).then(poll).catch(function (e) { status.textContent = e.message; }); });
        actions.append(retry);
      }
      if (actions.childNodes.length) row.append(actions);
      return row;
    }

    function renderExecutionRecords(records) {
      records = records.filter(isProcessing);
      var count = $('rag-processing-count'); if (count) count.textContent = records.length;
      var body = $('pipeline-records');
      if (!body) return;
      body.replaceChildren();
      var heading = document.createElement('p'); heading.className = 'pipeline-head';
      var headingLabel = document.createElement('strong'); headingLabel.textContent = '当前处理队列';
      var headingCount = document.createElement('em'); headingCount.textContent = records.length + ' 页';
      heading.append(headingLabel, headingCount); body.append(heading);
      if (!records.length) { var empty = document.createElement('p'); empty.className = 'auto-empty'; empty.textContent = '当前队列为空。可点击“批量处理”检查并安排待同步任务，失败项请到“失败任务”查看。'; body.append(empty); }
      records.slice(0, recordLimit).forEach(function (item) { body.append(createRecordRow(item)); });
      if (records.length > recordLimit) {
        var more = document.createElement('button'); more.type = 'button'; more.className = 'btn-ghost pipeline-more'; more.textContent = '查看更多排队任务';
        more.addEventListener('click', function () { recordLimit += 20; renderExecutionRecords(records); }); body.append(more);
      }
    }

    function renderFailureRecords(records) {
      latestFailures = records.filter(isFailure);
      var valid = new Set(latestFailures.map(function (item) { return item.id; }));
      selectedFailures.forEach(function (id) { if (!valid.has(id)) selectedFailures.delete(id); });
      var filter = $('rag-failure-filter');
      var categories = new Map();
      latestFailures.forEach(function (item) { var type = category(item); var old = categories.get(type.key); categories.set(type.key, { label: type.label, count: (old && old.count || 0) + 1 }); });
      filter.replaceChildren();
      var allOption = document.createElement('option'); allOption.value = 'all'; allOption.textContent = '全部错误（' + latestFailures.length + '）'; filter.append(allOption);
      if (failureFilter !== 'all' && !categories.has(failureFilter)) categories.set(failureFilter, { label: '当前类型', count: 0 });
      categories.forEach(function (value, key) { var option = document.createElement('option'); option.value = key; option.textContent = value.label + '（' + value.count + '）'; filter.append(option); });
      filter.value = failureFilter;
      var failures = filteredFailures();
      var count = $('rag-failure-count');
      if (count) count.textContent = latestFailures.length;
      var statusLine = $('rag-failure-status');
      if (statusLine) statusLine.textContent = '当前筛选 ' + failures.length + ' 条 / 共 ' + latestFailures.length + ' 条失败任务';
      updateSelection();
      var body = $('rag-failure-records');
      if (!body) return;
      body.replaceChildren();
      if (!failures.length) { var empty = document.createElement('p'); empty.className = 'auto-empty'; empty.textContent = '当前筛选下暂无失败任务。'; body.append(empty); return; }
      failures.slice(0, failureLimit).forEach(function (item) { body.append(createRecordRow(item, true)); });
      if (failures.length > failureLimit) {
        var more = document.createElement('button'); more.type = 'button'; more.className = 'btn-ghost pipeline-more'; more.textContent = '查看更多失败任务';
        more.addEventListener('click', function () { failureLimit += 20; renderFailureRecords(records); }); body.append(more);
      }
    }
    function read(enable) {
      var settings = options.settings();
      var cfg = Rag.withAuth(settings.rag, settings.backup);
      cfg.includePrivate = $('rag-private').checked;
      cfg.cleanupEnabled = $('rag-cleanup') ? $('rag-cleanup').checked : false;
      cfg.refreshDays = Math.max(1, Math.min(90, Number($('rag-refresh').value) || 7));
      cfg.autoSync = auto.checked;
      cfg.autoCapture = true;
      cfg.enabled = !!settings.rag.enabled || auto.checked || !!enable;

      /* 同步回 settings.rag，poll() 与后台都读同一份开关状态 */
      settings.rag.includePrivate = cfg.includePrivate;
      settings.rag.cleanupEnabled = cfg.cleanupEnabled;
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
    async function ensureReady(cfg) {
      Object.assign(cfg, await Rag.resolve(cfg, options.settings().backup));
      if (!Rag.available(cfg)) throw new Error('RAG 检索尚未就绪，请检测连接后重试');
    }
    auto.addEventListener('change', function () {
      var cfg = read(false);
      if (!auto.checked) { setState('未开启', 'off'); save().then(function () { return send('pipeline:pause'); }).then(poll).catch(function (e) { status.textContent = e.message; }); return; }
      try {
        setState('同步中', 'busy');
        var granted = permission(cfg, true);
        granted.then(async function (yes) { if (!yes) throw new Error('未授权网页访问，请允许后重试'); await ensureReady(cfg); await save(); await send('pipeline:start'); await poll(); }).catch(function (e) { auto.checked = false; setState('未开启', 'off'); status.textContent = e.message; });
      } catch (e) { auto.checked = false; cfg.autoSync = false; setState('未开启', 'off'); status.textContent = e.message; }
    });
    ['rag-private', 'rag-refresh', 'rag-cleanup'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        read(false); save().then(function () { return send('pipeline:changed'); }).catch(function (e) { status.textContent = e.message; });
      });
    });
    async function start(retry) {
      if (retrying || starting || retry && !selectedFailures.size) return;
      var ids = retry ? Array.from(selectedFailures) : null;
      var cfg = read(true);
      try {
        if (retry) { retrying = true; updateSelection(); }
        else { starting = true; $('pipeline-start').disabled = true; $('pipeline-start').textContent = '批量处理中…'; $('pipeline-process-result').textContent = '正在检查待同步项并处理队列…'; }
        status.textContent = ''; setState('同步中', 'busy');
        var granted = permission(cfg, true);
        if (!await granted) throw new Error('未授权网页访问，请允许后重试');
        await ensureReady(cfg); await save();
        var result = await send(retry ? 'pipeline:retry-failed' : 'pipeline:start', retry ? { ids: ids } : {});
        if (retry && result && result.retryBatch) { $('pipeline-retry-status').textContent = '已重新入队 ' + result.retryBatch.queued + ' 项，跳过 ' + result.retryBatch.skipped + ' 项。'; ids.forEach(function (id) { selectedFailures.delete(id); }); }
        if (!retry) $('pipeline-process-result').textContent = result && result.error || '已提交批量处理，队列状态将持续更新。';
      } catch (e) {
        status.textContent = e.message;
        if (retry) $('pipeline-retry-status').textContent = e.message;
        else $('pipeline-process-result').textContent = e.message;
      } finally {
        if (retry) retrying = false;
        else starting = false;
        await poll();
      }
    }
    if ($('pipeline-network')) $('pipeline-network').addEventListener('click', function () { send('pipeline:network-retry').then(poll).catch(function (e) { status.textContent = e.message; }); });
    if ($('pipeline-audit')) $('pipeline-audit').addEventListener('click', async function () {
      var container = $('pipeline-audit-results'); if (!container) return;
      try {
        var records = await send('pipeline:audit'); container.replaceChildren(); container.hidden = false;
        var explanation = document.createElement('p'); explanation.className = 'hint'; explanation.textContent = '仅检查，不自动删除。勾选表示你已核对该记录仅有元数据；清理不会删除书签或个人入口。'; container.append(explanation);
        records.forEach(function (item) { var label = document.createElement('label'); label.className = 'pipeline-record'; var check = document.createElement('input'); check.type = 'checkbox'; check.value = item.id; check.disabled = !item.selectable; var text = document.createElement('span'); text.textContent = item.title + ' · ' + item.url + ' · ' + item.reason; label.append(check, text); container.append(label); });
        var clean = document.createElement('button'); clean.type = 'button'; clean.className = 'btn-ghost'; clean.textContent = '清理已核对的所选空记录'; clean.disabled = true;
        container.onchange = function () { clean.disabled = !container.querySelector('input:checked'); };
        clean.addEventListener('click', async function () { clean.disabled = true; try { var ids = Array.from(container.querySelectorAll('input:checked')).map(function (input) { return input.value; }); await send('pipeline:clean', { ids: ids }); container.replaceChildren(); container.hidden = true; await poll(); } catch (e) { status.textContent = e.message; clean.disabled = false; } });
        container.append(clean);
      } catch (e) { status.textContent = e.message; }
    });
    function confirmDelete(items) {
      var bookmarks = items.reduce(function (sum, item) { return sum + (Number(item.bookmarkCount) || 0); }, 0);
      var dialog = document.createElement('dialog');
      dialog.className = 'tag-editor organizer-dialog confirm-dialog';
      var title = document.createElement('h2'); title.id = 'confirm-delete-title'; title.textContent = '删除所选收藏？';
      dialog.setAttribute('aria-labelledby', title.id);
      dialog.addEventListener('click', function (event) { event.stopPropagation(); });
      var text = document.createElement('p');
      var names = items.slice(0, 3).map(function (item) { return item.title || item.url || item.id; }).join('、');
      if (items.length > 3) names += ' 等 ' + items.length + ' 项';
      text.textContent = '将删除：' + names + '。' + (bookmarks ? '对应 ' + bookmarks + ' 个浏览器书签，' : '') + '并安排云端收录清理。删除后无法恢复。';
      var warning = document.createElement('p'); warning.className = 'hint'; warning.textContent = '仅在你确认网站无法访问时使用。';
      var actions = document.createElement('div'); actions.className = 'row';
      var cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn-ghost'; cancel.textContent = '取消';
      var confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'btn-ghost confirm-danger'; confirm.textContent = '确认删除';
      cancel.addEventListener('click', function () { dialog.close(); });
      confirm.addEventListener('click', function () { var ids = items.map(function (item) { return item.id; }); dialog.close(); deleteSelected(ids); });
      dialog.addEventListener('close', function () { dialog.remove(); });
      actions.append(cancel, confirm);
      dialog.append(title, text, warning, actions);
      document.body.append(dialog);
      dialog.showModal();
      cancel.focus();
    }
    async function deleteSelected(ids) {
      if (deleting || !ids.length) return;
      deleting = true;
      updateSelection();
      var line = $('pipeline-delete-status');
      if (line) line.textContent = '正在删除所选收藏…';
      try {
        var result = await send('pipeline:delete-failed', { ids: ids });
        var batch = result && result.deleteBatch;
        selectedFailures.clear();
        if (line) {
          var message = batch ? '已删除 ' + batch.removed + ' 个书签' : '删除请求已提交';
          if (batch && batch.failed && batch.failed.length) message += '，' + batch.failed.length + ' 个失败';
          if (batch && batch.cloudRemoved) message += '；云端清理完成';
          else if (batch && batch.cloudQueued) message += '；云端清理已排队';
          if (batch && batch.syncError) message += '；' + batch.syncError;
          line.textContent = message;
        }
      } catch (e) {
        if (line) line.textContent = e.message;
      } finally {
        deleting = false;
        await poll();
        updateSelection();
      }
    }
    if ($('pipeline-delete-selected')) $('pipeline-delete-selected').addEventListener('click', function () {
      if (deleting || retrying || starting) return;
      var items = latestFailures.filter(function (item) { return selectedFailures.has(item.id); });
      if (items.length) confirmDelete(items);
    });
    $('pipeline-start').addEventListener('click', function () { start(false); });
    if ($('pipeline-retry')) $('pipeline-retry').addEventListener('click', function () { start(true); });
    $('pipeline-pause').addEventListener('click', function () { send('pipeline:pause').then(poll).catch(function (e) { status.textContent = e.message; }); });
    async function bind() {
      var settings = options.settings();
      var cfg = settings.rag;
      auto.checked = !!cfg.enabled && cfg.autoSync !== false;
      $('rag-private').checked = cfg.includePrivate;
      if ($('rag-cleanup')) $('rag-cleanup').checked = !!cfg.cleanupEnabled;
      $('rag-refresh').value = cfg.refreshDays || 7;
      await checkConnection();
    }
    var checkingConnection = false;
    async function checkConnection() {
      var output = $('rag-connection-status');
      var button = $('rag-check');
      if (!output || checkingConnection) return;
      checkingConnection = true;
      if (button) button.disabled = true;
      output.textContent = '正在检测 RAG 检索连接…';
      try {
        var settings = options.settings();
        var result = await Rag.check(settings.rag, settings.backup);
        output.textContent = 'RAG 检索连接正常 · ' + new Date(result.checkedAt).toLocaleTimeString('zh-CN') + ' 检测通过（不代表所有收藏已入库）';
        output.dataset.tone = 'on';
      } catch (e) {
        output.textContent = e.message;
        output.dataset.tone = 'off';
      } finally {
        checkingConnection = false;
        if (button) button.disabled = false;
      }
    }
    if ($('rag-check')) $('rag-check').addEventListener('click', checkConnection);
    async function poll() {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
      try {
        var state = await send('pipeline:status'); if (!state) return;
        var settings = options.settings();
        var cfg = settings.rag;
        var autoOn = cfg.enabled && cfg.autoSync !== false;
        var running = !!state.manual || !!(state.jobs && (state.jobs.running || state.jobs.pending));
        var mode = state.queuePaused ? '已暂停' : autoOn ? '自动同步已开启' : state.manual ? '正在执行本次同步' : '自动同步未开启';
        progress.textContent = state.collection ? mode + ' · ' + CollectionStats.format(state.collection) : '正在读取收藏收录状态…';
        progress.title = mode + (state.error ? ' · ' + state.error : '') + '。总书签＝已收录＋未收录。处理队列和失败数量按任务计，与下方列表一致。';
        setState(state.queuePaused ? '已暂停' : running ? '同步中' : autoOn ? '已开启' : '未开启', state.queuePaused ? 'paused' : running ? 'busy' : autoOn ? 'on' : 'off');
        renderStats(state.collection, state.records || []);
        if (state.error) status.textContent = state.error;
        else if (lastPipelineError && status.textContent === lastPipelineError) status.textContent = '';
        lastPipelineError = state.error || '';
        var records = state.records || [];
        var queue = records.filter(isProcessing);
        $('pipeline-queue-status').textContent = (state.queuePaused ? '队列已暂停 · ' : '') + '处理中 ' + queue.filter(function (item) { return item.status === 'running'; }).length + ' · 排队 ' + queue.filter(function (item) { return item.status === 'pending'; }).length + ' · 计划等待 ' + queue.filter(function (item) { return item.status === 'waiting'; }).length + ' · 任务状态自动保存';
        $('pipeline-start').disabled = starting || retrying;
        $('pipeline-start').textContent = starting ? '批量处理中…' : '批量处理';
        renderExecutionRecords(records);
        renderFailureRecords(records);
      } catch (e) { status.textContent = e.message; }
    }
    if (chrome.runtime.onMessage) chrome.runtime.onMessage.addListener(function (message) { if (message.type === 'pipeline:updated') poll(); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
    setInterval(function () { if (!document.hidden) poll(); }, 4000); poll();
    document.addEventListener('workspace:search-page', function (event) { if (event.detail === 'rag') { poll(); checkConnection(); } });
    return { bind: bind };
  }
  global.RagSettings = { mount: mount };
})(typeof self !== 'undefined' ? self : window);
