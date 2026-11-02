/* QuillRAG 适配器：独立书签集合、增量同步和有边界的云端检索。 */
(function (global) {
  'use strict';
  var PROXY_BASE = 'https://api.jingmi.lllcnm.cn/api/rag';

  /**
   * 账号模式下，RAG 请求走后台代理：地址固定、Key 由服务端注入、
   * 集合由服务端按账号生成；浏览器只持有会话令牌。
   */
  function withAuth(ragCfg, backupCfg) {
    var cfg = Object.assign({}, ragCfg || {});
    if (global.Profiles) {
      var binding = Profiles.cloud();
      return Object.assign(cfg, { enabled: !!binding && !!cfg.enabled, baseUrl: PROXY_BASE, apiKey: '', authToken: binding ? binding.token : '', collection: binding ? binding.collection : '' });
    }
    var token = backupCfg && (backupCfg.authToken || backupCfg.token);
    if (token) {
      cfg.baseUrl = PROXY_BASE;
      cfg.apiKey = '';
      cfg.authToken = token;
      return cfg;
    }
    /* 兼容升级前的直连配置与单元测试；新装默认配置为空，会保持禁用 */
    if (cfg.baseUrl && cfg.apiKey) return cfg;
    cfg.enabled = false;
    return cfg;
  }

  function tokenOf(cfg) {
    return String(cfg && (cfg.authToken || cfg.apiKey) || '');
  }

  function available(cfg) {
    try { return !!(cfg && cfg.enabled && tokenOf(cfg) && /^chrome_tab_[a-zA-Z0-9_-]+$/.test(cfg.collection) && base(cfg)); }
    catch (e) { return false; }
  }
  function base(cfg) {
    var url = new URL(cfg.baseUrl);
    if (url.username || url.password) throw new Error('RAG 地址不能包含账号或密码');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname))) throw new Error('RAG 地址需要 HTTPS');
    return url.href.replace(/\/+$/, '');
  }
  async function request(cfg, path, body, method, timeout) {
    if (global.Profiles && path !== '/config') {
      var binding = await Profiles.requireCloud();
      if (cfg.collection !== binding.collection) throw new Error('RAG 账号已变化');
      cfg = Object.assign({}, cfg, { authToken: binding.token, apiKey: '', baseUrl: PROXY_BASE });
    }
    var operation = path === '/ingest' ? 'ingest' : method === 'DELETE' ? 'delete' : path === '/retrieve' ? 'retrieve' : 'service';
    var uncertainWrite = operation === 'ingest' || operation === 'delete';
    var startedAt = Date.now();
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeout || 8000);
    try {
      var headers = { Authorization: 'Bearer ' + tokenOf(cfg) };
      var data;
      if (body instanceof FormData) data = body;
      else if (body !== undefined) { headers['Content-Type'] = 'application/json'; data = JSON.stringify(body); }
      var response = await fetch(base(cfg) + path, { method: method || (body === undefined ? 'GET' : 'POST'), headers: headers, body: data, signal: controller.signal, redirect: 'error', credentials: 'omit' });
      if (!response.ok) {
        var error = new Error(response.status === 401 ? 'RAG 登录会话已失效，请重新登录后重试' : response.status === 409 ? 'RAG 上次写入结果待核验，已暂停重复写入' : response.status === 429 ? 'RAG 今日写入额度已用完，已暂停' : 'RAG 请求失败（' + response.status + '）');
        error.code = response.status === 401 ? 'unauthorized' : uncertainWrite && cfg.authToken && (response.status === 409 || response.status >= 500) ? 'outcome_unknown' : 'http_' + response.status;
        error.operation = operation; error.requestSource = cfg.authToken ? 'seoul_proxy' : 'rag_service'; error.elapsed = Date.now() - startedAt;
        throw error;
      }
      var result = await response.json();
      if ((path === '/config' ? result.ok !== true : result.code !== 'OK') || result.error_code) throw new Error('RAG 未完成操作，请检查服务状态');
      return result.data;
    } catch (e) {
      if (e.name === 'AbortError') { var timeoutError = new Error('RAG 请求超时'); timeoutError.code = uncertainWrite ? 'outcome_unknown' : 'timeout'; timeoutError.operation = operation; timeoutError.requestSource = cfg.authToken ? 'seoul_proxy' : 'rag_service'; timeoutError.elapsed = Date.now() - startedAt; throw timeoutError; }
      /* 不向界面透传可能包含认证信息的服务响应。 */
      if (e.code === 'daily_limit' || /^RAG |^RAG地址|HTTPS/.test(e.message)) throw e;
      var networkError = new Error('RAG 无法连接，请检查地址和站点授权'); networkError.code = uncertainWrite ? 'outcome_unknown' : 'network'; networkError.operation = operation; networkError.requestSource = cfg.authToken ? 'seoul_proxy' : 'rag_service'; networkError.elapsed = Date.now() - startedAt; throw networkError;
    } finally { clearTimeout(timer); }
  }
  async function clientId() {
    return AgentDB.updateMeta('rag:client', function (value) { return value || crypto.randomUUID(); });
  }
  async function defaultCollection() { return 'chrome_tab_bookmarks_' + (await clientId()).replace(/-/g, '').slice(0, 12); }

  /** 从后台读取当前账号只读的 RAG 集合；失败时返回 null */
  async function config(authToken) {
    var cfg = { baseUrl: PROXY_BASE, authToken: authToken, collection: 'chrome_tab_probe', enabled: true };
    var data = await request(cfg, '/config', undefined, 'GET', 8000);
    if (!data || !data.collection) throw new Error('后台尚未配置 RAG');
    return data;
  }
  /* 搜索及手动操作先刷新账号绑定，不能把校验缓存过期当作退出登录。 */
  async function resolve(ragCfg, backupCfg, force) {
    if (global.Profiles) await Profiles.requireCloud(force);
    return withAuth(ragCfg, backupCfg);
  }
  async function check(ragCfg, backupCfg) {
    var cfg = await resolve(Object.assign({}, ragCfg, { enabled: true }), backupCfg, true);
    if (!available(cfg)) throw new Error('RAG 尚未就绪，请检查账号服务');
    var data = await request(cfg, '/retrieve', { collection: cfg.collection, query: '连接检测', mode: 'hybrid', top_k: 1, candidate_k: 1, rerank: false }, 'POST', 8000);
    if (!data || !Array.isArray(data.results)) throw new Error('RAG 返回格式异常');
    return { checkedAt: Date.now() };
  }
  async function stateKey(cfg) { return 'rag:sync:' + base(cfg) + ':' + cfg.collection; }
  async function withLease(cfg, operation) {
    var key = await stateKey(cfg); var owner = crypto.randomUUID();
    /* 单次请求最长 20s，60s 租约足够覆盖且中断后恢复更快。 */
    var lease = await AgentDB.updateMeta(key + ':lease', function (value) { return !value || value.until < Date.now() ? { owner: owner, until: Date.now() + 60000 } : value; });
    if (lease.owner !== owner) throw new Error('其他页面正在同步书签');
    try { return await operation(key); }
    finally { await AgentDB.updateMeta(key + ':lease', function (value) { return value && value.owner === owner ? null : value; }); }
  }
  async function ensure(cfg) {
    if (!available(cfg)) throw new Error('RAG 尚未就绪：请先登录账号，并确认后台已配置 RAG');
    await request(cfg, '/collections', { name: cfg.collection }, 'POST', 20000);
  }
  async function recordOperation(cfg, event) {
    var key = await stateKey(cfg);
    event = Object.assign({ at: Date.now(), source: cfg.authToken ? 'seoul_proxy' : 'rag_service' }, event);
    await AgentDB.updateMeta(key + ':events', function (events) { events = events || []; events.push(event); return events.slice(-200); });
    await AgentDB.updateMeta(key + ':metrics', function (metrics) { metrics = metrics || {}; var name = event.kind + '_' + event.state; metrics[name] = (metrics[name] || 0) + 1; return metrics; });
  }
  async function removeDocument(cfg, documentId, expected) {
    return withLease(cfg, async function (key) {
      if (expected) {
        var current = await Documents.get(documentId);
        if (!current || current.revision !== expected.revision || expected.reason === 'historical_metadata' && String(current.text || '').trim()) return { stale: true };
        if (global.Settings && /^(http_404|http_410|private)$/.test(expected.reason)) { var settings = await Settings.load(); if (expected.reason === 'private' ? settings.rag.includePrivate : !settings.rag.cleanupEnabled) return { stale: true }; }
      }
      var saved = await AgentDB.getMeta(key) || {};
      var entry = saved[documentId];
      /* 状态记录丢失时也按当前 docId 规则尝试删除，避免本地已清理、云端仍保留。 */
      var intent = await AgentDB.getMeta(key + ':operation:' + documentId);
      if (intent && ['pending', 'unknown'].includes(intent.status)) { var pending = new Error('上次云端操作结果待核验，禁止自动重发'); pending.code = 'outcome_unknown'; throw pending; }
      var docId = entry ? entry.docId : intent && intent.docId || (cfg.authToken ? 'page-' + documentId : (await clientId()) + '-' + documentId);
      await AgentDB.setMeta(key + ':operation:' + documentId, { kind: 'delete', docId: docId, status: 'pending', at: Date.now() });
      try { await request(cfg, '/collections/' + encodeURIComponent(cfg.collection) + '/documents/' + encodeURIComponent(docId), undefined, 'DELETE', 15000); }
      catch (e) { if (e.code !== 'http_404' && !/（404）/.test(e.message)) { await AgentDB.setMeta(key + ':operation:' + documentId, { kind: 'delete', docId: docId, status: e.code === 'outcome_unknown' ? 'unknown' : 'retry', at: Date.now() }); await recordOperation(cfg, { id: documentId, kind: 'delete', state: e.code === 'outcome_unknown' ? 'unknown' : 'failed', code: e.code || 'unknown' }); throw e; } }
      await recordOperation(cfg, { id: documentId, kind: 'delete', state: 'confirmed' });
      await AgentDB.setMeta(key + ':operation:' + documentId, null);
      if (entry) await AgentDB.updateMeta(key, function (value) { value = value || {}; delete value[documentId]; return value; });
    });
  }
  async function upsertDocument(cfg, doc, classifications) {
    if (!available(cfg)) throw new Error('RAG 尚未配置完成');
    var isPrivate = !!doc.private || ['capture', 'feishu_api'].indexOf(doc.source) >= 0;
    if (doc.deleted || (isPrivate && !cfg.includePrivate)) {
      var removed = await removeDocument(cfg, doc.id, { revision: doc.revision, reason: doc.deleted ? 'deleted' : 'private' });
      if (removed && removed.stale) return { stale: true };
      return { excluded: !doc.deleted, deleted: !!doc.deleted };
    }
    if (!global.IngestPolicy) throw new Error('收录策略未加载，已停止上传');
    {
      var prior = await AgentDB.getMeta(await stateKey(cfg)) || {};
      var verdict = IngestPolicy.evaluate(doc, cfg, { receipt: prior[doc.id] });
      if (verdict.action !== 'upsert') return { held: true, admission: verdict.state, reason: verdict.reason };
    }
    return withLease(cfg, async function (key) {
      var operationKey = key + ':operation:' + doc.id;
      var intent = await AgentDB.getMeta(operationKey);
      if (intent && ['pending', 'unknown'].includes(intent.status)) { var pending = new Error('上次云端操作结果待核验，禁止自动重发'); pending.code = 'outcome_unknown'; throw pending; }
      var current = await Documents.get(doc.id);
      if (current && (current.deleted || current.revision !== doc.revision)) return { stale: true };
      if (global.Settings && IngestPolicy.privateDoc(doc)) { var latest = await Settings.load(); if (latest.rag && !latest.rag.includePrivate) return { held: true, admission: 'excluded' }; }
      var saved = await AgentDB.getMeta(key) || {};
      var id = await clientId(); var docId = cfg.authToken ? (saved[doc.id] && saved[doc.id].docId || 'page-' + doc.id) : id + '-' + doc.id;
      var refs = doc.bookmarks || [];
      var category = refs.map(function (ref) { return classifications[ref.id] && classifications[ref.id].category; }).find(Boolean) || '待整理';
      var tags = Array.from(new Set(refs.flatMap(function (ref) { return classifications[ref.id] && classifications[ref.id].tags || []; })));
      var metadata = { schema_version: 2, page_id: doc.id, client_id: id,
        canonical_url: doc.identity.canonicalUrl, provider: doc.identity.provider, document_type: doc.identity.kind,
        provider_document_id: doc.identity.token || '', title: doc.title, bookmarks: refs, tags: tags,
        content_hash: doc.contentHash || '', captured_at: doc.fetchedAt || null, coverage: doc.coverage || 'metadata',
        headings: doc.headings || [], capture_note: doc.captureNote || '', capture_state: doc.captureState, capture_source: doc.source || 'metadata', private: isPrivate,
        source_revision: doc.sourceRevision || null, source_updated_at: doc.sourceUpdatedAt || null };
      var text = [doc.title, '网址：' + doc.identity.canonicalUrl, '收藏入口：' + refs.map(function (r) { return r.title + ' / ' + r.folder + ' / 收藏时间 ' + (r.addedAt ? new Date(r.addedAt).toISOString() : '未知'); }).join('；'),
        '分类：' + category, '标签：' + tags.join('、'), '内容覆盖：' + (doc.captureState || 'metadata'),
        '文档版本：' + (doc.sourceRevision || doc.contentHash || '仅元数据'), doc.desc || '', doc.text || ''].join('\n');
      /* 变更指纹只取稳定字段：captured_at 等采集时间每次刷新都会变，
         放进指纹会让“内容没变”的定时刷新重复 ingest，产生残留向量。 */
      var signature = {
        canonical_url: metadata.canonical_url, provider: metadata.provider, document_type: metadata.document_type,
        provider_document_id: metadata.provider_document_id, title: metadata.title, bookmarks: metadata.bookmarks,
        tags: metadata.tags, content_hash: metadata.content_hash, coverage: metadata.coverage, headings: metadata.headings,
        capture_state: metadata.capture_state, capture_source: metadata.capture_source, private: metadata.private,
        source_revision: metadata.source_revision
      };
      var hash = await Documents.hash(JSON.stringify([text, signature]));
      /* 本地实例标识变化时旧记录会查不到：入库新 ID 后再删旧记录，避免同页两份。 */
      var staleDocId = saved[doc.id] && saved[doc.id].docId && saved[doc.id].docId !== docId ? saved[doc.id].docId : '';
      if (!saved[doc.id] || saved[doc.id].hash !== hash || staleDocId) {
        metadata.ingest_hash = hash;
        await AgentDB.setMeta(operationKey, { kind: 'ingest', docId: docId, hash: hash, contentHash: doc.contentHash || '', revision: doc.revision, status: 'pending', at: Date.now() });
        var form = new FormData();
        Object.entries({ collection: cfg.collection, doc_id: docId, text: text, file_type: 'txt', source: doc.identity.canonicalUrl,
          category: category, chunk_size: '1000', chunk_overlap: '160', metadata_json: JSON.stringify(metadata)
        }).forEach(function (pair) { form.append(pair[0], pair[1]); });
        if (global.ResourceGate) await ResourceGate.reserve('rag');
        var response;
        try { response = await request(cfg, '/ingest', form, 'POST', 20000); }
        catch (e) { await AgentDB.updateMeta(operationKey, function (op) { op.status = e.code === 'outcome_unknown' ? 'unknown' : 'retry'; return op; }); await recordOperation(cfg, { id: doc.id, kind: 'ingest', state: e.code === 'outcome_unknown' ? 'unknown' : 'failed', code: e.code || 'unknown', revision: doc.revision }); throw e; }
        await recordOperation(cfg, { id: doc.id, kind: 'ingest', state: 'confirmed', revision: doc.revision });
        if (cfg.authToken && response && response.doc_id) docId = response.doc_id;
        await AgentDB.updateMeta(operationKey, function (op) { op.docId = docId; return op; });
        if (staleDocId) {
          try { await request(cfg, '/collections/' + encodeURIComponent(cfg.collection) + '/documents/' + encodeURIComponent(staleDocId), undefined, 'DELETE', 15000); }
          catch (e) { if (!/（404）/.test(e.message)) throw e; }
        }
        await AgentDB.updateMeta(key, function (value) { value = value || {}; value[doc.id] = { hash: hash, docId: docId, pageId: doc.id, url: doc.identity.canonicalUrl, quality: 'body', contentHash: doc.contentHash || '', revision: doc.revision }; return value; });
      }
      await AgentDB.setMeta(operationKey, null);
      return { docId: docId, unchanged: !!(saved[doc.id] && saved[doc.id].hash === hash) };
    });
  }
  async function retrieve(cfg, query, rows) {
    if (!available(cfg)) return [];
    var id = await clientId(); var grouped = await Documents.groups(rows);
    var data = await request(cfg, '/retrieve', { collection: cfg.collection, query: query, mode: 'hybrid', top_k: 60, candidate_k: 100, rerank: true }, 'POST', cfg.retrieveTimeout || 5000);
    if (!data || !Array.isArray(data.results)) throw new Error('RAG 返回格式异常');
    var saved = cfg.authToken ? await AgentDB.getMeta(await stateKey(cfg)) || {} : {};
    var hits = new Map();
    for (var result of data.results) {
      var extra = result.metadata && result.metadata.extra || {};
      if ((!cfg.authToken && extra.client_id !== id) || (extra.private && !cfg.includePrivate)) continue;
      var group = grouped.get(extra.page_id);
      /* 旧版记录在首次完整同步前仍可检索，但必须严格匹配真实收藏。 */
      if (!group && extra.bookmark_id) {
        var legacy = rows.find(function (row) { return String(row.id) === String(extra.bookmark_id) && row.url === extra.url; });
        if (!legacy || result.doc_id !== id + '-' + legacy.id) continue;
        group = { info: await Documents.forUrl(legacy.url), rows: [legacy] };
      } else if (!group || result.doc_id !== (cfg.authToken ? (saved[group.info.id] && saved[group.info.id].docId || 'page-' + group.info.id) : id + '-' + group.info.id) || extra.canonical_url !== group.info.canonicalUrl) continue;
      var doc = await Documents.get(group.info.id);
      if (extra.capture_state === 'failed' || extra.coverage === 'metadata' || doc && (doc.deleted || doc.admissionState === 'invalid' || doc.admissionState === 'excluded')) continue;
      var receipt = (await AgentDB.getMeta(await stateKey(cfg)) || {})[group.info.id];
      var expectedHash = receipt && receipt.contentHash || doc && doc.contentHash;
      if (expectedHash && extra.content_hash && expectedHash !== extra.content_hash) continue;
      var hit = hits.get(group.info.id);
      if (!hit) {
        hit = { row: Object.assign({}, group.rows[0], { documentId: group.info.id, relatedBookmarks: group.rows.length,
          captureSource: extra.capture_source || '云端', contentStatus: doc ? Documents.captureLabel(doc) : '云端内容', syncStatus: '已入库' }),
          score: Number(result.score) || 0, source: 'rag', chunks: [] };
        hits.set(group.info.id, hit);
      }
      if (hit.chunks.length < 3 && !hit.chunks.some(function (chunk) { return chunk.index === result.chunk_index; })) hit.chunks.push({ index: result.chunk_index, text: String(result.content || '').slice(0, 1400), heading: result.metadata.heading_path || [] });
      hit.row.retrievedText = hit.chunks.map(function (chunk) { return chunk.text; }).join('\n\n').slice(0, 3600);
    }
    return Array.from(hits.values()).slice(0, 30);
  }
  async function verifyWrite(cfg, documentId) {
    var key = await stateKey(cfg); var op = await AgentDB.getMeta(key + ':operation:' + documentId);
    if (!op || !['pending', 'unknown'].includes(op.status) || op.kind !== 'ingest') return false;
    var doc = await Documents.get(documentId); if (!doc) return false;
    var data = await request(cfg, '/retrieve', { collection: cfg.collection, query: doc.identity.canonicalUrl, mode: 'hybrid', top_k: 60, candidate_k: 100, rerank: false }, 'POST', 8000);
    var found = (data.results || []).find(function (result) { var extra = result.metadata && result.metadata.extra || {}; return result.doc_id === op.docId && extra.page_id === documentId && extra.canonical_url === doc.identity.canonicalUrl && extra.ingest_hash === op.hash; });
    if (!found) return false;
    await AgentDB.updateMeta(key, function (saved) { saved = saved || {}; saved[documentId] = { docId: op.docId, pageId: documentId, url: doc.identity.canonicalUrl, hash: op.hash, contentHash: op.contentHash, revision: op.revision, quality: 'body' }; return saved; });
    await AgentDB.setMeta(key + ':operation:' + documentId, null); return true;
  }
  global.Rag = {
    verifyWrite: verifyWrite,
    metrics: async function (cfg) { return await AgentDB.getMeta((await stateKey(cfg)) + ':metrics') || {}; },
    PROXY_BASE: PROXY_BASE,
    available: available,
    withAuth: withAuth,
    config: config,
    resolve: resolve,
    check: check,
    request: request,
    clientId: clientId,
    defaultCollection: defaultCollection,
    retrieve: retrieve,
    ensure: ensure,
    upsertDocument: upsertDocument,
    removeDocument: removeDocument,
    stateKey: stateKey
  };
})(typeof self !== 'undefined' ? self : window);
