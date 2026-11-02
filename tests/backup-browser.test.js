/* 真实 Chrome 回归：账号注册/登录 → 备份 → 修改本机 → 恢复。
   备份服务用本地 HTTP 替身，不依赖 MySQL。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const executablePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('浏览器回归：账号注册/登录、备份与两步恢复', { skip: !fs.existsSync(executablePath), timeout: 60000 }, async () => {
  let savedPayload = null;
  let lastPutRaw = '';
  let account = null;
  let issued = 0;
  const originHolder = { origin: '' };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, data, headers) => {
      res.writeHead(status, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, headers || {}));
      res.end(JSON.stringify(data));
    };
    const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const authorized = bearer === 'test-token' || /^session-\d+$/.test(bearer);
    const readBody = cb => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        try { cb(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
        catch (e) { cb(null); }
      });
    };
    const issue = username => {
      const token = 'session-' + (++issued);
      send(200, { ok: true, data: {
        token,
        expires_at: '2026-12-01T00:00:00Z',
        user: { id: 2, username }
      } });
    };

    if (url.pathname === '/health') { send(200, { ok: true, service: 'test', version: '1.1.0' }); return; }
    if (url.pathname === '/api/auth/register' && req.method === 'POST') {
      readBody(body => {
        if (!body || !body.username.includes('@') || body.invite_code !== 'browser-test-invite') {
          send(422, { ok: false, error: { code: 'invalid_payload', message: '邮箱格式不正确' } });
          return;
        }
        account = { username: body.username, password: body.password };
        issue(account.username);
      });
      return;
    }
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      readBody(body => {
        if (!account || !body || body.username !== account.username || body.password !== account.password) {
          send(401, { ok: false, error: { code: 'invalid_credentials', message: '账号或密码错误' } });
          return;
        }
        issue(account.username);
      });
      return;
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      send(200, { ok: true, data: { loggedOut: true } });
      return;
    }
    if (url.pathname === '/api/auth/me') {
      if (!authorized) { send(401, { ok: false, error: { code: 'unauthorized', message: 'bad session' } }); return; }
      send(200, { ok: true, data: { user: { id: 2, username: account ? account.username : 'demo' }, kind: 'session' } });
      return;
    }
    if (url.pathname === '/api/backup/meta') {
      if (!authorized) { send(401, { ok: false, error: { code: 'unauthorized', message: 'bad session' } }); return; }
      send(200, { ok: true, data: savedPayload ? {
        last_backup_at: '2026-11-01 08:00:00',
        size_bytes: JSON.stringify(savedPayload).length,
        sha256: 'x'.repeat(64),
        schema: 1,
        device_id: 'default',
        history_count: 1
      } : null });
      return;
    }
    if (url.pathname === '/api/backup' && req.method === 'PUT') {
      if (!authorized) { send(401, { ok: false, error: { code: 'unauthorized', message: 'bad session' } }); return; }
      readBody(body => {
        if (!body) { send(422, { ok: false, error: { code: 'invalid_payload', message: 'bad json' } }); return; }
        lastPutRaw = JSON.stringify(body);
        savedPayload = body.payload;
        send(200, { ok: true, data: {
          id: 1, device_id: body.device_id, created_at: '2026-11-01 08:00:00',
          size_bytes: lastPutRaw.length, sha256: 'x'.repeat(64), deduped: false
        } });
      });
      return;
    }
    if (url.pathname === '/api/backup' && req.method === 'GET') {
      if (!authorized) { send(401, { ok: false, error: { code: 'unauthorized', message: 'bad session' } }); return; }
      if (!savedPayload) { send(404, { ok: false, error: { code: 'not_found', message: 'empty' } }); return; }
      send(200, { ok: true, data: { id: 1, payload: savedPayload, created_at: '2026-11-01 08:00:00' } });
      return;
    }

    /* 静态文件 */
    const file = path.resolve(root, '.' + url.pathname);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
    res.end(fs.readFileSync(file));
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  originHolder.origin = 'http://127.0.0.1:' + server.address().port;

  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === originHolder.origin ? route.continue() : route.fulfill({ status: 200, body: '' }));
    await context.addInitScript(({ serverOrigin }) => {
      window.__BACKUP_SERVER__ = serverOrigin;
      const load = () => { try { return JSON.parse(localStorage.getItem('__stub') || '{}'); } catch (e) { return {}; } };
      const save = () => localStorage.setItem('__stub', JSON.stringify(store));
      const store = load();
      window.__store = store;
      window.chrome = {
        storage: {
          local: {
            get: (key, cb) => { const out = {}; if (typeof key === 'string' && store[key] !== undefined) out[key] = store[key]; cb && cb(out); },
            set: (obj, cb) => { Object.assign(store, obj); save(); cb && cb(); },
            remove: (key, cb) => { delete store[key]; save(); cb && cb(); }
          },
          onChanged: { addListener: () => {} }
        },
        bookmarks: {
          getTree: cb => cb([{ id: '0', title: '', children: [] }]),
          onCreated: { addListener: () => {} }, onRemoved: { addListener: () => {} },
          onChanged: { addListener: () => {} }, onMoved: { addListener: () => {} },
          onChildrenReordered: { addListener: () => {} }
        },
        topSites: { get: cb => cb([]) },
        runtime: { lastError: null, id: 'test', getURL: p => p, getManifest: () => ({ version: '1.16.0' }), onMessage: { addListener: () => {} }, sendMessage: () => Promise.resolve({}) },
        permissions: { request: () => Promise.resolve(true), contains: () => Promise.resolve(true), onAdded: { addListener: () => {} }, onRemoved: { addListener: () => {} } },
        alarms: { create: () => {}, get: () => {}, clear: () => {}, onAlarm: { addListener: () => {} } },
        tabs: { create: () => {}, query: (q, cb) => { cb && cb([]); } },
        contextMenus: { create: () => {} },
        i18n: { getMessage: k => k }
      };
    }, { serverOrigin: originHolder.origin });

    const page = await context.newPage();
    await page.goto(originHolder.origin + '/newtab.html');
    await page.waitForFunction(() => window.__store !== undefined);

    assert.equal(await page.locator('#account-modal').isVisible(), false, '新用户进入首页时不弹出登录');
    const defaults = await page.evaluate(async () => window.Settings.load());
    assert.equal(defaults.backup.authToken, '');
    assert.equal(defaults.ai.enabled, false);
    assert.equal(defaults.rag.enabled, false);
    await page.locator('#settings-btn').click();
    await page.locator('#workspace-tab-search').click();
    await page.locator('#search-overview [data-search-target="settings"]').click();
    await page.locator('#ai-key').fill('sk-guest');
    await page.locator('#ai-key').dispatchEvent('change');
    await page.waitForFunction(() => (window.__store['newtab.profile.guest:newtab.settings.v1'] || {}).ai?.apiKey === 'sk-guest');
    await page.locator('#workspace-account').click();
    await page.waitForFunction(() => !document.querySelector('#account-modal').hidden);

    /* 未登录只显示两个字段，注册时才出现确认密码。 */
    assert.equal(await page.locator('#backup-account-form input:visible').count(), 2);
    assert.equal(await page.locator('#backup-actions').isVisible(), false);
    assert.equal(await page.locator('#backup-invite').isVisible(), false);
    await page.locator('#backup-register').click();
    assert.equal(await page.locator('#backup-account-form input:visible').count(), 4);
    await page.locator('#backup-username').fill('demo@example.com');
    await page.locator('#backup-password').fill('demo-pass');
    await page.locator('#backup-confirm-password').fill('different-pass');
    await page.locator('#backup-invite').fill('browser-test-invite');
    await page.locator('#backup-register').click();
    await page.waitForFunction(() => document.querySelector('#backup-status').textContent.includes('两次输入的密码不一致'));
    assert.equal(account, null, '密码不一致时不能发起注册');
    await page.locator('#backup-confirm-password').fill('demo-pass');
    await page.locator('#backup-confirm-password').press('Enter');
    await page.waitForFunction(() => document.body.textContent.includes('账号已切换'));
    await page.reload();
    await page.waitForFunction(() => window.Profiles && Profiles.current().user?.id === 2);
    assert.equal((await page.evaluate(() => Settings.load())).ai.apiKey, '', '新账号不继承访客的 AI 密钥');
    await page.locator('#settings-btn').click();
    await page.locator('#workspace-tab-search').click();
    await page.locator('#search-overview [data-search-target="settings"]').click();
    await page.locator('#ai-key').fill('sk-test');
    await page.locator('#ai-key').dispatchEvent('change');
    await page.waitForFunction(() => (window.__store['newtab.profile.user-2:newtab.settings.v1'] || {}).ai?.apiKey === 'sk-test');
    await page.locator('#workspace-account').click();
    await page.waitForFunction(() => document.querySelector('#backup-account-name')?.textContent === 'demo@example.com');

    assert.equal(await page.locator('#backup-password').inputValue(), '');
    assert.equal(await page.locator('#backup-confirm-password').inputValue(), '');
    assert.ok(!(await page.evaluate(() => localStorage.getItem('__stub'))).includes('demo-pass'), '密码不能存入本地设置');
    await page.locator('#backup-restore').click();
    await page.waitForFunction(() => document.querySelector('#backup-status').textContent.includes('服务器上还没有备份'));
    await page.locator('#backup-now').click();
    await page.waitForFunction(() => (document.querySelector('#backup-status').textContent || '').includes('上次备份'));
    assert.ok(savedPayload, '服务端应收到备份');
    assert.equal(savedPayload.settings.ai.apiKey, 'sk-test', '备份应包含 AI Key');
    assert.equal(savedPayload.settings.backup, undefined, '备份不能包含账号/备份连接');
    assert.ok(!lastPutRaw.includes('demo-pass'), '密码不能出现在备份请求体里');
    assert.ok(!lastPutRaw.includes('session-'), '会话令牌不能出现在备份请求体里');

    /* 修改账号空间的本机设置，再从服务器恢复。 */
    await page.evaluate(async () => { const settings = await Settings.load(); settings.ai.apiKey = 'sk-changed'; await Settings.save(settings); });

    await page.locator('#backup-restore').click();
    await page.waitForFunction(() => (document.querySelector('#backup-restore').textContent || '').includes('确认恢复'));
    await page.locator('#backup-restore').click();
    await page.waitForTimeout(1200);
    await page.waitForFunction(() => window.__store !== undefined);

    const restored = await page.evaluate(() => Settings.load());
    assert.equal(restored.ai.apiKey, 'sk-test', '恢复后应回到备份里的 AI Key');
    assert.equal((restored.backup || {}).username, 'demo@example.com', '恢复后应保留本机登录账号');
    assert.match((restored.backup || {}).authToken || '', /^session-\d+$/, '恢复后应保留会话令牌');

    /* 退出后密码错误 → 再登录成功 */
    await page.locator('#settings-btn').click();
    await page.locator('#workspace-account').click();
    await page.waitForFunction(() => (document.querySelector('#backup-account-name').textContent || '') === 'demo@example.com');
    await page.locator('#backup-logout').click();
    await page.waitForFunction(() => document.body.textContent.includes('账号已切换'));
    await page.reload();
    await page.locator('#settings-btn').click();
    await page.locator('#workspace-account').click();
    await page.waitForFunction(() => !document.querySelector('#backup-account-form').hidden);

    assert.equal(await page.locator('#backup-account-form input:visible').count(), 2);
    await page.locator('#backup-register').click();
    await page.locator('#backup-password').fill('temporary-pass');
    await page.locator('#backup-back-login').click();
    assert.equal(await page.locator('#backup-password').inputValue(), '');
    await page.locator('#backup-username').fill('demo@example.com');
    await page.locator('#backup-password').fill('wrong-pass');
    await page.locator('#backup-login').click();
    await page.waitForFunction(() => (document.querySelector('#backup-status').textContent || '').includes('账号或密码错误'));

    await page.locator('#backup-password').fill('demo-pass');
    await page.locator('#backup-password').press('Enter');
    await page.waitForFunction(() => document.body.textContent.includes('账号已切换'));
    await page.reload();
    await page.waitForFunction(() => window.Profiles && Profiles.current().user?.id === 2);
    assert.equal((await page.evaluate(() => Settings.load())).backup.username, 'demo@example.com');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});
