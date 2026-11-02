/* Backup 纯数据层：打包边界、恢复合并、错误分类与自动备份状态。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const root = path.resolve(__dirname, '..');

function defaults() {
  return {
    bg: { mode: 'gradient', imageId: null, url: '' },
    engine: 'bing',
    tags: { enabled: true, aiSuggest: true },
    ai: { enabled: true, apiKey: 'sk-ai', baseUrl: 'https://ai.test/v1', model: 'm' },
    rag: { enabled: false, apiKey: 'sk-rag', baseUrl: 'https://rag.test' },
    wallpaper: { keys: { pexels: 'p' }, token: 'wp-token', history: [{ url: 'x' }] },
    backup: { serverUrl: 'https://backup.test', token: 'secret-token', deviceId: 'default', auto: true }
  };
}

function merge(defaults, saved) {
  const out = JSON.parse(JSON.stringify(defaults));
  Object.keys(saved || {}).forEach(key => {
    const d = out[key];
    const s = saved[key];
    if (s && typeof s === 'object' && !Array.isArray(s) && d && typeof d === 'object' && !Array.isArray(d)) {
      out[key] = merge(d, s);
    } else if (s !== undefined) {
      out[key] = s;
    }
  });
  return out;
}

function context(opts) {
  opts = opts || {};
  const store = opts.store || {};
  const savedSettings = opts.settings || defaults();
  const meta = opts.meta || {};
  const applied = { meta: null, tags: null, settings: null };

  const c = { URL, setTimeout, clearTimeout, console, TextEncoder, crypto: webcrypto };
  c.chrome = {
    storage: {
      local: {
        get(key, cb) { cb({ [key]: store[key] }); },
        set(obj, cb) { Object.assign(store, obj); if (cb) cb(); }
      }
    },
    runtime: { getManifest: () => ({ version: '1.16.0' }) },
    alarms: { create() {}, get() {}, clear() {} },
    permissions: { contains: () => Promise.resolve(true) }
  };
  c.Settings = {
    DEFAULTS: defaults(),
    merge: merge,
    clone: v => JSON.parse(JSON.stringify(v)),
    load: () => Promise.resolve(JSON.parse(JSON.stringify(savedSettings))),
    save: s => { applied.settings = s; return Promise.resolve(); }
  };
  c.AgentDB = {
    getAllMeta: () => Promise.resolve(meta),
    replaceMeta: (entries, isOwned) => { applied.meta = entries; return Promise.resolve(); },
    setMeta: () => Promise.resolve()
  };
  c.QuickTags = {
    restoreState: (tags) => { applied.tags = tags; return Promise.resolve(tags); }
  };
  c.ImageStore = { get: () => Promise.resolve(null) };

  c.self = c;
  vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(root, 'js', 'backup.js'), 'utf8'), c);
  return { c, store, applied, meta };
}

test('打包排除 backup 令牌与壁纸历史，保留 AI/RAG/壁纸 Key', () => {
  const { c } = context();
  const payload = c.Backup.buildPayload({
    settings: defaults(),
    tags: { version: 2, tags: [{ url: 'https://a.com/' }], dismissed: {}, used: {}, updatedAt: 1 },
    meta: { 'auto:rules': { a: 1 }, 'enrich:queue': [1], 'class:bk1': { tags: ['x'] }, builtAt: 1 }
  });

  assert.equal(payload.settings.backup, undefined, 'backup 子树不能进入 payload');
  assert.equal(payload.settings.wallpaper.history, undefined, '壁纸历史可重建');
  assert.equal(payload.settings.ai.apiKey, 'sk-ai');
  assert.equal(payload.settings.rag.apiKey, 'sk-rag');
  assert.equal(payload.settings.wallpaper.token, 'wp-token');
  assert.ok(payload.meta['auto:rules']);
  assert.ok(payload.meta['class:bk1']);
  assert.equal(payload.meta['enrich:queue'], undefined, '队列缓存不应备份');
  assert.equal(payload.meta.builtAt, undefined);
  assert.ok(!JSON.stringify(payload).includes('secret-token'), '备份令牌绝不能出现');
});

test('signature 忽略 backup 与壁纸历史，但会感知 AI Key 变化', () => {
  const { c } = context();
  const a = defaults();
  const b = defaults();
  b.backup.token = 'other';
  b.wallpaper.history = [{ url: 'y' }];
  assert.equal(c.Backup.signature(a), c.Backup.signature(b));

  const d = defaults();
  d.ai.apiKey = 'changed';
  assert.notEqual(c.Backup.signature(a), c.Backup.signature(d));
});

test('恢复设置保留本机 backup 连接，图片丢失时回退渐变', async () => {
  const { c, applied } = context();
  const current = defaults();
  current.backup = { serverUrl: 'https://local.test', token: 'local-token', deviceId: 'my-pc', auto: true };

  const incoming = defaults();
  incoming.backup = { serverUrl: 'https://remote.test', token: 'remote-token' };
  incoming.bg = { mode: 'image', imageId: 99, url: '' };

  const payload = c.Backup.buildPayload({ settings: incoming, tags: { tags: [] }, meta: {} });
  const summary = await c.Backup.apply(payload, { currentSettings: current });

  assert.equal(summary.tags, 0);
  assert.equal(applied.settings.backup.serverUrl, 'https://local.test', '本机备份连接不能被覆盖');
  assert.equal(applied.settings.backup.token, 'local-token');
  assert.equal(applied.settings.bg.mode, 'gradient', '图片不备份，恢复后回退渐变');
  assert.equal(applied.settings.bg.imageId, null);
});

test('校验：版本/设置/标签结构错误会被拒绝', () => {
  const { c } = context();
  assert.throws(() => c.Backup.validatePayload(null), /有效 JSON/);
  assert.throws(() => c.Backup.validatePayload({ schema: 9 }), /版本不兼容/);
  assert.throws(() => c.Backup.validatePayload({ schema: 1 }), /缺少设置/);
  assert.throws(() => c.Backup.validatePayload({ schema: 1, settings: {}, tags: {} }), /缺少标签/);
});

test('自动备份错误分类：401/413 不重试，网络错误指数退避', () => {
  const { c } = context();
  assert.equal(c.Backup.noRetry('http_401'), true);
  assert.equal(c.Backup.noRetry('http_403'), true);
  assert.equal(c.Backup.noRetry('http_413'), true);
  assert.equal(c.Backup.noRetry('permission_missing'), true);
  assert.equal(c.Backup.noRetry('network'), false);
  assert.equal(c.Backup.retryDelay(0), 5 * 60 * 1000);
  assert.equal(c.Backup.retryDelay(3), 40 * 60 * 1000);
  assert.equal(c.Backup.retryDelay(20), 6 * 60 * 60 * 1000);
});

test('collect 只打包白名单 meta，并返回可校验的 sha256', async () => {
  const store = {};
  const { c } = context({
    store,
    meta: { 'auto:config': { on: true }, 'rag:sync:x': { p: 1 }, 'doc:alias:k': { id: 1 } }
  });
  store['newtab.tags.v1'] = { version: 2, tags: [{ url: 'https://a.com/' }], dismissed: {}, used: {}, updatedAt: 1 };
  const pack = await c.Backup.collect();
  assert.ok(pack.payload.meta['auto:config']);
  assert.ok(pack.payload.meta['doc:alias:k']);
  assert.equal(pack.payload.meta['rag:sync:x'], undefined);
  assert.match(pack.sha256, /^[a-f0-9]{64}$/);
  assert.ok(pack.sizeBytes > 0);
});
