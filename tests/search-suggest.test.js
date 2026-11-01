/* 搜索联想：接口解析、纯逻辑（打分/高亮）与状态机（防抖/竞态/失败）的回归测试。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

function context(extra = {}) {
  const c = { URL, setTimeout, clearTimeout, TextDecoder, console, ...extra };
  c.self = c;
  vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(root, 'js/search-suggest.js'), 'utf8'), c);
  return c;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('高亮切段覆盖原文，命中处逐段返回，正则元字符按字面处理', () => {
  const c = context();
  const text = '苏州天气 <预报>';

  const parts = c.SearchSuggest.segments(text, '苏州');
  assert.equal(parts.map((p) => p.text).join(''), text);
  assert.equal(parts.filter((p) => p.hit).map((p) => p.text).join('|'), '苏州');

  assert.equal(c.SearchSuggest.segments('abc', '').length, 1);
  assert.equal(c.SearchSuggest.segments('a.c', 'a.c').length, 1);
  assert.equal(c.SearchSuggest.segments('a.c', 'a.c')[0].hit, true);
  assert.equal(c.SearchSuggest.segments('abc', 'a.c').length, 1);
});

test('打分：相等 > 前缀 > 包含；多词查询必须全部命中', () => {
  const s = context().SearchSuggest.score;
  assert.ok(s('苏州', '苏州') > s('苏州天气预报', '苏州'));
  assert.ok(s('苏州天气预报', '苏州') > s('今日苏州天气', '苏州'));
  assert.equal(s('杭州天气', '苏州'), 0);
  assert.ok(s('YS 应收凭证', 'ys 应收') > 0);
  assert.equal(s('YS 应收凭证', 'ys 库存'), 0);
});

test('解析各引擎联想响应：Bing/Google 的 OpenSearch、百度 sugrec、搜狗 JS 壳', () => {
  const c = context();

  assert.equal(
    c.SearchSuggest.parse('bing', '["苏州",["苏州天气","苏州大学","苏州天气"]]').join('|'),
    '苏州天气|苏州大学'
  );
  assert.equal(
    c.SearchSuggest.parse('google', '["苏州",["苏州旅游","苏州天气"]]').join('|'),
    '苏州旅游|苏州天气'
  );
  assert.equal(
    c.SearchSuggest.parse('baidu', '{"q":"苏州","g":[{"q":"苏州天气"},{"q":"苏州旅游"},{"x":1}]}').join('|'),
    '苏州天气|苏州旅游'
  );
  assert.equal(
    c.SearchSuggest.parse('sogou', 'window.sogou.sug(["苏州",["苏州天气","苏州大学"],["0;15"],[""]]);').join('|'),
    '苏州天气|苏州大学'
  );

  assert.equal(c.SearchSuggest.parse('bing', '不是 JSON').length, 0);
  assert.equal(c.SearchSuggest.parse('sogou', '').length, 0);
  assert.equal(c.SearchSuggest.parse('bing', '{"unexpected":1}').length, 0);
});

test('请求联想词：按引擎拼地址、去重并只取前 8 条', async () => {
  const c = context();
  const calls = [];
  const fakeFetch = (url) => {
    calls.push(url);
    return Promise.resolve({ ok: true, text: async () => JSON.stringify(['苏州 天气', [
      '苏州天气', '苏州天气预报', '苏州天气15天', '苏州天气2345', '苏州天气网',
      '苏州天气穿衣', '苏州天气台风', '苏州天气预警', '苏州天气指数', '苏州天气查询'
    ]]) });
  };

  const out = await c.SearchSuggest.request({ engine: 'bing', query: '苏州 天气', fetch: fakeFetch });
  assert.equal(out.length, 8);
  assert.equal(out[0], '苏州天气');
  assert.match(calls[0], /^https:\/\/api\.bing\.com\/osjson\.aspx\?query=%E8%8B%8F%E5%B7%9E%20%E5%A4%A9%E6%B0%94/);

  await c.SearchSuggest.request({ engine: 'baidu', query: '苏州', fetch: fakeFetch });
  assert.match(calls[1], /^https:\/\/www\.baidu\.com\/sugrec\?prod=pc&wd=%E8%8B%8F%E5%B7%9E$/);
});

test('请求失败（非 2xx 或网络异常）统一 reject，交给上层降级', async () => {
  const c = context();
  await assert.rejects(
    c.SearchSuggest.request({ engine: 'bing', query: 'x', fetch: () => Promise.resolve({ ok: false, status: 502 }) }),
    /http_502/
  );
  await assert.rejects(
    c.SearchSuggest.request({ engine: 'bing', query: 'x', fetch: () => Promise.reject(new Error('offline')) }),
    /offline/
  );
});

test('多来源合并：按来源权重与名次排序，相同建议词只留一条', () => {
  const c = context();
  const out = c.SearchSuggest.merge([
    { id: 'recent', items: [{ kind: 'query', text: '苏州', source: 'recent', score: 90 }] },
    { id: 'web', items: [
      { kind: 'query', text: '苏州天气', source: 'web', score: 80 },
      { kind: 'query', text: '苏州天气', source: 'web', score: 70 }
    ] }
  ], 8);

  assert.equal(out.length, 2);
  assert.equal(out[0].text, '苏州');
  assert.equal(out[1].text, '苏州天气');
});

test('空查询按时间倒序给最近搜索，新记录排在最前', () => {
  const c = context();
  const entries = [
    { text: '旧词', hits: 1, ts: Date.now() - 40 * 864e5 },
    { text: '新词', hits: 1, ts: Date.now() },
    { text: '常用词', hits: 6, ts: Date.now() - 2 * 864e5 }
  ];

  const out = c.SearchSuggest.fromRecent(entries, '', 5);
  assert.equal(out.map((x) => x.text).join('|'), '新词|常用词|旧词');
  assert.equal(c.SearchSuggest.fromRecent(entries, '词', 2).length, 2);
});

test('输入防抖：只有最后一次输入真正发起查询，状态从 loading 到 ready', async () => {
  const c = context();
  const calls = [];
  const states = [];

  const session = c.SearchSuggest.createSession({
    delay: 20,
    onState: (state) => states.push(state.status + ':' + state.query),
    providers: [{
      id: 'web',
      run: (q) => {
        calls.push(q);
        return [{ kind: 'query', text: q + ' 结果', source: 'web', score: 50 }];
      }
    }]
  });

  session.update('苏');
  session.update('苏州');
  session.update('苏州天');
  await wait(80);

  assert.deepEqual(calls, ['苏州天']);
  assert.equal(states[0], 'loading:苏');
  assert.equal(states[states.length - 1], 'ready:苏州天');
  assert.equal(session.state.items[0].text, '苏州天 结果');
});

test('慢响应不会覆盖更新的输入', async () => {
  const c = context();
  const session = c.SearchSuggest.createSession({
    delay: 0,
    providers: [{
      id: 'web',
      run: (q) => new Promise((resolve) => setTimeout(() => resolve([
        { kind: 'query', text: q, source: 'web', score: 10 }
      ]), q === '旧' ? 40 : 5))
    }]
  });

  session.update('旧');
  await wait(10);          // 旧查询已经进入异步阶段
  session.update('新');
  await wait(120);         // 给慢响应足够时间返回

  assert.equal(session.state.query, '新');
  assert.equal(session.state.items[0].text, '新');
});

test('同一查询命中缓存，换引擎（invalidate）后重新请求', async () => {
  const c = context();
  let calls = 0;
  const session = c.SearchSuggest.createSession({
    delay: 0,
    providers: [{ id: 'web', run: () => { calls++; return []; } }]
  });

  session.update('缓存');
  await wait(20);
  assert.equal(session.state.status, 'empty');

  session.update('缓存');
  await wait(20);
  assert.equal(calls, 1);

  session.invalidate();       // 切换搜索引擎
  session.update('缓存');
  await wait(20);
  assert.equal(calls, 2);
});

test('没有建议词时是 empty；接口全部失败是 error，且失败结果不进缓存', async () => {
  const c = context();
  const ok = c.SearchSuggest.createSession({ delay: 0, providers: [{ id: 'web', run: () => [] }] });
  ok.update('无结果');
  await wait(20);
  assert.equal(ok.state.status, 'empty');
  assert.equal(ok.state.partial, false);

  let attempts = 0;
  const bad = c.SearchSuggest.createSession({
    delay: 0,
    providers: [{ id: 'web', run: () => { attempts++; throw new Error('offline'); } }]
  });
  bad.update('断网');
  await wait(20);
  assert.equal(bad.state.status, 'error');
  bad.update('断网');
  await wait(20);
  assert.equal(attempts, 2);       // 错误不缓存，网络恢复后还能重试

  const mixed = c.SearchSuggest.createSession({
    delay: 0,
    providers: [
      { id: 'web', run: () => [] },
      { id: 'recent', run: () => { throw new Error('local'); } }
    ]
  });
  mixed.update('部分失败');
  await wait(20);
  assert.equal(mixed.state.status, 'empty');
  assert.equal(mixed.state.partial, true);
});

test('收起面板会作废在途请求，之后不再回调 UI', async () => {
  const c = context();
  let rendered = 0;
  const session = c.SearchSuggest.createSession({
    delay: 0,
    onState: () => { rendered++; },
    providers: [{
      id: 'web',
      run: () => new Promise((resolve) => setTimeout(() => resolve([
        { kind: 'query', text: 'x', source: 'web', score: 40 }
      ]), 30))
    }]
  });

  session.update('x');
  session.cancel();
  await wait(80);

  assert.equal(rendered, 1);        // 只有同步的 loading
  assert.equal(session.state.status, 'idle');
});

test('最近搜索：去重累加、URL 不入库、上限截断、可持久化', () => {
  const c = context();
  const mem = {};
  const storage = {
    getItem: (key) => (key in mem ? mem[key] : null),
    setItem: (key, value) => { mem[key] = value; }
  };

  const recent = c.SearchSuggest.createRecent(storage, 'k', 3);
  recent.record('苏州');
  recent.record('杭州');
  recent.record('苏州');
  recent.record('https://example.com');
  recent.record('   ');

  const list = recent.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].text, '苏州');
  assert.equal(list[0].hits, 2);

  recent.record('a');
  recent.record('b');
  assert.equal(recent.list().length, 3);

  const reloaded = c.SearchSuggest.createRecent(storage, 'k', 3);
  assert.equal(reloaded.list()[0].text, 'b');
  assert.equal(reloaded.list().length, 3);
});

test('最近搜索：单条删除忽略大小写并立即持久化，删不存在的词无副作用', () => {
  const c = context();
  const mem = {};
  const storage = {
    getItem: (key) => (key in mem ? mem[key] : null),
    setItem: (key, value) => { mem[key] = value; }
  };

  const recent = c.SearchSuggest.createRecent(storage, 'k', 5);
  recent.record('GitHub');
  recent.record('苏州');

  assert.deepEqual(Array.from(recent.remove('github'), (e) => e.text), ['苏州']);
  assert.deepEqual(JSON.parse(mem.k).map((e) => e.text), ['苏州']);

  assert.deepEqual(Array.from(recent.remove('不存在'), (e) => e.text), ['苏州']);
  assert.equal(c.SearchSuggest.createRecent(storage, 'k', 5).list().length, 1);
});
