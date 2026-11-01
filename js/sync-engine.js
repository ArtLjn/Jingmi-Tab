/* 持久化采集与入库队列。每次唤醒只处理有限任务，租约过期后可由新后台恢复。 */
(function (global) {
  'use strict';
  var ALARM = 'bookmark-pipeline';
  var running = false;
  async function enqueue(id, force, kind) {
    var doc = await Documents.get(id);
    if (!doc) return;
    return AgentDB.updateRecord('jobs', id, function (old) {
      if (old && !force && old.documentRevision === doc.revision) return old;
      return { id: id, generation: (old && old.generation || 0) + 1, documentRevision: doc.revision || 0,
        status: 'pending', attempts: 0, nextAt: Date.now(), force: !!force, kind: kind || 'upsert', requestedAt: Date.now() };
    });
  }
  async function reconcile(force) {
    var rows = Bookmarks.flatten(await chrome.bookmarks.getTree());
    var groups = await Documents.reconcile(rows);
    var cfg = await Settings.load();
    var period = Math.max(1, Number(cfg.rag.refreshDays) || 7) * 864e5;
    var docs = await AgentDB.allRecords('documents');
    /* 一次读出任务再逐文档比对，避免为每条文档各开一次事务。 */
    var jobs = await AgentDB.allRecords('jobs');
    var jobMap = new Map(jobs.map(function (job) { return [job.id, job]; }));
    for (var doc of docs) {
      var changed = groups.has(doc.id) && groups.get(doc.id).changed;
      var stale = !doc.deleted && Date.now() - (doc.checkedAt || doc.fetchedAt || 0) > period;
      var job = jobMap.get(doc.id);
      if (force || changed || !job || job.documentRevision !== doc.revision || (doc.deleted && doc.syncState !== 'deleted' && job.status !== 'pending' && job.status !== 'running') || (stale && job.status === 'done')) await enqueue(doc.id, force || stale, doc.deleted ? 'delete' : 'upsert');
    }
    /* 一次迁移清除旧版按书签 ID 入库的记录，同一文档不重复保留。 */
    if (Rag.available(cfg.rag)) {
      var saved = await AgentDB.getMeta(await Rag.stateKey(cfg.rag)) || {};
      for (var id of Object.keys(saved)) if (!saved[id].pageId) {
        await AgentDB.updateRecord('jobs', 'legacy:' + id, function (job) {
          return job && job.status === 'done' ? job : { id: 'legacy:' + id, legacyId: id, kind: 'legacy', generation: 1, status: 'pending', attempts: 0, nextAt: Date.now() };
        });
      }
    }
  }
  async function markDirty(force) {
    await AgentDB.updateMeta('pipeline:dirty', function (value) { return { revision: (value && value.revision || 0) + 1, force: !!force || !!(value && value.force) }; });
  }
  async function request(options) {
    options = options || {};
    if (options.manual) { await AgentDB.setMeta('pipeline:paused', false); await AgentDB.setMeta('pipeline:manual', true); await AgentDB.setMeta('pipeline:serviceBackoff', null); }
    await markDirty(!!options.force);
    await alarm();
    return run();
  }
  async function alarm() {
    if (!chrome.alarms) return;
    /* Chrome 120+ 支持 30 秒周期；旧版本会自行钳制到 1 分钟。 */
    if (!await chrome.alarms.get(ALARM)) await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  }
  async function claim(job, owner) {
    var now = Date.now();
    return AgentDB.updateRecord('jobs', job.id, function (current) {
      if (!current || (current.status === 'running' && current.leaseUntil > now) || current.nextAt > now || ['done', 'paused', 'failed'].indexOf(current.status) >= 0) return current;
      return Object.assign(current, { status: 'running', owner: owner, leaseUntil: now + 60000 });
    });
  }
  async function finish(job, status, error, retryable) {
    var doc = job.legacyId ? null : await Documents.get(job.id);
    await AgentDB.updateRecord('jobs', job.id, function (current) {
      if (!current || current.owner !== job.owner || current.generation !== job.generation) return current;
      if (doc) current.documentRevision = doc.revision;
      current.attempts += 1; current.error = error || ''; current.finishedAt = Date.now();
      if (retryable && current.attempts < 5) { current.status = 'pending'; current.nextAt = Date.now() + Math.min(3600000, 30000 * Math.pow(2, current.attempts - 1)); }
      else current.status = retryable ? 'failed' : status;
      delete current.owner; delete current.leaseUntil;
      return current;
    });
  }
  async function process(job, cfg) {
    if (job.legacyId) { await Rag.removeDocument(cfg.rag, job.legacyId); return { status: 'done' }; }
    var doc = await Documents.get(job.id);
    if (!doc) return { status: 'done' };
    if (doc.deleted) {
      await Rag.removeDocument(cfg.rag, doc.id);
      await Documents.update(doc.id, function (current) { if (current.deleted) current.syncState = 'deleted'; return current; });
      return { status: 'done' };
    }
    var blocked = null;
    var captureNeeded = job.force || !doc.fetchedAt || doc.captureState === 'pending';
    var protectedCapture = doc.source === 'capture' || !!doc.private || doc.source === 'feishu_api';
    if (captureNeeded && cfg.rag.autoCapture !== false && !protectedCapture) {
      try {
        var captured = await CaptureAdapters.read(doc, cfg.rag, job.force);
        doc = await Documents.capture(doc.id, captured);
      } catch (e) {
        blocked = e;
        doc = await Documents.update(doc.id, function (current) {
          current.captureState = e.state || 'failed'; current.captureNote = e.message; current.checkedAt = Date.now(); return current;
        });
      }
    }
    /* 不再为每个任务全量拍平书签树和 reconcile 全部文档：
       数百条文档时这是 O(任务 × 文档)，会把同步拖到几十秒以上。
       文档的删除状态由 run 开头的 reconcile 统一维护。 */
    doc = await Documents.get(doc.id);
    var revision = doc.revision;
    var result = await Rag.upsertDocument(cfg.rag, doc, await Organizer.records(doc.bookmarks || []));
    await Documents.update(doc.id, function (current) {
      if (current.revision === revision && !current.deleted) {
        current.syncState = result.excluded ? 'excluded' : 'synced'; current.indexedAt = Date.now(); current.indexedRevision = revision;
      }
      return current;
    });
    return blocked ? { status: blocked.retryable ? 'pending' : 'paused', error: blocked.message, retryable: blocked.retryable } : { status: 'done' };
  }
  async function run() {
    if (running) return summary();
    running = true;
    var owner = crypto.randomUUID(); var leased = false;
    try {
      var cfg = await Settings.load();
      if (await AgentDB.getMeta('pipeline:paused')) return summary();
      var manual = await AgentDB.getMeta('pipeline:manual');
      if (!Rag.available(cfg.rag) || (cfg.rag.autoSync === false && !manual)) return summary();
      var lease = await AgentDB.updateMeta('pipeline:lease', function (value) { return !value || value.until < Date.now() ? { owner: owner, until: Date.now() + 60000 } : value; });
      if (lease.owner !== owner) return summary();
      leased = true;
      var dirty = await AgentDB.getMeta('pipeline:dirty');
      var last = await AgentDB.getMeta('pipeline:reconciledAt') || 0;
      if (dirty || Date.now() - last > 3600000) {
        await reconcile(!!(dirty && dirty.force));
        await AgentDB.updateMeta('pipeline:dirty', function (current) { return current && dirty && current.revision === dirty.revision ? null : current; });
        await AgentDB.setMeta('pipeline:reconciledAt', Date.now());
        /* 大库 reconcile 可能超过 60s 租约，处理任务前确认自己仍持有租约。 */
        await AgentDB.updateMeta('pipeline:lease', function (value) {
          if (!value || value.owner !== owner) throw new Error('任务租约已变化');
          return { owner: owner, until: Date.now() + 60000 };
        });
      }
      var jobs = (await AgentDB.allRecords('jobs')).filter(function (j) {
        return (j.status === 'pending' || (j.status === 'running' && j.leaseUntil < Date.now())) && j.nextAt <= Date.now();
      }).sort(function (a, b) {
        /* 删除优先：清理云端的任务不被大量新增/刷新任务饿死。 */
        var rank = { 'delete': 0, 'legacy': 0 };
        return (rank[a.kind] === undefined ? 1 : rank[a.kind]) - (rank[b.kind] === undefined ? 1 : rank[b.kind]) || a.nextAt - b.nextAt;
      });
      if (jobs.length) {
        var serviceScope = await Documents.hash(cfg.rag.baseUrl + cfg.rag.collection + cfg.rag.apiKey);
        var backoff = await AgentDB.getMeta('pipeline:serviceBackoff');
        if (backoff && backoff.scope === serviceScope && (backoff.blocked || backoff.nextAt > Date.now())) return summary();
        try {
          await Rag.ensure(cfg.rag);
          await AgentDB.setMeta('pipeline:serviceBackoff', null);
        } catch (e) {
          var attempts = backoff && backoff.scope === serviceScope ? backoff.attempts + 1 : 1;
          await AgentDB.setMeta('pipeline:serviceBackoff', { scope: serviceScope, attempts: attempts, blocked: attempts >= 5, nextAt: Date.now() + Math.min(3600000, 30000 * Math.pow(2, attempts - 1)) });
          throw new Error(e.message + (attempts >= 5 ? '；已暂停自动连接，请检查配置后重试' : '；稍后自动重试'));
        }
      }
      var start = Date.now();
      for (var candidate of jobs) {
        if (Date.now() - start > 18000) break;
        if (await AgentDB.getMeta('pipeline:paused')) break;
        var currentCfg = await Settings.load();
        if (!Rag.available(currentCfg.rag) || currentCfg.rag.baseUrl !== cfg.rag.baseUrl || currentCfg.rag.collection !== cfg.rag.collection || (currentCfg.rag.autoSync === false && !await AgentDB.getMeta('pipeline:manual'))) break;
        await AgentDB.updateMeta('pipeline:lease', function (value) { if (!value || value.owner !== owner) throw new Error('任务租约已变化'); return { owner: owner, until: Date.now() + 60000 }; });
        var job = await claim(candidate, owner);
        if (!job || job.owner !== owner) continue;
        try { var result = await process(job, cfg); await finish(job, result.status, result.error, result.retryable); }
        catch (e) {
          if (!job.legacyId) await Documents.update(job.id, function (doc) { if (doc) { doc.syncState = 'failed'; doc.syncError = e.message; } return doc; });
          await finish(job, 'failed', e.message, true);
        }
      }
      if (!(await AgentDB.allRecords('jobs')).some(function (j) { return j.status === 'pending' || j.status === 'running'; })) await AgentDB.setMeta('pipeline:manual', false);
      await AgentDB.setMeta('pipeline:lastError', null);
    } catch (e) { await AgentDB.setMeta('pipeline:lastError', e.message || '同步暂时失败'); }
    finally {
      if (leased) await AgentDB.updateMeta('pipeline:lease', function (value) { return value && value.owner === owner ? null : value; });
      running = false;
    }
    if (chrome.runtime && chrome.runtime.sendMessage) chrome.runtime.sendMessage({ type: 'pipeline:updated' }).catch(function () {});
    return summary();
  }
  async function summary() {
    var jobs = await AgentDB.allRecords('jobs'); var docs = await AgentDB.allRecords('documents');
    var counts = { pending: 0, running: 0, done: 0, paused: 0, failed: 0 };
    jobs.forEach(function (job) { counts[job.status] = (counts[job.status] || 0) + 1; });
    return { jobs: counts, queuePaused: !!(await AgentDB.getMeta('pipeline:paused')), manual: !!(await AgentDB.getMeta('pipeline:manual')), documents: docs.filter(function (d) { return !d.deleted; }).length,
      indexed: docs.filter(function (d) { return !d.deleted && d.syncState === 'synced'; }).length,
      error: await AgentDB.getMeta('pipeline:lastError'), details: jobs.filter(function (j) { return j.error; }).slice(0, 8).map(function (j) { return { id: j.id, status: j.status, error: j.error, attempts: j.attempts }; }) };
  }
  async function retry(id) {
    await AgentDB.setMeta('pipeline:serviceBackoff', null);
    await AgentDB.setMeta('pipeline:paused', false);
    await AgentDB.setMeta('pipeline:manual', true);
    if (id) await enqueue(id, true);
    else { await markDirty(true); await AgentDB.setMeta('pipeline:manual', true); }
    return run();
  }
  async function retryFailed() {
    var jobs = await AgentDB.allRecords('jobs');
    for (var job of jobs) if (job.status === 'failed' || job.status === 'paused') await enqueue(job.id, true);
    return request({ manual: true });
  }
  async function pause() { await AgentDB.setMeta('pipeline:paused', true); await AgentDB.setMeta('pipeline:manual', false); return summary(); }
  global.SyncEngine = { ALARM: ALARM, alarm: alarm, enqueue: enqueue, reconcile: reconcile,
    request: request, run: run, summary: summary, retry: retry, retryFailed: retryFailed, pause: pause, markDirty: markDirty };
})(typeof self !== 'undefined' ? self : window);
