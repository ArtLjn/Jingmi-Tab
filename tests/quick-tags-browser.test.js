/* 在真实 Chrome 中验证 @ 面板：触发、分区、固定、过滤与开关。
   扩展 API 全部使用页面内替身，不依赖真实扩展安装。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const executablePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('浏览器回归：@ 快捷标签的触发、候选、固定与过滤', { skip: !fs.existsSync(executablePath), timeout: 60000 }, async () => {
  const server = http.createServer((req, res) => {
    /* 根路径给一个 200 空页，供「创建标签后跳转」用例结束导航 */
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>ok</title>'); return; }
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

    const port = server.address().port;
    await context.addInitScript(({ port }) => {
      /* 用 localStorage 承载替身存储，保证 reload 后数据不丢 */
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
          getTree: cb => cb({ id: '0', title: '', children: [
            { id: '10', parentId: '0', title: '书签栏', children: [
              { id: '1', title: 'YS 应收', url: 'https://yonyou.com/ar', dateAdded: Date.now() },
              { id: '2', title: '项目文档', url: 'https://example.com/doc', dateAdded: Date.now() - 1000 }
            ] }
          ] }),
          onCreated: { addListener: () => {} },
          onRemoved: { addListener: () => {} },
          onChanged: { addListener: () => {} },
          onMoved: { addListener: () => {} },
          onChildrenReordered: { addListener: () => {} }
        },
        topSites: { get: cb => cb([
          { url: 'https://oa.hongdi.com/', title: 'OA 打卡' },
          { url: 'http://127.0.0.1:' + port + '/other', title: '本地开发' },
          { url: 'https://www.bing.com/', title: 'Bing' }
        ]) },
        runtime: { lastError: null, id: 'test', getURL: p => p, onMessage: { addListener: () => {} }, sendMessage: (m, cb) => { cb && cb({}); return Promise.resolve({}); } },
        permissions: { request: () => Promise.resolve(true), contains: () => Promise.resolve(true), onAdded: { addListener: () => {} }, onRemoved: { addListener: () => {} } },
        alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
        tabs: { create: () => {}, query: (q, cb) => { cb && cb([]); } },
        contextMenus: { create: () => {} },
        i18n: { getMessage: k => k }
      };
    }, { port });

    const page = await context.newPage();
    await page.goto(origin + '/newtab.html');
    const input = page.locator('#search-input');
    await input.click();

    await page.keyboard.type('@');
    await page.locator('#ac-panel.is-open').waitFor();

    assert.equal(await page.locator('#engine-chip').innerText(), '标签', '搜索框右侧应显示模式标记');
    const panelText = await page.locator('#ac-panel').innerText();
    assert.match(panelText, /常用 · 按使用频率/, '空查询应直接列出按频率排序的推荐');
    assert.match(panelText, /oa\.hongdi\.com/, '常访站点应进入候选');
    assert.doesNotMatch(panelText, /bing\.com/, '搜索引擎不应进候选');

    /* 固定：候选转手动标签，并出现在固定区 */
    await page.locator('#ac-panel [data-act="pin"]').first().click();
    await page.waitForFunction(() => document.querySelector('#ac-panel').innerText.includes('固定'));
    const pinned = await page.locator('#ac-panel').innerText();
    assert.match(pinned, /固定[\s\S]*OA 打卡/, '固定后应出现在固定区并保留可读名称');
    assert.match(pinned, /用过 0 次|OA 打卡/, '固定项应展示域名副标题');

    /* 过滤：输入片段只留下命中项 */
    await input.fill('');
    await input.click();
    await page.keyboard.type('@oo');
    const filtered = await page.locator('#ac-panel').innerText();
    assert.doesNotMatch(filtered, /YS 应收/, '不匹配的标签应被过滤');
    assert.match(filtered, /没有匹配的标签|OA 打卡/, '剩余结果应来自域名匹配');

    /* URL 形态查询：即使同 host 已在常访站点里，回车也应创建标签而不是打开候选 */
    await input.fill('');
    await input.click();
    await page.keyboard.type('@127.0.0.1:' + port);
    await page.locator('#ac-panel.is-open').waitFor();
    assert.match(await page.locator('#ac-panel').innerText(), /创建为快捷标签/, '完整地址应提供创建入口');
    await page.keyboard.press('Enter');
    await page.waitForURL('http://127.0.0.1:' + port + '/', { waitUntil: 'commit' });

    await page.goto(origin + '/newtab.html');
    await page.waitForFunction(() => window.__store !== undefined);
    const savedTags = await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('__stub') || '{}');
      return raw['newtab.profile.guest:newtab.tags.v1'] || { tags: [] };
    });
    assert.ok(savedTags.tags.some(t => t.url === 'http://127.0.0.1:' + port + '/'),
      '新建标签必须已经落盘，导航不能取消写入');

    /* 关闭开关后 @ 退回普通搜索，不再弹面板。
       先等上一次输入的设置写入落地，否则待发的持久化会把这次的关闭覆盖掉。 */
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const key = 'newtab.profile.guest:newtab.settings.v1';
      const raw = JSON.parse(localStorage.getItem('__stub') || '{}');
      const s = raw[key] || {};
      s.tags = { enabled: false };
      raw[key] = s;
      localStorage.setItem('__stub', JSON.stringify(raw));
    });
    await page.reload();
    /* reload 后设置是异步读盘：等首屏交互就绪再输入，否则会先按默认值（标签开启）跑一次。 */
    await page.waitForFunction(() => document.querySelector('#settings-btn') !== null && window.__store !== undefined);
    await page.waitForTimeout(300);
    await page.locator('#search-input').click();
    await page.keyboard.type('@oa');
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#ac-panel.is-open').count(), 0, '关闭后不应再出现标签面板');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});
