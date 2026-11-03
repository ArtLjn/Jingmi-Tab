/* 在真实 Chrome 中验证背景动效、指针视差及其可访问性降级。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const executablePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function extensionStub() {
  const load = () => { try { return JSON.parse(localStorage.getItem('__ambient_stub') || '{}'); } catch (e) { return {}; } };
  const store = load();
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const save = () => localStorage.setItem('__ambient_stub', JSON.stringify(store));
  window.chrome = {
    storage: {
      local: {
        /* 与 chrome.storage 一样按值读写，避免测试拿到内存中的可变引用。 */
        get: (key, cb) => { const out = {}; if (typeof key === 'string' && store[key] !== undefined) out[key] = clone(store[key]); cb && cb(out); },
        set: (obj, cb) => { Object.assign(store, clone(obj)); save(); cb && cb(); }
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
    runtime: { lastError: null, id: 'ambient-test', getURL: p => p, onMessage: { addListener: () => {} }, sendMessage: (m, cb) => { cb && cb({}); return Promise.resolve({}); } },
    permissions: { request: () => Promise.resolve(true), contains: () => Promise.resolve(true) }
  };
}

test('浏览器回归：背景动效、指针视差与减少动态效果降级', { skip: !fs.existsSync(executablePath), timeout: 60000 }, async () => {
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + req.url.split('?')[0]);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  const errors = [];

  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'no-preference' });
    await context.addInitScript(extensionStub);
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      return route.fulfill({ status: 200, body: '' });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/newtab.html');

    /* 启动层在背景绘制后退场，且不拦截首屏交互。 */
    await page.waitForFunction(() => !document.getElementById('boot'), null, { timeout: 5000 });

    await page.waitForFunction(() => document.body.classList.contains('ambient-motion'));
    assert.equal(await page.locator('#bg-image').evaluate(el => getComputedStyle(el).animationName), 'bg-drift');
    assert.equal(await page.locator('.ambient-light-a').evaluate(el => getComputedStyle(el).animationName), 'ambient-drift-a');
    assert.equal(await page.locator('.ambient-light-b').evaluate(el => getComputedStyle(el).animationName), 'ambient-drift-b');

    /* 指针移动只驱动背景视差变量；页面不再生成任何自定义光标图层。 */
    assert.equal(await page.locator('#cursor-dot').count(), 0);
    assert.equal(await page.locator('#cursor-ring').count(), 0);
    await page.mouse.move(160, 180);
    await page.mouse.move(520, 340, { steps: 6 });
    await page.waitForFunction(() => Math.abs(parseFloat(document.querySelector('.bg-layer').style.getPropertyValue('--parallax-x'))) > 0.1);
    await page.waitForFunction(() => Math.abs(parseFloat(document.querySelector('.bg-layer').style.getPropertyValue('--parallax-y'))) > 0.1);
    assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).cursor), 'auto');

    /* 文本编辑保留原生 I 型指针，按钮点击仍走原有交互。 */
    await page.locator('#search-input').hover();
    assert.equal(await page.locator('#search-input').evaluate(el => getComputedStyle(el).cursor), 'text');
    await page.locator('#settings-btn').hover();
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForFunction(() => document.body.classList.contains('panel-open'));
    await page.locator('#workspace-tab-appearance').click();

    /* 用户开关同时关闭循环动效与视差，并在重开后保留。 */
    await page.locator('label.switch:has(#sw-motion)').click();
    await page.waitForFunction(() => !document.body.classList.contains('ambient-motion'));
    assert.equal(await page.locator('.bg-layer').evaluate(el => el.style.getPropertyValue('--parallax-x')), '0px');
    assert.equal(await page.locator('#sw-motion').isChecked(), false);
    assert.equal(await page.locator('#bg-image').evaluate(el => getComputedStyle(el).animationName), 'none');
    /* waitForFunction 不会等待异步谓词，直接检查已落盘的存储值。 */
    await page.waitForFunction(() => {
      try { return JSON.parse(localStorage.getItem('__ambient_stub') || '{}')['newtab.profile.guest:newtab.settings.v1'].bg.motion === false; }
      catch (e) { return false; }
    });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#sw-motion').checked === false, null, { timeout: 5000 }).catch(async error => {
      const state = await page.evaluate(() => ({ ready: document.readyState, body: document.body.className, stored: localStorage.getItem('__ambient_stub') }));
      throw new Error(error.message + '；状态=' + JSON.stringify(state) + '；页面错误=' + JSON.stringify(errors));
    });
    assert.equal(await page.locator('body').evaluate(el => el.classList.contains('ambient-motion')), false);

    /* 系统减少动态效果优先于用户开关；恢复系统偏好后可重新启用。 */
    await page.locator('#settings-btn').click();
    await page.locator('#workspace-tab-appearance').click();
    await page.locator('label.switch:has(#sw-motion)').click();
    await page.waitForFunction(() => document.body.classList.contains('ambient-motion'));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => !document.body.classList.contains('ambient-motion'));
    await page.mouse.move(300, 240);
    assert.equal(await page.locator('.bg-layer').evaluate(el => el.style.getPropertyValue('--parallax-x')), '0px');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForFunction(() => document.body.classList.contains('ambient-motion'));

    /* 触摸设备保留轻量背景循环，但指针保持系统原生、不因触摸产生漂移。 */
    const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await touchContext.addInitScript(extensionStub);
    await touchContext.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      return route.fulfill({ status: 200, body: '' });
    });
    const touchPage = await touchContext.newPage();
    touchPage.on('pageerror', error => errors.push(error.message));
    await touchPage.goto(origin + '/newtab.html');
    await touchPage.waitForFunction(() => document.body.classList.contains('ambient-motion'));
    await touchPage.touchscreen.tap(195, 300);
    assert.equal(await touchPage.locator('#cursor-dot').count(), 0);
    assert.equal(await touchPage.locator('.bg-layer').evaluate(el => parseFloat(el.style.getPropertyValue('--parallax-x') || '0')), 0);
    await touchContext.close();

    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
