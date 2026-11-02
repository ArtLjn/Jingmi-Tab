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
      store['newtab.profile.guest:newtab.tags.v1'] = store['newtab.profile.guest:newtab.tags.v1'] || {
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
          getTree: cb => cb([{ id: '0', title: '', children: [
            { id: '10', parentId: '0', title: '书签栏', children: [
              { id: '1', title: 'GitHub', url: 'https://github.com/', dateAdded: Date.now() },
              { id: '2', title: 'X', url: 'https://x.com/', dateAdded: Date.now() - 1000 }
            ] }
          ] }]),
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

    await page.waitForFunction(() => document.querySelectorAll('#tag-pinned-list .tag-name').length === 2);
    const pinnedNames = () => page.locator('#tag-pinned-list .tag-name').allInnerTexts();
    assert.deepEqual(await pinnedNames(), ['打卡', 'YS 应收'], '固定标签按手写顺序展示');

    /* 忽略记录里能看到被拉黑的站点 */
    assert.match(await page.locator('#tag-ignored-list').innerText(), /x\.com/);
    assert.equal(await page.locator('#tag-cand-list').innerText().then(t => /x\.com/.test(t)), false, '已拉黑站点不应出现在推荐里');

    /* 完整编辑：人工别名和用途说明独立落盘。 */
    await page.locator('#tag-pinned-list .tag-row').first().getByRole('button', { name: '编辑', exact: true }).click();
    assert.equal(await page.locator('.tag-editor select').count(), 0, '编辑弹窗不应混入书签选择器');
    await page.getByLabel('别名', { exact: true }).fill('007、OA');
    await page.getByLabel('个人说明', { exact: true }).fill('公司内部入口，办理报销和请假');
    await page.screenshot({ path: '/tmp/chrome-tab-tag-editor.png' });
    for (const width of [800, 390]) {
      await page.setViewportSize({ width, height: 800 });
      const bounds = await page.locator('.tag-editor').boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
      await page.screenshot({ path: '/tmp/chrome-tab-tag-editor-' + width + '.png' });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('.tag-editor').getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('.tag-editor').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => QuickTags.list()[0].note), '公司内部入口，办理报销和请假');
    assert.equal(await page.evaluate(() => document.body.classList.contains('panel-open')), true, '编辑弹窗关闭不应误关工作台');
    await page.locator('#tag-pinned-list .tag-row').first().getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByLabel('个人说明', { exact: true }).fill('不应保存的说明');
    await page.evaluate(() => {
      window.__originalTagSet = chrome.storage.local.set;
      chrome.storage.local.set = (values, cb) => {
        if (values[Profiles.key('newtab.tags.v1')]) { chrome.runtime.lastError = { message: '存储不可用' }; cb(); chrome.runtime.lastError = null; }
        else window.__originalTagSet(values, cb);
      };
    });
    await page.locator('.tag-editor').getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.tag-editor [role=alert]').textContent.includes('保存失败'));
    assert.equal(await page.locator('.tag-editor').isVisible(), true, '失败时表单和输入应保留');
    assert.equal(await page.evaluate(() => QuickTags.list()[0].note), '公司内部入口，办理报销和请假');
    await page.evaluate(() => { chrome.storage.local.set = window.__originalTagSet; delete window.__originalTagSet; });
    await page.locator('.tag-editor').getByRole('button', { name: '取消', exact: true }).click();


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

    await page.evaluate(() => QuickTags.flush());
    await page.locator('#panel-close').click();
    await page.locator('#search-input').fill('@007');
    await page.waitForFunction(() => document.querySelector('#ac-panel').innerText.includes('上班打卡'));
    await page.reload();
    await page.locator('#search-input').fill('@007');
    await page.waitForFunction(() => document.querySelector('#ac-panel').innerText.includes('上班打卡'));
    assert.equal(await page.evaluate(() => QuickTags.list().find(t => t.aliases.includes('007')).note), '公司内部入口，办理报销和请假');

    /* 重名不默选，直接回车不能按使用频率误开。 */
    await page.evaluate(async () => QuickTags.save({ label: '另一个平台', url: 'https://other.example.com/', aliases: ['007'] }));
    await page.locator('#search-input').fill('@007');
    await page.waitForFunction(() => document.querySelector('#ac-panel').innerText.includes('多个入口'));
    assert.equal(await page.locator('#ac-panel .ac-item.is-sel').count(), 0);
    const currentUrl = page.url(); await page.keyboard.press('Enter'); assert.equal(page.url(), currentUrl);

    /* 在书签里搜索并给已有书签加备注，不再要求手动新建 URL。 */
    await page.locator('#search-input').fill('');
    await page.locator('#settings-btn').click();
    await page.locator('#workspace-tab-tags').click();
    await page.locator('#tag-search').fill('GitHub');
    await page.waitForFunction(() => document.querySelector('#tag-cand-list').innerText.includes('GitHub'));
    assert.match(await page.locator('#tag-cand-list').innerText(), /加备注/);
    assert.equal(await page.locator('#tag-add').count(), 0, '不应再有单独的新建入口按钮');
    await page.locator('#tag-cand-list').getByRole('button', { name: '加备注', exact: true }).click();
    await page.getByLabel('别名', { exact: true }).fill('代码');
    await page.getByLabel('个人说明', { exact: true }).fill('代码托管');
    await page.locator('.tag-editor').getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#tag-pinned-list').innerText.includes('GitHub'));
    assert.equal(await page.evaluate(() => QuickTags.list().some(t => t.url === 'https://github.com/' && t.note === '代码托管')), true);
    await page.locator('#tag-search').fill('GitHub');
    await page.waitForFunction(() => document.querySelector('#tag-cand-list').innerText.includes('编辑'));
    await page.locator('#tag-search').fill('');
    await page.waitForFunction(() => !document.querySelector('#tag-cand-count').textContent.includes('结果'));

    /* @ 绑定入口时也在书签里搜索目标，不再要求手动拼网址。 */
    await page.locator('#panel-close').click();
    await page.locator('#search-input').fill('@zzz');
    await page.keyboard.press('Enter');
    await page.locator('.tag-editor .tag-picker').waitFor();
    await page.locator('.tag-picker input').fill('GitHub');
    await page.locator('.tag-picker-result').first().click();
    assert.equal(await page.locator('.tag-editor input[name="url"]').inputValue(), 'https://github.com/');
    assert.equal(await page.locator('.tag-editor input[name="label"]').inputValue(), 'GitHub');
    await page.locator('.tag-editor').getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForFunction(() => QuickTags.list().some(t => t.aliases.includes('zzz') && t.url === 'https://github.com/'));
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});
