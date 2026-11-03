/* 持久化采集与入库队列。每次唤醒只处理有限任务，租约过期后可由新后台恢复。 */
(function (global) {
  'use strict';
  var ALARM = 'bookmark-pipeline';
  var running = false;
  async function enqueue(id, force, kind, reschedule) {
    var doc = await Documents.get(id);
    if (!doc) return;
    return AgentDB.updateRecord('jobs', id, function (old) {
      if (doc.outcomeUnknown && old) return old;
      if (old && !force && !reschedule && old.documentRevision === doc.revision) return old;
      return { id: id, generation: (old && old.generation || 0) + 1, documentRevision: doc.revision || 0,
        status: 'pending', attempts: 0, nextAt: Date.now(), force: !!force, kind: kind || 'upsert', requestedAt: Date.now() };
    });
  }
  async function reconcile(force) {
    var rows = Bookmarks.flatten(await chrome.bookmarks.getTree());
    var groups = await Documents.reconcile(rows);
    var cfg = await Settings.load();
    cfg.rag = Rag.withAuth(cfg.rag, cfg.backup);
    var period = Math.max(1, Number(cfg.rag.refreshDays) || 7) * 864e5;
    var docs = await AgentDB.allRecords('documents');
    /* 一次读出任务再逐文档比对，避免为每条文档各开一次事务。 */
    var jobs = await AgentDB.allRecords('jobs');
    var jobMap = new Map(jobs.map(function (job) { return [job.id, job]; }));
    for (var doc of docs) {
      var changed = groups.has(doc.id) && groups.get(doc.id).changed;
      var stale = !doc.deleted && Date.now() - (doc.checkedAt || doc.fetchedAt || doc.indexedAt || doc.createdAt || 0) > period;
      var job = jobMap.get(doc.id);
      var policyChanged = doc.policyVersion !== IngestPolicy.VERSION || (doc.captureError || '') !== (doc.lastEvaluatedError || '');
      if (job && job.kind === 'cleanup' && ['pending', 'running'].includes(job.status) && job.cleanupRevision === doc.revision) continue;
      if (job && job.status === 'paused' && RetryPolicy.resumed(job.errorCode, job.finishedAt)) { await enqueue(doc.id, true, doc.deleted ? 'delete' : 'upsert'); continue; }
      if (force || policyChanged || changed || !job || job.documentRevision !== doc.revision || (doc.deleted && doc.syncState !== 'deleted' && job.status !== 'pending' && job.status !== 'running') || (stale && job.status === 'done')) await enqueue(doc.id, force || stale, doc.deleted ? 'delete' : 'upsert', policyChanged);
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
  async function finish(job, status, error, retryable, errorCode, result) {
    result = result || {};
    var doc = job.legacyId ? null : await Documents.get(job.id);
    await AgentDB.updateRecord('jobs', job.id, function (current) {
      if (!current || current.owner !== job.owner || current.generation !== job.generation) return current;
      if (doc) current.documentRevision = doc.revision;
      if (result.waiting || result.stale) {
        current.status = result.dueAt || result.stale ? 'pending' : 'paused';
        current.nextAt = result.stale ? Date.now() : result.dueAt || 0;
        current.force = !!result.dueAt || !!result.stale; current.kind = 'upsert';
        current.error = error || ''; current.errorCode = errorCode || ''; current.finishedAt = Date.now();
        delete current.owner; delete current.leaseUntil; return current;
      }
      current.attempts += 1; current.error = error || ''; current.errorCode = errorCode || '';
      var policy = RetryPolicy.classify(current.errorCode, current.attempts);
      if (error && !policy.auto) retryable = false;
      if (error && ['manual', 'paused'].includes(policy.kind)) status = 'paused';
      else if (error && !retryable) status = 'failed'; current.finishedAt = Date.now();
      if (retryable && current.attempts < 5) { current.status = 'pending'; current.nextAt = Date.now() + policy.delay; }
      else current.status = retryable ? 'failed' : status;
      delete current.owner; delete current.leaseUntil;
      return current;
    });
  }
  async function deleteCurrent(doc, cfg, reason) {
    var revision = doc.revision;
    await Documents.update(doc.id, function (current) { current.syncState = 'deleting'; current.deleteIntent = { revision: revision, reason: reason, at: Date.now() }; return current; });
    var removed = await Rag.removeDocument(cfg.rag, doc.id, { revision: revision, reason: reason });
    if (removed && removed.stale) return true;
    var current = await Documents.update(doc.id, function (value) {
      if (value.revision === revision) { value.syncState = 'deleted'; value.deleteIntent = null; value.outcomeUnknown = false; }
      return value;
    });
    return current.revision !== revision;
  }
  async function process(job, cfg) {
    if (job.legacyId) { await Rag.removeDocument(cfg.rag, job.legacyId); return { status: 'done' }; }
    var doc = await Documents.get(job.id);
    if (!doc) return { status: 'done' };
    if (doc.outcomeUnknown) { var unknown = new Error('云端操作结果待核验，已停止自动重发'); unknown.code = 'outcome_unknown'; throw unknown; }
    if (job.kind === 'cleanup') {
      if (doc.revision !== job.cleanupRevision || String(doc.text || '').trim() || IngestPolicy.personal(doc)) return { status: 'done' };
      var cleanupStale = await deleteCurrent(doc, cfg, 'historical_metadata');
      await Documents.update(doc.id, function (current) { if (!cleanupStale) { current.admissionState = 'metadata'; current.admissionReason = 'historical_metadata'; current.policyVersion = IngestPolicy.VERSION; current.lastEvaluatedError = current.captureError || ''; } return current; });
      return { status: 'done', stale: cleanupStale };
    }
    if (doc.deleted || IngestPolicy.privateDoc(doc) && !cfg.rag.includePrivate && !IngestPolicy.personal(doc)) {
      var deletionStale = await deleteCurrent(doc, cfg, doc.deleted ? 'deleted' : 'private');
      await Documents.update(doc.id, function (current) { if (!deletionStale) { current.admissionState = 'excluded'; current.policyVersion = IngestPolicy.VERSION; current.lastEvaluatedError = current.captureError || ''; current.syncState = current.deleted ? 'deleted' : 'excluded'; } return current; });
      return { status: 'done', stale: deletionStale };
    }
    if (await NetworkStatus.waiting()) return { status: 'paused', waiting: true, dueAt: (await NetworkStatus.read()).until, error: '本地网络或 VPN 链路疑似异常，暂停后将小量重试', errorCode: 'network_suspected' };
    var blocked = null;
    var captureNeeded = job.force || !!doc.captureError || !doc.fetchedAt || doc.captureState === 'pending';
    var protectedCapture = IngestPolicy.privateDoc(doc);
    var personalOnly = IngestPolicy.personal(doc) && !doc.text && !job.force && !await AgentDB.getMeta('pipeline:manual');
    if (captureNeeded && cfg.rag.autoCapture !== false && !protectedCapture && !personalOnly) {
      try { doc = await Documents.capture(doc.id, await CaptureAdapters.read(doc, cfg.rag, job.force)); }
      catch (e) {
        blocked = e;
        doc = await Documents.update(doc.id, function (current) { current.captureState = e.state || 'failed'; current.captureError = e.code || 'unknown'; if (['http_401', 'http_403', 'login_wall', 'waiting_permission', 'waiting_auth'].includes(e.code)) current.accessCondition = e.code; current.captureNote = e.message; current.checkedAt = Date.now(); return current; });
        if (/^(timeout|network)$/.test(e.code)) await NetworkStatus.diagnose(cfg.rag);
      }
    }
    var receipts = await AgentDB.getMeta(await Rag.stateKey(cfg.rag)) || {};
    var verdict = IngestPolicy.evaluate(doc, cfg.rag, { receipt: receipts[doc.id], error: blocked });
    await AgentDB.setMeta('pipeline:audit:' + doc.id, { id: doc.id, revision: doc.revision, state: verdict.state, action: verdict.action, reason: verdict.reason, at: Date.now() });
    doc = await Documents.update(doc.id, function (current) {
      current.admissionState = verdict.state; current.admissionReason = verdict.reason; current.policyVersion = verdict.policyVersion; current.lastEvaluatedError = current.captureError || '';
      current.reviewDueAt = verdict.dueAt; if (verdict.candidate) current.invalidCandidate = verdict.candidate;
      if (verdict.state === 'eligible') { current.invalidCandidate = null; current.reviewDueAt = 0; }
      if (verdict.action === 'hold') current.syncState = receipts[doc.id] ? 'synced' : 'paused';
      return current;
    });
    if (verdict.action === 'delete') {
      var stale = await deleteCurrent(doc, cfg, verdict.reason);
      return { status: 'done', stale: stale, waiting: !!verdict.dueAt, dueAt: verdict.dueAt };
    }
    if (verdict.action === 'hold') {
      /* metadata 是完成态；临时失败或失效恢复计划由 nextAt 单独调度。 */
      if (verdict.state === 'metadata') return { status: 'done' };
      return { status: 'paused', waiting: true, dueAt: verdict.dueAt, error: blocked && blocked.message || (verdict.state === 'invalid' ? '页面已失效；自动清理未开启，本地已隔离问答证据' : '等待访问条件恢复'), errorCode: verdict.reason };
    }
    var revision = doc.revision;
    var result = await Rag.upsertDocument(cfg.rag, doc, await Organizer.records(doc.bookmarks || []));
    if (result.stale) return { status: 'pending', stale: true };
    var updated = await Documents.update(doc.id, function (current) {
      if (current.revision === revision && !current.deleted) {
        current.syncState = result.held ? 'paused' : result.excluded ? 'excluded' : 'synced';
        if (!result.held && !result.excluded) { current.indexedAt = Date.now(); current.indexedRevision = revision; current.indexedQuality = verdict.includeBody === false ? 'personal' : 'body'; }
      }
      return current;
    });
    return { status: 'done', stale: updated.revision !== revision };
  }
  async function run() {
    if (running) return summary();
    running = true;
    var owner = crypto.randomUUID(); var leased = false;
    try {
      var cfg = await Settings.load();
      cfg.rag = Rag.withAuth(cfg.rag, cfg.backup);
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
        var serviceScope = await Documents.hash(cfg.rag.baseUrl + cfg.rag.collection + cfg.rag.apiKey + cfg.rag.authToken);
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
        currentCfg.rag = Rag.withAuth(currentCfg.rag, currentCfg.backup);
        if (!Rag.available(currentCfg.rag) || currentCfg.rag.baseUrl !== cfg.rag.baseUrl || currentCfg.rag.collection !== cfg.rag.collection || currentCfg.rag.authToken !== cfg.rag.authToken || (currentCfg.rag.autoSync === false && !await AgentDB.getMeta('pipeline:manual'))) break;
        await AgentDB.updateMeta('pipeline:lease', function (value) { if (!value || value.owner !== owner) throw new Error('任务租约已变化'); return { owner: owner, until: Date.now() + 60000 }; });
        var job = await claim(candidate, owner);
        if (!job || job.owner !== owner) continue;
        try { var result = await process(job, cfg); await finish(job, result.status, result.error, result.retryable, result.errorCode, result); }
        catch (e) {
          if (!job.legacyId) await Documents.update(job.id, function (doc) { if (doc) { doc.syncState = e.code === 'outcome_unknown' ? 'paused' : 'failed'; doc.syncError = e.code === 'outcome_unknown' ? '云端操作结果待核验，已暂停自动重发' : e.message; doc.outcomeUnknown = e.code === 'outcome_unknown'; } return doc; });
          var gated = ['daily_limit', 'http_409', 'http_429', 'outcome_unknown'].indexOf(e.code) >= 0;
          await finish(job, gated ? 'paused' : 'failed', e.message, !gated, e.code || 'unknown');
        }
      }
      if (!(await AgentDB.allRecords('jobs')).some(function (j) { return j.status === 'pending' && j.nextAt <= Date.now() || j.status === 'running'; })) await AgentDB.setMeta('pipeline:manual', false);
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
    jobs.forEach(function (job) { if (job.status === 'pending' && job.nextAt > Date.now()) { counts.waiting = (counts.waiting || 0) + 1; return; } counts[job.status] = (counts[job.status] || 0) + 1; });
    var jobMap = new Map(jobs.map(function (job) { return [job.id, job]; }));
    var records = docs.filter(function (doc) { return !doc.deleted; }).map(function (doc) {
      var job = jobMap.get(doc.id);
      return { id: doc.id, url: doc.identity && doc.identity.canonicalUrl || '', title: doc.title || (doc.identity && doc.identity.canonicalUrl) || '未命名收藏',
        bookmarkCount: Array.isArray(doc.bookmarks) ? doc.bookmarks.length : 0,
        capture: Documents.captureLabel(doc), sync: doc.syncState || 'pending', syncLabel: Documents.syncLabel(doc), admission: doc.admissionState || '', outcomeUnknown: !!doc.outcomeUnknown, dueAt: job && job.nextAt || 0,
        status: job ? job.status === 'pending' && job.nextAt > Date.now() ? 'waiting' : job.status : 'unqueued', error: job && job.error || '',
        errorCode: job && job.errorCode || '', errorCategory: RetryPolicy.category(job && job.errorCode), selectableRetry: !!canSelectedRetry(job, doc),
        policy: job && job.error ? RetryPolicy.classify(job.errorCode, job.attempts) : null,
        at: doc.indexedAt || doc.checkedAt || doc.fetchedAt || 0 };
    }).sort(function (a, b) {
      var rank = { failed: 0, paused: 1, running: 2, pending: 3, done: 4 };
      return (rank[a.status] === undefined ? 5 : rank[a.status]) - (rank[b.status] === undefined ? 5 : rank[b.status]) || b.at - a.at;
    });
    var settings = await Settings.load(); var ragCfg = Rag.withAuth(settings.rag, settings.backup);
    var diagnostics = await NetworkStatus.read();
    var metrics = Rag.available(ragCfg) ? await Rag.metrics(ragCfg) : {};
    var docMap = new Map(docs.map(function (doc) { return [doc.id, doc]; }));
    return { metrics: metrics, network: diagnostics, retryableJobs: jobs.filter(function (job) { return canBulkRetry(job, docMap.get(job.id)); }).length, collection: await CollectionStats.read({ docs: docs, jobs: jobs }), records: records, jobs: counts, queuePaused: !!(await AgentDB.getMeta('pipeline:paused')), manual: !!(await AgentDB.getMeta('pipeline:manual')), documents: docs.filter(function (d) { return !d.deleted; }).length,
      indexed: docs.filter(function (d) { return !d.deleted && d.syncState === 'synced'; }).length,
      error: await AgentDB.getMeta('pipeline:lastError'), details: jobs.filter(function (j) { return j.error; }).slice(0, 8).map(function (j) { return { id: j.id, status: j.status, error: j.error, attempts: j.attempts }; }) };
  }
  async function retry(id) {
    if (id) {
      var existing = await AgentDB.getRecord('jobs', id);
      if (existing && existing.errorCode && !RetryPolicy.classify(existing.errorCode, 0).allowManual) throw new Error(RetryPolicy.classify(existing.errorCode, 0).message);
    }
    await AgentDB.setMeta('pipeline:serviceBackoff', null);
    await NetworkStatus.reset();
    await AgentDB.setMeta('pipeline:paused', false);
    await AgentDB.setMeta('pipeline:manual', true);
    if (id) await enqueue(id, true);
    else await markDirty(true);
    return run();
  }
  /* 显式批量重试可重置临时错误的次数；访问门槛及不确定写入仍须逐项处理。 */
  function canBulkRetry(job, doc) {
    return doc && !doc.deleted && !doc.outcomeUnknown && job.error
      && ['failed', 'paused', 'pending'].includes(job.status)
      && RetryPolicy.classify(job.errorCode, 0).bulk;
  }
  function canSelectedRetry(job, doc) {
    return job && doc && !doc.deleted && !doc.outcomeUnknown && job.error
      && ['failed', 'paused', 'pending'].includes(job.status)
      && RetryPolicy.classify(job.errorCode, 0).allowManual;
  }
  async function retryFailed(ids) {
    if (ids !== undefined && !Array.isArray(ids)) throw new Error('请选择需要重试的任务');
    var selected = ids === undefined ? null : new Set(ids);
    var jobs = await AgentDB.allRecords('jobs');
    var docs = new Map((await AgentDB.allRecords('documents')).map(function (doc) { return [doc.id, doc]; }));
    var queued = 0; var skipped = 0;
    for (var job of jobs) {
      if (selected && !selected.has(job.id)) continue;
      if (selected ? canSelectedRetry(job, docs.get(job.id)) : canBulkRetry(job, docs.get(job.id))) {
        var updated = await enqueue(job.id, true);
        if (updated && updated.status === 'pending' && !updated.error) queued++;
        else skipped++;
      } else if (job.error && job.status !== 'running' && job.status !== 'done' && docs.has(job.id) && !docs.get(job.id).deleted) skipped++;
    }
    if (selected) skipped = selected.size - queued;
    if (queued) await NetworkStatus.reset();
    var result = queued ? await request({ manual: true }) : await summary();
    result.retryBatch = { queued: queued, skipped: skipped };
    return result;
  }
  function removeBookmark(id) {
    return new Promise(function (resolve, reject) {
      var done = false;
      function finish(error) {
        if (done) return;
        done = true;
        if (error) reject(error); else resolve();
      }
      try {
        var result = chrome.bookmarks.remove(String(id), function () {
          var error = chrome.runtime && chrome.runtime.lastError;
          finish(error ? new Error(error.message || '删除书签失败') : null);
        });
        if (result && typeof result.then === 'function') result.then(function () { finish(); }, finish);
      } catch (e) { finish(e); }
    });
  }
  /* 用户在失败任务页确认网站不可访问后删除收藏；云端清理交给同一轮 reconcile。 */
  async function deleteFailed(ids) {
    if (!Array.isArray(ids) || !ids.length) throw new Error('请选择需要删除的收藏');
    var selected = new Set(ids.map(String));
    var docs = new Map((await AgentDB.allRecords('documents')).map(function (doc) { return [doc.id, doc]; }));
    var removed = 0; var failed = []; var ready = [];
    for (var id of selected) {
      var doc = docs.get(id);
      if (!doc || doc.deleted) { failed.push({ id: id, title: doc && doc.title || '', error: '文档已删除或不存在' }); continue; }
      var refs = Array.isArray(doc.bookmarks) ? doc.bookmarks : [];
      if (!refs.length) { failed.push({ id: id, title: doc.title, error: '没有可删除的书签引用' }); continue; }
      var refErrors = 0;
      for (var ref of refs) {
        try { await removeBookmark(ref.id); removed++; }
        catch (e) {
          refErrors++;
          failed.push({ id: id, title: doc.title, url: doc.identity && doc.identity.canonicalUrl || '', error: e.message || '删除书签失败' });
        }
      }
      if (!refErrors) ready.push(id);
    }
    var cloudRemoved = 0; var cloudQueued = 0; var syncError = '';
    if (ready.length) {
      var settings = await Settings.load();
      settings.rag = Rag.withAuth(settings.rag, settings.backup);
      var cloudReady = Rag.available(settings.rag);
      for (var id of ready) {
        var current = await Documents.update(id, function (value) {
          if (!value) return value;
          value.deleted = true; value.bookmarks = [];
          value.revision = (value.revision || 0) + 1;
          value.syncState = 'pending'; value.syncError = '';
          return value;
        });
        if (!current) continue;
        if (cloudReady) {
          try {
            var stale = await deleteCurrent(current, settings, 'deleted');
            if (!stale) cloudRemoved++;
          } catch (e) { syncError = e.message || '云端清理未完成'; }
        }
        var after = await Documents.get(id);
        if (!after || after.syncState !== 'deleted') {
          await AgentDB.updateRecord('jobs', id, function (old) {
            return { id: id, generation: (old && old.generation || 0) + 1, documentRevision: (after && after.revision || current.revision || 0),
              status: 'pending', attempts: 0, nextAt: Date.now(), kind: 'delete', requestedAt: Date.now() };
          });
          cloudQueued++;
        }
      }
      /* 只登记删除任务，不触发同步或重扫，避免删除后把其余收藏重新采集。 */
    }
    var result = await summary();
    result.deleteBatch = { removed: removed, failed: failed, cloudRemoved: cloudRemoved, cloudQueued: cloudQueued, syncError: syncError };
    return result;
  }
  async function pause() { await AgentDB.setMeta('pipeline:paused', true); await AgentDB.setMeta('pipeline:manual', false); return summary(); }
  async function audit() {
    var cfg = await Settings.load(); cfg.rag = Rag.withAuth(cfg.rag, cfg.backup);
    var receipts = await AgentDB.getMeta(await Rag.stateKey(cfg.rag)) || {};
    return (await AgentDB.allRecords('documents')).filter(function (doc) { return !doc.deleted && receipts[doc.id]; }).map(function (doc) {
      var receipt = receipts[doc.id]; var empty = !String(doc.text || '').trim();
      return { id: doc.id, title: doc.title, url: doc.identity.canonicalUrl, revision: doc.revision,
        reason: receipt.quality === 'personal' ? '已确认用户备注和别名，保留' : empty ? '本地未保存正文，请核对是否仅元数据' : receipt.quality === 'body' ? '已确认正文版本，保留' : '历史记录资格未核验，保留',
        selectable: empty && !IngestPolicy.personal(doc) && receipt.quality !== 'personal' && !doc.outcomeUnknown, quality: receipt.quality || 'unknown' };
    });
  }
  async function clean(ids) {
    var candidates = await audit(); var selected = new Set(ids || []);
    for (var item of candidates) if (item.selectable && selected.has(item.id)) {
      await enqueue(item.id, true, 'cleanup');
      await AgentDB.updateRecord('jobs', item.id, function (job) { job.cleanupRevision = item.revision; return job; });
    }
    return request({ manual: true });
  }
  async function recapture(id) {
    var doc = await Documents.get(id); if (!doc || doc.outcomeUnknown) throw new Error('请先核验未确认的云端操作');
    await NetworkStatus.reset(); await enqueue(id, true); return request({ manual: true });
  }
  async function verify(id) {
    var cfg = await Settings.load(); cfg.rag = Rag.withAuth(cfg.rag, cfg.backup);
    if (!await Rag.verifyWrite(cfg.rag, id)) throw new Error('尚未取得确切版本证据。删除结果或服务端隔离状态需在首尔服务核验，暂不重发');
    await Documents.update(id, function (doc) { doc.outcomeUnknown = false; doc.syncError = ''; return doc; });
    await enqueue(id, true); return request({ manual: true });
  }
  async function networkRetry(manual) {
    manual = manual !== false;
    var cfg = await Settings.load(); cfg.rag = Rag.withAuth(cfg.rag, cfg.backup);
    if (!manual && (await AgentDB.getMeta('pipeline:paused') || !cfg.rag.enabled || cfg.rag.autoSync === false)) return summary();
    await NetworkStatus.reset();
    var diagnosis = await NetworkStatus.diagnose(cfg.rag, true);
    if (diagnosis.service === 'unreachable' || diagnosis.reason === 'offline') { await AgentDB.setMeta('pipeline:lastError', '服务链路仍不可达，请检查网络/VPN 后重试'); return summary(); }
    var jobs = (await AgentDB.allRecords('jobs')).filter(function (job) { return /^(timeout|network|network_suspected)$/.test(job.errorCode || ''); });
    for (var index = 0; index < jobs.length; index++) {
      var job = jobs[index]; await enqueue(job.id, true);
      await AgentDB.updateRecord('jobs', job.id, function (current) { if (current.status === 'pending') current.nextAt = Date.now() + Math.floor(index / 4) * 30000; return current; });
    }
    if (global.BookmarkEnrich && BookmarkEnrich.resumeNetwork) await BookmarkEnrich.resumeNetwork();
    return request({ manual: manual });
  }
  global.SyncEngine = { recapture: recapture, audit: audit, clean: clean, verify: verify, networkRetry: networkRetry, ALARM: ALARM, alarm: alarm, enqueue: enqueue, reconcile: reconcile,
    request: request, run: run, summary: summary, retry: retry, retryFailed: retryFailed, deleteFailed: deleteFailed, pause: pause, markDirty: markDirty };
})(typeof self !== 'undefined' ? self : window);
