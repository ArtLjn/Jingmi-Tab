/* 仅验证旧日志恢复；扩展不再生成整理计划或新目录。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/extension');
function snapshot(node) { return { parentId: node.parentId, index: node.index, title: node.title, url: node.url }; }
async function legacyMove(f, ids = ['3', '4', '5']) {
  const items = [];
  for (const id of ids.slice().reverse()) {
    const before = snapshot(f.node(id));
    const moved = await f.bookmarks.move(id, { parentId: '1' });
    items.push({ id, title: before.title, before, after: snapshot(moved), destinationId: '1', state: 'moved' });
  }
  const journal = { id: 'old-batch', items };
  await f.c.AgentDB.setMeta('organizer:journal', journal);
  return journal;
}
test('保留旧日志撤销，恢复原目录和顺序', async () => {
  const f = fixture(); const before = f.node('2').children.map(n => n.id);
  await legacyMove(f);
  assert.equal((await f.c.OrganizerMoves.summary()).canUndo, true);
  const result = await f.c.OrganizerMoves.undo();
  assert.equal(result.items.filter(i => i.state === 'restored').length, 3);
  assert.deepEqual(f.node('2').children.map(n => n.id), before);
  assert.equal((await f.c.OrganizerMoves.summary()).canUndo, false);
  assert.equal(f.c.OrganizerMoves.prepare, undefined); assert.equal(f.c.OrganizerMoves.apply, undefined);
});
test('撤销保留后续人工修改，日志可由新后台恢复', async () => {
  const f = fixture(); await legacyMove(f);
  f.node('3').title = '人工重命名';
  const next = fixture({ db: f.c.indexedDB }); next.c.chrome.bookmarks = f.bookmarks;
  const result = await next.c.OrganizerMoves.undo();
  assert.equal(f.node('3').parentId, '1');
  assert.match(result.items.find(i => i.id === '3').error, /人工修改/);
  assert.equal(result.items.filter(i => i.state === 'restored').length, 2);
});
test('移动后日志未确认的中断状态仍可撤销', async () => {
  const f = fixture(); const journal = await legacyMove(f, ['3']);
  journal.items[0].state = 'pending'; delete journal.items[0].after;
  await f.c.AgentDB.setMeta('organizer:journal', journal);
  const result = await f.c.OrganizerMoves.undo();
  assert.equal(result.items[0].state, 'restored'); assert.equal(f.node('3').parentId, '2');
});
test('归档的可撤销旧日志可以逐批恢复，无日志时不改目录', async () => {
  const f = fixture(); const first = await legacyMove(f, ['3']);
  await f.c.AgentDB.setMeta('organizer:history', [{ ...first, undoable: true }]);
  await legacyMove(f, ['4']);
  await f.c.OrganizerMoves.undo(); assert.equal(f.node('4').parentId, '2');
  await f.c.OrganizerMoves.undo(); assert.equal(f.node('3').parentId, '2');
  await assert.rejects(f.c.OrganizerMoves.undo(), /暂无可撤销/);
});
test('旧分类仅作为兼容元数据读取，失效链接的旧分类不用于新页面', async () => {
  const f = fixture(); const rows = f.c.Bookmarks.flatten(f.tree);
  await f.c.AgentDB.setMeta('class:3', { url: f.node('3').url, category: '工作', tags: ['财务'] });
  await f.c.AgentDB.setMeta('class:4', { url: 'https://old.example.com', category: '工具' });
  const records = await f.c.Organizer.records(rows);
  assert.equal(records['3'].category, '工作'); assert.equal(records['4'], undefined);
  assert.equal(f.c.Organizer.classify, undefined); assert.equal(f.c.AI.classify, undefined);
});
