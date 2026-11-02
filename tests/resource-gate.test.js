/* 门禁额度和失败停止策略；并发预扣不能超额。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/extension');

test('每日配额原子预扣，重载状态不重置；跨日恢复', async () => {
  const { c } = fixture();
  const d = new Date(); const day = [d.getFullYear(), d.getMonth() + 1, d.getDate()].join('-');
  await c.AgentDB.setMeta('guard:daily', { day, counts: { capture: 499 } });
  const outcomes = await Promise.allSettled([c.ResourceGate.reserve('capture'), c.ResourceGate.reserve('capture')]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  await assert.rejects(c.ResourceGate.reserve('capture'), { code: 'daily_limit' });
  await c.AgentDB.setMeta('guard:daily', { day: '过去日期', counts: { capture: 500 } });
  await c.ResourceGate.reserve('capture');
  assert.equal((await c.AgentDB.getMeta('guard:daily')).counts.capture, 1);
});

test('预算耗尽和门禁存储故障都不发送网页或后台 AI 请求', async () => {
  let calls = 0;
  const { c } = fixture({ fetch: async () => { calls++; throw new Error('不得联网'); } });
  const reserve = c.ResourceGate.reserve;
  c.ResourceGate.reserve = async () => { const error = new Error('额度已用完'); error.code = 'daily_limit'; throw error; };
  assert.equal((await c.PageInfo.fetchOne('https://example.test/')).reason, 'daily_limit');
  const result = await c.AI.chat({}, '系统', '输入', { background: true });
  assert.equal(result.error, 'daily_limit');
  assert.equal(calls, 0);
  c.ResourceGate.reserve = reserve;
  c.AgentDB.updateMeta = async () => { throw new Error('存储不可用'); };
  await assert.rejects(c.ResourceGate.reserve('ai'));
});

test('达到失败上限的任务不会被普通全量或增量扫描复活，明确重试才重置', async () => {
  const { c } = fixture();
  c.setTimeout = () => 0;
  c.Settings = { load: async () => ({ ai: {} }) };
  await c.AgentDB.setMeta('enrich:failed', [{ id: '3', url: 'https://example.com/a', code: 'timeout', attempts: 5, at: 1 }]);
  await c.BookmarkEnrich.scan();
  assert.equal((await c.AgentDB.getMeta('enrich:queue')).some(x => x.id === '3'), false);
  await c.BookmarkEnrich.scan({ retryFailed: true });
  assert.equal((await c.AgentDB.getMeta('enrich:queue')).some(x => x.id === '3'), false);
  await c.BookmarkEnrich.retry('3');
  assert.equal((await c.AgentDB.getMeta('enrich:queue')).some(x => x.id === '3'), true);
  assert.equal((await c.AgentDB.getMeta('enrich:failed'))[0].attempts, 0);
});

test('RAG 配额耗尽不会发送 ingest，也不会登记入库成功', async () => {
  let writes = 0;
  const { c } = fixture({ fetch: async url => { if (url.endsWith('/ingest')) writes++; return new Response('{}'); } });
  await c.Documents.reconcile([{ id: '3', title: '测试文档', url: 'https://example.com/a' }]);
  const doc = await c.Documents.forUrl('https://example.com/a');
  const captured = await c.Documents.capture(doc.id, { text: '有效正文', source: 'public' });
  c.ResourceGate.reserve = async () => { const e = new Error('今日额度已用完'); e.code = 'daily_limit'; throw e; };
  const cfg = { enabled: true, baseUrl: 'https://rag.example.com', apiKey: 'key', collection: 'chrome_tab_test' };
  await assert.rejects(c.Rag.upsertDocument(cfg, captured, {}), { code: 'daily_limit' });
  assert.equal(writes, 0);
  assert.equal(await c.AgentDB.getMeta(await c.Rag.stateKey(cfg)), null);
});
