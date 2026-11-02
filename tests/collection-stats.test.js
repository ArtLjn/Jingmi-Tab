/* 五项统计按收藏计数，同一收藏跨队列去重，收录仅依据 RAG 当前版本成功回执。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/extension');

function setup() {
  const f = fixture({ tree: [{ id: '0', children: [{ id: '2', title: '其他书签', children: [
    { id: '3', title: '入口 A', url: 'https://example.com/a' },
    { id: '4', title: '入口 A 重复', url: 'https://example.com/a' },
    { id: '5', title: '入口 B', url: 'https://example.com/b' },
    { id: '6', title: '特殊收藏', url: 'chrome://extensions/' }
  ] }] }] });
  f.c.Settings = { load: async () => ({ rag: { enabled: true, baseUrl: 'https://rag.test', apiKey: 'k', collection: 'chrome_tab_stats', includePrivate: false } }) };
  return f;
}
async function seed(f) {
  const rows = f.c.Bookmarks.flatten(f.tree);
  await f.c.Documents.reconcile(rows);
  const info = await f.c.Documents.forUrl('https://example.com/a');
  const doc = await f.c.Documents.update(info.id, d => ({ ...d, syncState: 'synced', indexedRevision: d.revision }));
  const settings = await f.c.Settings.load();
  const key = await f.c.Rag.stateKey(settings.rag);
  await f.c.AgentDB.setMeta(key, { [doc.id]: { docId: 'remote-a', hash: '成功回执' } });
  return { doc, key };
}

test('重复网址按收藏条目折算，特殊地址计入未收录，总数恒等于两者之和', async () => {
  const f = setup();
  await seed(f);
  const result = await f.c.CollectionStats.read();
  assert.equal(result.total, 4);
  assert.equal(result.collected, 2);
  assert.equal(result.uncollected, 2);
  assert.equal(result.total, result.collected + result.uncollected);
});

test('采集正文、AI 摘要或单独标记同步成功，均不能代替 RAG 成功回执', async () => {
  const f = setup();
  const { doc, key } = await seed(f);
  await f.c.AgentDB.setMeta(key, {});
  await f.c.AgentDB.setMeta('enrich:summaries', { '3': { url: 'https://example.com/a', summary: '已生成摘要' } });
  await f.c.AgentDB.putPage({ url: 'https://example.com/a', status: 'ok', text: '正文已保存' });
  assert.equal((await f.c.CollectionStats.read()).collected, 0);
  await f.c.AgentDB.setMeta(key, { [doc.id]: { docId: 'remote-a' } });
  await f.c.Documents.update(doc.id, d => ({ ...d, revision: d.revision + 1 }));
  assert.equal((await f.c.CollectionStats.read()).collected, 2);
});

test('双队列同收藏只计一次，重试中的旧失败和已删除任务不重复计入', async () => {
  const f = setup();
  const { doc } = await seed(f);
  await f.c.AgentDB.updateRecord('jobs', doc.id, () => ({ id: doc.id, status: 'pending' }));
  await f.c.AgentDB.setMeta('enrich:queue', [{ id: '3', url: 'https://example.com/a' }, { id: '99', url: 'https://deleted.test/' }]);
  await f.c.AgentDB.setMeta('enrich:failed', [
    { id: '3', url: 'https://example.com/a', code: 'timeout' },
    { id: '5', url: 'https://example.com/b', code: 'network' },
    { id: '6', url: '旧网址', code: 'network' }
  ]);
  const result = await f.c.CollectionStats.read();
  assert.equal(result.queue, 0);
  assert.equal(result.updates.queued, 2);
  assert.equal(result.failed, 1);
});

test('旧网址和已删除文档不冒充当前收藏已收录', async () => {
  const f = setup();
  const { doc } = await seed(f);
  f.node('3').url = 'https://changed.test/';
  assert.equal((await f.c.CollectionStats.read()).collected, 1);
  await f.c.Documents.update(doc.id, d => ({ ...d, deleted: true }));
  assert.equal((await f.c.CollectionStats.read()).collected, 0);
});

test('失败按收藏去重，待授权与额度暂停不算失败', async () => {
  const f = setup();
  const { doc } = await seed(f);
  await f.c.AgentDB.updateRecord('jobs', doc.id, () => ({ id: doc.id, status: 'failed' }));
  await f.c.AgentDB.setMeta('enrich:failed', [
    { id: '3', url: 'https://example.com/a', code: 'network' },
    { id: '5', url: 'https://example.com/b', code: 'private' }
  ]);
  assert.equal((await f.c.CollectionStats.read()).failed, 0);
  assert.equal((await f.c.CollectionStats.read()).updates.failed, 2);
  await f.c.AgentDB.updateRecord('jobs', doc.id, () => ({ id: doc.id, status: 'paused' }));
  await f.c.AgentDB.setMeta('enrich:failed', [{ id: '5', url: 'https://example.com/b', code: 'daily_limit' }]);
  assert.equal((await f.c.CollectionStats.read()).failed, 0);
});

test('暂停自动同步不抹去已收录事实，切换集合不沿用旧集合的回执', async () => {
  const f = setup();
  await seed(f);
  const settings = await f.c.Settings.load();
  settings.rag.enabled = false;
  f.c.Settings.load = async () => settings;
  assert.equal((await f.c.CollectionStats.read()).collected, 2);
  settings.rag.collection = 'chrome_tab_another';
  assert.equal((await f.c.CollectionStats.read()).collected, 0);
});

test('每个未收录书签都有可见去向，重复网址不吞条目，分类之和等于未收录总数', async () => {
  const f = setup(); await seed(f);
  const result = await f.c.CollectionStats.read();
  assert.equal(result.uncollectedItems.length, result.uncollected);
  assert.deepEqual(Array.from(result.uncollectedItems, item => item.id), ['5', '6']);
  assert.equal(result.uncollectedItems.find(item => item.id === '6').reason, '此类地址不支持正文收录');
  assert.equal(Object.values(result.uncollectedBreakdown).reduce((a, b) => a + b, 0), result.uncollected);
  assert.equal(result.uncollectedBreakdown.manual, 1);
  assert.equal(result.uncollectedBreakdown.unarranged, 1);
});

test('失败任务按网页计数，未收录明细保留同网页的每个书签；已收录更新失败不混入未收录', async () => {
  const f = setup(); const { doc, key } = await seed(f);
  await f.c.AgentDB.setMeta(key, {});
  await f.c.AgentDB.updateRecord('jobs', doc.id, () => ({ id: doc.id, status: 'failed', error: '网络异常', errorCode: 'network' }));
  let result = await f.c.CollectionStats.read();
  assert.equal(result.uncollected, 4);
  assert.equal(result.uncollectedBreakdown.failed, 2);
  assert.equal(result.uncollectedItems.filter(item => item.state === 'failed').length, 2);
  await f.c.AgentDB.updateRecord('jobs', doc.id, () => ({ id: doc.id, status: 'pending', nextAt: Date.now() + 60000 }));
  result = await f.c.CollectionStats.read();
  assert.equal(result.uncollectedBreakdown.queue, 2);
  await f.c.AgentDB.setMeta(key, { [doc.id]: { docId: 'remote-a', quality: 'body' } });
  await f.c.AgentDB.updateRecord('jobs', doc.id, () => ({ id: doc.id, status: 'failed', error: '更新失败' }));
  result = await f.c.CollectionStats.read();
  assert.equal(result.collected, 2);
  assert.equal(result.uncollectedBreakdown.failed, 0);
  assert.equal(result.uncollectedItems.length, 2);
});

test('任务归类只把实际排队或运行项计入队列，失败、完成和未安排互不混淆', () => {
  const { c } = setup();
  const kind = c.CollectionStats.taskKind;
  assert.equal(kind({ status: 'done', sync: 'synced' }), '');
  assert.equal(kind({ status: 'unqueued' }), '');
  assert.equal(kind({ status: 'pending', sync: 'failed' }), 'queue');
  assert.equal(kind({ status: 'waiting', error: '网络失败' }), 'failed');
  assert.equal(kind({ status: 'running', outcomeUnknown: true }), 'failed');
});
