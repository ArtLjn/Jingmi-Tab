/* 收藏总览：统一以当前书签条目为单位，按最近成功的 RAG 回执计收录，更新状态不抹去已有收录。 */
(function (global) {
  'use strict';
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
    groups.forEach(function (group, id) {
      var doc = docsById.get(id), job = jobsById.get(id);
      var current = doc && !doc.deleted;
      var receipt = receipts[id];
      var privateDoc = doc && (doc.private || ['capture', 'feishu_api'].includes(doc.source));
      var written = current && receipt && receipt.docId && !(privateDoc && !cfg.includePrivate);
      group.rows.forEach(function (row) {
        var key = String(row.id);
        if (written) collected.add(key);
        if (current && job && ['pending', 'running'].includes(job.status)) queued.add(key);
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

    return { total: rows.length, collected: collected.size, uncollected: rows.length - collected.size,
      queue: states.queued, failed: states.failed, states: states, updates: updates };
  }
  function format(stats) {
    return '收藏总数 ' + stats.total + ' · 已收录 ' + stats.collected + ' · 未收录 ' + stats.uncollected +
      ' · 任务队列 ' + stats.queue + ' · 失败 ' + stats.failed;
  }
  function breakdown(stats) {
    var s = stats.states;
    if (!s) return '';
    var text = '未收录 ' + stats.uncollected + ' = 队列 ' + s.queued + ' + 失败 ' + s.failed +
      ' + 需人工处理 ' + s.manual + ' + 暂停 ' + s.paused + ' + 待安排 ' + s.waiting;
    if (stats.updates && (stats.updates.queued || stats.updates.failed)) text += '；已收录的后续任务：队列 ' + stats.updates.queued + '，异常 ' + stats.updates.failed;
    return text;
  }
  global.CollectionStats = { read: read, format: format, breakdown: breakdown };
})(typeof self !== 'undefined' ? self : window);
