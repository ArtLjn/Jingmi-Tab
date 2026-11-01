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

test('同域名多数归档形成学习规则，命中后自动移动并可撤销', async () => {
  const f = harness();
  const rules = await f.c.AutoOrganizer.learn();
  assert.equal(rules['corp.com'].folderId, '7');
  assert.equal(rules['corp.com'].source, 'learned');

  const created = await f.bookmarks.create({ parentId: '2', title: '人事系统', url: 'https://hr.corp.com/' });
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

test('用户手动选目录或拖动收藏会写成站点级规则，并优先于域名规则', async () => {
  const f = harness();
  await f.c.AutoOrganizer.learn();

  const first = await f.bookmarks.create({ parentId: '8', title: 'OA 后台', url: 'https://oa.corp.com/home' });
  const learned = await f.c.AutoOrganizer.onCreated(first.id, first);
  assert.equal(learned.action, 'learned');
  assert.equal(f.node(first.id).parentId, '8');

  let rules = await f.c.AgentDB.getMeta('auto:rules');
  assert.equal(rules['oa.corp.com'].source, 'manual');
  assert.equal(rules['oa.corp.com'].folderId, '8');

  /* 站点级规则优先于 corp.com 的学习规则。 */
  const next = await f.bookmarks.create({ parentId: '2', title: 'OA 登录', url: 'https://oa.corp.com/login' });
  await f.c.AutoOrganizer.onCreated(next.id, next);
  assert.equal(f.node(next.id).parentId, '8');

  /* 拖动到另一个目录同样是一次明确表态。 */
  const dragged = await f.bookmarks.create({ parentId: '2', title: '私有 Git', url: 'https://git.corp.com/team' });
  const moved = await f.bookmarks.move(dragged.id, { parentId: '7' });
  await f.c.AutoOrganizer.onMoved(dragged.id, { parentId: '7', oldParentId: '2', index: moved.index });
  rules = await f.c.AgentDB.getMeta('auto:rules');
  assert.equal(rules['git.corp.com'].source, 'manual');
  assert.equal(rules['git.corp.com'].folderId, '7');

  /* 重新学习只重算“学习”规则，手动规则保持不变。 */
  await f.c.AutoOrganizer.learn();
  rules = await f.c.AgentDB.getMeta('auto:rules');
  assert.equal(rules['oa.corp.com'].source, 'manual');
  assert.equal(rules['oa.corp.com'].folderId, '8');

  /* 同一域名下两个站点确认到同一目录，升级为整域规则。 */
  const second = await f.bookmarks.create({ parentId: '7', title: 'HR 系统', url: 'https://hr.corp.com/' });
  await f.c.AutoOrganizer.onCreated(second.id, second);
  rules = await f.c.AgentDB.getMeta('auto:rules');
  assert.equal(rules['corp.com'].folderId, '7');
  assert.equal(rules['corp.com'].source, 'learned');
  /* 主机级例外仍然优先：oa.corp.com 继续进“项目”。 */
  assert.equal(rules['oa.corp.com'].folderId, '8');
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
  assert.equal(rules['travel.othersite.org'].source, 'confirmed');
  assert.equal(rules['travel.othersite.org'].folderId, '7');
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
