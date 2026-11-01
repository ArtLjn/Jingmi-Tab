/* 快捷标签纯函数层：地址归一、分组匹配、候选去噪与学习回写。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

function context() {
  const c = { URL, setTimeout, clearTimeout };
  c.self = c;
  vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(root, 'js', 'quick-tags.js'), 'utf8'), c);
  return c;
}

function seeded(tags) {
  const c = context();
  c.QuickTags._inject({ tags: tags || [] });
  return c;
}

test('地址归一：补协议、拒非 http、保留路径', () => {
  const c = context();
  assert.equal(c.QuickTags.normalizeUrl('oa.hongdi.com'), 'http://oa.hongdi.com/');
  assert.equal(c.QuickTags.normalizeUrl('https://x.com/a/b'), 'https://x.com/a/b');
  assert.equal(c.QuickTags.normalizeUrl('8.145.50.4:8000'), 'http://8.145.50.4:8000/');
  assert.equal(c.QuickTags.normalizeUrl('chrome://extensions'), '');
  assert.equal(c.QuickTags.normalizeUrl('随便写点什么'), '');
  assert.equal(c.QuickTags.normalizeUrl(''), '');
});

test('空查询按手写顺序，有查询时名称前缀优先于域名命中', () => {
  const c = seeded([
    { id: 'a', label: 'YS 应收', url: 'https://yonyou.com/a', pin: 0 },
    { id: 'b', label: 'GitHub', url: 'https://github.com', pin: 1 },
    { id: 'c', label: '看板', url: 'https://github.com/board', pin: 2 }
  ]);

  assert.deepEqual(Array.from(c.QuickTags.search('', {}).pinned, t => t.id), ['a', 'b', 'c']);

  const r = c.QuickTags.search('git', {});
  assert.deepEqual(Array.from(r.pinned, t => t.id), ['b', 'c'], '名称前缀应排在域名命中之前');

  assert.equal(c.QuickTags.search('yonyou', {}).pinned[0].id, 'a', '域名片段也能命中');
  assert.equal(c.QuickTags.search('zzz', {}).pinned.length, 0);
});

test('候选去噪：搜索引擎、登录中转、扩展页都不进池子', () => {
  const c = seeded([]);
  const now = Date.now();
  const rows = [
    { url: 'https://www.bing.com/search?q=abc', host: 'www.bing.com', title: 'bing', added: now },
    { url: 'https://oa.hongdi.com/', host: 'oa.hongdi.com', title: 'OA', added: now },
    { url: 'https://sso.example.com/login?goto=x', host: 'sso.example.com', title: '登录', added: now },
    { url: 'https://github.com/pulls?utm_source=x', host: 'github.com', title: 'GitHub', added: now }
  ];
  const hosts = Array.from(c.QuickTags.buildCandidates({ rows, topSites: [] }), x => x.host);
  assert.deepEqual(hosts, ['oa.hongdi.com']);
});

test('同一域名只出一条候选，且让位给已固定的标签', () => {
  const c = seeded([{ id: 'a', label: 'OA', url: 'https://oa.hongdi.com/', pin: 0 }]);
  const now = Date.now();
  const rows = [
    { url: 'https://oa.hongdi.com/home', host: 'oa.hongdi.com', title: 'OA 首页', added: now },
    { url: 'https://github.com/a', host: 'github.com', title: 'GitHub', added: now },
    { url: 'https://github.com/b', host: 'github.com', title: 'GitHub 二条', added: now - 1000 }
  ];
  const hosts = Array.from(c.QuickTags.buildCandidates({ rows, topSites: [] }), x => x.host);
  assert.deepEqual(hosts, ['github.com']);
});

test('词首缩写可命中：@gh 打开 GitHub，@ys 打开 YS 应收', () => {
  const c = seeded([{ id: 'a', label: 'YS 应收', url: 'https://yonyou.com/ar', pin: 0 }]);
  assert.equal(c.QuickTags.abbrOf('GitHub'), 'gh');
  assert.equal(c.QuickTags.abbrOf('YS 应收'), 'ys');
  assert.equal(c.QuickTags.abbrOf('广州仓看板'), '', '中文缩写需要拼音表，v1.11 再补');

  const topSites = [{ url: 'https://github.com/', title: 'GitHub' }];
  assert.equal(c.QuickTags.search('gh', { topSites }).candidates.length, 1);
  assert.equal(c.QuickTags.search('ys', {}).pinned[0].id, 'a');
});

test('内网地址保留端口，避免不同服务被并成一条', () => {
  const c = context();
  assert.equal(c.QuickTags.hostOf('http://8.145.50.4:8000/'), '8.145.50.4:8000');
  const rows = [
    { url: 'http://8.145.50.4:8000/', host: '8.145.50.4:8000', title: 'A19 财务', added: Date.now() },
    { url: 'http://8.145.50.4:9000/', host: '8.145.50.4:9000', title: 'AI 网关', added: Date.now() }
  ];
  assert.equal(c.QuickTags.buildCandidates({ rows, topSites: [] }).length, 2);
});

test('候选被隐藏三次后不再生成，清空学习数据可恢复', () => {  const c = seeded([]);
  const entry = { id: 'auto_x.com', kind: 'auto', host: 'x.com' };
  assert.equal(c.QuickTags.dismiss(entry), 1);
  assert.equal(c.QuickTags.dismiss(entry), 2);
  assert.equal(c.QuickTags.dismiss(entry), 3);

  const rows = [{ url: 'https://x.com/', host: 'x.com', title: 'X', added: Date.now() }];
  assert.equal(c.QuickTags.buildCandidates({ rows, topSites: [] }).length, 0);

  c.QuickTags.resetLearned();
  assert.equal(c.QuickTags.buildCandidates({ rows, topSites: [] }).length, 1);
});

test('命中回写：手动标签记命中，自动候选按使用次数上浮', () => {
  const c = seeded([{ id: 'a', label: 'OA', url: 'https://oa.hongdi.com/', pin: 0 }]);
  const tag = c.QuickTags.search('', {}).pinned[0];
  c.QuickTags.touch(tag);
  const after = c.QuickTags._state().tags[0];
  assert.equal(after.hits, 1);
  assert.ok(after.lastUsed > 0);

  const used = { id: 'auto_github.com', kind: 'auto', host: 'github.com' };
  const before = c.QuickTags.buildCandidates({ rows: [], topSites: [{ url: 'https://github.com/', title: 'GitHub' }] })[0];
  c.QuickTags.touch(used);
  c.QuickTags.touch(used);
  const afterBoost = c.QuickTags.buildCandidates({ rows: [], topSites: [{ url: 'https://github.com/', title: 'GitHub' }] })[0];
  assert.ok(afterBoost.score > before.score, '用过的候选应该比没用过时得分更高');
});

test('新建标签：同类地址不重复，删除后序号保持连续', () => {
  const c = seeded([]);
  const first = c.QuickTags.add({ url: 'oa.hongdi.com', label: '打卡' });
  assert.equal(first.ok, true);
  assert.equal(first.tag.label, '打卡');

  const dup = c.QuickTags.add({ url: 'http://oa.hongdi.com/' });
  assert.equal(dup.existed, true);

  c.QuickTags.add({ url: 'https://github.com' });
  c.QuickTags.remove(first.tag.id);
  assert.deepEqual(Array.from(c.QuickTags.list(), t => t.pin), [0]);
});

test('管理页排序：上移下移交换相邻项，边界不动', () => {
  const c = seeded([
    { id: 'a', label: 'A', url: 'https://a.com', pin: 0 },
    { id: 'b', label: 'B', url: 'https://b.com', pin: 1 },
    { id: 'c', label: 'C', url: 'https://c.com', pin: 2 }
  ]);
  assert.equal(c.QuickTags.move('b', -1), true);
  assert.deepEqual(Array.from(c.QuickTags.list(), t => t.id), ['b', 'a', 'c']);
  assert.deepEqual(Array.from(c.QuickTags.list(), t => t.pin), [0, 1, 2], '序号应保持连续');
  assert.equal(c.QuickTags.move('b', -1), false, '首项无法继续上移');
  assert.equal(c.QuickTags.move('c', 1), false, '末项无法继续下移');
});

test('撤销删除时按原位置插回，不打乱既有顺序', () => {
  const c = seeded([
    { id: 'a', label: 'A', url: 'https://a.com', pin: 0 },
    { id: 'b', label: 'B', url: 'https://b.com', pin: 1 },
    { id: 'c', label: 'C', url: 'https://c.com', pin: 2 }
  ]);
  c.QuickTags.remove('b');
  const res = c.QuickTags.add({ url: 'https://b.com', label: 'B', pin: 1 });
  assert.equal(res.ok, true);
  assert.deepEqual(Array.from(c.QuickTags.list(), t => t.label), ['A', 'B', 'C']);
});

test('已忽略可恢复：恢复后重新进入候选', () => {
  const c = seeded([]);
  const entry = { id: 'auto_x.com', kind: 'auto', host: 'x.com' };
  c.QuickTags.dismiss(entry);
  c.QuickTags.dismiss(entry);
  c.QuickTags.dismiss(entry);

  const ignored = Array.from(c.QuickTags.ignored());
  assert.equal(ignored.length, 1);
  assert.equal(ignored[0].count, 3);

  const rows = [{ url: 'https://x.com/', host: 'x.com', title: 'X', added: Date.now() }];
  assert.equal(c.QuickTags.buildCandidates({ rows, topSites: [] }).length, 0);

  assert.equal(c.QuickTags.restore('x.com'), true);
  assert.equal(c.QuickTags.buildCandidates({ rows, topSites: [] }).length, 1);
  assert.equal(c.QuickTags.ignored().length, 0);
});

test('导出只带固定标签，导入按地址去重', () => {
  const c = seeded([{ id: 'a', label: '打卡', url: 'https://oa.hongdi.com/', pin: 0 }]);
  const dump = c.QuickTags.exportData();
  assert.equal(dump.version, 1);
  assert.equal(dump.tags.length, 1);
  assert.equal(dump.tags[0].label, '打卡');
  assert.equal(dump.tags[0].host, undefined, '导出不包含派生字段');

  const res = c.QuickTags.importData(JSON.stringify(dump));
  assert.equal(res.added, 0);
  assert.equal(res.skipped, 1, '同地址应跳过');

  const bad = c.QuickTags.importData('不是 json');
  assert.equal(bad.ok, false);

  const two = c.QuickTags.importData(JSON.stringify({ tags: [
    { label: 'GitHub', url: 'https://github.com' },
    { label: '坏数据', url: 'javascript:alert(1)' }
  ] }));
  assert.equal(two.added, 1);
  assert.equal(two.skipped, 1);
});
