const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/extension');
function setup(options = {}) {
  const docs = new Map(); let publicCalls = 0; let ingests = 0;
  const tree = [{ id: '0', title: '', children: [{ id: '1', parentId: '0', title: '其他书签', children: [
    { id: '3', title: '接口文档', url: 'https://example.com/a?utm_source=test', dateAdded: 1000 },
    { id: '4', title: '同文档的另一个入口', url: 'https://example.com/a', dateAdded: 2000 }
  ] }] }];
  const config = { ai: { enabled: false }, organizer: { autoMove: false }, rag: { enabled: true, baseUrl: 'https://rag.example.com', apiKey: 'test', collection: 'chrome_tab_pipeline', autoSync: true, autoCapture: true, includePrivate: false, refreshDays: 7 } };
  const f = fixture({ db: options.db, tree: options.tree || tree, fetch: async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (!url.startsWith(config.rag.baseUrl)) {
      publicCalls++; if (options.failCapture) throw new Error('断网');
      return new Response('<html><head><title>应收接口</title></head><body><article><h1>凭证同步</h1><p>订单会自动生成应收凭证。</p></article></body></html>', { headers: { 'content-type': 'text/html' } });
    }
    let data = {};
    if (path === '/ingest') {
      ingests++;
      if (options.failIngest) return new Response('', { status: 503 });
      const form = init.body; docs.set(form.get('doc_id'), { content: form.get('text'), metadata: JSON.parse(form.get('metadata_json')) });
      data = { doc_id: form.get('doc_id') };
    } else if (init.method === 'DELETE') docs.delete(decodeURIComponent(path.split('/').pop()));
    else if (path === '/retrieve') data = { results: Array.from(docs).map(([id, d]) => ({ doc_id: id, content: d.content, chunk_index: 0, score: 1, metadata: { extra: d.metadata } })) };
    return new Response(JSON.stringify({ code: 'OK', data }));
  } });
  f.c.Settings = { load: async () => config };
  f.c.chrome.permissions = { contains: async () => options.permission !== false };
  return { ...f, config, docs, calls: () => ({ publicCalls, ingests }) };
}

test('自动队列先采集正文再入库，相同文档多收藏仅一份向量记录', async () => {
  const f = setup();
  const result = await f.c.SyncEngine.request();
  assert.equal(result.documents, 1);
  assert.equal(result.indexed, 1);
  assert.equal(f.docs.size, 1);
  const value = Array.from(f.docs.values())[0];
  assert.match(value.content, /订单会自动生成应收凭证/);
  assert.equal(value.metadata.bookmarks.length, 2);
  assert.equal(value.metadata.bookmarks[0].addedAt, 1000);
  assert.equal(value.metadata.coverage, 'html');
  assert.equal(f.calls().publicCalls, 1);
  await f.c.SyncEngine.request();
  assert.equal(f.calls().ingests, 1);
});

test('强制刷新相同正文不会重复 ingest', async () => {
  const f = setup(); await f.c.SyncEngine.request();
  assert.equal(f.calls().ingests, 1);
  await new Promise(resolve => setTimeout(resolve, 5));
  await f.c.SyncEngine.request({ force: true });
  assert.equal(f.calls().ingests, 1);
});

test('删除一个收藏保留文档，删除最后一个入口才移除云端文档', async () => {
  const f = setup(); await f.c.SyncEngine.request();
  f.node('1').children.splice(0, 1);
  await f.c.SyncEngine.request();
  assert.equal(f.docs.size, 1);
  assert.equal(Array.from(f.docs.values())[0].metadata.bookmarks.length, 1);
  f.node('1').children.splice(0, 1);
  await f.c.SyncEngine.request();
  assert.equal(f.docs.size, 0);
});

test('断网重试持久化，五次失败后停止自动尝试', async () => {
  const f = setup({ failIngest: true });
  await f.c.SyncEngine.request();
  let job = (await f.c.AgentDB.allRecords('jobs'))[0];
  assert.equal(job.status, 'pending'); assert.equal(job.attempts, 1);
  for (let i = 0; i < 4; i++) {
    await f.c.AgentDB.updateRecord('jobs', job.id, j => ({ ...j, nextAt: 0 }));
    await f.c.SyncEngine.run();
  }
  job = await f.c.AgentDB.getRecord('jobs', job.id);
  assert.equal(job.status, 'failed'); assert.equal(job.attempts, 5);
  assert.equal(f.calls().ingests, 5);
});

