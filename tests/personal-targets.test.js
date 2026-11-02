/* 个人字段只参与本地定位，不能泄漏为正文或跨域名关联。 */
const test = require('node:test'); const assert = require('node:assert/strict'); const { fixture } = require('./helpers/extension');
test('007 关联真实目标，/ 查书签，个人说明与正文分离', async () => {
  const { c } = fixture(); c.QuickTags._inject({ tags: [{ id: 'p', label: '公司平台', aliases: ['007'], note: '报销入口', url: 'https://portal.example.com/oa' }] });
  const rows = [{ id: 'a', title: '企业协同平台', url: 'https://portal.example.com/oa', host: 'portal.example.com', text: '' }, { id: 'b', title: '财务', url: 'https://portal.example.com/finance', host: 'portal.example.com' }];
  await c.PersonalTargets.hydrate(rows);
  assert.equal(c.Bookmarks.query(rows, '007').length, 1); assert.equal(c.Bookmarks.query(rows, '报销')[0].row.id, 'a');
  assert.equal(rows[0].text, ''); assert.deepEqual(Array.from(rows[1].personalNames || []), []);
  let calls = 0; c.AI.available = () => true; c.AI.chatStream = () => { calls++; };
  const result = await c.BookmarkSearch.run({ rows, query: '007怎么报销', cfg: {}, answer: true });
  assert.match(result.message, /无可用正文/); assert.equal(calls, 0);
  assert.doesNotMatch(c.PersonalTargets.resolve('007怎么报销', rows).query, /007|报销入口/);
});
test('删除别名立刻移出索引，非书签入口仅在 ? 可定位', async () => {
  const { c } = fixture(); c.QuickTags._inject({ tags: [{ id: 'p', label: '公司平台', aliases: ['007'], url: 'https://portal.example.com/' }] });
  const rows = [{ id: 'a', title: '平台', url: 'https://portal.example.com/' }]; await c.PersonalTargets.hydrate(rows);
  c.QuickTags._inject({ tags: [] }); await c.PersonalTargets.hydrate(rows); assert.equal(c.Bookmarks.query(rows, '007').length, 0);
  c.QuickTags._inject({ tags: [{ id: 'p', label: '公司平台', aliases: ['007'], url: 'https://portal.example.com/' }] });
  const result = await c.BookmarkSearch.run({ rows: [], query: '007怎么报销', cfg: {}, answer: true }); assert.equal(result.hits.length, 1); assert.match(result.message, /尚无可用正文/);
  assert.equal(c.Bookmarks.query([], '007').length, 0);
});
