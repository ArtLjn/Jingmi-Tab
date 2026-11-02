/* 收录决策的业务边界：不以字数或采集器能力判断网站生死。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/extension');
function sample() { return { id: 'a', bookmarks: [{ id: 'b' }], text: '', source: 'public', captureState: 'failed' }; }
test('短正文可收录，长个人说明或描述不能充当正文', () => {
  const { c } = fixture(); const d = sample();
  assert.equal(c.IngestPolicy.evaluate({ ...d, text: '周一至周五开放。', captureState: 'ready' }, {}).state, 'eligible');
  assert.equal(c.IngestPolicy.evaluate({ ...d, desc: '描述'.repeat(1000), note: '说明'.repeat(1000) }, {}).state, 'metadata');
});
test('临时失败保留旧版，任意 receipt 不能冒充合格正文', () => {
  const { c } = fixture(); const d = sample();
  const verdict = c.IngestPolicy.evaluate(d, {}, { receipt: { docId: 'old', quality: 'body' }, error: { code: 'timeout' } });
  assert.equal(verdict.state, 'deferred'); assert.equal(verdict.action, 'hold'); assert.equal(verdict.previous, true);
  assert.equal(c.IngestPolicy.evaluate(d, {}, { receipt: { docId: 'metadata' }, error: { code: 'timeout' } }).previous, false);
});
test('404 必须间隔 24 小时且是新观察；同缓存不累计', () => {
  const { c } = fixture(); const now = 200000000;
  const d = { ...sample(), invalidCandidate: { firstSeenAt: now - 86400001, lastSeenAt: now - 1000, count: 1 } };
  assert.equal(c.IngestPolicy.evaluate(d, { cleanupEnabled: true }, { now, error: { code: 'http_404', observedAt: now - 1000 } }).action, 'hold');
  assert.equal(c.IngestPolicy.evaluate(d, { cleanupEnabled: true }, { now, error: { code: 'http_404', observedAt: now } }).action, 'delete');
  assert.equal(c.IngestPolicy.evaluate(d, { cleanupEnabled: false }, { now, error: { code: 'http_404', observedAt: now } }).action, 'hold');
});
test('请求错误、不支持和权限失败都不能自动删正文；撤权优先', () => {
  const { c } = fixture();
  for (const code of ['http_400','http_422','unsupported','not_html','waiting_permission','http_403']) assert.equal(c.IngestPolicy.evaluate(sample(), { cleanupEnabled: true }, { error: { code } }).action, 'hold', code);
  assert.equal(c.IngestPolicy.evaluate({ ...sample(), private: true, text: '正文' }, { includePrivate: false }, {}).action, 'delete');
});
