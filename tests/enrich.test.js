/* 收藏补全：正文采集、标题/摘要建议、确认后改名。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./helpers/extension');
const root = path.resolve(__dirname, '..');

const HTML = '<html><head><title>A19 财务系统</title><meta name="description" content="应收凭证接口说明"></head><body><article><p>应收凭证支持按订单同步，接口地址见文档。</p></article></body></html>';
const CHAT = { choices: [{ message: { content: '{"title":"A19 财务对接 · 应收凭证","summary":"A19 财务系统应收凭证接口说明","tags":["财务","接口"]}' } }] };

function setup(aiEnabled = true) {
  const f = fixture({
    fetch: async url => {
      if (String(url).indexOf('api.test') !== -1) {
        return new Response(JSON.stringify(CHAT), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(HTML, { headers: { 'content-type': 'text/html' } });
    }
  });
  f.c.chrome.storage = {
    local: {
      get: (key, cb) => cb({ 'newtab.settings.v1': { ai: { enabled: aiEnabled, baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm', timeout: 5000 } } }),
      set: (value, cb) => cb && cb()
    }
  };
  vm.runInContext(fs.readFileSync(path.join(root, 'js/store.js'), 'utf8'), f.c);
  return f;
}

test('新收藏自动采正文并生成标题/摘要建议，应用后才改名', async () => {
  const f = setup();
  await f.c.BookmarkEnrich.onCreated('3', f.node('3'));
  await f.c.BookmarkEnrich.run();

  const state = await f.c.BookmarkEnrich.status();
  assert.equal(state.totalPending, 1);
  assert.match(state.pending[0].title, /A19/);
  assert.match(state.pending[0].summary, /应收凭证/);
  assert.deepEqual(state.pending[0].tags, ['财务', '接口']);
  assert.equal(f.node('3').title, '财务接口 A');

  const pages = await f.c.AgentDB.getPages(['https://example.com/a']);
  assert.equal(pages['https://example.com/a'].status, 'ok');
  assert.match(pages['https://example.com/a'].text, /应收凭证/);

  const rows = f.c.Bookmarks.flatten(f.tree);
  await f.c.BookmarkEnrich.applySummaries(rows);
  assert.match(rows.find(row => row.id === '3').hay, /应收凭证/);

  await f.c.BookmarkEnrich.apply('3');
  assert.match(f.node('3').title, /A19/);
  const tags = await f.c.AgentDB.getMeta('class:3');
  assert.deepEqual(tags.tags, ['财务', '接口']);
  assert.equal((await f.c.BookmarkEnrich.status()).undoable, true);

  await f.c.BookmarkEnrich.undoLast();
  assert.equal(f.node('3').title, '财务接口 A');
  assert.equal(await f.c.AgentDB.getMeta('class:3'), null);
  assert.equal((await f.c.BookmarkEnrich.status()).totalPending, 0);
});

test('没有 AI 配置时仍采集正文，不产生标题建议', async () => {
  const f = setup(false);
  const result = await f.c.BookmarkEnrich.scan({ mode: 'capture', limit: 5 });
  assert.equal(result.queued, 4);
  await f.c.BookmarkEnrich.run();

  const pages = await f.c.AgentDB.getPages(['https://example.com/a', 'https://example.com/b']);
  assert.equal(pages['https://example.com/a'].status, 'ok');
  assert.equal(pages['https://example.com/b'].status, 'ok');
  assert.equal((await f.c.BookmarkEnrich.status()).totalPending, 0);
});

test('补全扫描跳过已有建议的书签，忽略后不再重复出现', async () => {
  const f = setup();
  const first = await f.c.BookmarkEnrich.scan({ mode: 'enrich', limit: 1 });
  assert.equal(first.queued, 1);
  await f.c.BookmarkEnrich.run();
  assert.equal((await f.c.BookmarkEnrich.status()).totalPending, 1);

  const second = await f.c.BookmarkEnrich.scan({ mode: 'enrich', limit: 5 });
  assert.equal(second.queued, 3);

  const pending = (await f.c.BookmarkEnrich.status()).pending[0];
  await f.c.BookmarkEnrich.dismiss(pending.id);
  assert.equal((await f.c.BookmarkEnrich.status()).totalPending, 0);
});

test('AI 失败保留原因并允许重试，重试前不改名', async () => {
  const f = setup();
  f.c.fetch = async url => String(url).includes('api.test')
    ? new Response('', { status: 503 })
    : new Response(HTML, { headers: { 'content-type': 'text/html' } });
  await f.c.BookmarkEnrich.onCreated('3', f.node('3'));
  await f.c.BookmarkEnrich.run();
  let state = await f.c.BookmarkEnrich.status();
  assert.equal(state.totalPending, 0);
  assert.equal(state.totalFailed, 1);
  assert.match(state.failures[0].reason, /AI 请求失败/);
  assert.equal(f.node('3').title, '财务接口 A');

  f.c.fetch = async url => new Response(String(url).includes('api.test') ? JSON.stringify(CHAT) : HTML,
    { headers: { 'content-type': String(url).includes('api.test') ? 'application/json' : 'text/html' } });
  await f.c.BookmarkEnrich.retry('3');
  await f.c.BookmarkEnrich.run();
  state = await f.c.BookmarkEnrich.status();
  assert.equal(state.totalFailed, 0);
  assert.equal(state.totalPending, 1);
  assert.equal(f.node('3').title, '财务接口 A');
});

test('只有摘要时仍显示在最近生成记录，不产生改名建议', async () => {
  const f = setup();
  f.c.fetch = async url => new Response(String(url).includes('api.test')
    ? JSON.stringify({ choices: [{ message: { content: '{"title":"","summary":"应收凭证按订单同步","tags":[]}' } }] }) : HTML,
    { headers: { 'content-type': String(url).includes('api.test') ? 'application/json' : 'text/html' } });
  await f.c.BookmarkEnrich.onCreated('3', f.node('3'));
  await f.c.BookmarkEnrich.run();
  const state = await f.c.BookmarkEnrich.status();
  assert.equal(state.totalPending, 0);
  assert.match(state.recent[0].summary, /应收凭证/);
  assert.equal(f.node('3').title, '财务接口 A');
});

test('关键信息进入搜索索引，覆盖率按当前正文计算', async () => {
  const f = setup();
  f.c.fetch = async url => new Response(String(url).includes('api.test')
    ? JSON.stringify({ choices: [{ message: { content: '{"title":"A19 接口说明","summary":"应收凭证按订单同步","tags":["财务"],"facts":["接口 /api/v1/receipts"]}' } }] }) : HTML,
    { headers: { 'content-type': String(url).includes('api.test') ? 'application/json' : 'text/html' } });
  await f.c.BookmarkEnrich.onCreated('3', f.node('3'));
  await f.c.BookmarkEnrich.run();
  const state = await f.c.BookmarkEnrich.status();
  assert.equal(state.withBody, 1);
  assert.equal(state.missingBody, state.totalWeb - 1);
  const rows = f.c.Bookmarks.flatten(f.tree);
  await f.c.BookmarkEnrich.applySummaries(rows);
  assert.match(rows.find(row => row.id === '3').hay, /receipts/);
  assert.match(state.pending[0].facts[0], /receipts/);
});

test('前台 AI 请求期间补全队列让出模型连接', async () => {
  const f = setup();
  await f.c.BookmarkEnrich.onCreated('3', f.node('3'));
  await f.c.AgentDB.setMeta('ai:foreground', { seq: 1, until: Date.now() + 20000 });
  await f.c.BookmarkEnrich.run();
  assert.equal((await f.c.BookmarkEnrich.status()).queue, 1);
  await f.c.AgentDB.setMeta('ai:foreground', null);
  await f.c.BookmarkEnrich.run();
  assert.equal((await f.c.BookmarkEnrich.status()).totalPending, 1);
});

test('手动重试绕过临时失败缓存并重新采集', async () => {
  const f = setup();
  let pageCalls = 0;
  f.c.fetch = async url => {
    if (String(url).includes('api.test')) return new Response(JSON.stringify(CHAT), { headers: { 'content-type': 'application/json' } });
    pageCalls++;
    return pageCalls <= 2 ? new Response('', { status: 503 }) : new Response(HTML, { headers: { 'content-type': 'text/html' } });
  };
  await f.c.BookmarkEnrich.onCreated('3', f.node('3'));
  await f.c.BookmarkEnrich.run();
  assert.equal(pageCalls, 2);
  assert.equal((await f.c.BookmarkEnrich.status()).totalFailed, 1);
  await f.c.BookmarkEnrich.retry('3');
  await f.c.BookmarkEnrich.run();
  assert.equal(pageCalls, 3);
  assert.equal((await f.c.BookmarkEnrich.status()).totalPending, 1);
});

test('私人正文只在明确确认后发送给 AI', async () => {
  const f = setup();
  let modelCalls = 0;
  f.c.fetch = async url => {
    if (String(url).includes('api.test')) {
      modelCalls++;
      return new Response(JSON.stringify(CHAT), { headers: { 'content-type': 'application/json' } });
    }
    throw new Error('私人页面不应公开抓取');
  };
  await f.c.AgentDB.putPage({ url: 'https://example.com/a', status: 'ok', source: 'capture', private: true,
    text: '已登录页面正文', version: f.c.ContentIndex.VERSION, fetchedAt: Date.now() });
  await f.c.BookmarkEnrich.onCreated('3', f.node('3'));
  await f.c.BookmarkEnrich.run();
  assert.equal(modelCalls, 0);
  assert.equal((await f.c.BookmarkEnrich.status()).failures[0].code, 'private');
  await f.c.BookmarkEnrich.suggestPrivate('3');
  await f.c.BookmarkEnrich.run();
  assert.equal(modelCalls, 1);
  assert.equal((await f.c.BookmarkEnrich.status()).totalPending, 1);
});
