/* 个人字段参与检索，但与网页正文分离且不跨路径关联。 */
const test = require('node:test'); const assert = require('node:assert/strict'); const { fixture } = require('./helpers/extension');
test('007 关联真实目标，/ 查书签，个人说明与正文分离', async () => {
  const { c } = fixture(); c.QuickTags._inject({ tags: [{ id: 'p', label: '公司平台', aliases: ['007'], note: '报销入口', url: 'https://portal.example.com/oa' }] });
  const rows = [{ id: 'a', title: '企业协同平台', url: 'https://portal.example.com/oa', host: 'portal.example.com', text: '' }, { id: 'b', title: '财务', url: 'https://portal.example.com/finance', host: 'portal.example.com' }];
  await c.PersonalTargets.hydrate(rows);
  assert.equal(c.Bookmarks.query(rows, '007').length, 1); assert.equal(c.Bookmarks.query(rows, '报销')[0].row.id, 'a');
  assert.equal(rows[0].text, ''); assert.deepEqual(Array.from(rows[1].personalNames || []), []);
  let calls = 0; c.AI.available = () => true;
  c.BookmarkAnswer.runStream = async options => {
    calls++; assert.match(options.cands[0].row.personalEvidence, /用户填写[\s\S]*007[\s\S]*报销入口/);
    return { ok: true, answer: '根据你的备注，这是报销入口，具体操作流程尚无证据。', sources: [] };
  };
  const result = await c.BookmarkSearch.run({ rows, query: '007怎么报销', cfg: {}, answer: true });
  assert.match(result.answer.text, /根据你的备注/); assert.equal(calls, 1);
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

test('人工资料可作问答依据且保留来源，受限正文不会跟随备注进入证据', async () => {
  const { c } = fixture();
  c.QuickTags._inject({ tags: [{ id: 'p', label: '公司平台', aliases: ['007'], note: '用于请假', url: 'https://portal.example.com/oa' }] });
  const rows = [{ id: 'a', title: '企业平台', url: 'https://portal.example.com/oa', text: '受限正文不可带出', admissionState: 'excluded' }];
  await c.PersonalTargets.hydrate(rows);
  const evidence = c.BookmarkAnswer.buildEvidence(rows, '请假');
  assert.equal(evidence.length, 1); assert.match(evidence[0].text, /用户填写[\s\S]*007[\s\S]*用于请假/);
  assert.doesNotMatch(evidence[0].text, /受限正文/);
  const candidate = c.AI.toCandidate(rows[0], Date.now(), '请假');
  assert.match(candidate.user_annotation, /用于请假/);
  c.QuickTags._inject({ tags: [] }); await c.PersonalTargets.hydrate(rows);
  assert.equal(c.BookmarkAnswer.buildEvidence(rows, '请假').length, 0);
});
