/* QuillRAG 适配器：独立书签集合、增量同步和有边界的云端检索。 */
(function (global) {
  'use strict';
  function available(cfg) {
    try { return !!(cfg && cfg.enabled && cfg.apiKey && /^chrome_tab_[a-zA-Z0-9_-]+$/.test(cfg.collection) && base(cfg)); }
    catch (e) { return false; }
  }
  function base(cfg) {
    var url = new URL(cfg.baseUrl);
    if (url.username || url.password) throw new Error('RAG 地址不能包含账号或密码');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname))) throw new Error('RAG 地址需要 HTTPS');
    return url.href.replace(/\/+$/, '');
  }
  async function request(cfg, path, body, method, timeout) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeout || 8000);
    try {
      var headers = { Authorization: 'Bearer ' + cfg.apiKey };
      var data;
      if (body instanceof FormData) data = body;
      else if (body !== undefined) { headers['Content-Type'] = 'application/json'; data = JSON.stringify(body); }
      var response = await fetch(base(cfg) + path, { method: method || (body === undefined ? 'GET' : 'POST'), headers: headers, body: data, signal: controller.signal, redirect: 'error', credentials: 'omit' });
      if (!response.ok) throw new Error('RAG 请求失败（' + response.status + '）');
      var result = await response.json();
      if (result.code !== 'OK' || result.error_code) throw new Error('RAG 未完成操作，请检查服务状态');
      return result.data;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('RAG 请求超时');
      /* 不向界面透传可能包含认证信息的服务响应。 */
      if (/^RAG |^RAG地址|HTTPS/.test(e.message)) throw e;
      throw new Error('RAG 无法连接，请检查地址和站点授权');
    } finally { clearTimeout(timer); }
  }
  async function clientId() {
    return AgentDB.updateMeta('rag:client', function (value) { return value || crypto.randomUUID(); });
  }
  async function defaultCollection() { return 'chrome_tab_bookmarks_' + (await clientId()).replace(/-/g, '').slice(0, 12); }
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
    if (!available(cfg)) throw new Error('请启用 RAG、填写密钥，并使用 chrome_tab_ 开头的独立集合');
    await request(cfg, '/collections', { name: cfg.collection }, 'POST', 20000);
  }
  async function removeDocument(cfg, documentId) {
    return withLease(cfg, async function (key) {
      var saved = await AgentDB.getMeta(key) || {};
      var entry = saved[documentId];
      /* 状态记录丢失时也按当前 docId 规则尝试删除，避免本地已清理、云端仍保留。 */
      var docId = entry ? entry.docId : (await clientId()) + '-' + documentId;
      try { await request(cfg, '/collections/' + encodeURIComponent(cfg.collection) + '/documents/' + encodeURIComponent(docId), undefined, 'DELETE', 15000); }
      catch (e) { if (!/（404）/.test(e.message)) throw e; }
      if (entry) await AgentDB.updateMeta(key, function (value) { value = value || {}; delete value[documentId]; return value; });
    });
  }
  async function upsertDocument(cfg, doc, classifications) {
    if (!available(cfg)) throw new Error('RAG 尚未配置完成');
    var isPrivate = !!doc.private || ['capture', 'feishu_api'].indexOf(doc.source) >= 0;
    if (doc.deleted || (isPrivate && !cfg.includePrivate)) {
      await removeDocument(cfg, doc.id);
      return { excluded: !doc.deleted, deleted: !!doc.deleted };
    }
    return withLease(cfg, async function (key) {
      var saved = await AgentDB.getMeta(key) || {};
      var id = await clientId(); var docId = id + '-' + doc.id;
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
        var form = new FormData();
        Object.entries({ collection: cfg.collection, doc_id: docId, text: text, file_type: 'txt', source: doc.identity.canonicalUrl,
          category: category, chunk_size: '1000', chunk_overlap: '160', metadata_json: JSON.stringify(metadata)
        }).forEach(function (pair) { form.append(pair[0], pair[1]); });
        await request(cfg, '/ingest', form, 'POST', 20000);
        if (staleDocId) {
          try { await request(cfg, '/collections/' + encodeURIComponent(cfg.collection) + '/documents/' + encodeURIComponent(staleDocId), undefined, 'DELETE', 15000); }
          catch (e) { if (!/（404）/.test(e.message)) throw e; }
        }
        await AgentDB.updateMeta(key, function (value) { value = value || {}; value[doc.id] = { hash: hash, docId: docId, pageId: doc.id, url: doc.identity.canonicalUrl }; return value; });
      }
      return { docId: docId, unchanged: !!(saved[doc.id] && saved[doc.id].hash === hash) };
    });
  }
  async function retrieve(cfg, query, rows) {
    if (!available(cfg)) return [];
    var id = await clientId(); var grouped = await Documents.groups(rows);
    var data = await request(cfg, '/retrieve', { collection: cfg.collection, query: query, mode: 'hybrid', top_k: 60, candidate_k: 100, rerank: true }, 'POST', cfg.retrieveTimeout || 5000);
    if (!data || !Array.isArray(data.results)) throw new Error('RAG 返回格式异常');
    var hits = new Map();
    for (var result of data.results) {
      var extra = result.metadata && result.metadata.extra || {};
      if (extra.client_id !== id || (extra.private && !cfg.includePrivate)) continue;
      var group = grouped.get(extra.page_id);
      /* 旧版记录在首次完整同步前仍可检索，但必须严格匹配真实收藏。 */
      if (!group && extra.bookmark_id) {
        var legacy = rows.find(function (row) { return String(row.id) === String(extra.bookmark_id) && row.url === extra.url; });
        if (!legacy || result.doc_id !== id + '-' + legacy.id) continue;
        group = { info: await Documents.forUrl(legacy.url), rows: [legacy] };
      } else if (!group || result.doc_id !== id + '-' + group.info.id || extra.canonical_url !== group.info.canonicalUrl) continue;
      var doc = await Documents.get(group.info.id);
      if (doc && doc.contentHash && extra.content_hash && doc.contentHash !== extra.content_hash) continue;
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
  global.Rag = { available: available, request: request, clientId: clientId, defaultCollection: defaultCollection, retrieve: retrieve, ensure: ensure, upsertDocument: upsertDocument, removeDocument: removeDocument, stateKey: stateKey };
})(typeof self !== 'undefined' ? self : window);
