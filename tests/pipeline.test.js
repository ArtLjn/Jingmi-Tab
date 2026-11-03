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

test('确认删除失败任务时移除书签并清理云端文档', async () => {
  const f = setup(); await f.c.SyncEngine.request();
  const doc = (await f.c.AgentDB.allRecords('documents'))[0];
  assert.ok(doc);
  assert.equal(doc.bookmarks.length, 2);
  const result = await f.c.SyncEngine.deleteFailed([doc.id]);
  assert.equal(result.deleteBatch.removed, 2);
  assert.equal(result.deleteBatch.failed.length, 0);
  assert.equal(result.deleteBatch.cloudRemoved, 1);
  assert.equal(result.deleteBatch.cloudQueued, 0);
  assert.equal(f.calls().publicCalls, 1, '删除收藏不应重新采集其他页面');
  assert.equal(f.calls().ingests, 1, '删除收藏不应重新入库其他文档');
  assert.equal(f.node('3'), undefined);
  assert.equal(f.node('4'), undefined);
  assert.equal(f.node('1').children.length, 0);
  assert.equal(f.docs.size, 0);
  const after = await f.c.AgentDB.allRecords('documents');
  assert.equal(after.every(item => item.deleted), true);
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

test('权限缺失不入库，显示待授权，显式重试后采集正文', async () => {
  const f = setup({ permission: false });
  const result = await f.c.SyncEngine.request();
  assert.equal(result.jobs.paused, 1); assert.equal(f.calls().publicCalls, 0);
  let document = (await f.c.AgentDB.allRecords('documents'))[0];
  assert.equal(document.captureState, 'waiting_permission');
  assert.equal(f.docs.size, 0);
  assert.equal(document.admissionState, 'deferred');
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

function manualEntry(note = '办理报销和请假', aliases = ['007', 'OA']) {
  return { id: 'manual', label: '公司平台', aliases, note, url: 'https://example.com/a' };
}
test('无正文的人工备注和别名单独入库，无需访问源站且不会被元数据清理选中', async () => {
  const f = setup({ permission: false }); f.c.QuickTags._inject({ tags: [manualEntry()] });
  await f.c.SyncEngine.request();
  const doc = (await f.c.AgentDB.allRecords('documents'))[0];
  const saved = Array.from(f.docs.values())[0];
  assert.equal(f.calls().publicCalls, 0); assert.equal(f.docs.size, 1);
  assert.match(saved.content, /用户填写[\s\S]*公司平台[\s\S]*007[\s\S]*报销和请假/);
  assert.equal(saved.metadata.record_quality, 'personal'); assert.equal(saved.metadata.coverage, 'personal');
  assert.equal(doc.text, undefined); assert.equal(doc.indexedQuality, 'personal');
  assert.match(f.c.Documents.syncLabel(doc), /未收录正文/);
  assert.equal((await f.c.SyncEngine.audit())[0].selectable, false);
  const stats = await f.c.CollectionStats.read(); assert.equal(stats.collected, 2);
  const rows = f.c.Bookmarks.flatten(f.tree);
  assert.equal((await f.c.Rag.retrieve(f.config.rag, '人员报销系统', rows)).length, 1);
  await f.c.SyncEngine.request(); assert.equal(f.calls().ingests, 1);
});
test('登录失败不妨碍备注收录，登录页内容不会混入检索资料', async () => {
  const f = setup(); f.c.QuickTags._inject({ tags: [manualEntry()] });
  const original = f.c.fetch;
  f.c.fetch = (url, init) => url.startsWith(f.config.rag.baseUrl) ? original(url, init) : Promise.resolve(new Response('<title>登录</title><body>扫码输入密码</body>', { headers: { 'content-type': 'text/html' } }));
  await f.c.SyncEngine.request({ force: true });
  const saved = Array.from(f.docs.values())[0];
  assert.match(saved.content, /办理报销和请假/); assert.doesNotMatch(saved.content, /扫码输入密码/);
  assert.equal((await f.c.AgentDB.allRecords('jobs'))[0].status, 'done');
});
test('备注和别名修改会更新指纹，旧人工信息在同步前即停止召回；全部删除后清理云端', async () => {
  const f = setup(); f.c.QuickTags._inject({ tags: [manualEntry()] });
  await f.c.SyncEngine.request();
  const rows = f.c.Bookmarks.flatten(f.tree);
  f.c.QuickTags._inject({ tags: [manualEntry('仅办理请假', ['008'])] });
  assert.equal((await f.c.Rag.retrieve(f.config.rag, '报销', rows)).length, 0);
  await f.c.SyncEngine.request(); assert.equal(f.calls().ingests, 2); assert.equal(f.docs.size, 1);
  const saved = Array.from(f.docs.values())[0];
  assert.match(saved.content, /008[\s\S]*仅办理请假/); assert.doesNotMatch(saved.content, /007|报销/);
  f.c.QuickTags._inject({ tags: [] });
  assert.equal((await f.c.Rag.retrieve(f.config.rag, '请假', rows)).length, 0);
  f.config.rag.autoCapture = false;
  await f.c.SyncEngine.request(); assert.equal(f.docs.size, 0);
});
test('正文与人工信息共同更新，移除备注不会丢失合格旧正文', async () => {
  const f = setup(); await f.c.SyncEngine.request();
  const old = (await f.c.AgentDB.allRecords('documents'))[0];
  f.c.QuickTags._inject({ tags: [manualEntry()] }); await f.c.SyncEngine.request();
  assert.match(Array.from(f.docs.values())[0].content, /订单会自动生成[\s\S]*个人备注/);
  const original = f.c.fetch;
  f.c.fetch = (url, init) => url.startsWith(f.config.rag.baseUrl) ? original(url, init) : Promise.reject(new Error('断网'));
  f.c.QuickTags._inject({ tags: [] }); await f.c.SyncEngine.request({ force: true });
  const saved = Array.from(f.docs.values())[0];
  assert.match(saved.content, /订单会自动生成/); assert.doesNotMatch(saved.content, /个人备注|007/);
  assert.equal(saved.metadata.record_quality, 'body');
  assert.equal((await f.c.Documents.get(old.id)).text, old.text);
});
test('备注可单独收录，关闭私有正文上传后不携带私有正文或描述', async () => {
  const f = setup(); await f.c.SyncEngine.reconcile(false);
  const doc = (await f.c.AgentDB.allRecords('documents'))[0];
  await f.c.Documents.capture(doc.id, { text: '私有机密正文', desc: '私有页面描述', source: 'capture', private: true, coverage: 'rendered', captureState: 'partial' });
  f.c.QuickTags._inject({ tags: [manualEntry()] });
  f.config.rag.includePrivate = true; await f.c.SyncEngine.request();
  assert.match(Array.from(f.docs.values())[0].content, /私有机密正文/);
  f.config.rag.includePrivate = false; await f.c.SyncEngine.request({ force: true });
  const saved = Array.from(f.docs.values())[0];
  assert.doesNotMatch(saved.content, /私有机密正文|私有页面描述/);
  assert.match(saved.content, /办理报销/); assert.equal(saved.metadata.private, false);
  f.c.QuickTags._inject({ tags: [] }); await f.c.SyncEngine.request(); assert.equal(f.docs.size, 0);
});
test('同域不同路径的备注不串入，删除最后书签仍清理人工资料', async () => {
  const f = setup(); f.c.QuickTags._inject({ tags: [{ ...manualEntry(), url: 'https://example.com/b' }] });
  await f.c.SyncEngine.request(); assert.doesNotMatch(Array.from(f.docs.values())[0].content, /007|办理报销/);
  f.c.QuickTags._inject({ tags: [manualEntry()] }); await f.c.SyncEngine.request();
  f.node('1').children = []; await f.c.SyncEngine.request(); assert.equal(f.docs.size, 0);
});

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

test('关闭正文采集时只保存本地入口，完成后不反复入队', async () => {
  const f = setup(); f.config.rag.autoCapture = false;
  await f.c.SyncEngine.request();
  const job = (await f.c.AgentDB.allRecords('jobs'))[0];
  await f.c.SyncEngine.request();
  const current = await f.c.AgentDB.getRecord('jobs', job.id);
  assert.equal(current.generation, job.generation);
  assert.equal(current.status, 'done');
  assert.equal(f.calls().publicCalls, 0);
  assert.equal(f.calls().ingests, 0);
});

test('首次本地网络失败不上传骨架、不删云端、不消耗站点短重试次数', async () => {
  const f = setup({ failCapture: true }); await f.c.SyncEngine.request();
  const doc = (await f.c.AgentDB.allRecords('documents'))[0]; const job = await f.c.AgentDB.getRecord('jobs', doc.id);
  assert.equal(f.calls().ingests, 0); assert.equal(f.docs.size, 0); assert.equal(doc.admissionState, 'deferred');
  assert.equal(job.attempts, 0); assert.ok(job.nextAt > Date.now()); assert.equal(doc.captureError, 'network');
});

test('404 双次复核清理与主动恢复组成闭环，不依赖缓存自己更新', async () => {
  const f = setup(); f.config.rag.cleanupEnabled = true; await f.c.SyncEngine.request();
  const id = (await f.c.AgentDB.allRecords('documents'))[0].id; const original = f.c.fetch;
  f.c.fetch = (url, options) => url.startsWith(f.config.rag.baseUrl) ? original(url, options) : Promise.resolve(new Response('', { status: 404 }));
  await f.c.SyncEngine.retry(id); assert.equal(f.docs.size, 1); assert.equal((await f.c.Documents.get(id)).admissionState, 'deferred');
  await f.c.Documents.update(id, d => ({ ...d, invalidCandidate: { ...d.invalidCandidate, firstSeenAt: Date.now() - 86400001, lastSeenAt: Date.now() - 1000 } }));
  await f.c.AgentDB.updateRecord('jobs', id, j => ({ ...j, nextAt: 0, force: true })); await f.c.SyncEngine.run();
  assert.equal(f.docs.size, 0); assert.equal((await f.c.Documents.get(id)).admissionState, 'invalid'); assert.equal((await f.c.Documents.get(id)).syncState, 'deleted');
  f.c.fetch = original; await f.c.AgentDB.updateRecord('jobs', id, j => ({ ...j, nextAt: 0 })); await f.c.SyncEngine.run();
  assert.equal(f.docs.size, 1); assert.equal((await f.c.Documents.get(id)).admissionState, 'eligible');
});

test('默认关闭自动失效删除，但立即隔离失效证据并保留恢复计划', async () => {
  const f = setup(); await f.c.SyncEngine.request(); const id = (await f.c.AgentDB.allRecords('documents'))[0].id;
  const original = f.c.fetch; f.c.fetch = (url, options) => url.startsWith(f.config.rag.baseUrl) ? original(url, options) : Promise.resolve(new Response('', { status: 410 }));
  await f.c.SyncEngine.retry(id); assert.equal(f.docs.size, 1); assert.equal((await f.c.Documents.get(id)).admissionState, 'invalid');
  const rows = f.c.Bookmarks.flatten(f.tree); assert.equal((await f.c.Rag.retrieve(f.config.rag, '凭证', rows)).length, 0);
  assert.ok((await f.c.AgentDB.getRecord('jobs', id)).nextAt > Date.now());
});

test('客户端写入中断后服务器可能已完成，核验前不重发；确切版本可确认', async () => {
  const f = setup(); const original = f.c.fetch; let writes = 0;
  f.c.fetch = async (url, options) => {
    const response = await original(url, options);
    if (url.endsWith('/ingest')) { writes++; const error = new Error('客户端先停止等待'); error.name = 'AbortError'; throw error; }
    return response;
  };
  await f.c.SyncEngine.request(); const doc = (await f.c.AgentDB.allRecords('documents'))[0];
  assert.equal(doc.outcomeUnknown, true); assert.equal(writes, 1); assert.equal(f.docs.size, 1);
  await f.c.SyncEngine.request({ force: true }); assert.equal(writes, 1);
  f.c.fetch = original; await f.c.SyncEngine.verify(doc.id);
  assert.equal((await f.c.Documents.get(doc.id)).outcomeUnknown, false); assert.equal(f.calls().ingests, 1);
});

test('删除失败保留实际 docId 与清理意图，确认删除前不标已清', async () => {
  const f = setup(); await f.c.SyncEngine.request(); const doc = (await f.c.AgentDB.allRecords('documents'))[0]; const original = f.c.fetch;
  f.node('1').children.splice(0);
  f.c.fetch = (url, options) => options && options.method === 'DELETE' ? Promise.resolve(new Response('', { status: 503 })) : original(url, options);
  await f.c.SyncEngine.request(); const failed = await f.c.Documents.get(doc.id);
  assert.notEqual(failed.syncState, 'deleted'); assert.ok(failed.deleteIntent); assert.equal(f.docs.size, 1);
  f.c.fetch = original; await f.c.AgentDB.updateRecord('jobs', doc.id, j => ({ ...j, nextAt: 0 })); await f.c.SyncEngine.run();
  assert.equal(f.docs.size, 0); assert.equal((await f.c.Documents.get(doc.id)).syncState, 'deleted');
});

test('删除期间生成新正文，旧删除完成不能冒充新版本已清理，随后重建', async () => {
  const f = setup(); f.config.rag.cleanupEnabled = true; await f.c.SyncEngine.request(); const doc = (await f.c.AgentDB.allRecords('documents'))[0]; const original = f.c.fetch; let changed = false;
  f.c.fetch = async (url, options) => {
    if (options && options.method === 'DELETE' && !changed) {
      changed = true; await f.c.Documents.capture(doc.id, { text: '删除期间出现的新正文', captureState: 'ready', source: 'public' }); f.config.rag.autoCapture = false;
    }
    return original(url, options);
  };
  await f.c.Documents.update(doc.id, d => ({ ...d, captureError: 'http_410' })); await f.c.SyncEngine.request({ force: true });
  /* force 采集会清错误，直接以历史空记录清理任务验证版本竞争。 */
  await f.c.Documents.update(doc.id, d => ({ ...d, captureError: 'http_410' })); f.config.rag.autoCapture = false;
  await f.c.SyncEngine.request({ force: true }); await f.c.SyncEngine.run();
  assert.match(Array.from(f.docs.values())[0].content, /新正文/); assert.equal((await f.c.Documents.get(doc.id)).syncState, 'synced');
});

test('历史审计先预览，只有显式选择且仍为空的记录才清理', async () => {
  const f = setup(); f.config.rag.autoCapture = false; await f.c.SyncEngine.reconcile(false);
  const doc = (await f.c.AgentDB.allRecords('documents'))[0]; const key = await f.c.Rag.stateKey(f.config.rag);
  const cloudId = 'legacy-empty'; f.docs.set(cloudId, { content: '仅标题', metadata: {} });
  await f.c.AgentDB.setMeta(key, { [doc.id]: { pageId: doc.id, docId: cloudId, quality: 'metadata' } });
  const preview = await f.c.SyncEngine.audit(); assert.equal(preview[0].selectable, true); assert.equal(f.docs.size, 1);
  await f.c.SyncEngine.clean([doc.id]); assert.equal(f.docs.size, 0); assert.equal((await f.c.Documents.get(doc.id)).admissionState, 'metadata');
});

test('仅描述的新采集不覆盖旧成功正文，保持正文版本并显示历史状态', async () => {
  const f = setup(); await f.c.SyncEngine.request(); const doc = (await f.c.AgentDB.allRecords('documents'))[0];
  const updated = await f.c.Documents.capture(doc.id, { text: '', desc: '只有描述', captureState: 'metadata', source: 'public' });
  assert.equal(updated.text, doc.text); assert.equal(updated.contentHash, doc.contentHash); assert.equal(updated.revision, doc.revision);
  await f.c.SyncEngine.reconcile(false); f.config.rag.autoCapture = false; await f.c.SyncEngine.request({ force: true });
  assert.equal(f.docs.size, 1); assert.equal((await f.c.Documents.get(doc.id)).syncState, 'synced');
});

test('网络恢复只唤醒网络类任务，不复活未确认写入或其他失效任务', async () => {
  const f = setup({ failCapture: true }); await f.c.SyncEngine.request(); const doc = (await f.c.AgentDB.allRecords('documents'))[0];
  await f.c.AgentDB.updateRecord('jobs', doc.id, j => ({ ...j, errorCode: 'outcome_unknown', status: 'paused' }));
  await f.c.Documents.update(doc.id, d => ({ ...d, outcomeUnknown: true }));
  await f.c.SyncEngine.networkRetry(); assert.equal((await f.c.AgentDB.getRecord('jobs', doc.id)).status, 'paused'); assert.equal(f.calls().ingests, 0);
});

test('补全采集的新正文会通知协调器，元数据完成态可升级入库', async () => {
  const f = setup(); f.config.rag.autoCapture = false; await f.c.SyncEngine.request(); const id = (await f.c.AgentDB.allRecords('documents'))[0].id;
  assert.equal(f.calls().ingests, 0);
  await f.c.AgentDB.putPage({ url: 'https://example.com/a?utm_source=test', version: f.c.ContentIndex.VERSION, status: 'ok', source: 'public', text: '后来补采得到的正文', fetchedAt: Date.now() + 1000 });
  await f.c.SyncEngine.request(); assert.equal(f.calls().ingests, 1); assert.equal((await f.c.Documents.get(id)).admissionState, 'eligible');
});

test('已知登录条件后的匿名 404 不自动判死', async () => {
  const f = setup(); f.config.rag.cleanupEnabled = true; await f.c.SyncEngine.request(); const id = (await f.c.AgentDB.allRecords('documents'))[0].id; const original = f.c.fetch;
  f.c.fetch = (url, options) => url.startsWith(f.config.rag.baseUrl) ? original(url, options) : Promise.resolve(new Response('', { status: 403 }));
  await f.c.SyncEngine.retry(id);
  f.c.fetch = (url, options) => url.startsWith(f.config.rag.baseUrl) ? original(url, options) : Promise.resolve(new Response('', { status: 404 }));
  await f.c.SyncEngine.recapture(id); assert.equal(f.docs.size, 1); assert.equal((await f.c.Documents.get(id)).admissionState, 'deferred');
  assert.equal((await f.c.Documents.get(id)).admissionReason, 'waiting_auth');
});

test('后台重建后读取逐项保存的当前任务与失败原因，不依赖设置页保活', async () => {
  const first = setup({ failIngest: true });
  await first.c.SyncEngine.request();
  const before = await first.c.SyncEngine.summary();
  assert.equal(before.records.length, 1);
  assert.equal(before.records[0].sync, 'failed');
  const restored = setup({ db: first.c.indexedDB, tree: first.tree });
  const after = await restored.c.SyncEngine.summary();
  assert.equal(after.records[0].id, before.records[0].id);
  assert.equal(after.records[0].status, before.records[0].status);
  assert.equal(after.records[0].error, before.records[0].error);
  assert.ok(after.records[0].error);
  assert.equal(restored.calls().ingests, 0);
});

test('显式批量重试重置临时错误上限和退避，跳过访问门槛、不确定写入、运行及删除项', async () => {
  const f = setup();
  await f.c.SyncEngine.reconcile(false);
  const template = (await f.c.AgentDB.allRecords('documents'))[0];
  const cases = [
    ['network', 'failed', 2, {}], ['http_503', 'pending', 3, {}],
    ['login_wall', 'paused', 1, {}], ['network', 'failed', 2, { outcomeUnknown: true }],
    ['daily_limit', 'paused', 1, {}], ['http_404', 'failed', 1, {}],
    ['network', 'running', 1, {}], ['network', 'failed', 2, { deleted: true }]
  ];
  for (const [index, [code, status, attempts, extra]] of cases.entries()) {
    const id = 'batch-' + index;
    await f.c.AgentDB.updateRecord('documents', id, () => ({ ...template, ...extra, id }));
    await f.c.AgentDB.updateRecord('jobs', id, () => ({ id, generation: 1, documentRevision: template.revision, status, attempts, errorCode: code, error: code, nextAt: Date.now() + 999999 }));
  }
  // 保持另一个后台的租约，以便直接核对入队结果及持久化状态。
  await f.c.AgentDB.setMeta('pipeline:lease', { owner: 'active-worker', until: Date.now() + 60000 });
  assert.equal((await f.c.SyncEngine.summary()).retryableJobs, 2);
  const result = await f.c.SyncEngine.retryFailed();
  assert.equal(result.retryBatch.queued, 2);
  assert.equal(result.retryBatch.skipped, 4);
  for (let index = 0; index < cases.length; index++) {
    const job = await f.c.AgentDB.getRecord('jobs', 'batch-' + index);
    assert.equal(job.generation, index < 2 ? 2 : 1);
    assert.equal(job.status, index < 2 ? 'pending' : cases[index][1]);
    if (index < 2) { assert.equal(job.attempts, 0); assert.equal(job.error, undefined); assert.ok(job.nextAt <= Date.now()); }
  }
});

test('无可重试项时批量操作不启动队列', async () => {
  const f = setup();
  await f.c.SyncEngine.reconcile(false);
  const result = await f.c.SyncEngine.retryFailed();
  assert.equal(result.retryBatch.queued, 0);
  assert.equal(result.manual, false);
  assert.equal(f.calls().ingests, 0);
});

test('所选失败任务按 ID 去重重试，服务端排除不可重试项且不改动未选任务', async () => {
  const f = setup(); await f.c.SyncEngine.reconcile(false);
  const template = (await f.c.AgentDB.allRecords('documents'))[0];
  const cases = [['selected', 'login_wall', {}], ['unselected', 'network', {}], ['uncertain', 'network', { outcomeUnknown: true }], ['quota', 'daily_limit', {}]];
  for (const [id, code, extra] of cases) {
    await f.c.AgentDB.updateRecord('documents', id, () => ({ ...template, ...extra, id }));
    await f.c.AgentDB.updateRecord('jobs', id, () => ({ id, generation: 1, status: 'failed', attempts: 5, errorCode: code, error: code, nextAt: 0 }));
  }
  await f.c.AgentDB.setMeta('pipeline:lease', { owner: 'active-worker', until: Date.now() + 60000 });
  const summary = await f.c.SyncEngine.summary();
  assert.equal(summary.records.find(row => row.id === 'selected').selectableRetry, true);
  assert.equal(summary.records.find(row => row.id === 'selected').errorCategory.key, 'login');
  assert.equal(summary.records.find(row => row.id === 'uncertain').selectableRetry, false);
  const result = await f.c.SyncEngine.retryFailed(['selected', 'selected', 'uncertain', 'quota', 'missing']);
  assert.equal(result.retryBatch.queued, 1); assert.equal(result.retryBatch.skipped, 3);
  assert.equal((await f.c.AgentDB.getRecord('jobs', 'selected')).status, 'pending');
  for (const id of ['unselected', 'uncertain', 'quota']) assert.equal((await f.c.AgentDB.getRecord('jobs', id)).generation, 1);
  const empty = await f.c.SyncEngine.retryFailed([]);
  assert.equal(empty.retryBatch.queued, 0);
});

test('没有持久化任务的收藏不冒充待处理队列', async () => {
  const f = setup(); await f.c.SyncEngine.reconcile(false);
  const job = (await f.c.AgentDB.allRecords('jobs'))[0];
  await f.c.AgentDB.updateRecord('jobs', job.id, () => null);
  assert.equal((await f.c.SyncEngine.summary()).records[0].status, 'unqueued');
});
