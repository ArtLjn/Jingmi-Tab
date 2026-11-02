/* 真实 Chrome 回归：@ 面板 AI 短名推荐的隐私边界与 24h 缓存。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const executablePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('浏览器回归：AI 推荐只发标题/域名，缓存后不重复请求', { skip: !fs.existsSync(executablePath), timeout: 60000 }, async () => {
  let aiCalls = 0;
  let aiBody = '';

  const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + req.url.split('?')[0]);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;

  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route('**/*', route => {
      const url = route.request().url();
      if (new URL(url).origin === origin) return route.continue();
      if (url.endsWith('/chat/completions')) {
        aiCalls++;
        aiBody = route.request().postData() || '';
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            choices: [{ message: { content: '{"picks":[{"id":"c1","name":"打卡"}]}' } }]
          })
        });
      }
      return route.fulfill({ status: 200, body: '' });
    });

    await context.addInitScript(() => {
      const load = () => { try { return JSON.parse(localStorage.getItem('__stub') || '{}'); } catch (e) { return {}; } };
      const save = () => localStorage.setItem('__stub', JSON.stringify(store));
      const store = load();
      window.__store = store;
      if (!store['newtab.settings.v1']) {
        store['newtab.settings.v1'] = {
          ai: { enabled: true, apiKey: 'k', baseUrl: 'https://ai.test/v1', model: 'm', timeout: 8000 },
          tags: { enabled: true, aiSuggest: true }
        };
        save();
      }
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
          getTree: cb => cb([{ id: '0', title: '', children: [{ id: '1', title: 'GitHub', url: 'https://github.com/', dateAdded: Date.now() }] }]),
          onCreated: { addListener: () => {} }, onRemoved: { addListener: () => {} },
          onChanged: { addListener: () => {} }, onMoved: { addListener: () => {} },
          onChildrenReordered: { addListener: () => {} }
        },
        topSites: { get: cb => cb([
          { url: 'https://oa.hongdi.com/', title: 'OA 打卡' },
          { url: 'https://github.com/', title: 'GitHub' }
        ]) },
        runtime: { lastError: null, id: 'test', getURL: p => p, getManifest: () => ({ version: '1.16.0' }), onMessage: { addListener: () => {} }, sendMessage: () => Promise.resolve({}) },
        permissions: { request: () => Promise.resolve(true), contains: () => Promise.resolve(true), onAdded: { addListener: () => {} }, onRemoved: { addListener: () => {} } },
        alarms: { create: () => {}, get: () => {}, clear: () => {}, onAlarm: { addListener: () => {} } },
        tabs: { create: () => {}, query: (q, cb) => { cb && cb([]); } },
        contextMenus: { create: () => {} },
        i18n: { getMessage: k => k }
      };
    });

    const page = await context.newPage();
    await page.goto(origin + '/newtab.html');
    await page.waitForFunction(() => window.__store !== undefined);
    await page.locator('#search-input').click();
    await page.keyboard.type('@');

    await page.waitForFunction(() => (document.querySelector('#ac-panel').innerText || '').includes('AI 推荐'));
    const panel = await page.locator('#ac-panel').innerText();
    assert.match(panel, /AI 推荐/);
    assert.match(panel, /打卡/);

    assert.equal(aiCalls, 1, '首次打开应请求一次');
    assert.ok(aiBody.includes('oa.hongdi.com'));
    assert.ok(!aiBody.includes('http://'), '请求体不能包含完整 URL');
    assert.ok(!aiBody.includes('https://'), '请求体不能包含完整 URL');
    assert.ok(!aiBody.includes('folder'), '不能发送书签文件夹');
    assert.ok(!aiBody.includes('/v1'), '不能把接口路径等无关内容混进去');

    /* 24h 缓存：reload 后仍显示，且不再请求 */
    await page.reload();
    await page.waitForFunction(() => window.__store !== undefined);
    await page.locator('#search-input').click();
    await page.keyboard.type('@');
    await page.waitForFunction(() => (document.querySelector('#ac-panel').innerText || '').includes('AI 推荐'));
    assert.equal(aiCalls, 1, '缓存有效时不应重复请求');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});
