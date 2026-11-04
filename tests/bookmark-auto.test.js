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
  await f.c.AgentDB.setMeta('auto:rules', { 'hr.corp.com/': { folderId: '7', source: 'confirmed', remembered: true, scope: { host: 'hr.corp.com', path: '/', search: '', hash: '', prefix: false } } });
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

test('手动整理和旧版隐式规则均不会自动搬动新收藏', async () => {
  const f = harness();
  const first = await f.bookmarks.create({ parentId: '8', title: '项目文档', url: 'https://github.com/team/project/docs' });
  await f.c.AutoOrganizer.onCreated(first.id, first);
  assert.equal(await f.c.AgentDB.getMeta('auto:rules'), null);
  await f.c.AgentDB.setMeta('auto:rules', { 'github.com/team/project': {
    folderId: '8', source: 'manual', scope: { host: 'github.com', path: '/team/project', search: '', hash: '', prefix: true }
  } });
  const next = await f.bookmarks.create({ parentId: '2', title: '项目源码', url: 'https://github.com/team/project/src' });
  assert.equal((await f.c.AutoOrganizer.onCreated(next.id, next)).action, 'pending');
  assert.equal(f.node(next.id).parentId, '2');
  const state = await f.c.AutoOrganizer.status();
  assert.equal(state.totalRules, 0);
  assert.equal(state.rules.find(rule => rule.key === 'github.com/team/project').remembered, false);
});

