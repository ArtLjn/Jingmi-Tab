/* TagSuggest 纯逻辑：候选映射、隐私边界、缓存与失败退避。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

function context(opts) {
  opts = opts || {};
  const store = {};
  let aiCalls = 0;

  const c = { URL, setTimeout, clearTimeout, console };
  c.chrome = {
    storage: {
      local: {
        get(key, cb) { cb({ [key]: store[key] }); },
        set(obj, cb) { Object.assign(store, obj); if (cb) cb(); }
      }
    }
  };
  c.localStorage = {
    getItem(k) { return store[k] === undefined ? null : JSON.stringify(store[k]); },
    setItem(k, v) { store[k] = JSON.parse(v); }
  };
  c.AI = {
    available(cfg) { return !!(cfg && cfg.enabled); },
    parseLoose(text) { try { return JSON.parse(text); } catch (e) { return null; } },
    chat(cfg, system, user) {
      aiCalls++;
      if (opts.chat) return opts.chat(cfg, system, user);
      return Promise.resolve({
        ok: true,
        content: JSON.stringify({ picks: [{ id: 'c1', name: '打卡' }] })
      });
    }
  };

  c.self = c;
  vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(root, 'js', 'quick-tags.js'), 'utf8'), c);
  vm.runInContext(fs.readFileSync(path.join(root, 'js', 'tag-suggest.js'), 'utf8'), c);

  c.QuickTags._inject({ tags: [] });
  return { c, store, calls: () => aiCalls };
}

const CFG = { enabled: true, baseUrl: 'https://ai.test/v1', apiKey: 'k', model: 'm' };
const CTX = {
  topSites: [
    { url: 'https://oa.hongdi.com/', title: 'OA 打卡' },
    { url: 'https://github.com/', title: 'GitHub' }
  ],
  rows: []
};

test('AI 条目只映射当前候选，旧缓存 host 不存在时跳过', async () => {
  const { c } = context();
  await c.TagSuggest.load();
  c.TagSuggest._inject({
    fingerprint: 'x',
    expiresAt: Date.now() + 1000,
    picks: [{ host: 'oa.hongdi.com', name: '打卡', rank: 0 }, { host: 'gone.com', name: '旧', rank: 1 }]
  });
  const entries = c.TagSuggest.entries(CTX, CFG);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].host, 'oa.hongdi.com');
  assert.equal(entries[0].label, '打卡');
  assert.equal(entries[0].url, 'https://oa.hongdi.com/');
});

test('请求只发送标题与域名，不发送完整 URL/路径/文件夹', async () => {
  let sent = '';
  const { c } = context({
    chat: (cfg, system, user) => { sent = user; return Promise.resolve({ ok: true, content: '{"picks":[{"id":"c1","name":"打卡"}]}' }); }
  });
  await c.TagSuggest.load();
  const ok = await c.TagSuggest.ensure(CTX, CFG);
  assert.equal(ok, true);
  assert.ok(sent.includes('oa.hongdi.com'));
  assert.ok(!sent.includes('http://'), '不能发送完整协议头');
  assert.ok(!sent.includes('/v1'), '不能把接口路径等无关内容混进去');
  assert.ok(!sent.includes('folder'), '不能发送书签文件夹');
});

test('非法 id、空名、重复 host 被丢弃，合法短名保留', async () => {
  const { c } = context({
    chat: () => Promise.resolve({
      ok: true,
      content: JSON.stringify({ picks: [
        { id: 'c1', name: '  打卡\n' },
        { id: 'c99', name: '不存在' },
        { id: 'c2', name: '' },
        { id: 'c1', name: '重复' }
      ] })
    })
  });
  await c.TagSuggest.load();
  await c.TagSuggest.ensure(CTX, CFG);
  const picks = c.TagSuggest.status().picks;
  assert.equal(picks.length, 1);
  assert.equal(picks[0].host, 'oa.hongdi.com');
  assert.equal(picks[0].name, '打卡');
});

test('24 小时内不重复请求，过期后重新请求', async () => {
  const { c, calls } = context();
  await c.TagSuggest.load();
  assert.equal(await c.TagSuggest.ensure(CTX, CFG), true);
  assert.equal(calls(), 1);
  assert.equal(await c.TagSuggest.ensure(CTX, CFG), false, '缓存有效时不应再请求');
  assert.equal(calls(), 1);

  const fresh = c.TagSuggest.status();
  c.TagSuggest._inject(Object.assign({}, fresh, { expiresAt: Date.now() - 1 }));
  assert.equal(await c.TagSuggest.ensure(CTX, CFG), true, '过期后应刷新');
  assert.equal(calls(), 2);
});

test('AI 失败保留旧缓存，并在 15 分钟内退避', async () => {
  let fail = false;
  const { c, calls } = context({
    chat: () => fail
      ? Promise.resolve({ ok: false, error: 'timeout' })
      : Promise.resolve({ ok: true, content: '{"picks":[{"id":"c1","name":"打卡"}]}' })
  });
  await c.TagSuggest.load();
  await c.TagSuggest.ensure(CTX, CFG);
  const before = c.TagSuggest.status();
  assert.equal(before.picks.length, 1);

  fail = true;
  c.TagSuggest._inject(Object.assign({}, before, { expiresAt: Date.now() - 1 }));
  assert.equal(await c.TagSuggest.ensure(CTX, CFG), false);
  assert.equal(c.TagSuggest.status().picks.length, 1, '失败不应清掉旧缓存');
  assert.equal(c.TagSuggest.status().lastError, 'timeout');

  assert.equal(await c.TagSuggest.ensure(CTX, CFG), false, '失败退避期内不再请求');
  assert.equal(calls(), 2);
});

test('AI 未配置时不请求也不展示', async () => {
  const { c, calls } = context();
  await c.TagSuggest.load();
  assert.deepEqual(Array.from(c.TagSuggest.entries(CTX, { enabled: false })), []);
  assert.equal(await c.TagSuggest.ensure(CTX, { enabled: false }), false);
  assert.equal(calls(), 0);
});
