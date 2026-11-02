/* 账号切换时扩展重启后的页面恢复，不读取或修改真实账号。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function setup(url, pageDocument, sharedValues) {
  const values = sharedValues || { 'newtab.session.v1': { version: 'v2', user: null, token: '' },
    'newtab.profile.landing.v1': { tabId: 9, version: 'v2', at: Date.now() } };
  const updates = [];
  const listeners = [];
  var reloads = 0;
  const c = { crypto: require('node:crypto').webcrypto, URL, AbortController, setTimeout, clearTimeout,
    chrome: { runtime: { getURL: p => 'chrome-extension://test/' + p },
      storage: { local: { get: (k, cb) => cb({ [k]: values[k] }), set: (v, cb) => { Object.assign(values, v); cb(); } }, onChanged: { addListener(fn) { listeners.push(fn); } } },
      tabs: { get: async () => ({ id: 9, url }), update: async (id, value) => updates.push({ id, ...value }) } } };
  if (pageDocument) { c.document = pageDocument; c.location = { reload() { reloads++; } }; }
  c.self = c; vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/profiles.js'), 'utf8'), c);
  return { c, values, updates, listeners, reloads: () => reloads };
}
test('后台重启后只恢复刚切换账号的扩展页，不覆盖用户已导航的其他页面', async () => {
  const f = setup('chrome-extension://test/newtab.html');
  await f.c.Profiles.restoreLanding();
  assert.equal(f.updates.length, 1);
  assert.equal(f.updates[0].url, 'chrome-extension://test/newtab.html');
  assert.equal(f.values['newtab.profile.landing.v1'], null);
  await f.c.Profiles.restoreLanding();
  assert.equal(f.updates.length, 1);
  const other = setup('https://example.com/');
  await other.c.Profiles.restoreLanding();
  assert.equal(other.updates.length, 0);
});

test('没有 tabs 权限读不到标签 URL 时，仍恢复本轮切换登记的新标签页', async () => {
  const f = setup(undefined);
  await f.c.Profiles.restoreLanding();
  assert.equal(f.updates.length, 1);
  assert.equal(f.updates[0].url, 'chrome-extension://test/newtab.html');
  assert.equal(f.values['newtab.profile.landing.v1'], null);
});


test('HTTP 兼容路径的账号切换事件重复送达时只重载一次，期间不隐藏整个文档', async () => {
  var shown;
  const doc = { documentElement: { style: {} }, body: { replaceChildren(node) { shown = node; } },
    createElement() { return { style: {}, setAttribute() {}, textContent: '' }; } };
  const f = setup('chrome-extension://test/newtab.html', doc);
  await f.c.Profiles.initial();
  const changed = { 'newtab.session.v1': { newValue: { version: 'v3', user: null, token: '' } } };
  f.listeners[0](changed, 'local');
  f.listeners[0](changed, 'local');
  assert.equal(f.reloads(), 1);
  assert.equal(doc.documentElement.style.visibility, undefined);
  assert.match(shown.textContent, /正在切换账号/);
});


test('真实 activate 代码路径先落恢复标记，登录页不抢先重载，随后由新后台恢复已就绪的扩展页', async () => {
  var shown;
  const doc = { documentElement: { style: {} }, body: { replaceChildren(node) { shown = node; } },
    createElement() { return { style: {}, setAttribute() {}, textContent: '' }; } };
  const f = setup('chrome://newtab/', doc);
  f.c.chrome.runtime.id = 'test';
  f.c.chrome.tabs.getCurrent = async () => ({ id: 9 });
  f.values['newtab.profile.legacy-owner.v1'] = { id: 1, username: '原有账号' };
  f.values['newtab.profile.user-2:initialized'] = { at: 1 };
  f.c.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: { kind: 'session', user: { id: 2, username: '测试账号' } } }) });
  await f.c.Profiles.activate({ user: { id: 2, username: '测试账号' }, token: '仅用于测试的会话' });
  assert.equal(f.reloads(), 0, '旧扩展卸载期间不能抢先重载页面');
  assert.match(shown.textContent, /正在切换账号/);
  assert.equal(f.values['newtab.profile.landing.v1'].version, f.values['newtab.session.v1'].version);
  const worker = setup('chrome://newtab/', undefined, f.values);
  await worker.c.Profiles.restoreLanding();
  assert.equal(worker.updates.length, 1);
  assert.equal(worker.updates[0].url, 'chrome-extension://test/newtab.html');
  assert.equal(f.values['newtab.profile.landing.v1'], null);
});

test('其他已打开的扩展页清除旧账号内容并提示刷新，不自动进入卸载中的扩展地址', async () => {
  var shown;
  const doc = { documentElement: { style: {} }, body: { replaceChildren(node) { shown = node; } },
    createElement() { return { style: {}, setAttribute() {}, textContent: '' }; } };
  const f = setup('chrome://newtab/', doc);
  f.c.chrome.runtime.id = 'test';
  await f.c.Profiles.initial();
  f.listeners[0]({ 'newtab.session.v1': { newValue: { version: 'v3', user: null, token: '' } } }, 'local');
  assert.equal(f.reloads(), 0);
  assert.match(shown.textContent, /刷新此页/);
});

test('退出登录同样等待新后台恢复扩展页，不导航到 Chrome 原生首页', async () => {
  var shown;
  const doc = { documentElement: { style: {} }, body: { replaceChildren(node) { shown = node; } },
    createElement() { return { style: {}, setAttribute() {}, textContent: '' }; } };
  const f = setup('chrome-extension://test/newtab.html', doc);
  f.values['newtab.session.v1'] = { version: 'logged-in', user: { id: 2, username: '测试账号' }, token: '测试会话' };
  f.c.chrome.runtime.id = 'test';
  f.c.chrome.tabs.getCurrent = async () => ({ id: 9 });
  await f.c.Profiles.logout();
  assert.equal(f.reloads(), 0);
  assert.equal(f.values['newtab.session.v1'].user, null);
  assert.match(shown.textContent, /正在切换账号/);
  const worker = setup('chrome-extension://test/newtab.html', undefined, f.values);
  await worker.c.Profiles.restoreLanding();
  assert.equal(worker.updates[0].url, 'chrome-extension://test/newtab.html');
});
