const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fixture } = require('./helpers/extension');

test('体检报告识别重复、失效、无正文和空目录', () => {
  const f = fixture();
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/bookmark-health.js'), 'utf8'), f.c);
  const tree = [{ id: '0', title: '', children: [
    { id: '1', title: '空目录', children: [] },
    { id: '2', title: '资料', children: [
      { id: '3', title: 'A', url: 'https://example.com/a' },
      { id: '4', title: 'A 副本', url: 'https://example.com/a' },
      { id: '5', title: '失效页', url: 'https://example.com/missing' }
    ] }
  ] }];
  const rows = f.c.Bookmarks.flatten(tree);
  const issues = f.c.BookmarkHealth.inspect(tree, rows, {
    'https://example.com/a': { status: 'ok', text: '可用正文' },
    'https://example.com/missing': { status: 'fail', reason: 'http_404' }
  });
  assert.ok(issues.some(issue => issue.kind === '重复网址' && issue.id === '4'));
  assert.ok(issues.some(issue => issue.kind === '失效链接' && issue.id === '5'));
  assert.ok(issues.some(issue => issue.kind === '无正文' && issue.id === '5'));
  assert.ok(issues.some(issue => issue.kind === '空目录' && issue.id === '1'));
});
