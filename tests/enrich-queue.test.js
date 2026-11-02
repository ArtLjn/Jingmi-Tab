/* 全量与增量采集：验证持久化队列、完整统计和中断恢复。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { fixture } = require('./helpers/extension');

function setup(count) {
  const f = fixture({ tree: [{ id: '0', title: '', children: [{ id: '2', title: '其他书签', children:
    Array.from({ length: count }, (_, i) => ({ id: String(10 + i), title: '收藏' + i, url: 'https://example.test/' + i }))
  }] }] });
  // 队列由测试显式推进，避免后台定时器与断点模拟互相影响。
  f.c.setTimeout = () => 0;
  f.c.clearTimeout = () => {};
  f.c.Settings = { load: async () => ({ ai: { enabled: true } }) };
  f.c.AI.available = cfg => !!cfg.enabled;
  f.c.AI.chat = async () => ({ ok: true, content: '{"title":"具体项目说明","summary":"说明项目功能与接口","tags":["项目"]}' });
  f.c.PageInfo.getMany = async urls => {
    const result = {};
    for (const url of urls) {
      const row = { url, status: 'ok', source: 'public', text: '具体项目的功能、操作与接口说明。', version: f.c.ContentIndex.VERSION, fetchedAt: Date.now() };
      result[url] = row;
      await f.c.AgentDB.putPage(row);
    }
    return result;
  };
  return f;
}

async function drain(f) {
  for (let i = 0; i < 180; i++) {
    if (!(await f.c.AgentDB.getMeta('enrich:queue') || []).length) return;
    await f.c.BookmarkEnrich.run();
  }
  assert.fail('队列未完成');
}

test('403 条书签一次全量登记，重复扫描不重复入队，全部处理且建议不截断', async () => {
  const f = setup(403);
  assert.equal((await f.c.BookmarkEnrich.scan()).queued, 403);
  assert.equal((await f.c.BookmarkEnrich.scan()).queued, 0);
  let state = await f.c.BookmarkEnrich.status();
  assert.equal(state.queued, 403);
  assert.equal(state.failedCount, 0);
  assert.equal(state.unprocessed, 0);
  await drain(f);
  state = await f.c.BookmarkEnrich.status();
  assert.equal(state.successful, 403);
  assert.equal(state.capturedPages, 403);
  assert.equal(state.totalPending, 403);
  assert.equal((await f.c.BookmarkEnrich.scan()).queued, 0);
});

test('任务执行中新增书签不会被旧队列快照覆盖', async () => {
  const f = setup(1);
  const capture = f.c.PageInfo.getMany;
  let added = false;
  f.c.PageInfo.getMany = async urls => {
    if (!added) {
      added = true;
      const node = await f.bookmarks.create({ parentId: '2', title: '执行中新收藏', url: 'https://new.test/' });
      await f.c.BookmarkEnrich.onCreated(node.id, node);
    }
    return capture(urls);
  };
  await f.c.BookmarkEnrich.scan();
  await drain(f);
  assert.equal((await f.c.BookmarkEnrich.status()).successful, 2);
});

test('后台中断的任务保留在队列，租约到期后重新加载模块可续采', async () => {
  const f = setup(1);
  const capture = f.c.PageInfo.getMany;
  let started;
  const begun = new Promise(resolve => { started = resolve; });
  f.c.PageInfo.getMany = async () => { started(); return new Promise(() => {}); };
  await f.c.BookmarkEnrich.scan();
  f.c.BookmarkEnrich.run();
  await begun;
  const state = await f.c.BookmarkEnrich.status();
  assert.equal(state.processing, 1);
  await f.c.AgentDB.updateMeta('enrich:queue', list => { list[0].leaseUntil = Date.now() - 1; return list; });
  f.c.PageInfo.getMany = capture;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/bookmark-enrich.js'), 'utf8'), f.c);
  await f.c.BookmarkEnrich.run();
  assert.equal((await f.c.BookmarkEnrich.status()).successful, 1);
  assert.equal((await f.c.AgentDB.getMeta('enrich:queue')).length, 0);
});

test('失败记录超过 30 条仍完整保存，批量重试强制抓取全部失败项', async () => {
  const f = setup(45);
  const capture = f.c.PageInfo.getMany;
  f.c.PageInfo.getMany = async urls => {
    const result = {};
    for (const url of urls) {
      result[url] = { url, status: 'fail', reason: 'timeout', version: f.c.ContentIndex.VERSION, fetchedAt: Date.now() };
      await f.c.AgentDB.putPage(result[url]);
    }
    return result;
  };
  await f.c.BookmarkEnrich.scan();
  await drain(f);
  const state = await f.c.BookmarkEnrich.status();
  assert.equal(state.totalFailed, 45);
  assert.equal(state.failedCount, 45);
  assert.equal(state.failures.length, 30);
  let forced = 0;
  f.c.PageInfo.getMany = async (urls, progress, options) => { if (options.force) forced++; return capture(urls); };
  assert.equal((await f.c.BookmarkEnrich.scan({ retryFailed: true })).queued, 45);
  await drain(f);
  assert.equal(forced, 45);
  assert.equal((await f.c.BookmarkEnrich.status()).successful, 45);
});

test('新书签显示未处理而非失败，正文成功与 AI 补全成功分开统计', async () => {
  const f = setup(4);
  let state = await f.c.BookmarkEnrich.status();
  assert.equal(state.unprocessed, 4);
  assert.equal(state.failedCount, 0);
  await f.c.BookmarkEnrich.scan({ mode: 'capture' });
  await drain(f);
  state = await f.c.BookmarkEnrich.status();
  assert.equal(state.capturedPages, 4);
  assert.equal(state.successful, 0);
  assert.equal(state.failedCount, 0);
});

test('增量扫描跳过新鲜结果，缺失和过期正文入队，私人失败不自动授权', async () => {
  const f = setup(3);
  await f.c.BookmarkEnrich.scan();
  await drain(f);
  await f.c.AgentDB.setMeta('enrich:pending', []);
  const url = f.node('10').url;
  await f.c.AgentDB.putPage({ url, status: 'ok', source: 'public', text: '过期正文', fetchedAt: 1, version: f.c.ContentIndex.VERSION });
  await f.c.AgentDB.putPage({ url: f.node('11').url, status: 'ok', source: 'capture', private: true, text: '私人正文', fetchedAt: Date.now() });
  await f.c.BookmarkEnrich.onCaptured('11', f.node('11'));
  assert.equal((await f.c.BookmarkEnrich.scan({ incremental: true, ai: {} })).queued, 1);
  assert.equal((await f.c.AgentDB.getMeta('enrich:queue'))[0].id, '10');
  assert.equal((await f.c.BookmarkEnrich.scan({ retryFailed: true })).queued, 0);
});

test('执行中修改网址，新任务保留且旧结果不写入新网址', async () => {
  const f = setup(1);
  const capture = f.c.PageInfo.getMany;
  let changed = false;
  f.c.PageInfo.getMany = async urls => {
    if (!changed) {
      changed = true;
      const node = f.node('10');
      node.url = 'https://replacement.test/new';
      await f.c.BookmarkEnrich.onCreated('10', node);
    }
    return capture(urls);
  };
  await f.c.BookmarkEnrich.scan();
  await drain(f);
  const done = await f.c.AgentDB.getMeta('enrich:done');
  const pending = await f.c.AgentDB.getMeta('enrich:pending');
  assert.equal(done['10'].url, 'https://replacement.test/new');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].url, 'https://replacement.test/new');
});