test('过期运行租约由新后台恢复，活动租约阻止并发处理', async () => {
  const f = setup(); await f.c.SyncEngine.reconcile(false);
  const job = (await f.c.AgentDB.allRecords('jobs'))[0];
  await f.c.AgentDB.updateRecord('jobs', job.id, j => ({ ...j, status: 'running', owner: 'old-worker', leaseUntil: 1 }));
  await f.c.AgentDB.setMeta('pipeline:lease', { owner: 'old-worker', until: 1 });
  const next = setup({ db: f.c.indexedDB, tree: f.tree });
  await next.c.SyncEngine.run();
  assert.equal(next.docs.size, 1);
  const first = setup();
  await first.c.AgentDB.setMeta('pipeline:lease', { owner: 'active-worker', until: Date.now() + 100000 });
  await first.c.SyncEngine.request();
  assert.equal(first.docs.size, 0);
});

test('权限缺失只同步元数据，显示待授权，显式重试后采集正文', async () => {
  const f = setup({ permission: false });
  const result = await f.c.SyncEngine.request();
  assert.equal(result.jobs.paused, 1); assert.equal(f.calls().publicCalls, 0);
  let document = (await f.c.AgentDB.allRecords('documents'))[0];
  assert.equal(document.captureState, 'waiting_permission');
  assert.doesNotMatch(Array.from(f.docs.values())[0].content, /订单会自动生成/);
  f.c.chrome.permissions.contains = async () => true;
  await f.c.SyncEngine.retry(document.id);
  document = await f.c.Documents.get(document.id);
  assert.equal(document.captureState, 'partial');
  assert.match(Array.from(f.docs.values())[0].content, /订单会自动生成/);
});

test('默认不上传浏览器采集的登录正文，配置关闭后清理已上传内容', async () => {
  const f = setup(); await f.c.SyncEngine.reconcile(false);
  const doc = (await f.c.AgentDB.allRecords('documents'))[0];
  await f.c.Documents.capture(doc.id, { text: '工作区私有文档', source: 'capture', private: true, coverage: 'rendered', captureState: 'partial' });
  await f.c.SyncEngine.request(); assert.equal(f.docs.size, 0);
  f.config.rag.includePrivate = true; await f.c.SyncEngine.request({ force: true }); assert.equal(f.docs.size, 1);
  f.config.rag.includePrivate = false; await f.c.SyncEngine.request({ force: true }); assert.equal(f.docs.size, 0);
});

test('不同飞书 token 不合并，wiki 只有解析到真实文档后才关联', async () => {
  const { c } = fixture();
  const first = await c.Documents.forUrl('https://tenant.feishu.cn/docx/ABC?from=share');
  const second = await c.Documents.forUrl('https://tenant.feishu.cn/docx/DEF');
  const same = await c.Documents.forUrl('https://tenant.feishu.cn/docx/ABC#heading');
  assert.notEqual(first.id, second.id); assert.equal(first.id, same.id);
  const wiki = await c.Documents.forUrl('https://tenant.feishu.cn/wiki/WIKI');
  assert.notEqual(wiki.id, first.id);
  await c.Documents.alias('https://tenant.feishu.cn/wiki/WIKI', 'https://tenant.feishu.cn/docx/ABC');
  const resolved = await c.Documents.forUrl('https://tenant.feishu.cn/wiki/WIKI');
  assert.equal(resolved.id, first.id); assert.equal(resolved.kind, 'docx');
});

module.exports = { setup };

test('服务不可用时使用持久化退避，不在每次唤醒重复连接', async () => {
  const f = setup(); let attempts = 0;
  f.c.Rag.ensure = async () => { attempts++; throw new Error('RAG 请求失败（503）'); };
  await f.c.SyncEngine.request();
  assert.equal(attempts, 1);
  await f.c.SyncEngine.run();
  assert.equal(attempts, 1);
  for (let i = 0; i < 4; i++) {
    await f.c.AgentDB.updateMeta('pipeline:serviceBackoff', value => ({ ...value, nextAt: 0 }));
    await f.c.SyncEngine.run();
  }
  assert.equal(attempts, 5);
  assert.equal((await f.c.AgentDB.getMeta('pipeline:serviceBackoff')).blocked, true);
  await f.c.SyncEngine.run(); assert.equal(attempts, 5);
});

test('刷新失败保留旧正文，但状态与任务不会误报成功', async () => {
  const f = setup(); await f.c.SyncEngine.request();
  const old = (await f.c.AgentDB.allRecords('documents'))[0];
  const original = f.c.fetch;
  f.c.fetch = (url, options) => url.startsWith(f.config.rag.baseUrl) ? original(url, options) : Promise.reject(new Error('断网'));
  await f.c.SyncEngine.retry(old.id);
  const doc = await f.c.Documents.get(old.id);
  assert.equal(doc.text, old.text); assert.equal(doc.captureState, 'failed');
  assert.equal((await f.c.AgentDB.getRecord('jobs', old.id)).status, 'pending');
});