test('陌生域名先预览，明确记住后才建立页面规则', async () => {
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

  const state = await f.c.AutoOrganizer.adopt(created.id, '7', true);
  assert.equal(f.node(created.id).parentId, '7');
  assert.equal(state.pending.length, 0);

  const rules = await f.c.AgentDB.getMeta('auto:rules');
  assert.equal(rules['travel.othersite.org/'].remembered, true);
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
  assert.doesNotMatch(JSON.stringify(payload), /Wiki/);
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
  const picked = await f.bookmarks.create({ parentId: '2', title: '内网文档', url: 'http://10.0.0.1:3000/docs/item?doc=one' });
  await f.c.AutoOrganizer.onCreated(picked.id, picked);
  await f.c.AutoOrganizer.adopt(picked.id, '8', true);
  const same = await f.bookmarks.create({ parentId: '2', title: '相同页面', url: picked.url });
  assert.equal((await f.c.AutoOrganizer.onCreated(same.id, same)).action, 'filed');
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

test('相似收藏优先选取实际命中的案例，手动改选只移动本条并支持撤销', async () => {
  const f = enabled();
  for (let i = 0; i < 4; i++) await f.bookmarks.create({ parentId: '8', title: '无关收藏 ' + i, url: 'https://different.test/' + i });
  await f.bookmarks.create({ parentId: '8', title: 'Playwright 浏览器测试', url: 'https://github.com/team/playwright-testing' });
  await f.bookmarks.create({ parentId: '7', title: '报销入口', url: 'https://github.com/team/reimbursement' });
  const added = await f.bookmarks.create({ parentId: '2', title: '项目指南', url: 'https://github.com/other/playwright-guide' });
  await f.c.AutoOrganizer.onCreated(added.id, added);
  let input;
  f.c.AI.chat = async (cfg, system, json) => { input = JSON.parse(json); return aiReply(input); };
  await f.c.AutoOrganizer.classifyPending();
  const candidates = input.bookmarks[0].similarFolders;
  assert.deepEqual(candidates, [{ path: '工作 / 项目', titles: ['Playwright 浏览器测试'] }]);
  assert.equal(f.node(added.id).parentId, '2');
  await assert.rejects(f.c.AutoOrganizer.adopt(added.id, '1', true), /目标目录/);
  await f.c.AutoOrganizer.adopt(added.id, '7', false);
  assert.equal(f.node(added.id).parentId, '7');
  assert.equal((await f.c.AutoOrganizer.status()).totalRules, 0);
  await f.c.OrganizerMoves.undo();
  assert.equal(f.node(added.id).parentId, '2');
  await f.c.AutoOrganizer.scanInbox();
  assert.equal((await f.c.AutoOrganizer.status()).pending.some(item => item.id === added.id), false);
});

test('公开摘要入库触发一次复评，并替换初评预览', async () => {
  const f = enabled();
  const url = 'https://misc.example.net/';
  const payloads = [];
  f.c.AI.chat = async (cfg, system, json) => {
    const input = JSON.parse(json);
    payloads.push(input.bookmarks[0]);
    const folder = input.bookmarks[0].summary ? '工作 / 公司系统' : '工作 / 项目';
    return { ok: true, content: JSON.stringify({ items: [{ id: '3', folder, confidence: 'high' }] }) };
  };
  await f.c.AutoOrganizer.scanInbox();
  assert.equal((await f.c.AutoOrganizer.classifyPending())[0].folderId, '8');
  let notify;
  const observed = new Promise(resolve => { notify = resolve; });
  const onPageReady = f.c.AutoOrganizer.onPageReady;
  f.c.AutoOrganizer.onPageReady = async (...args) => { await onPageReady(...args); notify(args); };
  f.c.fetch = async () => new Response('<html><head><title>报销流程</title><meta name="description" content="报销流程和审批说明"></head><body>报销流程和审批说明</body></html>', { headers: { 'content-type': 'text/html' } });
  await f.c.PageInfo.getMany([url]);
  assert.deepEqual(await observed, [url]);
  assert.equal((await f.c.AutoOrganizer.classifyPending())[0].folderId, '7');
  await f.c.AutoOrganizer.classifyPending();
  assert.equal(payloads.length, 2);
  assert.match(payloads[1].summary, /报销流程/);
  assert.equal(f.node('3').parentId, '2');
});

test('并发确认归档后撤销恢复收件箱的原始顺序', async () => {
  const f = harness();
  const next = await f.bookmarks.create({ parentId: '2', title: '第二条', url: 'https://second.test/' });
  await f.c.AutoOrganizer.scanInbox();
  await Promise.all([f.c.AutoOrganizer.adopt('3', '7', false), f.c.AutoOrganizer.adopt(next.id, '7', false)]);
  await f.c.OrganizerMoves.undo();
  assert.deepEqual((await f.bookmarks.getChildren('2')).map(node => node.id), ['3', next.id]);
});

test('归档目录保留浏览器层级，默认目录只用于浏览', async () => {
  const f = harness();
  const parent = await f.bookmarks.create({ parentId: '1', title: '设计 / 研究' });
  const child = await f.bookmarks.create({ parentId: parent.id, title: '资料' });
  const folders = (await f.c.AutoOrganizer.status()).folders;
  assert.equal(folders.find(folder => folder.id === '1').selectable, false);
  assert.equal(folders.find(folder => folder.id === parent.id).title, '设计 / 研究');
  assert.equal(folders.find(folder => folder.id === child.id).parentId, parent.id);
  assert.equal(folders.find(folder => folder.id === child.id).selectable, true);
});

test('主动推荐支持普通目录，忽略可保留，采纳可撤销并校验书签变化', async () => {
  const f = enabled();
  const chosen = await f.bookmarks.create({ parentId: '7', title: '发布流程', url: 'https://delivery.test/release' });
  const ignored = await f.bookmarks.create({ parentId: '7', title: '云端部署', url: 'https://infra.test/rollout' });
  const old = await f.bookmarks.create({ parentId: '7', title: '服务迁移', url: 'https://platform.test/migrate' });
  await f.c.AutoOrganizer.toggle(false);
  const ids = [chosen.id, ignored.id, old.id];
  const plan = await f.c.AutoOrganizer.review(ids);
  assert.equal(plan.items.length, 3);
  assert.equal((await f.c.AutoOrganizer.status()).review.id, plan.id);
  assert.equal(f.node(chosen.id).parentId, '7');
  await f.c.AutoOrganizer.decideReview(plan.id, ignored.id, false);
  await f.bookmarks.update(old.id, { title: '手动更名' });
  await assert.rejects(f.c.AutoOrganizer.decideReview(plan.id, old.id, true), /收藏已变化/);
  await f.c.AutoOrganizer.decideReview(plan.id, chosen.id, true);
  assert.equal(f.node(chosen.id).parentId, '8');
  assert.equal(f.node(ignored.id).parentId, '7');
  assert.equal((await f.c.AutoOrganizer.status()).totalRules, 0);
  const next = await f.c.AutoOrganizer.review(ids);
  assert.equal(next.analyzed, 2);
  assert.deepEqual(Array.from(next.items, item => item.id), [old.id]);
  await f.c.OrganizerMoves.undo();
  assert.equal(f.node(chosen.id).parentId, '7');
});

test('归档页主动推荐按收藏时间取全库最新一批', async () => {
  const f = enabled();
  const ids = [];
  for (let i = 0; i < 10; i++) {
    const item = await f.bookmarks.create({ parentId: '7', title: '新收藏 ' + i, url: 'https://new.test/' + i });
    f.node(item.id).dateAdded = 100 + i;
    ids.unshift(item.id);
  }
  let sent;
  f.c.AI.chat = async (cfg, system, input) => {
    const payload = JSON.parse(input);
    sent = payload.bookmarks.map(item => item.id);
    return aiReply(payload);
  };
  assert.equal((await f.c.AutoOrganizer.review()).analyzed, 8);
  assert.deepEqual(sent, ids.slice(0, 8));
});

test('AI 可建议新建一级目录，采纳才创建，后续复用同名目录', async () => {
  const f = enabled();
  const first = await f.bookmarks.create({ parentId: '2', title: '简历', url: 'https://example.test/resume' });
  const second = await f.bookmarks.create({ parentId: '2', title: '岗位', url: 'https://example.test/job' });
  f.c.AI.chat = async (cfg, system, input) => {
    const payload = JSON.parse(input);
    assert.ok(payload.newFolderParents.some(parent => parent.id === '1'));
    return { ok: true, content: JSON.stringify({ items: payload.bookmarks.map(item => ({
      id: item.id, folder: '', newFolder: { parentId: '1', title: '求职资料' }, why: '已有目录不适合'
    })) }) };
  };
  const plan = await f.c.AutoOrganizer.review([first.id, second.id]);
  assert.equal(plan.items[0].createsFolder, true);
  assert.match(plan.checked[0].result, /建议新建/);
  assert.equal((await f.bookmarks.getChildren('1')).length, 0);
  await f.c.AutoOrganizer.decideReview(plan.id, first.id, true);
  await f.c.AutoOrganizer.decideReview(plan.id, second.id, true);
  const folders = await f.bookmarks.getChildren('1');
  assert.equal(folders.length, 1);
  assert.equal(folders[0].title, '求职资料');
  assert.equal(f.node(first.id).parentId, folders[0].id);
  assert.equal(f.node(second.id).parentId, folders[0].id);
  await f.c.OrganizerMoves.undo();
  assert.equal(f.node(first.id).parentId, '2');
  assert.equal(f.node(second.id).parentId, '2');
});

test('记住手动选择的站点位置，后续优先使用且不匹配其他端口', async () => {
  const f = enabled();
  const site = 'https://internal.test:9443';
  const first = await f.bookmarks.create({ parentId: '2', title: '代码服务', url: site + '/projects' });
  const plan = await f.c.AutoOrganizer.review([first.id]);
  assert.equal(plan.items[0].to, '工作 / 项目');
  await f.c.AutoOrganizer.decideReview(plan.id, first.id, true, '7', true);
  assert.equal(f.node(first.id).parentId, '7');
  const next = await f.bookmarks.create({ parentId: '2', title: '发布版本', url: site + '/releases' });
  const unrelated = await f.bookmarks.create({ parentId: '2', title: '另一个服务', url: 'https://internal.test:8443/releases' });
  const sent = [];
  f.c.AI.chat = async (cfg, system, input) => {
    const payload = JSON.parse(input);
    sent.push(...payload.bookmarks.map(item => item.id));
    return aiReply(payload);
  };
  const checked = await f.c.AutoOrganizer.review([first.id, next.id, unrelated.id]);
  assert.deepEqual(sent, [unrelated.id]);
  assert.equal(checked.matchedPreferences, 2);
  assert.equal(checked.items.find(item => item.id === next.id).to, '工作 / 公司系统');
  assert.equal(checked.items.some(item => item.id === first.id), false);
  assert.equal(f.node(next.id).parentId, '2');
  await f.c.AutoOrganizer.onCreated(next.id, next);
  assert.equal(f.node(next.id).parentId, '7');
});
