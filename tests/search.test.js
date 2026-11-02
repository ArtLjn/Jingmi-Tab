/* 使用独立沙箱与真实 IndexedDB 兼容实现验证跨页面内容检索。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { IDBFactory } = require('fake-indexeddb');
const { DOMParser } = require('linkedom');
const root = path.resolve(__dirname, '..');
function context(indexedDB = new IDBFactory(), extra = {}) {
  const c = { URL, AbortController, TextDecoder, Response, DOMParser, indexedDB, setTimeout, clearTimeout, ...extra };
  c.self = c;
  vm.createContext(c);
  for (const name of ['db', 'bookmarks', 'content-index', 'pageinfo', 'ai', 'bookmark-answer', 'bookmark-search']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'js', name + '.js'), 'utf8'), c);
  }
  return c;
}
function rows(c) {
  return c.Bookmarks.flatten([{ children: [{ id: '1', title: '项目文档', url: 'https://example.com/a' }] }]);
}
const html = '<html><head><title>项目文档</title><meta name="description" content="财务接口介绍"></head><body><nav>无关导航</nav><article><h1>系统对接</h1><p>应收凭证支持按订单同步。</p><script>危险脚本</script><form>私密输入</form><div hidden>隐藏内容</div></article></body></html>';

test('采集正文，排除脚本、表单和隐藏内容', () => {
  const c = context();
  const result = c.PageInfo.extract(html);
  assert.match(result.text, /应收凭证/);
  assert.doesNotMatch(result.text, /危险|私密|隐藏|无关导航/);
  assert.equal(result.desc, '财务接口介绍');
});

test('内容在新页面重新加载及后台重建元数据后仍可搜索', async () => {
  const db = new IDBFactory();
  const c = context(db, { fetch: async () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
  const first = rows(c);
  assert.equal(c.Bookmarks.query(first, '应收凭证').length, 0);
  await c.PageInfo.getMany(first.map(r => r.url));
  await c.ContentIndex.hydrate(first);
  assert.equal(c.Bookmarks.query(first, '应收凭证').length, 1);
  const other = context(db);
  const reloaded = rows(other);
  await other.ContentIndex.hydrate(reloaded);
  await other.AgentDB.replaceAll(reloaded);
  assert.equal(other.Bookmarks.query(await other.AgentDB.getAll(), '应收凭证').length, 1);
  assert.match(other.Bookmarks.snippet(reloaded[0], '应收凭证'), /应收凭证/);
  const size = reloaded[0].hay.length;
  await other.ContentIndex.hydrate(reloaded);
  assert.equal(reloaded[0].hay.length, size);
});

test('正文命中不依赖最近收藏时间，时间加分不能产生无关结果', () => {
  const c = context();
  const data = rows(c);
  c.ContentIndex.apply(data, { 'https://example.com/a': { status: 'ok', text: '应收凭证接口', fetchedAt: 1 } });
  assert.equal(c.Bookmarks.query(data, '应收凭证').length, 1);
  data[0].added = Date.now();
  assert.equal(c.Bookmarks.query(data, '火星殖民').length, 0);
});

test('旧版摘要缓存会升级采集，成功缓存复用，失败缓存不反复请求', async () => {
  let calls = 0;
  const c = context(undefined, { fetch: async () => { calls++; return new Response(html); } });
  await c.AgentDB.putPage({ url: 'https://example.com/a', status: 'ok', desc: '旧摘要', fetchedAt: Date.now() });
  await c.PageInfo.getMany(['https://example.com/a']);
  await c.PageInfo.getMany(['https://example.com/a']);
  assert.equal(calls, 1);
  c.fetch = async () => { calls++; return new Response('', { status: 403 }); };
  await c.PageInfo.getMany(['https://example.com/b']);
  await c.PageInfo.getMany(['https://example.com/b']);
  assert.equal(calls, 2);
});

test('手动采集的登录内容不会被公开抓取覆盖，片段不同路由独立保存', async () => {
  let calls = 0;
  const c = context(undefined, { fetch: async () => { calls++; throw new Error('不可请求'); } });
  await c.AgentDB.putPage({ url: 'https://example.com/a#doc1', status: 'ok', source: 'capture', text: '内部文档' });
  const map = await c.PageInfo.getMany(['https://example.com/a#doc1']);
  assert.equal(calls, 0);
  assert.equal(map['https://example.com/a#doc1'].text, '内部文档');
  assert.notEqual(c.ContentIndex.normUrl('https://example.com/a#doc1'), c.ContentIndex.normUrl('https://example.com/a#doc2'));
});

test('更新失败保留旧内容，24 小时后可以重试', async () => {
  const c = context(undefined, { fetch: async () => new Response('', { status: 503 }) });
  await c.AgentDB.putPage({ url: 'https://example.com/a', status: 'ok', version: 3, text: '应收凭证', fetchedAt: 1 });
  const map = await c.PageInfo.getMany(['https://example.com/a']);
  const page = map['https://example.com/a'];
  assert.equal(page.text, '应收凭证');
  assert.equal(page.fetchedAt, 1);
  assert.equal(c.ContentIndex.fresh(page, page.checkedAt + 864e5 + 1), false);
});

test('公开采集去重、跳过特殊协议，后续请求复用缓存', async () => {
  let calls = 0;
  const c = context(undefined, { fetch: async () => { calls++; return new Response(html); } });
  const urls = ['https://example.com/a', 'https://example.com/a', 'chrome://settings'];
  const pages = await c.PageInfo.getMany(urls);
  assert.equal(Object.keys(pages).length, 1); assert.equal(calls, 1);
  await c.PageInfo.getMany(urls); assert.equal(calls, 1);
});

test('AI 零召回改写找到单条候选后仍继续筛选', async () => {
  const c = context();
  const data = rows(c);
  data[0].title = 'WMS 项目文档';
  data[0].hay = 'wms 项目文档 https://example.com/a';
  c.ContentIndex.apply(data, { 'https://example.com/a': { status: 'ok', text: '库存和 WMS 仓储管理' } });
  let reranks = 0;
  c.AI.available = () => true;
  c.AI.rewrite = async () => ({ ok: true, keywords: ['WMS'] });
  c.AI.rerank = async ({ hits }) => { reranks++; return { ok: true, picks: [{ id: hits[0].row.id, why: '正文匹配' }] }; };
  const result = await c.BookmarkSearch.run({ rows: data, query: '货物存放方案', cfg: { fetchDesc: false } });
  assert.equal(reranks, 1);
  assert.equal(result.hits[0].row.id, '1');
});

test('AI 改写或筛选异常时保留本地结果，过期查询不进入筛选', async () => {
  const c = context();
  c.AI.available = () => true;
  c.AI.rewrite = async () => { throw new Error('失败'); };
  c.AI.rerank = async () => { throw new Error('失败'); };
  const result = await c.BookmarkSearch.run({ rows: rows(c), query: '项目 文档', cfg: { fetchDesc: false } });
  assert.equal(result.hits.length, 1);
  assert.match(result.message, /本地排序/);
  let called = false;
  c.AI.rerank = async () => { called = true; };
  const stale = await c.BookmarkSearch.run({ rows: rows(c), query: '项目', cfg: {}, current: () => false });
  assert.equal(stale, null);
  assert.equal(called, false);
});

test('AI 缓存随候选和证据变化，非法格式降级而非误报无结果', async () => {
  let calls = 0;
  const c = context(undefined, { fetch: async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: '{"picks":[{"id":"1","why":"匹配"}]}' } }] })); } });
  const data = rows(c);
  const opts = { cfg: { enabled: true, apiKey: '测试凭证', baseUrl: 'https://api.example.com/v1', model: 'test' }, query: '项目', hits: [{ row: data[0] }] };
  await c.AI.rerank(opts);
  assert.equal((await c.AI.rerank(opts)).cached, true);
  data[0].text = '新增正文';
  await c.AI.rerank(opts);
  assert.equal(calls, 2);
  c.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '不是 JSON' } }] }));
  c.AI.clearCache();
  assert.equal((await c.AI.rerank(opts)).error, 'bad_response');
  assert.equal(c.AI.parsePicks('{"picks":[{"id":"999"}]}', [{ id: '1' }]).length, 0);
});


test('公开页面按声明字符集读取，中文旧站点不会变成乱码', async () => {
  const bytes = Buffer.concat([Buffer.from('<html><head><title>GBK</title></head><body><article>'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('</article></body></html>')]);
  const c = context(undefined, { fetch: async () => new Response(bytes, { headers: { 'content-type': 'text/html; charset=gbk' } }) });
  const page = await c.PageInfo.fetchOne('https://example.com/gbk');
  assert.equal(page.status, 'ok');
  assert.equal(page.text, '中文');
});


test('动态页面占位内容不当作正文，登录实现教程仍可正常采集', async () => {
  const c = context(undefined, { fetch: async () => new Response('<html><body><main>Loading...</main></body></html>', { headers: { 'content-type': 'text/html' } }) });
  assert.equal((await c.PageInfo.fetchOne('https://example.com/app')).reason, 'dynamic_shell');
  c.fetch = async () => new Response('<html><head><title>登录鉴权实现教程</title></head><body><article><p>会话鉴权和接口实现步骤。</p></article></body></html>', { headers: { 'content-type': 'text/html' } });
  assert.equal((await c.PageInfo.fetchOne('https://example.com/login-guide')).status, 'ok');
});

test('IP 查询按完整主机精确匹配，跳过模型改写与重排', async () => {
  const c = context();
  const data = c.Bookmarks.flatten([{ children: [
    { id: '1', title: 'A19 财务', url: 'http://8.145.50.4:8000/login' },
    { id: '2', title: '接口说明', url: 'https://example.com/doc' }
  ] }]);
  c.ContentIndex.apply(data, { 'https://example.com/doc': { status: 'ok', text: '8.5 修改合约 abi 接口说明', fetchedAt: 1 } });
  let aiCalls = 0;
  c.AI.available = () => { aiCalls++; return true; };
  c.AI.rewrite = async () => { aiCalls++; return { ok: true, keywords: [] }; };
  c.AI.rerank = async () => { aiCalls++; return { ok: true, picks: [] }; };

  assert.equal(data.find(row => row.id === '1').site, '8.145.50.4');
  const hits = c.Bookmarks.query(data, '8.145.50.4');
  assert.equal(hits[0].row.id, '1');

  const result = await c.BookmarkSearch.run({ rows: data, query: '8.145.50.4', cfg: {} });
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].row.id, '1');
  assert.match(result.message, /地址精确匹配/);
  assert.equal(aiCalls, 0);
});

test('关键词检索只调用一次重排，不生成回答', async () => {
  const c = context();
  const data = c.Bookmarks.flatten([{ children: [
    { id: '1', title: 'A19 财务接口地址', url: 'https://example.com/a19' },
    { id: '2', title: '部署说明', url: 'https://example.com/deploy' }
  ] }]);
  data[0].text = 'A19 财务系统接口地址是 https://8.145.50.4:8000/api，调用方式为 POST。';
  data[0].desc = 'A19 对接说明';
  c.AI.available = () => true;
  c.AI.rewrite = async () => ({ ok: true, keywords: ['接口'] });
  let calls = 0;
  c.AI.rerank = async () => { calls++; return { ok: true, picks: [{ id: '1', why: '接口地址' }, { id: '999', why: '伪造' }] }; };
  const result = await c.BookmarkSearch.run({ rows: data, query: 'A19 接口地址', cfg: {} });
  assert.equal(calls, 1);
  assert.equal(result.answer, undefined);
  assert.equal(result.hits[0].row.id, '1');
  assert.match(result.hits[0].why, /接口地址/);
  assert.equal(result.hits[0].row.id, '1');
  assert.match(result.message, /找到 1 条/);
});

test('问句走 SSE 流式回答，按 [n] 标记还原来源', async () => {
  const c = context();
  const data = c.Bookmarks.flatten([{ children: [
    { id: '1', title: 'A19 财务接口地址', url: 'https://example.com/a19' }
  ] }]);
  data[0].text = 'A19 财务系统接口地址是 https://8.145.50.4:8000/api。';
  c.AI.available = () => true;
  c.AI.rewrite = async () => ({ ok: true, keywords: [] });
  let chats = 0;
  c.AI.chat = async () => { chats++; return { ok: true, content: '{}' }; };
  c.AI.chatStream = async (cfg, system, user, opts) => {
    opts.onDelta('接口地址是 ', '接口地址是 ');
    opts.onDelta('https://8.145.50.4:8000/api [1]', '接口地址是 https://8.145.50.4:8000/api [1]');
    return { ok: true, content: '接口地址是 https://8.145.50.4:8000/api [1]', streamed: true };
  };
  const deltas = [];
  const result = await c.BookmarkSearch.run({
    rows: data, query: 'A19 的接口地址是什么', cfg: {},
    onAnswer: partial => deltas.push(partial)
  });
  assert.equal(chats, 0);
  assert.equal(deltas[0].streaming, true);
  assert.match(result.answer.text, /8\.145\.50\.4/);
  assert.equal(result.answer.sources.length, 1);
  assert.equal(result.answer.sources[0].marker, 1);
  assert.equal(result.answer.sources[0].url, 'https://example.com/a19');
});

test('六条合法引用全部显示在来源列表中', async () => {
  const c = context();
  c.AI.available = () => true;
  c.AI.chatStream = async () => ({ ok: true, content: '依据资料 [1][2][3][4][5][6]' });
  const cands = Array.from({ length: 6 }, (_, index) => ({
    row: { id: String(index + 1), title: '资料 ' + (index + 1), url: 'https://example.com/' + (index + 1), text: '可用正文证据' }
  }));
  const result = await c.BookmarkAnswer.runStream({ cfg: {}, query: '资料有哪些', cands });
  assert.equal(result.sources.length, 6);
  assert.deepEqual(Array.from(result.sources, source => source.marker), [1, 2, 3, 4, 5, 6]);
});

test('SSE 流式解析：逐段回调并在结束时给出完整文本', async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"content":"接口"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"地址是 8.145.50.4"}}]}\n\n',
    'data: [DONE]\n\n'
  ];
  const stream = new ReadableStream({
    start(controller) {
      chunks.forEach(chunk => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    }
  });
  const c = context(undefined, {
    fetch: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  });
  const deltas = [];
  const result = await c.AI.chatStream(
    { enabled: true, baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' },
    'system', 'user', { onDelta: delta => deltas.push(delta) }
  );
  assert.equal(result.ok, true);
  assert.equal(result.content, '接口地址是 8.145.50.4');
  assert.deepEqual(deltas, ['接口', '地址是 8.145.50.4']);
});

test('SSE 最后一段没有换行时仍输出回答', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"最后一段"}}]}'));
    controller.close();
  } });
  const c = context(undefined, { fetch: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }) });
  const result = await c.AI.chatStream({ enabled: true, baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' }, '系统', '问题');
  assert.equal(result.content, '最后一段');
});

test('模型改写失败时用本地类别词兜底召回站点', async () => {
  const c = context();
  const data = c.Bookmarks.flatten([{ children: [
    { id: '1', title: '淘宝', url: 'https://taobao.com/' },
    { id: '2', title: '京东', url: 'https://jd.com/' },
    { id: '3', title: '无关文档', url: 'https://example.com/doc' }
  ] }]);
  c.AI.available = () => true;
  c.AI.rewrite = async () => ({ ok: false });
  c.AI.rerank = async () => ({ ok: true, picks: [{ id: '1', why: '本地类别词命中' }] });
  const result = await c.BookmarkSearch.run({ rows: data, query: '电商网站', cfg: {} });
  assert.ok(result.candidates.some(hit => hit.row.title === '淘宝'));
  assert.equal(result.hits[0].row.id, '1');
});

test('改写返回纯文本时兜底提取关键词', async () => {
  const c = context(undefined, {
    fetch: async () => new Response(JSON.stringify({
      choices: [{ message: { content: '电商、购物、淘宝、京东' } }]
    }), { headers: { 'content-type': 'application/json' } })
  });
  const result = await c.AI.rewrite({
    cfg: { enabled: true, apiKey: 'k', baseUrl: 'https://api.test/v1', model: 'm' },
    query: '电商网站'
  });
  assert.equal(result.ok, true);
  assert.ok(result.keywords.indexOf('淘宝') !== -1);
});

test('模型输出夹带说明或示例时仍能取出第一个完整 JSON', () => {
  const c = context();
  const parsed = c.AI.parseLoose('先说明一下 {"picks":[{"id":"1","why":"匹配"}]} 后面是示例 {"picks":[]}');
  assert.equal(parsed.picks.length, 1);
  assert.equal(parsed.picks[0].id, '1');
  assert.equal(parsed.picks[0].why, '匹配');
});

test('问句即使本地有候选也会改写，避免只命中字面词', async () => {
  const c = context();
  const data = c.Bookmarks.flatten([{ children: [
    { id: '1', title: '某网站一', url: 'https://example.com/1' },
    { id: '2', title: '某网站二', url: 'https://example.com/2' },
    { id: '3', title: '某网站三', url: 'https://example.com/3' }
  ] }]);
  c.AI.available = () => true;
  let rewrites = 0;
  c.AI.rewrite = async () => { rewrites++; return { ok: true, keywords: ['淘宝', '京东'] }; };
  c.AI.chat = async () => ({ ok: true, content: '{"enough":false,"picks":[]}' });
  c.AI.rerank = async () => ({ ok: true, picks: [] });
  await c.BookmarkSearch.run({ rows: data, query: '我之前用的电商网站有哪些', cfg: {} });
  assert.equal(rewrites, 1);
});

test('关键词查询只做一次重排', async () => {
  const c = context();
  const data = c.Bookmarks.flatten([{ children: [
    { id: '1', title: '项目文档', url: 'https://example.com/a' },
    { id: '2', title: '部署说明', url: 'https://example.com/b' }
  ] }]);
  data[0].text = '项目文档的验收标准';
  c.AI.available = () => true;
  c.AI.rewrite = async () => ({ ok: true, keywords: [] });
  let reranks = 0;
  c.AI.rerank = async () => { reranks++; return { ok: true, picks: [{ id: '1', why: '标题命中' }] }; };
  const result = await c.BookmarkSearch.run({ rows: data, query: '项目 文档', cfg: {} });
  assert.equal(reranks, 1);
  assert.equal(result.hits[0].row.id, '1');
});

test('关键词查询不生成答案，只展示模型挑选的来源', async () => {
  const c = context();
  const data = c.Bookmarks.flatten([{ children: [
    { id: '1', title: '虹迪财务', url: 'https://example.com/1' },
    { id: '2', title: '虹迪业务', url: 'https://example.com/2' },
    { id: '3', title: '虹迪项目', url: 'https://example.com/3' }
  ] }]);
  data.forEach(row => { row.text = '虹迪系统说明'; });
  c.AI.available = () => true;
  c.AI.rerank = async () => ({ ok: true, picks: [{ id: '2', why: '业务系统' }] });
  const result = await c.BookmarkSearch.run({ rows: data, query: '虹迪', cfg: {} });
  assert.equal(result.answer, undefined);
  assert.equal(result.hits[0].row.id, '2');
  assert.match(result.message, /找到 3 条/);
});

test('没有正文证据时退回书签重排，不生成答案', async () => {
  const c = context();
  const data = c.Bookmarks.flatten([{ children: [{ id: '1', title: '项目文档', url: 'https://example.com/a' }] }]);
  c.AI.available = () => true;
  let chats = 0; let reranks = 0;
  c.AI.rewrite = async () => ({ ok: false });
  c.AI.chat = async () => { chats++; return { ok: true, content: '{}' }; };
  c.AI.rerank = async () => { reranks++; return { ok: true, picks: [{ id: '1', why: '标题匹配' }] }; };
  const result = await c.BookmarkSearch.run({ rows: data, query: '项目 文档', cfg: {} });
  assert.equal(chats, 0);
  assert.equal(reranks, 1);
  assert.equal(result.answer, undefined);
});

test('问句把本地编号命中优先交给 AI，并由 AI 回答用途', async () => {
  const c = context();
  const data = c.Bookmarks.flatten([{ children: [
    { id: '7', title: '007虹迪', url: 'http://124.221.8.180/' },
    { id: '8', title: '在线短信', url: 'https://hero-sms.com/' }
  ] }]);
  data[0].text = '虹迪股份业务系统，用于内部业务管理。';
  c.AI.available = () => true;
  c.AI.rewrite = async () => ({ ok: true, keywords: ['007'] });
  let prompt = '';
  let modelCalls = 0;
  c.AI.chatStream = async (cfg, system, user) => {
    modelCalls++;
    prompt = user;
    return { ok: true, content: '007虹迪是虹迪股份的业务系统，用于内部业务管理。[1]' };
  };
  const result = await c.BookmarkSearch.run({ rows: data, query: '007是哪个网站，是做什么的', cfg: {} });
  assert.equal(modelCalls, 1);
  assert.match(prompt, /007虹迪/);
  assert.match(prompt, /124\.221\.8\.180/);
  assert.match(prompt, /用于内部业务管理/);
  assert.match(result.answer.text, /内部业务管理/);
  assert.equal(result.answer.sources.length, 1);
  assert.equal(result.answer.sources[0].url, 'http://124.221.8.180/');
  assert.equal(result.hits[0].row.id, '7');
});

test('口语“啥网站”直接用本地证据回答，不等待 RAG 或改写', async () => {
  const c = context();
  const data = c.Bookmarks.flatten([{ children: [{ id: '7', title: '007虹迪', url: 'http://124.221.8.180/' }] }]);
  data[0].text = '虹迪股份业务系统，用于内部业务管理。';
  c.AI.available = () => true;
  c.AI.rewrite = async () => { throw new Error('不应改写'); };
  c.AI.chatStream = async () => ({ ok: true, content: '这是虹迪股份业务系统。[1]' });
  const result = await c.BookmarkSearch.run({ rows: data, query: '007是啥网站', cfg: {} });
  assert.match(result.answer.text, /虹迪股份/);
  assert.equal(result.answer.sources[0].id, '7');
});

test('问答使用强模型，改写使用快模型，未配置时回退主模型', async () => {
  const used = [];
  const c = context(undefined, { fetch: async (url, init) => {
    used.push(JSON.parse(init.body).model);
    return new Response(JSON.stringify({ choices: [{ message: { content: used.length === 1 ? '{"k":["接口"]}' : '接口说明。[1]' } }] }),
      { headers: { 'content-type': 'application/json' } });
  } });
  const cfg = { enabled: true, apiKey: 'k', baseUrl: 'https://api.test/v1', model: 'default', fastModel: 'fast', strongModel: 'strong' };
  await c.AI.rewrite({ cfg, query: '接口说明' });
  await c.BookmarkAnswer.runStream({ cfg, query: '接口是什么', cands: [{ row: { id: '1', title: '接口', text: '接口说明', url: 'https://example.com' } }] });
  assert.deepEqual(used, ['fast', 'strong']);
});

test('相同重排请求合并为一次模型调用', async () => {
  let calls = 0;
  const c = context(undefined, { fetch: async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"picks":[{"id":"1","why":"匹配"}]}' } }] }),
      { headers: { 'content-type': 'application/json' } });
  } });
  const cfg = { enabled: true, apiKey: 'k', baseUrl: 'https://api.test/v1', model: 'm' };
  const hits = [{ row: { id: '1', title: '项目文档', url: 'https://example.com/a' } }];
  await Promise.all([c.AI.rerank({ cfg, query: '项目', hits }), c.AI.rerank({ cfg, query: '项目', hits })]);
  assert.equal(calls, 1);
});

test('问答接口误返重排 JSON 时降级，不把 JSON 展示成回答', async () => {
  const c = context();
  c.AI.available = () => true;
  c.AI.chatStream = async () => ({ ok: true, content: '{"picks":[{"id":"1"}]}' });
  const result = await c.BookmarkAnswer.runStream({ cfg: {}, query: '这是什么',
    cands: [{ row: { id: '1', title: '资料', text: '资料正文' } }] });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'bad_response');
});

test('标题命中仍交给模型重排，本地候选充足时只跳过改写', async () => {
  const c = context();
  const data = c.Bookmarks.flatten([{ children: [
    { id: '1', title: '项目文档', url: 'https://example.com/a' },
    { id: '2', title: '项目文档二', url: 'https://example.com/b' },
    { id: '3', title: '项目计划', url: 'https://example.com/c' }
  ] }]);
  let rewrites = 0; let reranks = 0;
  c.AI.available = () => true;
  c.AI.rewrite = async () => { rewrites++; return { ok: true, keywords: ['项目'] }; };
  c.AI.rerank = async () => { reranks++; return { ok: true, picks: [{ id: '1', why: '标题匹配' }] }; };
  const result = await c.BookmarkSearch.run({ rows: data, query: '项目', cfg: {} });
  assert.equal(rewrites, 0);
  assert.equal(reranks, 1);
  assert.equal(result.hits[0].row.id, '1');
  assert.equal(c.AI.toCandidate(data[0], Date.now(), '项目').host, 'example.com');
});

test('网络瞬断和超时最多重试一次，权限拒绝不重试', async () => {
  for (const name of ['AbortError', 'TypeError']) {
    let calls = 0;
    const c = context(undefined, { fetch: async (url, options) => {
      assert.equal(options.credentials, 'omit');
      if (++calls === 1) { const error = new Error('临时故障'); error.name = name; throw error; }
      return new Response(html, { headers: { 'content-type': 'text/html' } });
    } });
    assert.equal((await c.PageInfo.fetchOne('https://example.com')).status, 'ok');
    assert.equal(calls, 2);
    c.fetch = async () => { calls++; return new Response('', { status: 403 }); };
    assert.equal((await c.PageInfo.fetchOne('https://example.com')).reason, 'http_403');
    assert.equal(calls, 3);
  }
});

test('正文流中断保留已收到的描述和正文，并缩短缓存时间', async () => {
  const c = context(undefined, { fetch: async () => ({
    ok: true, headers: new Headers({ 'content-type': 'text/html' }),
    body: { getReader() { let first = true; return {
      async read() { if (first) { first = false; return { value: new TextEncoder().encode(html), done: false }; } throw new Error('连接中断'); },
      cancel: async () => {}
    }; } }
  }) });
  const page = await c.PageInfo.fetchOne('https://example.com');
  assert.equal(page.status, 'ok');
  assert.equal(page.partial, true);
  assert.match(page.text, /应收凭证/);
  assert.equal(c.ContentIndex.fresh(page, page.fetchedAt + 3600e3 + 1), false);
});

test('稀疏页面使用结构化描述，兼容后台和 DOM 解析，不执行脚本', async () => {
  const sparse = '<html><head><title>图库</title><script type="application/ld+json">{"@graph":[{"description":"提供自然风光摄影作品与高清图片下载。"}]}</script></head><body><main>Loading...</main></body></html>';
  for (const DOM of [DOMParser, undefined]) {
    const c = context(undefined, { DOMParser: DOM, fetch: async () => new Response(sparse, { headers: { 'content-type': 'text/html' } }) });
    const page = await c.PageInfo.fetchOne('https://example.com');
    assert.equal(page.status, 'ok');
    assert.equal(page.text, '');
    assert.equal(page.coverage, 'metadata');
    assert.match(page.desc, /自然风光/);
  }
});

test('浏览器不支持提示和无描述空壳不进入摘要，元数据仍可兜底', async () => {
  const c = context();
  for (const body of ['当前浏览器不受支持，请更新浏览器。', 'Your browser is not supported. Please update.', '']) {
    c.fetch = async () => new Response('<html><head><title>控制台</title></head><body><main>' + body + '</main></body></html>', { headers: { 'content-type': 'text/html' } });
    assert.equal((await c.PageInfo.fetchOne('https://example.com')).status, 'fail');
  }
  c.fetch = async () => new Response('<html><head><meta property="og:description" content="管理设备与网络连接的控制台"></head><body>Loading...</body></html>', { headers: { 'content-type': 'text/html' } });
  const page = await c.PageInfo.fetchOne('https://example.com');
  assert.equal(page.status, 'ok');
  assert.equal(page.text, '');
});

test('临时故障五分钟后可重新采集，手动采集长期保留', () => {
  const c = context();
  const page = { status: 'fail', reason: 'timeout', version: c.ContentIndex.VERSION, fetchedAt: Date.now() };
  assert.equal(c.ContentIndex.fresh(page, page.fetchedAt + 60000), true);
  assert.equal(c.ContentIndex.fresh(page, page.fetchedAt + 300001), false);
  assert.equal(c.ContentIndex.fresh({ ...page, status: 'ok', source: 'capture' }, page.fetchedAt + 864e8), true);
});

test('真实超时信号终止挂起请求，两次尝试后返回而不无限等待', async () => {
  let calls = 0;
  const budgets = [];
  const c = context(undefined, {
    setTimeout: (callback, delay) => { budgets.push(delay); return setTimeout(callback, 1); },
    fetch: async (url, options) => {
      calls++;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => { const error = new Error('超时'); error.name = 'AbortError'; reject(error); }, { once: true });
      });
    }
  });
  const page = await c.PageInfo.fetchOne('https://example.com');
  assert.equal(page.reason, 'timeout');
  assert.equal(calls, 2);
  assert.deepEqual(budgets, [5000, 8000]);
});