test('手动暂停队列会持久化，立即同步可以恢复', async () => {
  const f = setup(); await f.c.SyncEngine.pause();
  const paused = await f.c.SyncEngine.request();
  assert.equal(paused.queuePaused, true); assert.equal(f.docs.size, 0);
  const resumed = await f.c.SyncEngine.request({ manual: true });
  assert.equal(resumed.queuePaused, false); assert.equal(f.docs.size, 1);
});

test('相同域名、相同标题的不同路径分别采集和入库，有意义的参数与路由不合并', async () => {
  const f = setup(); const original = f.c.fetch; const visited = [];
  f.node('1').children = [
    { id: '3', title: '资料详情', url: 'https://example.com/articles/finance', parentId: '1' },
    { id: '4', title: '资料详情', url: 'https://example.com/articles/agriculture', parentId: '1' }
  ];
  f.c.fetch = async (url, options) => {
    if (url.startsWith(f.config.rag.baseUrl)) return original(url, options);
    visited.push(url);
    const content = url.endsWith('/finance') ? '应收凭证接口对接' : '水稻病虫害防治';
    return new Response('<html><body><main><p>' + content + '</p></main></body></html>', { headers: { 'content-type': 'text/html' } });
  };
  await f.c.SyncEngine.request();
  assert.equal(visited.length, 2); assert.equal(f.docs.size, 2);
  const stored = Array.from(f.docs.values());
  assert.match(stored.find(d => d.metadata.canonical_url.endsWith('/finance')).content, /应收凭证/);
  assert.match(stored.find(d => d.metadata.canonical_url.endsWith('/agriculture')).content, /水稻病虫害/);
  assert.notEqual((await f.c.Documents.forUrl('https://example.com/detail?id=1')).id, (await f.c.Documents.forUrl('https://example.com/detail?id=2')).id);
  assert.notEqual((await f.c.Documents.forUrl('https://example.com/app#/doc/1')).id, (await f.c.Documents.forUrl('https://example.com/app#/doc/2')).id);
});

test('未配置站点适配凭证时统一走公开 HTML 通道，不因域名要求特定授权', async () => {
  const f = setup(); const original = f.c.fetch;
  f.node('1').children = [{ id: '3', title: '公开文档', url: 'https://tenant.feishu.cn/docx/PUBLIC', parentId: '1' }];
  f.c.fetch = async (url, options) => {
    if (url.startsWith(f.config.rag.baseUrl)) return original(url, options);
    assert.equal(new URL(url).hostname, 'tenant.feishu.cn');
    return new Response('<html><body><article><p>公开页面的业务说明</p></article></body></html>', { headers: { 'content-type': 'text/html' } });
  };
  await f.c.SyncEngine.request();
  assert.equal(f.docs.size, 1);
  assert.match(Array.from(f.docs.values())[0].content, /公开页面的业务说明/);
});

test('同步无需 AI 与目录整理，重试失败项不重复采集成功页面', async () => {
  const f = setup();
  const first = await f.c.SyncEngine.request();
  assert.equal(first.indexed, 1); assert.equal(f.node('3').parentId, '1');
  await f.c.SyncEngine.retryFailed();
  assert.equal(f.calls().publicCalls, 1); assert.equal(f.calls().ingests, 1);
  assert.equal(await f.c.Organizer.get('3'), null);
});
test('关闭自动同步后后台不采集，手动同步一次后仍保持自动关闭', async () => {
  const f = setup(); f.config.rag.autoSync = false;
  await f.c.SyncEngine.request(); assert.equal(f.docs.size, 0);
  const result = await f.c.SyncEngine.request({ manual: true });
  assert.equal(result.indexed, 1); assert.equal(result.manual, false);
  assert.equal(f.config.rag.autoSync, false);
});

test('相同正文只更新采集时间不会增加版本、重新入队或减少已收录', async () => {
  const f = setup(); await f.c.SyncEngine.request();
  const before = (await f.c.AgentDB.allRecords('documents'))[0];
  const job = await f.c.AgentDB.getRecord('jobs', before.id);
  await f.c.AgentDB.putPage({ ...before, url: before.identity.canonicalUrl, status: 'ok', fetchedAt: before.fetchedAt + 1000 });
  await f.c.SyncEngine.reconcile(false);
  const after = await f.c.Documents.get(before.id);
  assert.equal(after.revision, before.revision);
  assert.equal((await f.c.AgentDB.getRecord('jobs', before.id)).generation, job.generation);
  await f.c.SyncEngine.run();
  assert.equal(f.calls().ingests, 1);
  assert.equal((await f.c.CollectionStats.read()).collected, 2);
});

