/* 分类策略与未收录对账；不可重试错误不进入批量重试。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/extension');

test('超时和网络故障两轮后停止，永久错误、权限、客户端拦截与额度不自动重试', () => {
  const { c } = fixture();
  for (const code of ['timeout', 'network', 'ai_timeout']) {
    assert.equal(c.RetryPolicy.classify(code, 1).auto, true);
    assert.equal(c.RetryPolicy.classify(code, 2).auto, false);
    assert.equal(c.RetryPolicy.classify(code, 2).bulk, false);
    assert.equal(c.RetryPolicy.classify(code, 2).allowManual, true);
  }
  for (const code of ['http_404', 'http_410', 'http_403', 'private', 'client_blocked', 'daily_limit', 'http_409', 'http_429']) {
    assert.equal(c.RetryPolicy.classify(code, 0).auto, false);
    assert.equal(c.RetryPolicy.classify(code, 0).bulk, false);
  }
  assert.equal(c.RetryPolicy.classify('http_502', 4).auto, true);
  assert.equal(c.RetryPolicy.classify('http_502', 5).auto, false);
});

test('未收录的互斥分类覆盖总量，已收录后续异常单列', async () => {
  const f = fixture();
  f.c.Settings = { load: async () => ({ rag: {} }) };
  const rows = f.c.Bookmarks.flatten(f.tree).filter(r => /^https?:/.test(r.url));
  await f.c.AgentDB.setMeta('enrich:failed', [
    { id: rows[0].id, url: rows[0].url, code: 'http_403', attempts: 1 },
    { id: rows[1].id, url: rows[1].url, code: 'timeout', attempts: 2 },
    { id: rows[2].id, url: rows[2].url, code: 'daily_limit', attempts: 0 }
  ]);
  const stats = await f.c.CollectionStats.read();
  assert.equal(Object.values(stats.states).reduce((a, b) => a + b, 0), stats.uncollected);
  assert.equal(stats.states.manual, 1);
  assert.equal(stats.states.failed, 1);
  assert.equal(stats.states.paused, 1);
  assert.equal(stats.states.waiting, 1);
});

test('批量重试跳过超时耗尽、权限与永久失败，只登记可重试项', async () => {
  const f = fixture(); f.c.setTimeout = () => 0;
  f.c.Settings = { load: async () => ({ ai: {}, rag: {} }) };
  const rows = f.c.Bookmarks.flatten(f.tree);
  await f.c.AgentDB.setMeta('enrich:failed', rows.map((r, i) => ({ id: r.id, url: r.url,
    code: ['timeout', 'http_404', 'http_403', 'http_502'][i], attempts: i === 0 ? 2 : 1 })));
  await f.c.BookmarkEnrich.scan({ retryFailed: true });
  const queue = await f.c.AgentDB.getMeta('enrich:queue');
  assert.deepEqual(Array.from(queue, x => x.id), [rows[3].id]);
  await assert.rejects(f.c.BookmarkEnrich.retry(rows[1].id), /停止/);
});

test('额度等待跨日恢复，不通过重试清空配额；不确定写入不自动恢复', () => {
  const { c } = fixture();
  const previous = new Date(2026, 10, 1, 23, 50).getTime();
  assert.equal(c.RetryPolicy.resumed('daily_limit', previous, new Date(2026, 10, 1, 23, 59).getTime()), false);
  assert.equal(c.RetryPolicy.resumed('daily_limit', previous, new Date(2026, 10, 2, 0, 1).getTime()), true);
  assert.equal(c.RetryPolicy.resumed('http_409', previous, previous + 86400000), false);
});
