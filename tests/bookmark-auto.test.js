/* 域名记忆：历史学习、子域名继承、手动纠正和 AI 建议确认。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./helpers/extension');
const root = path.resolve(__dirname, '..');

const TREE = [{ id: '0', title: '', children: [
  { id: '1', title: '书签栏', children: [] },
  { id: '2', title: '其他书签', children: [
    { id: '3', title: '散落收藏', url: 'https://misc.example.net/' }
  ] },
  { id: '6', title: '工作', children: [
    { id: '7', title: '公司系统', children: [
      { id: '20', title: 'OA', url: 'https://oa.corp.com/' },
      { id: '21', title: '报销', url: 'https://sso.corp.com/' }
    ] },
    { id: '8', title: '项目', children: [
      { id: '22', title: 'Wiki', url: 'https://wiki.corp.com/' }
    ] }
  ] }
] }];

function harness(fetchImpl) {
  const f = fixture({ tree: JSON.parse(JSON.stringify(TREE)), fetch: fetchImpl });
  f.c.chrome.storage = { local: {
    get: (key, cb) => cb({ 'newtab.settings.v1': { ai: {
      enabled: !!fetchImpl, baseUrl: 'https://ai.test/v1', apiKey: 'k', model: 'm', timeout: 5000
    } } }),
    set: (value, cb) => cb && cb()
  } };
  for (const file of ['js/store.js', 'js/bookmark-auto.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), f.c);
  }
  return f;
}

test('域名归一处理多段后缀、IP 与非网页协议', () => {
  const f = harness();
  const { domainOf, hostOf } = f.c.AutoOrganizer;
  assert.equal(domainOf('oa.corp.com'), 'corp.com');
  assert.equal(domainOf('a.b.corp.co.uk'), 'corp.co.uk');
  assert.equal(domainOf('192.168.1.10'), '192.168.1.10');
  assert.equal(hostOf('https://OA.Corp.com/x'), 'oa.corp.com');
  assert.equal(hostOf('chrome://settings'), '');
});

test('历史域名学习仅作参考，明确范围规则自动归档并可撤销', async () => {
  const f = harness();
  const rules = await f.c.AutoOrganizer.learn();
  assert.equal(rules['corp.com'].folderId, '7');
  assert.equal(rules['corp.com'].source, 'learned');

  const created = await f.bookmarks.create({ parentId: '2', title: '人事系统', url: 'https://hr.corp.com/' });
  assert.equal((await f.c.AutoOrganizer.onCreated(created.id, created)).action, 'pending');
  assert.equal(f.node(created.id).parentId, '2');
  await f.c.AgentDB.setMeta('auto:rules', { 'hr.corp.com/': { folderId: '7', source: 'confirmed', scope: { host: 'hr.corp.com', path: '/', search: '', hash: '', prefix: false } } });
  const result = await f.c.AutoOrganizer.onCreated(created.id, created);
  assert.equal(result.action, 'filed');
  assert.equal(f.node(created.id).parentId, '7');

  const journal = await f.c.AgentDB.getMeta('organizer:journal');
  assert.equal(journal.items.length, 1);
  assert.equal(journal.items[0].source, 'auto');
  assert.equal((await f.c.OrganizerMoves.summary()).canUndo, true);

  await f.c.OrganizerMoves.undo();
  assert.equal(f.node(created.id).parentId, '2');
});

test('手动选择目录形成页面范围规则，同站不同内容不会被整站归档', async () => {
  const f = harness();
  const first = await f.bookmarks.create({ parentId: '8', title: '项目文档', url: 'https://github.com/team/project/docs' });
  await f.c.AutoOrganizer.onCreated(first.id, first);
  const next = await f.bookmarks.create({ parentId: '2', title: '项目源码', url: 'https://github.com/team/project/src' });
  await f.c.AutoOrganizer.onCreated(next.id, next);
  assert.equal(f.node(next.id).parentId, '8');
  const other = await f.bookmarks.create({ parentId: '2', title: '设计素材', url: 'https://github.com/design/icons' });
  await f.c.AutoOrganizer.onCreated(other.id, other);
  assert.equal(f.node(other.id).parentId, '2');
  await f.c.AutoOrganizer.learn();
  assert.equal((await f.c.AgentDB.getMeta('auto:rules'))['github.com/team/project'].source, 'manual');
});

test('陌生域名只登记待确认，AI 建议确认后才移动并记住站点', async () => {
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const payload = JSON.parse(body.messages[1].content);
    const items = payload.bookmarks.map(item => ({
      id: item.id, folder: '工作 / 公司系统', confidence: 'high', why: '标题像业务系统'
    }));
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ items }) } }], usage: { total_tokens: 12 } })
    };
  };
  const f = harness(fetchImpl);

  const created = await f.bookmarks.create({ parentId: '2', title: '差旅报销系统', url: 'https://travel.othersite.org/' });
  const result = await f.c.AutoOrganizer.onCreated(created.id, created);
  assert.equal(result.action, 'pending');
  assert.equal(f.node(created.id).parentId, '2');

  const pending = await f.c.AutoOrganizer.classifyPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].folderId, '7');
  assert.equal(pending[0].confidence, 'high');

  const state = await f.c.AutoOrganizer.adopt(created.id);
  assert.equal(f.node(created.id).parentId, '7');
  assert.equal(state.pending.length, 0);

  const rules = await f.c.AgentDB.getMeta('auto:rules');
  assert.equal(rules['travel.othersite.org/'].source, 'confirmed');
  assert.equal(rules['travel.othersite.org/'].folderId, '7');
});

test('关闭自动归档后不移动新收藏，规则移除后不再匹配', async () => {
  const f = harness();
  await f.c.AutoOrganizer.learn();
  await f.c.AutoOrganizer.toggle(false);

  const created = await f.bookmarks.create({ parentId: '2', title: '人事系统', url: 'https://hr.corp.com/' });
  const result = await f.c.AutoOrganizer.onCreated(created.id, created);
  assert.equal(result.action, 'ignored');
  assert.equal(f.node(created.id).parentId, '2');

  await f.c.AutoOrganizer.toggle(true);
  await f.c.AutoOrganizer.removeRule('corp.com');
  const next = await f.bookmarks.create({ parentId: '2', title: '人事系统 2', url: 'https://hr.corp.com/2' });
  await f.c.AutoOrganizer.onCreated(next.id, next);
  assert.equal(f.node(next.id).parentId, '2');
});

function aiReply(payload) {
  return { ok: true, content: JSON.stringify({ items: payload.bookmarks.map(b => ({ id: b.id, folder: '工作 / 项目', confidence: 'high', why: '内容与项目目录相符' })) }) };
}

function enabled() {
  const f = harness(async () => { throw new Error('测试使用模型替身'); });
  f.c.AI.chat = async (cfg, system, input) => aiReply(JSON.parse(input));
  return f;
}

test('收件箱扫描只处理直属网页，书签栏和子目录保持原位', async () => {
  const f = enabled();
  const bar = await f.bookmarks.create({ parentId: '1', title: '书签栏收藏', url: 'https://bar.test' });
  const nested = await f.bookmarks.create({ parentId: '2', title: '手工目录' });
  const child = await f.bookmarks.create({ parentId: nested.id, title: '目录内收藏', url: 'https://nested.test' });
  await f.c.AutoOrganizer.scanInbox();
  await f.c.AutoOrganizer.onCreated(bar.id, bar);
  const pending = await f.c.AutoOrganizer.classifyPending();
  assert.deepEqual(Array.from(pending, x => x.id), ['3']);
  assert.equal(f.node(bar.id).parentId, '1');
  assert.equal(f.node(child.id).parentId, nested.id);
  assert.equal(f.node('3').parentId, '2');
});

test('AI 只收到公开摘要和目录示例，私人正文与标签不发送', async () => {
  const f = enabled();
  const privateNode = await f.bookmarks.create({ parentId: '2', title: '私有页面', url: 'https://private.test/' });
  await f.c.AgentDB.putPage({ url: 'https://misc.example.net/', status: 'ok', source: 'public', desc: '公开项目说明' });
  await f.c.AgentDB.putPage({ url: privateNode.url, status: 'ok', source: 'capture', private: true, text: '保密正文', desc: '保密描述' });
  await f.c.AgentDB.setMeta('class:' + privateNode.id, { url: privateNode.url, tags: ['保密标签'] });
  let payload;
  f.c.AI.chat = async (cfg, system, input) => { payload = JSON.parse(input); return aiReply(payload); };
  await f.c.AutoOrganizer.scanInbox();
  await f.c.AutoOrganizer.classifyPending();
  assert.match(JSON.stringify(payload), /公开项目说明/);
  assert.match(JSON.stringify(payload.folderExamples), /Wiki/);
  assert.doesNotMatch(JSON.stringify(payload), /保密/);
  assert.equal(f.node('3').parentId, '2');
});

test('AI 请求期间忽略不复活，手动移动后不能采用旧建议', async () => {
  const f = enabled();
  await f.c.AutoOrganizer.scanInbox();
  f.c.AI.chat = async (cfg, system, input) => {
    await f.c.AutoOrganizer.dismiss('3');
    return aiReply(JSON.parse(input));
  };
  await f.c.AutoOrganizer.classifyPending();
  assert.equal((await f.c.AutoOrganizer.status()).pending.length, 0);
  await f.c.AutoOrganizer.scanInbox();
  assert.equal((await f.c.AutoOrganizer.status()).pending.length, 0);

  const node = await f.bookmarks.create({ parentId: '2', title: '新页面', url: 'https://new.test/' });
  f.c.AI.chat = async (cfg, system, input) => aiReply(JSON.parse(input));
  await f.c.AutoOrganizer.onCreated(node.id, node);
  await f.c.AutoOrganizer.classifyPending();
  await f.bookmarks.move(node.id, { parentId: '7' });
  await assert.rejects(() => f.c.AutoOrganizer.adopt(node.id), /手动修改/);
  assert.equal(f.node(node.id).parentId, '7');
});

test('超过一批按未处理项推进，模型不能为批次外书签写入建议', async () => {
  const f = enabled();
  for (let i = 0; i < 10; i++) await f.bookmarks.create({ parentId: '2', title: '收藏' + i, url: 'https://batch.test/' + i });
  await f.c.AutoOrganizer.scanInbox();
  const batches = [];
  f.c.AI.chat = async (cfg, system, input) => {
    const payload = JSON.parse(input);
    batches.push(payload.bookmarks.map(b => b.id));
    return aiReply(payload);
  };
  await f.c.AutoOrganizer.classifyPending();
  await f.c.AutoOrganizer.classifyPending();
  assert.equal(batches[0].length, 8);
  assert.equal(batches[1].length, 3);
  assert.equal(batches[0].some(id => batches[1].includes(id)), false);
});

test('暂停时不调用 AI，手动移回收件箱不再次搬走', async () => {
  const f = enabled();
  await f.c.AutoOrganizer.scanInbox();
  let calls = 0;
  f.c.AI.chat = async () => { calls++; return { ok: false }; };
  await f.c.AutoOrganizer.toggle(false);
  await f.c.AutoOrganizer.classifyPending();
  assert.equal(calls, 0);
  await f.c.AutoOrganizer.toggle(true);
  const node = await f.bookmarks.create({ parentId: '8', title: '收藏', url: 'https://held.test/' });
  await f.c.AutoOrganizer.onCreated(node.id, node);
  await f.bookmarks.move(node.id, { parentId: '2' });
  await f.c.AutoOrganizer.onMoved(node.id, { parentId: '2', oldParentId: '8' });
  await f.c.AutoOrganizer.scanInbox();
  assert.equal(f.node(node.id).parentId, '2');
  assert.equal((await f.c.AutoOrganizer.status()).pending.some(p => p.id === node.id), false);
});

test('范围规则区分端口、查询参数和不同项目', async () => {
  const f = enabled();
  const picked = await f.bookmarks.create({ parentId: '8', title: '内网文档', url: 'http://10.0.0.1:3000/docs/item?doc=one' });
  await f.c.AutoOrganizer.onCreated(picked.id, picked);
  for (const url of ['http://10.0.0.1:8000/docs/item?doc=one', 'http://10.0.0.1:3000/docs/item?doc=two', 'http://10.0.0.1:3000/other/item?doc=one']) {
    const node = await f.bookmarks.create({ parentId: '2', title: '不同内容', url });
    await f.c.AutoOrganizer.onCreated(node.id, node);
    assert.equal(f.node(node.id).parentId, '2');
  }
});

test('拒绝模型伪造的批次外 ID 和未知目录', async () => {
  const f = enabled();
  const target = await f.bookmarks.create({ parentId: '2', title: '未分析条目', url: 'https://outside.test' });
  await f.c.AutoOrganizer.scanInbox();
  const list = await f.c.AgentDB.getMeta('auto:pending');
  await f.c.AgentDB.setMeta('auto:pending', list.map(item => item.id === target.id ? { ...item, attempts: 2 } : item));
  f.c.AI.chat = async () => ({ ok: true, content: JSON.stringify({ items: [
    { id: target.id, folder: '工作 / 项目', confidence: 'high' },
    { id: '3', folder: '并不存在的目录', confidence: 'high' }
  ] }) });
  await f.c.AutoOrganizer.classifyPending();
  const pending = await f.c.AgentDB.getMeta('auto:pending');
  assert.equal(pending.some(item => item.folderId), false);
  assert.equal(f.node(target.id).parentId, '2');
});

test('归档记录合并历史并去重，保留当时目录、撤销状态与时间顺序', async () => {
  const f = harness();
  const older = { id: '3', title: '旧记录', before: { parentId: '2', title: '旧记录' }, after: { parentId: '7' }, state: 'restored', movedAt: 10 };
  const newer = { id: '9', title: '新记录', before: { parentId: 'gone' }, beforePath: '原有目录', after: { parentId: 'gone2' }, destinationPath: '当时的目标', state: 'moved', movedAt: 20 };
  await f.c.AgentDB.setMeta('organizer:history', [{ items: [older, newer] }]);
  await f.c.AgentDB.setMeta('organizer:journal', { items: [newer, { id: 'failed', state: 'pending' }] });
  const records = (await f.c.AutoOrganizer.status()).archiveRecords;
  assert.equal(records.length, 2);
  assert.equal(records[0].title, '新记录');
  assert.equal(records[0].from, '原有目录');
  assert.equal(records[0].to, '当时的目标');
  assert.equal(records[1].state, 'restored');
  assert.equal(records[1].from, '其他书签');
  assert.equal(records[1].to, '工作 / 公司系统');
});