test('待更新及更新失败保留最近一次成功收录，不把已有云端记录算成未收录', async () => {
  const options = {}; const f = setup(options); await f.c.SyncEngine.request();
  const before = (await f.c.AgentDB.allRecords('documents'))[0];
  await f.c.Documents.capture(before.id, { text: '真正变化后的正文' });
  await f.c.SyncEngine.reconcile(false);
  assert.equal((await f.c.CollectionStats.read()).collected, 2);
  options.failIngest = true;
  await f.c.SyncEngine.run();
  assert.equal((await f.c.CollectionStats.read()).collected, 2);
  assert.equal((await f.c.AgentDB.getRecord('jobs', before.id)).status, 'pending');
});

test('同页收藏入口调整顺序以及连续重新加载，不反复同步完成任务', async () => {
  let f = setup(); await f.c.SyncEngine.request();
  f.node('1').children.reverse();
  const before = (await f.c.AgentDB.allRecords('documents'))[0];
  await f.c.SyncEngine.request();
  assert.equal(f.calls().ingests, 1);
  for (let i = 0; i < 4; i++) {
    f = setup({ db: f.c.indexedDB, tree: f.tree });
    await f.c.SyncEngine.request();
    assert.equal(f.calls().publicCalls, 0);
    assert.equal(f.calls().ingests, 0);
    const stats = await f.c.CollectionStats.read();
    assert.equal(stats.collected, 2);
    assert.equal(stats.queue, 0);
    assert.equal((await f.c.Documents.get(before.id)).revision, before.revision);
  }
});

test('同内容再次采集不复活已达失败上限的任务', async () => {
  const options = { failIngest: true }; const f = setup(options);
  await f.c.SyncEngine.request();
  const doc = (await f.c.AgentDB.allRecords('documents'))[0];
  await f.c.AgentDB.updateRecord('jobs', doc.id, j => ({ ...j, status: 'failed', attempts: 5 }));
  await f.c.AgentDB.putPage({ ...doc, url: doc.identity.canonicalUrl, status: 'ok', fetchedAt: doc.fetchedAt + 1000 });
  await f.c.SyncEngine.request();
  const job = await f.c.AgentDB.getRecord('jobs', doc.id);
  assert.equal(job.attempts, 5);
  assert.equal(job.status, 'failed');
  assert.equal(f.calls().ingests, 1);
});

test('更新采集失败只保留待重试状态，不将错误提示再入库', async () => {
  const f = setup(); await f.c.SyncEngine.request();
  const doc = (await f.c.AgentDB.allRecords('documents'))[0];
  const original = f.c.fetch;
  f.c.fetch = (url, opts) => url.startsWith(f.config.rag.baseUrl) ? original(url, opts) : Promise.reject(new Error('临时断网'));
  await f.c.SyncEngine.retry(doc.id);
  assert.equal(f.calls().ingests, 1);
  assert.equal((await f.c.CollectionStats.read()).collected, 2);
  assert.equal((await f.c.AgentDB.getRecord('jobs', doc.id)).status, 'pending');
});

test('无网页标题时沿用收藏标题，重建索引不来回修改版本', async () => {
  const f = setup(); const original = f.c.fetch;
  f.c.fetch = (url, opts) => url.startsWith(f.config.rag.baseUrl) ? original(url, opts) : Promise.resolve(new Response('<html><body><p>没有 title 的项目正文。</p></body></html>', { headers: { 'content-type': 'text/html' } }));
  await f.c.SyncEngine.request();
  const before = (await f.c.AgentDB.allRecords('documents'))[0];
  await f.c.SyncEngine.request();
  const after = await f.c.Documents.get(before.id);
  assert.equal(after.revision, before.revision);
  assert.equal(f.calls().ingests, 1);
});

test('关闭正文采集的元数据记录成功后，不因没有 fetchedAt 每次重载都重做', async () => {
  const f = setup(); f.config.rag.autoCapture = false;
  await f.c.SyncEngine.request();
  const job = (await f.c.AgentDB.allRecords('jobs'))[0];
  await f.c.SyncEngine.request();
  const current = await f.c.AgentDB.getRecord('jobs', job.id);
  assert.equal(current.generation, job.generation);
  assert.equal(current.status, 'done');
  assert.equal(f.calls().publicCalls, 0);
  assert.equal(f.calls().ingests, 1);
});
