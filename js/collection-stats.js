/* 收藏总览：统一以当前书签条目为单位，按最近成功的 RAG 回执计收录，更新状态不抹去已有收录。 */
(function (global) {
  'use strict';
  function taskKind(item) {
    if (item.outcomeUnknown) return 'failed';
    if (item.status === 'done' && !item.error && ['metadata', 'excluded'].includes(item.admission)) return '';
    if (item.status === 'running' || item.status === 'pending' && !item.error) return 'queue';
    if (item.status === 'failed' || item.status === 'paused' || item.error || item.sync === 'failed' || item.sync === 'paused') return 'failed';
    return item.status === 'waiting' ? 'queue' : '';
  }
  /* 展示实际访问或采集原因，不把“任务结束但未入库”一律当作错误。 */
  function describeBookmark(doc, job, cfg) {
    doc = doc || {}; cfg = cfg || {};
    var code = String(job && job.errorCode || doc.captureError || doc.admissionReason || '').replace(/^ai_/, '');
    function result(key, label, reason) { return { reasonKey: key, reasonLabel: label, reason: reason }; }
    if (taskKind({ status: job && job.status, error: job && job.error, sync: doc.syncState, admission: doc.admissionState, outcomeUnknown: doc.outcomeUnknown }) === 'queue') return result('queue', '处理中', job && job.status === 'running' ? '正在采集或同步内容。' : '已安排处理，请等待队列执行。');
    if (doc.outcomeUnknown || /^(outcome_unknown|http_409)$/.test(code)) return result('verify', '待核验写入', '上次云端写入结果不确定，请先核验，避免重复写入。');
    if (/^(login_wall|http_401|http_403)$/.test(code)) return result('login', '需要登录', '自动采集未能访问正文，请打开原网页检查登录状态后采集。');
    if (/^(waiting_auth|waiting_permission|unauthorized)$/.test(code)) return result('auth', '需要授权', '尚未取得页面或站点访问权限，请完成授权后采集。');
    if ((doc.private || ['capture', 'feishu_api'].includes(doc.source)) && !cfg.includePrivate || code === 'private') return result('private', '登录页上传已关闭', '正文保留在本机；若要收录，请在同步设置中开启登录页面正文上传。');
    if (/^(unsupported|not_html)$/.test(code)) return result('unsupported', '不支持采集', '此类地址或文件暂不支持自动采集正文。');
    if (/^http_(404|410)$/.test(code)) return result('invalid', '页面无法访问', '原页面不存在或已失效，请打开网页确认地址。');
    if (/^(daily_limit|http_429)$/.test(code)) return result('quota', '限流暂停', '服务额度或访问频率受限，等待恢复后再处理。');
    if (/^(timeout|network|network_suspected|http_408|http_5\d\d)$/.test(code)) return result('network', '网络或服务失败', job && job.error || doc.syncError || '网络或服务暂时异常，请检查后重试。');
    if (/^(no_body|no_content|dynamic_shell|waiting_open)$/.test(code) || doc.captureState === 'waiting_open') return result('no_body', '未取得正文', '仅保存了标题、描述或入口。请打开原网页，点击扩展图标采集正文；这不等于网络处理失败。');
    if (job && job.error || doc.syncState === 'failed') return result('failed', '采集或同步失败', job && job.error || doc.syncError || '采集或同步出现错误，请检查后重试。');
    if (!job) return result('unarranged', '未安排', '尚未安排处理任务，可在处理任务中点击批量处理。');
    if (!String(doc.text || '').trim()) return result('no_body', '未取得正文', '自动采集未提取到可入库正文。请打开网页后采集；该项尚未收录，不作为处理成功展示。');
    return result('not_synced', '尚未入库', '本机已有内容，但尚未取得入库成功回执，可通过批量处理继续同步。');
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
    var bookmarkDocs = new Map();
    var coverage = { body: 0, profile: 0, personal: 0 };
    groups.forEach(function (group, id) {
      var doc = docsById.get(id), job = jobsById.get(id);
      var current = doc && !doc.deleted;
      var receipt = receipts[id];
      var privateDoc = doc && (doc.private || ['capture', 'feishu_api'].includes(doc.source));
      var written = current && receipt && receipt.docId && !['invalid', 'excluded', 'metadata'].includes(doc.admissionState) && receipt.quality !== 'metadata' && !(privateDoc && !cfg.includePrivate && receipt.quality !== 'personal');
      group.rows.forEach(function (row) {
        var key = String(row.id);
        if (current) bookmarkDocs.set(key, { doc: doc, job: job, quality: receipt && receipt.quality });
        if (written) { collected.add(key); var quality = receipt.quality || 'body'; if (coverage[quality] !== undefined) coverage[quality]++; }
        if (!written && current) {
          var kind = taskKind({ status: job && job.status || 'unqueued', error: job && job.error, sync: doc.syncState, admission: doc.admissionState, outcomeUnknown: doc.outcomeUnknown });
          var state = kind || (job && job.status === 'done' ? 'manual' : 'unarranged');
          details.set(key, Object.assign({ state: state, documentId: doc.id }, describeBookmark(doc, job, cfg)));
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
      var detail = !ContentIndex.isWeb(row.url) ? { state: 'manual', reasonKey: 'unsupported', reasonLabel: '不支持采集', reason: '此类地址不支持正文收录' }
        : details.get(String(row.id)) || { state: 'unarranged', reasonKey: 'unarranged', reasonLabel: '未安排', reason: '尚未安排处理任务' };
      uncollectedBreakdown[detail.state]++;
      return Object.assign({ id: String(row.id), title: row.title || row.url, url: row.url }, detail);
    });
    var collectedItems = rows.filter(function (row) { return collected.has(String(row.id)); }).map(function (row) {
      var info = bookmarkDocs.get(String(row.id));
      var updateFailed = info && taskKind({ status: info.job && info.job.status, error: info.job && info.job.error, sync: info.doc.syncState, admission: info.doc.admissionState, outcomeUnknown: info.doc.outcomeUnknown }) === 'failed';
      var description = info && info.quality === 'profile' ? '网站资料可检索；尚未取得正文，不能据此回答具体文档内容。' : info && info.quality === 'personal' ? '用户备注和别名可检索；尚未收录正文。' : '内容已入库，可用于检索。';
      return { id: String(row.id), documentId: info && info.doc.id, title: row.title || row.url, url: row.url, quality: info && info.quality, reasonKey: 'collected', reasonLabel: '已收录', reason: updateFailed ? '已有内容可检索；最近一次更新失败，可在失败任务中查看。' : description };
    });
    return { total: rows.length, collected: collected.size, uncollected: rows.length - collected.size,
      collectedItems: collectedItems, coverage: coverage, uncollectedItems: uncollectedItems, uncollectedBreakdown: uncollectedBreakdown,
      queue: states.queued, failed: states.failed, states: states, updates: updates };
  }
  function format(stats) {
    return '总书签 ' + stats.total + ' · 已收录 ' + stats.collected + ' · 未收录 ' + stats.uncollected;
  }
  function breakdown(stats) {
    return '总书签 ' + stats.total + ' = 已收录 ' + stats.collected + ' + 未收录 ' + stats.uncollected;
  }
  global.CollectionStats = { read: read, format: format, breakdown: breakdown, taskKind: taskKind, describeBookmark: describeBookmark };
})(typeof self !== 'undefined' ? self : window);
