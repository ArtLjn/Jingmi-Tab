/* 验证后台按钮、脚本注入和内容落库的连接，不操作真实用户标签页。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { IDBFactory } = require('fake-indexeddb');
const { DOMParser } = require('linkedom');
const root = path.resolve(__dirname, '..');

test('工具栏只采集已收藏的当前网页，持久化正文并拒绝跳转和特殊页面', async () => {
  let listener;
  let injected = 0;
  let badge;
  let title;
  const url = 'https://example.com/doc';
  const document = new DOMParser().parseFromString('<html><head><title>工作文档</title></head><body><article>应收凭证内部接口</article></body></html>', 'text/html');
  const page = { URL, DOMParser, location: { href: url, hostname: 'example.com' }, document, setTimeout,
    getComputedStyle: () => ({ overflowY: 'visible', display: 'block' }) };
  page.self = page;
  vm.createContext(page);
  const worker = { URL, crypto: require('node:crypto').webcrypto, TextEncoder, indexedDB: new IDBFactory(), setTimeout, clearTimeout };
  worker.self = worker;
  worker.chrome = {
    bookmarks: { getTree: async () => [{ children: [{ id: '1', url, title: '工作文档' }] }] },
    permissions: { contains: async () => false },
    runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} } },
    action: {
      onClicked: { addListener(fn) { listener = fn; } },
      setBadgeText: async value => { badge = value.text; },
      setTitle: async value => { title = value.title; }
    },
    scripting: { executeScript: async options => {
      injected++;
      if (options.files) {
        for (const file of options.files) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), page);
        return [];
      }
      return [{ result: await vm.runInContext('(' + options.func.toString() + ')()', page) }];
    } }
  };
  vm.createContext(worker);
  worker.importScripts = (...files) => { for (const file of files) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), worker); };
  vm.runInContext(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'), worker);
  await listener({ id: 1, url });
  assert.equal(badge, '已存', title);
  assert.equal(injected, 2);
  const saved = (await worker.AgentDB.getPages([url]))[url];
  assert.equal(saved.source, 'capture');
  assert.match(saved.text, /应收凭证内部接口/);
  await listener({ id: 2, url: 'https://example.com/unbookmarked' });
  assert.equal(badge, '失败');
  assert.match(title, /先收藏/);
  assert.equal(injected, 2);
  await listener({ id: 3, url: 'chrome://settings' });
  assert.match(title, /不支持/);
  page.location.href = 'https://example.com/redirected';
  await listener({ id: 1, url });
  assert.equal(badge, '失败');
  assert.match(title, /已跳转/);
  assert.equal((await worker.AgentDB.getPages([url]))[url].text, saved.text);
});
