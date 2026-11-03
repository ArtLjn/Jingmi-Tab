/* 网站身份与公开介绍的来源边界，不把平台简介当成具体文档正文。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/extension');
test('只有可识别的书签名称才可降级为网站资料；登录提示和裸网址不凑数', () => {
  const { c } = fixture();
  const doc = { identity: { canonicalUrl: 'https://example.com/a' }, bookmarks: [{ title: 'Milvus 向量数据库文档' }] };
  assert.equal(c.SiteProfile.build(doc).evidence, 'bookmark_identity');
  assert.equal(c.SiteProfile.build({ ...doc, bookmarks: [{ title: '登录' }, { title: 'https://example.com' }, { title: '1721899249142962.pdf' }] }), null);
  const verdict = c.IngestPolicy.evaluate({ ...doc, captureError: 'timeout' }, {});
  assert.equal(verdict.quality, 'profile'); assert.equal(verdict.includeBody, false);
});
test('公开描述可单独收录，私有描述不能随网站资料默认上传', () => {
  const { c } = fixture();
  const doc = { identity: { canonicalUrl: 'https://example.com/a' }, bookmarks: [{ title: '图像工具' }], desc: '支持压缩和裁剪图片', source: 'public' };
  assert.equal(c.SiteProfile.build(doc).description, doc.desc);
  assert.equal(c.SiteProfile.build({ ...doc, source: 'capture', private: true }).description, '');
  assert.equal(c.IngestPolicy.evaluate({ ...doc, source: 'capture', private: true }, { includePrivate: false }).action, 'delete');
});
test('平台介绍保留来源并明确与文档内容分开，书签调整顺序不改变资料', () => {
  const { c } = fixture();
  const doc = { identity: { canonicalUrl: 'https://example.com/private/doc' }, bookmarks: [{ title: '技术资产' }, { title: '资产资料' }], publicProfile: { description: '团队知识管理工具', scope: 'site', sourceUrl: 'https://example.com/' } };
  const profile = c.SiteProfile.build(doc);
  assert.match(c.SiteProfile.describe(profile), /不代表当前文档内容[\s\S]*https:\/\/example.com\//);
  assert.equal(JSON.stringify(c.SiteProfile.build({ ...doc, bookmarks: doc.bookmarks.slice().reverse() })), JSON.stringify(profile));
});
