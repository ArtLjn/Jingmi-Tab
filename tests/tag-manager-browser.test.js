/* 在真实 Chrome 中验证工作台「快捷标签」管理页：改名、排序、删除撤销、忽略恢复。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const executablePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('浏览器回归：快捷标签管理页的改名、排序、撤销与恢复', { skip: !fs.existsSync(executablePath), timeout: 60000 }, async () => {
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
      if (new URL(route.request().url()).origin === origin) return route.continue();
      return route.fulfill({ status: 200, body: '' });
    });

    await context.addInitScript(() => {
      const load = () => { try { return JSON.parse(localStorage.getItem('__stub') || '{}'); } catch (e) { return {}; } };
      const store = load();
      const save = () => localStorage.setItem('__stub', JSON.stringify(store));
      store['newtab.tags.v1'] = {
        version: 1,
        tags: [
          { id: 't1', label: '打卡', url: 'https://oa.hongdi.com/', host: 'oa.hongdi.com', pin: 0, hits: 12, lastUsed: 1 },
          { id: 't2', label: 'YS 应收', url: 'https://yonyou.com/ar', host: 'yonyou.com', pin: 1, hits: 3, lastUsed: 1 }
        ],
        dismissed: { 'x.com': 3 },
        used: {}
      };
      save();
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
          getTree: cb => cb({ id: '0', title: '', children: [
            { id: '10', parentId: '0', title: '书签栏', children: [
              { id: '1', title: 'GitHub', url: 'https://github.com/', dateAdded: Date.now() },
              { id: '2', title: 'X', url: 'https://x.com/', dateAdded: Date.now() - 1000 }
            ] }
          ] }),
          onCreated: { addListener: () => {} },
          onRemoved: { addListener: () => {} },
          onChanged: { addListener: () => {} },
          onMoved: { addListener: () => {} },
          onChildrenReordered: { addListener: () => {} }
        },
        topSites: { get: cb => cb([{ url: 'https://x.com/', title: 'X' }]) },
        runtime: { lastError: null, id: 'test', getURL: p => p, onMessage: { addListener: () => {} }, sendMessage: (m, cb) => { cb && cb({}); return Promise.resolve({}); } },
        permissions: { request: () => Promise.resolve(true), contains: () => Promise.resolve(true), onAdded: { addListener: () => {} }, onRemoved: { addListener: () => {} } },
        alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
        tabs: { create: () => {}, query: (q, cb) => { cb && cb([]); } },
        contextMenus: { create: () => {} },
        i18n: { getMessage: k => k }
      };
    });

    const page = await context.newPage();
    await page.goto(origin + '/newtab.html');
    await page.locator('#settings-btn').click();
    await page.locator('#workspace-tab-tags').click();
    await page.locator('#workspace-tags').waitFor({ state: 'visible' });

    const pinnedNames = () => page.locator('#tag-pinned-list .tag-name').allInnerTexts();
    assert.deepEqual(await pinnedNames(), ['打卡', 'YS 应收'], '固定标签按手写顺序展示');

    /* 忽略记录里能看到被拉黑的站点 */
    assert.match(await page.locator('#tag-ignored-list').innerText(), /x\.com/);
    assert.equal(await page.locator('#tag-cand-list').innerText().then(t => /x\.com/.test(t)), false, '已拉黑站点不应出现在推荐里');

    /* 改名：点名称变输入框，回车提交 */
    await page.locator('#tag-pinned-list .tag-name').first().click();
    await page.locator('.tag-name-input').fill('上班打卡');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (document.querySelector('#tag-pinned-list .tag-name') || {}).textContent === '上班打卡');

    /* 排序：下移后与第二项交换 */
    await page.locator('#tag-pinned-list .tag-row').first().locator('.tag-op').nth(1).click();
    assert.deepEqual(await pinnedNames(), ['YS 应收', '上班打卡']);

    /* 删除后可撤销，并回到原位置 */
    await page.locator('#tag-pinned-list .tag-row').first().locator('.tag-op.is-danger').click();
    assert.match(await page.locator('#tag-status').innerText(), /已删除/);
    assert.deepEqual(await pinnedNames(), ['上班打卡']);
    await page.locator('.tag-undo').click();
    assert.deepEqual(await pinnedNames(), ['YS 应收', '上班打卡'], '撤销应插回原位');

    /* 恢复被拉黑的站点：从已忽略消失，重新出现在推荐里 */
    await page.locator('#tag-ignored-list .tag-op').first().click();
    assert.equal(await page.locator('#tag-ignored-list .tag-row').count(), 0);
    assert.match(await page.locator('#tag-cand-list').innerText(), /x\.com/);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});
