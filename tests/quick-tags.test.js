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

/** 带 chrome.storage 替身的上下文：可延迟读盘，验证首屏竞态 */
function storageContext(initial, delayRead) {
  const c = { URL, setTimeout, clearTimeout };
  const store = {};
  if (initial) store['newtab.tags.v1'] = initial;
  const pending = [];
  c.chrome = {
    storage: {
      local: {
        get(key, cb) {
          const run = () => cb({ [key]: store[key] });
          if (delayRead) pending.push(run); else run();
        },
        set(obj, cb) { Object.assign(store, obj); if (cb) cb(); }
      }
    }
  };
  c.self = c;
  vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(root, 'js', 'quick-tags.js'), 'utf8'), c);
  return { c, store, release: () => { delayRead = false; pending.splice(0).forEach(fn => fn()); } };
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

test('localhost 带端口/路径可创建，localhostfoo 不算地址', () => {
  const c = context();
  assert.equal(c.QuickTags.normalizeUrl('localhost:5173'), 'http://localhost:5173/');
  assert.equal(c.QuickTags.normalizeUrl('localhost:5173/admin?x=1'), 'http://localhost:5173/admin?x=1');
  assert.equal(c.QuickTags.normalizeUrl('localhost'), 'http://localhost/');
  assert.equal(c.QuickTags.normalizeUrl('localhostfoo'), '');
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
  assert.equal(dump.version, 2);
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

test('空查询按使用频率排序，同频/从未使用回落手写顺序', () => {
  const now = Date.now();
  const c = seeded([
    { id: 'a', label: 'A', url: 'https://a.com', pin: 0, hits: 1, lastUsed: now },
    { id: 'b', label: 'B', url: 'https://b.com', pin: 1, hits: 10, lastUsed: now },
    { id: 'c', label: 'C', url: 'https://c.com', pin: 2, hits: 0, lastUsed: 0 }
  ]);
  assert.deepEqual(Array.from(c.QuickTags.search('', {}).pinned, t => t.id), ['b', 'a', 'c']);
});

test('URL 形态查询生成创建条目；已有同 URL 标签时不重复创建', () => {
  const c = seeded([]);
  const cand = c.QuickTags.createCandidate('localhost:5173');
  assert.equal(cand.kind, 'create');
  assert.equal(cand.url, 'http://localhost:5173/');

  c.QuickTags.add({ url: 'localhost:5173' });
  assert.equal(c.QuickTags.createCandidate('localhost:5173'), null, '已存在时回车的语义是打开');
  assert.equal(c.QuickTags.createCandidate('随便写点什么'), null);
});

test('AI 条目只映射当前候选，并与常用区按 host 去重', () => {
  const c = seeded([]);
  const topSites = [
    { url: 'https://oa.hongdi.com/', title: 'OA 打卡' },
    { url: 'https://github.com/', title: 'GitHub' }
  ];
  const r = c.QuickTags.search('', { topSites }, [{ host: 'oa.hongdi.com', name: '打卡', rank: 0 }]);
  assert.equal(r.ai.length, 1);
  assert.equal(r.ai[0].label, '打卡');
  assert.equal(r.ai[0].url, 'https://oa.hongdi.com/');
  assert.ok(!r.candidates.some(x => x.host === 'oa.hongdi.com'), 'AI 已占用的 host 不应在常用区重复出现');

  const missing = c.QuickTags.search('', { topSites }, [{ host: 'nope.com', name: 'X', rank: 0 }]);
  assert.equal(missing.ai.length, 0, '缓存里不存在的站点必须丢弃');
});

test('固定自动候选时继承已使用次数，频率不从 0 开始', () => {
  const c = seeded([]);
  const entry = { id: 'auto_oa.hongdi.com', kind: 'auto', host: 'oa.hongdi.com' };
  c.QuickTags.touch(entry);
  c.QuickTags.touch(entry);
  const res = c.QuickTags.add({ url: 'https://oa.hongdi.com/', label: '打卡' });
  assert.equal(res.tag.hits, 2);
  assert.ok(res.tag.lastUsed > 0);
});

test('flush 立即落盘，不等 200ms 防抖', async () => {
  const { c, store } = storageContext({});
  await c.QuickTags.load();
  c.QuickTags.add({ url: 'https://x.com' });
  await c.QuickTags.flush();
  assert.equal(store['newtab.tags.v1'].tags.length, 1);
});

test('首屏读盘未完成时新建的标签不会被旧状态覆盖', async () => {
  const { c, store, release } = storageContext({
    version: 1,
    tags: [{ id: 'old', label: '旧站', url: 'https://old.com/', pin: 0 }]
  }, true);

  const loading = c.QuickTags.load();
  const res = c.QuickTags.add({ url: 'localhost:5173' });
  assert.equal(res.ok, true);
  release();
  await loading;

  const saved = store['newtab.tags.v1'];
  assert.equal(saved.tags.length, 2);
  assert.ok(saved.tags.some(t => t.url === 'http://localhost:5173/'));
  assert.ok(saved.tags.some(t => t.url === 'https://old.com/'));
});

test('备份快照：replace 整体替换，merge 按 URL 合并', async () => {
  const c = seeded([{ id: 'a', label: 'A', url: 'https://a.com', pin: 0, hits: 5, lastUsed: Date.now() }]);
  const snap = c.QuickTags.snapshot();
  assert.equal(snap.tags[0].hits, 5);

  await c.QuickTags.restoreState({ tags: [{ label: 'B', url: 'https://b.com' }] });
  assert.deepEqual(Array.from(c.QuickTags.list(), t => t.label), ['B']);

  await c.QuickTags.restoreState(snap, { mode: 'merge' });
  assert.deepEqual(Array.from(c.QuickTags.list(), t => t.label).sort(), ['A', 'B']);
});

test('个人称呼：007 精确别名高于高频域名，前导零不被丢弃', () => {
  const c = seeded([
    { id: 'portal', label: '公司平台', url: 'https://portal.example.com/', aliases: ['007', 'OA'], note: '报销和请假' },
    { id: 'noise', label: '高频网站', url: 'https://007.example.com/', hits: 99999, lastUsed: Date.now() }
  ]);
  assert.equal(c.QuickTags.search('００７', {}).pinned[0].id, 'portal');
  assert.equal(c.QuickTags.search('007', {}).pinned[0].match, 120);
  assert.equal(c.QuickTags.search('7', {}).pinned.find(t => t.id === 'portal').match < 120, true);
  assert.equal(c.QuickTags.search('报销', {}).pinned[0].id, 'portal');
});

test('个人称呼：所有精确冲突可见，同域不同路径不合并', () => {
  const c = seeded(Array.from({ length: 12 }, (_, i) => ({ id: 't' + i, label: '入口' + i, aliases: ['007'], url: 'https://portal.example.com/p' + i })));
  const groups = c.QuickTags.search('007', {});
  assert.equal(groups.ambiguous, true);
  assert.equal(groups.pinned.length, 12);
});

test('完整编辑落盘并保留人工信息，过期表单不能覆盖', async () => {
  const { c, store } = storageContext({ version: 2, tags: [{ id: 'a', label: '旧名称', url: 'https://portal.example.com/', hits: 6, pin: 0 }] });
  await c.QuickTags.load();
  const result = await c.QuickTags.save({ label: '公司平台', url: 'https://portal.example.com/', aliases: ['007', ' OA ', 'oa'], note: '报销与请假' }, 'a', 0);
  assert.equal(result.ok, true); assert.equal(store['newtab.tags.v1'].tags[0].note, '报销与请假');
  assert.equal(result.tag.hits, 6); assert.deepEqual(Array.from(result.tag.aliases), ['007', 'OA']);
  const stale = await c.QuickTags.save({ label: '旧表单', url: result.tag.url }, 'a', 0);
  assert.equal(stale.ok, false); assert.equal(c.QuickTags.list()[0].label, '公司平台');
  const dump = c.QuickTags.exportData(); assert.equal(dump.tags[0].note, '报销与请假');
  c.QuickTags.resetLearned(); await c.QuickTags.flush(); assert.equal(c.QuickTags.list()[0].note, '报销与请假');
});

test('保存失败不发布新状态；不支持的新版拒绝写回', async () => {
  const { c, store } = storageContext({ version: 2, tags: [] }); await c.QuickTags.load();
  c.chrome.runtime = { lastError: { message: '磁盘写失败' } };
  const saved = await c.QuickTags.save({ label: '公司平台', url: 'https://portal.example.com/', aliases: ['007'] });
  assert.equal(saved.ok, false); assert.equal(c.QuickTags.list().length, 0); delete c.chrome.runtime.lastError;
  assert.equal(c.QuickTags.importData({ version: 999, tags: [] }).ok, false);
  store['newtab.tags.v1'] = { version: 999, tags: [] }; await assert.rejects(c.QuickTags.reload(), /新版/);
});

test('字段限制不静默截断，拒绝凭据网址与冲突 URL', async () => {
  const c = seeded([{ id: 'a', label: '公司平台', url: 'https://portal.example.com/', note: '原说明' }]);
  assert.equal(c.QuickTags.validate({ label: '名'.repeat(201), url: 'https://example.com' }).ok, false);
  assert.equal(c.QuickTags.validate({ label: '名称', note: '字'.repeat(501), url: 'https://example.com' }).ok, false);
  assert.equal(c.QuickTags.normalizeUrl('https://user:password@example.com/'), '');
  assert.equal((await c.QuickTags.save({ label: '重复入口', url: 'https://portal.example.com/' })).ok, false);
});

test('另一页面先提交时，旧页面的频率写入不能覆盖新别名与说明', async () => {
  const a = storageContext({ version: 2, tags: [{ id: 'a', label: '公司', url: 'https://portal.example.com/' }] });
  const b = context(); b.chrome = a.c.chrome; await a.c.QuickTags.load(); await b.QuickTags.load();
  assert.equal((await b.QuickTags.save({ label: '公司', url: 'https://portal.example.com/', aliases: ['007'], note: '新说明' }, 'a', 0)).ok, true);
  a.c.QuickTags.touch({ kind: 'manual', id: 'a' }); await assert.rejects(a.c.QuickTags.flush(), /其他页面/);
  assert.deepEqual(a.store['newtab.tags.v1'].tags[0].aliases, ['007']); assert.equal(a.store['newtab.tags.v1'].tags[0].note, '新说明');
});

test('Unicode 名称按字符计数，保存与重载不截断合法的表情名称', async () => {
  const { c, store } = storageContext({ tags: [] }); await c.QuickTags.load();
  const label = '😀'.repeat(40); const added = c.QuickTags.add({ label, url: 'https://example.com/' });
  assert.equal(added.ok, true); assert.equal(added.tag.label, label);
  await c.QuickTags.flush(); await c.QuickTags.reload(); assert.equal(c.QuickTags.list()[0].label, label);
  assert.equal(store['newtab.tags.v1'].tags[0].label, label);
});

test('长书签名称保存、改名和备份往返遵循相同上限且不截断', async () => {
  const { c } = storageContext({ tags: [] }); await c.QuickTags.load();
  const label = '仓储工时与薪资系统·排期 - 飞书云文档' + '完整标题'.repeat(10);
  const saved = await c.QuickTags.save({ label, url: 'https://example.com/salary', aliases: ['suanxin', '算薪资'], note: '虹迪算薪排期表' });
  assert.equal(saved.ok, true);
  await c.QuickTags.reload(); assert.equal(c.QuickTags.list()[0].label, label);
  assert.equal(c.QuickTags.search('suanxin', {}).pinned[0].note, '虹迪算薪排期表');
  const dump = c.QuickTags.exportData();
  const other = storageContext({ tags: [] }); await other.c.QuickTags.load();
  assert.equal(other.c.QuickTags.importData(dump).added, 1);
  await other.c.QuickTags.flush(); await other.c.QuickTags.reload();
  assert.equal(other.c.QuickTags.list()[0].label, label);
  const boundary = '😀'.repeat(200);
  assert.equal(c.QuickTags.rename(saved.tag.id, boundary), true);
  await c.QuickTags.flush(); await c.QuickTags.reload();
  assert.equal(c.QuickTags.list()[0].label, boundary);
  assert.equal(c.QuickTags.rename(saved.tag.id, boundary + '字'), false);
  assert.equal(c.QuickTags.validate({ label: '  ', url: saved.tag.url }).ok, false);
  assert.equal(c.QuickTags.validate({ label, url: saved.tag.url, aliases: ['别'.repeat(41)] }).ok, false);
});
