/* 升级回归：旧版自动整理设置不会重新启用；新归档只按域名规则执行。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./helpers/extension');
const root = path.resolve(__dirname, '..');

test('旧自动整理设置被忽略，未命中域名规则时后台不移动书签', async () => {
  let mutated = 0; let modelCalls = 0; let alarm;
  const f = fixture({ fetch: async () => { modelCalls++; throw new Error('不应调用模型'); } });
  f.c.chrome.bookmarks.create = async () => { mutated++; throw new Error('不应创建书签'); };
  f.c.chrome.bookmarks.move = async () => { mutated++; throw new Error('不应修改目录'); };
  const events = {};
  for (const name of ['onCreated', 'onMoved', 'onRemoved', 'onChanged', 'onChildrenReordered']) {
    events[name] = []; f.c.chrome.bookmarks[name] = { addListener(fn) { events[name].push(fn); } };
  }
  f.c.chrome.runtime = { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} } };
  f.c.chrome.action = { onClicked: { addListener() {} } };
  f.c.chrome.permissions = { contains: async () => false };
  f.c.chrome.alarms = { get: async () => ({}), onAlarm: { addListener(fn) { alarm = fn; } } };
  f.c.chrome.storage = {
    local: {
      get: (key, cb) => cb({ [key]: { organizer: { autoClassify: true, autoMove: true }, ai: { enabled: false } } }),
      set: (value, cb) => cb && cb()
    }
  };
  f.c.importScripts = (...files) => { for (const file of files) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), f.c); };
  vm.runInContext(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'), f.c);

  const settings = await f.c.Settings.load();
  assert.equal(settings.organizer, undefined);
  assert.equal(f.c.HANDLERS['organizer:run'], undefined);
  assert.equal(f.c.HANDLERS['organizer:apply'], undefined);
  /* 新模块存在，但旧设置不会让它移动任何书签。 */
  assert.equal(typeof f.c.AutoOrganizer, 'object');
  assert.equal(typeof f.c.HANDLERS['auto:status'], 'function');
  assert.equal(events.onCreated.length, 2); assert.equal(events.onMoved.length, 2);

  await events.onCreated[events.onCreated.length - 1]('999', {
    id: '999', parentId: '2', index: 0, title: '陌生站点', url: 'https://unknown.example.com/'
  });
  await alarm({ name: f.c.SyncEngine.ALARM }); await f.c.rebuild();
  assert.equal(mutated, 0);
  assert.equal(modelCalls, 0);

  const state = await f.c.HANDLERS['auto:status']();
  assert.equal(state.enabled, true);
  assert.equal(state.rules.length, 0);
  assert.equal(state.pending.length, 0);
});
