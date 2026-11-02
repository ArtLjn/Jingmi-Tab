/* 收藏总览：统一以当前书签条目为单位，按最近成功的 RAG 回执计收录，更新状态不抹去已有收录。 */
(function (global) {
  'use strict';
  function taskKind(item) {
    if (item.outcomeUnknown) return 'failed';
    if (item.status === 'running' || item.status === 'pending' && !item.error) return 'queue';
    if (item.status === 'failed' || item.status === 'paused' || item.error || item.sync === 'failed' || item.sync === 'paused') return 'failed';
    return item.status === 'waiting' ? 'queue' : '';
  }
  async function read(input) {
    input = input || {};
    var rows = input.rows || Bookmarks.flatten(await chrome.bookmarks.getTree());
    var docs = input.docs || await AgentDB.allRecords('documents');
    var jobs = input.jobs || await AgentDB.allRecords('jobs');
    var queue = input.queue || await AgentDB.getMeta('enrich:queue') || [];
    var failures = input.failures || await AgentDB.getMeta('enrich:failed') || [];
    var settings = input.settings || await Settings.load();
    var cfg = Rag.withAuth(settings.rag, settings.backup);
    var receipts = {};
    if (cfg.collection) {
      try { receipts = await AgentDB.getMeta(await Rag.stateKey(cfg)) || {}; } catch (e) { /* 未绑定集合时没有可确认的回执 */ }
    }
    var groups = await Documents.groups(rows);
    var docsById = new Map(docs.map(function (doc) { return [doc.id, doc]; }));
    var jobsById = new Map(jobs.map(function (job) { return [job.id, job]; }));
    var pages = await AgentDB.getPages(rows.map(function (row) { return ContentIndex.normUrl(row.url); }));
    var collected = new Set(), queued = new Set(), failed = new Set(), policies = new Map();
    var details = new Map();
    groups.forEach(function (group, id) {
      var doc = docsById.get(id), job = jobsById.get(id);
      var current = doc && !doc.deleted;
      var receipt = receipts[id];
      var privateDoc = doc && (doc.private || ['capture', 'feishu_api'].includes(doc.source));
      var written = current && receipt && receipt.docId && !['invalid', 'excluded', 'metadata'].includes(doc.admissionState) && receipt.quality !== 'metadata' && !(privateDoc && !cfg.includePrivate);
      group.rows.forEach(function (row) {
        var key = String(row.id);
        if (written) collected.add(key);
        if (!written && current) {
          var kind = taskKind({ status: job && job.status || 'unqueued', error: job && job.error, sync: doc.syncState, outcomeUnknown: doc.outcomeUnknown });
          var state = kind || (job && job.status === 'done' ? 'manual' : 'unarranged');
          var reason = kind === 'queue' ? job.status === 'running' ? '正在处理' : job.nextAt > Date.now() ? '已安排，等待执行时间' : '已排队，等待处理'
            : kind === 'failed' ? job && job.error || doc.syncError || doc.captureNote || '处理失败或等待访问条件恢复'
            : state === 'manual' ? Documents.captureLabel(doc) + '，尚未取得正文入库回执' : '尚未安排处理任务';
          details.set(key, { state: state, reason: reason });
        }
        if (current && job && (job.status === 'running' || job.status === 'pending' && (job.nextAt || 0) <= Date.now())) queued.add(key);
        if (current && job && ['failed', 'paused'].includes(job.status)) {
          failed.add(key); policies.set(key, RetryPolicy.classify(job.errorCode || doc.captureState || 'unknown', job.attempts));
        }
      });
    });
    rows.forEach(function (row) {
      var id = String(row.id);
      if (queue.some(function (q) { return String(q.id) === id && (!q.url || q.url === row.url); })) queued.add(id);
      var error = failures.find(function (f) { return String(f.id) === id && f.url === row.url; });
      if (error && !policies.has(id)) { failed.add(id); policies.set(id, RetryPolicy.classify(error.code, error.attempts)); }
      var page = pages[ContentIndex.normUrl(row.url)];
      if (!policies.has(id) && page && (page.status === 'fail' || page.refreshError)) policies.set(id, RetryPolicy.classify(page.refreshError || page.reason, 0));
      if (!ContentIndex.isWeb(row.url)) policies.set(id, RetryPolicy.classify('unsupported', 0));
    });
    var states = { queued: 0, failed: 0, manual: 0, paused: 0, waiting: 0 };
    var updates = { queued: 0, failed: 0 };
    rows.forEach(function (row) {
      var id = String(row.id), policy = policies.get(id);
      if (collected.has(id)) {
        if (queued.has(id)) updates.queued++;
        else if (failed.has(id)) updates.failed++;
        return;
      }
      if (queued.has(id)) states.queued++;
      else if (policy && policy.kind === 'manual') states.manual++;
      else if (policy && policy.kind === 'paused') states.paused++;
      else if (policy) states.failed++;
      else states.waiting++;
    });

    var uncollectedBreakdown = { queue: 0, failed: 0, manual: 0, unarranged: 0 };
    var uncollectedItems = rows.filter(function (row) { return !collected.has(String(row.id)); }).map(function (row) {
      var detail = !ContentIndex.isWeb(row.url) ? { state: 'manual', reason: '此类地址不支持正文收录' }
        : details.get(String(row.id)) || { state: 'unarranged', reason: '尚未安排处理任务' };
      uncollectedBreakdown[detail.state]++;
      return { id: String(row.id), title: row.title || row.url, url: row.url, state: detail.state, reason: detail.reason };
    });
    return { total: rows.length, collected: collected.size, uncollected: rows.length - collected.size,
      uncollectedItems: uncollectedItems, uncollectedBreakdown: uncollectedBreakdown,
      queue: states.queued, failed: states.failed, states: states, updates: updates };
  }
  function format(stats) {
    return '总书签 ' + stats.total + ' · 已收录 ' + stats.collected + ' · 未收录 ' + stats.uncollected;
  }
  function breakdown(stats) {
    var s = stats.uncollectedBreakdown;
    return s ? '未收录 ' + stats.uncollected + ' 个书签 = 处理中 ' + s.queue + ' + 处理失败 ' + s.failed + ' + 需补充条件 ' + s.manual + ' + 未安排 ' + s.unarranged
      : '总书签 ' + stats.total + ' = 已收录 ' + stats.collected + ' + 未收录 ' + stats.uncollected;
  }
  global.CollectionStats = { read: read, format: format, breakdown: breakdown, taskKind: taskKind };
})(typeof self !== 'undefined' ? self : window);
