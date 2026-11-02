const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/extension');
function server() {
  const docs = new Map();
  const calls = [];
  const fetch = async (url, options = {}) => {
    const path = new URL(url).pathname; calls.push({ path, method: options.method, body: options.body });
    let data = {};
    if (path === '/ingest') {
      const body = options.body;
      docs.set(body.get('doc_id'), { text: body.get('text'), meta: JSON.parse(body.get('metadata_json')) });
      data = { doc_id: body.get('doc_id') };
    } else if (options.method === 'DELETE') docs.delete(decodeURIComponent(path.split('/').pop()));
    else if (path === '/retrieve') data = { results: Array.from(docs).map(([id, doc]) => ({ content: doc.text, doc_id: id, score: 1, metadata: { extra: doc.meta } })) };
    return new Response(JSON.stringify({ code: 'OK', data }));
  };
  return { fetch, docs, calls };
}
const cfg = { enabled: true, baseUrl: 'https://rag.example.com', apiKey: 'test-key', collection: 'chrome_tab_test', includePrivate: false };
async function documentFor(c, row, source = 'public') {
  await c.Documents.reconcile([row]);
  const info = await c.Documents.forUrl(row.url);
  return c.Documents.capture(info.id, { text: row.text || row.title, source, coverage: 'partial', captureState: 'partial' });
}
test('RAG 按文档更新，正文与结构化元数据共同入库，相同版本跳过', async () => {
  const api = server(); const { c } = fixture({ fetch: api.fetch });
  const row = { id: '3', title: '接口文档', url: 'https://example.com/a', text: '财务接口内容', added: 1000 };
  let doc = await documentFor(c, row);
  await c.Rag.upsertDocument(cfg, doc, {});
  await c.Rag.upsertDocument(cfg, doc, {});
  assert.equal(api.calls.filter(c => c.path === '/ingest').length, 1);
  doc = await c.Documents.capture(doc.id, { text: '更新后的正文' });
  await c.Rag.upsertDocument(cfg, doc, {});
  assert.equal(api.calls.filter(c => c.path === '/ingest').length, 2);
  assert.match(Array.from(api.docs.values())[0].text, /更新后的正文/);
  assert.equal(Array.from(api.docs.values())[0].meta.bookmarks[0].addedAt, 1000);
  assert.equal((await c.Rag.retrieve(cfg, '凭证', [row])).length, 1);
  await c.Rag.removeDocument(cfg, doc.id); assert.equal(api.docs.size, 0);
});

test('默认不上传登录正文，打开上传后可入库，关闭时移除已有记录', async () => {
  const api = server(); const { c } = fixture({ fetch: api.fetch });
  const doc = await documentFor(c, { id: '3', title: '内部文档', url: 'https://example.com/a', text: '内部内容' }, 'capture');
  await c.Rag.upsertDocument(cfg, doc, {}); assert.equal(api.docs.size, 0);
  await c.Rag.upsertDocument({ ...cfg, includePrivate: true }, doc, {}); assert.equal(api.docs.size, 1);
  await c.Rag.upsertDocument(cfg, doc, {}); assert.equal(api.docs.size, 0);
});

test('失败不记为成功，活动租约阻止并发入库', async () => {
  let calls = 0;
  const api = server(); const { c } = fixture({ fetch: async (url, options) => {
    if (url.endsWith('/ingest') && calls++ === 0) return new Response('', { status: 503 });
    return api.fetch(url, options);
  } });
  const doc = await documentFor(c, { id: '3', title: '文档', url: 'https://example.com/a' });
  await assert.rejects(c.Rag.upsertDocument(cfg, doc, {}), /503/);
  await c.Rag.upsertDocument(cfg, doc, {}); assert.equal(api.docs.size, 1);
  await c.AgentDB.setMeta('rag:sync:https://rag.example.com:' + cfg.collection + ':lease', { owner: 'other', until: Date.now() + 60000 });
  await assert.rejects(c.Rag.upsertDocument(cfg, doc, {}), /其他页面/);
});

test('远端召回只接受当前实例和存在的文档版本', async () => {
  const api = server(); const { c } = fixture({ fetch: api.fetch });
  const row = { id: '3', title: '文档', url: 'https://example.com/a' };
  const doc = await documentFor(c, row);
  await c.Rag.upsertDocument(cfg, doc, {});
  api.docs.set('forged', { text: '伪造来源', meta: { page_id: doc.id, client_id: 'other' } });
  assert.equal((await c.Rag.retrieve(cfg, '文档', [row])).length, 1);
  assert.equal((await c.Rag.retrieve(cfg, '文档', [])).length, 0);
  await c.Documents.capture(doc.id, { text: '新版本正文' });
  assert.equal((await c.Rag.retrieve(cfg, '文档', [row])).length, 0);
  assert.equal(c.Rag.available({ ...cfg, collection: 'agent_user_memory_bge_m3' }), false);
});

test('语义召回可以找到关键词未命中的书签，模型空选择不会隐藏候选', async () => {
  const { c } = fixture();
  const rows = [{ id: '3', title: '网页 A', url: 'https://example.com/a', hay: '网页 a' }];
  c.Rag.retrieve = async () => [{ row: { ...rows[0], retrievedText: '图像压缩工具' }, score: 1, source: 'rag' }];
  c.AI.available = () => true;
  c.AI.rewrite = async () => ({ ok: true, keywords: ['压缩'] });
  c.AI.rerank = async () => ({ ok: true, picks: [] });
  const result = await c.BookmarkSearch.run({ rows, query: '让图片变小', cfg: { fetchDesc: false }, rag: cfg });
  assert.equal(result.hits.length, 1);
  assert.match(result.message, /可能相关/);
});

test('账号模式本机状态重建后沿用服务端文档 ID，兼容旧实例元数据', async () => {
  const api = server();
  let stored = false;
  const { c } = fixture({ fetch: async (url, options = {}) => {
    if (url.endsWith('/ingest')) {
      if (stored) return new Response(JSON.stringify({ code: 'OK', data: { doc_id: 'persisted-document', unchanged: true } }));
      stored = true;
      options.body.set('doc_id', 'persisted-document');
    }
    return api.fetch(url, options);
  } });
  const accountCfg = { ...cfg, authToken: 'session-token' };
  const row = { id: '3', title: '项目文档', url: 'https://example.com/a', text: '项目内容' };
  const doc = await documentFor(c, row);
  await c.Rag.upsertDocument(accountCfg, doc, {});
  await c.AgentDB.setMeta(await c.Rag.stateKey(accountCfg), null);
  await c.AgentDB.setMeta('rag:client', 'another-browser-instance');
  await c.Rag.upsertDocument(accountCfg, doc, {});
  const saved = await c.AgentDB.getMeta(await c.Rag.stateKey(accountCfg));
  assert.equal(saved[doc.id].docId, 'persisted-document');
  assert.equal(api.docs.size, 1);
  assert.equal((await c.Rag.retrieve(accountCfg, '项目', [row])).length, 1);
});
