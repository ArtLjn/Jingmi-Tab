/* 用真实页面结构验证概览、子页、面包屑与表单状态保留。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const executablePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('搜索工作台：五个独立子页、返回概览和窄屏导航', { skip: !fs.existsSync(executablePath), timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    const html = fs.readFileSync(path.join(root, 'newtab.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
    await page.setContent(html);
    await page.addStyleTag({ path: path.join(root, 'css/newtab.css') });
    await page.addScriptTag({ path: path.join(root, 'js/workspace.js') });
    await page.evaluate(() => {
      window.__navigationMessages = [];
      window.chrome = { runtime: { sendMessage: async message => {
        window.__navigationMessages.push(message.type);
        return { ok: true, data: { enabled: true, totalPending: 0, totalFailed: 0, pending: [], failures: [], recent: [{ url: 'https://example.com', summary: '最近完成的摘要' }] } };
      } } };
    });
    await page.addScriptTag({ path: path.join(root, 'js/bookmark-enrich-ui.js') });
    await page.evaluate(() => {
      BookmarkEnrichUI.mount();
      const original = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = async message => message.type === 'pipeline:status' ? { ok: true, data: {
        jobs: { pending: 0, running: 0, done: 25, paused: 0, failed: 0 }, indexed: 25, documents: 25,
        records: Array.from({ length: 25 }, (_, i) => ({ title: '已同步收藏 ' + i, capture: '已采集正文', sync: 'synced', status: 'done' }))
      } } : original(message);
      window.Rag = { withAuth: cfg => cfg, available: () => false };
      window.BookmarkHealth = { report: async () => Array.from({ length: 61 }, (_, i) => ({ title: '体检结果 ' + i, kind: '重复', detail: '有重复收藏' })) };
    });
    await page.addScriptTag({ path: path.join(root, 'js/rag-settings.js') });
    await page.addScriptTag({ path: path.join(root, 'js/bookmark-health-ui.js') });
    await page.evaluate(() => {
      RagSettings.mount({ settings: () => ({ rag: {}, backup: {} }), persist: () => {} });
      BookmarkHealthUI.mount();
    });
    await page.evaluate(() => Workspace.open('search'));
    assert.equal(await page.locator('#search-overview').isVisible(), true);
    assert.equal(await page.locator('[data-search-page]:visible').count(), 0);
    assert.equal(await page.locator('#search-overview .search-entry').count(), 5);
    for (const name of ['settings', 'rag', 'organize', 'enrich', 'health']) {
      await page.locator('#search-overview [data-search-target="' + name + '"]').click();
      assert.equal(await page.locator('[data-search-page]:visible').count(), 1);
      assert.equal(await page.locator('[data-search-page="' + name + '"]').isVisible(), true);
      assert.equal(await page.locator('#search-overview').isVisible(), false);
      assert.equal(await page.locator('#search-breadcrumb').isVisible(), true);
      if (name === 'settings') await page.locator('#ai-model').fill('保留我的模型');
      if (name === 'health') {
        assert.equal(await page.locator('#bookmark-health').getAttribute('open') !== null, true);
        await page.getByRole('button', { name: '查看更多体检结果' }).click();
        assert.equal(await page.locator('#bookmark-health-body .enrich-item').count(), 61);
        assert.equal(await page.locator('#bookmark-health-body').evaluate(el => el.clientHeight >= 360 && el.clientHeight <= 760 && el.scrollHeight > el.clientHeight), true);
      }
      if (name === 'enrich') {
        assert.equal(await page.locator('#enrich-details').getAttribute('open') !== null, true);
        assert.match(await page.locator('#enrich-body').textContent(), /最近完成的摘要/);
        assert.equal(await page.locator('#enrich-body').evaluate(el => getComputedStyle(el).height), '620px');
        assert.equal(await page.locator('#enrich-body').evaluate(el => getComputedStyle(el).overflowY), 'auto');
        assert.equal(await page.locator('#enrich-body a').first().evaluate(el => getComputedStyle(el).textDecorationLine), 'none');
      }
      if (name === 'rag') {
        assert.equal(await page.locator('#rag-connection').getAttribute('open'), null);
        await page.locator('#rag-connection > summary').click();
        assert.equal(await page.locator('#rag-connection').getAttribute('open') !== null, true);
        await page.getByRole('button', { name: '查看更多处理记录' }).click();
        assert.equal(await page.locator('#pipeline-records .auto-archive-record').count(), 25);
        assert.equal(await page.locator('#pipeline-records').evaluate(el => el.clientHeight >= 360 && el.clientHeight <= 760 && el.scrollHeight > el.clientHeight), true);
      }
      await page.locator('#search-breadcrumb button').press('Enter');
      assert.equal(await page.locator('#search-overview').isVisible(), true);
      assert.equal(await page.locator('#search-overview [data-search-target="' + name + '"]').evaluate(el => el === document.activeElement), true);
    }
    await page.locator('[data-search-target="settings"]').click();
    assert.equal(await page.locator('#ai-model').inputValue(), '保留我的模型');
    await page.locator('#workspace-tab-appearance').click();
    await page.locator('#workspace-tab-search').click();
    assert.equal(await page.locator('#search-overview').isVisible(), true);
    await page.evaluate(() => { document.querySelector('#enrich-summary').textContent = '待确认 3 条'; });
    await page.waitForFunction(() => document.querySelector('[data-search-status="enrich"]').textContent === '待确认 3 条');
    await page.screenshot({ path: '/tmp/chrome-tab-search-overview.png' });
    for (const width of [760, 390]) {
      await page.setViewportSize({ width, height: 850 });
      for (const name of ['settings', 'rag', 'organize', 'enrich', 'health']) {
        await page.locator('#search-overview [data-search-target="' + name + '"]').click();
        const list = page.locator('[data-search-page="' + name + '"] .enrich-body').first();
        if (await list.count()) assert.equal(await list.evaluate(el => el.clientHeight >= 360 && el.clientHeight <= 760), true);
        const overflow = await page.locator('#workspace-search').evaluate(el => el.scrollWidth > el.clientWidth + 1);
        assert.equal(overflow, false, width + ' 像素下子页不应横向溢出：' + name);
        await page.locator('#search-breadcrumb button').click();
      }
    }
    await page.evaluate(() => Workspace.open('search', 'rag'));
    assert.equal(await page.locator('[data-search-page="rag"]').isVisible(), true);
    await page.locator('#search-breadcrumb button').click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('[data-search-target="enrich"]').click();
    await page.locator('#enrich-scan').click();
    await page.waitForFunction(() => window.__navigationMessages.includes('enrich:scan'));
    assert.equal(await page.locator('#enrich-status').isVisible(), true);
    assert.equal(await page.locator('#rag-enabled').isVisible(), false);
    await page.screenshot({ path: '/tmp/chrome-tab-search-enrich.png' });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
