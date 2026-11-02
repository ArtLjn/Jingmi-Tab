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
      window.__deleteCalls = [];
      var pipeline = {
        jobs: { pending: 0, running: 0, done: 25, paused: 0, failed: 1 }, indexed: 25, documents: 26, retryableJobs: 1,
        records: [
          { id: 'fail-1', url: 'https://example.com/fail', title: '失败收藏', bookmarkCount: 1, capture: '未采集正文', sync: 'failed', syncLabel: '未入库', status: 'failed', error: '正文采集失败：http_403', admission: 'deferred', selectableRetry: true, policy: { kind: 'manual', allowManual: true, auto: false } }
        ].concat(Array.from({ length: 25 }, (_, i) => ({ title: '排队收藏 ' + i, capture: '已采集正文', sync: 'pending', status: 'pending' })))
      };
      chrome.runtime.sendMessage = async message => {
        if (message.type === 'pipeline:status') return { ok: true, data: pipeline };
        if (message.type === 'pipeline:delete-failed') {
          window.__deleteCalls.push(message);
          return { ok: true, data: Object.assign({}, pipeline, { deleteBatch: { removed: 1, failed: [], syncError: '' } }) };
        }
        return original(message);
      };
      window.Rag = { withAuth: cfg => cfg, available: () => false };
      window.BookmarkHealth = { report: async () => Array.from({ length: 61 }, (_, i) => ({ title: '体检结果 ' + i, kind: '重复', detail: '有重复收藏' })) };
    });
    await page.addScriptTag({ path: path.join(root, 'js/collection-stats.js') });
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
        assert.equal(await page.locator('#search-page-detail-wrap').isVisible(), false);
        assert.equal(await page.locator('#bookmark-health').getAttribute('open') !== null, true);
        await page.getByRole('button', { name: '查看更多体检结果' }).click();
        assert.equal(await page.locator('#bookmark-health-body .enrich-item').count(), 61);
        assert.equal(await page.locator('#bookmark-health-body').evaluate(el => el.clientHeight >= 360 && el.clientHeight <= 760 && el.scrollHeight > el.clientHeight), true);
      }
      if (name === 'enrich') {
        assert.equal(await page.locator('#enrich-details').getAttribute('open') !== null, true);
        assert.equal(await page.locator('#enrich-filters [data-filter="recent"]').getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('#search-page-detail').textContent(), '最近成功');
        await page.locator('#enrich-filters [data-filter="pending"]').click();
        assert.equal(await page.locator('#search-page-detail').textContent(), '待确认');
        assert.match(await page.locator('#enrich-body').textContent(), /暂无待确认建议/);
        await page.locator('#enrich-filters [data-filter="recent"]').click();
        assert.equal(await page.locator('#search-page-detail').textContent(), '最近成功');
        assert.match(await page.locator('#enrich-body').textContent(), /最近完成的摘要/);
        assert.equal(await page.locator('#enrich-body').evaluate(el => getComputedStyle(el).height), '620px');
        assert.equal(await page.locator('#enrich-body').evaluate(el => getComputedStyle(el).overflowY), 'auto');
        const enrichLink = page.locator('#enrich-body a').first();
        await enrichLink.waitFor({ state: 'visible' });
        assert.equal(await enrichLink.evaluate(el => getComputedStyle(el).textDecorationLine), 'none');
      }
      if (name === 'rag') {
        assert.equal(await page.locator('#search-page-detail-wrap').isVisible(), true);
        assert.equal(await page.locator('#search-page-detail').textContent(), '处理任务');
        assert.equal(await page.locator('#rag-connection').getAttribute('open'), null);
        await page.locator('#rag-connection > summary').click();
        assert.equal(await page.locator('#rag-connection').getAttribute('open') !== null, true);
        await page.getByRole('button', { name: '查看更多排队任务' }).click();
        assert.equal(await page.locator('#pipeline-records .auto-archive-record').count(), 25);
        assert.equal(await page.locator('#pipeline-records').evaluate(el => el.clientHeight >= 360 && el.clientHeight <= 760 && el.scrollHeight > el.clientHeight), true);
        await page.locator('#rag-failures-tab').click();
        assert.equal(await page.locator('#rag-failures-panel').isVisible(), true);
        assert.equal(await page.locator('#search-page-detail').textContent(), '失败任务');
        assert.match(await page.locator('#rag-failure-records').innerText(), /正文采集失败：http_403/);
        assert.equal(await page.locator('#rag-failure-records .pipeline-record .pipeline-actions .pipeline-retry').count(), 1);
        const failLink = page.locator('#rag-failure-records .pipeline-record a.pipeline-main').first();
        assert.equal(await failLink.getAttribute('target'), '_blank');
        assert.equal(await failLink.getAttribute('href'), 'https://example.com/fail');
        assert.equal(await page.locator('#pipeline-retry').isVisible(), true);
        await page.locator('#rag-failure-records .pipeline-select').first().check();
        assert.equal(await page.locator('#pipeline-delete-selected').isEnabled(), true);
        await page.locator('#pipeline-delete-selected').click();
        await page.locator('.confirm-dialog').waitFor();
        assert.match(await page.locator('.confirm-dialog').innerText(), /删除后无法恢复/);
        await page.locator('.confirm-dialog').getByRole('button', { name: '确认删除', exact: true }).click();
        await page.waitForFunction(() => window.__deleteCalls.some(function (message) { return Array.isArray(message.ids) && message.ids.indexOf('fail-1') >= 0; }));
        await page.waitForFunction(() => document.querySelector('#pipeline-delete-status').textContent.includes('已删除 1 个书签'));
        await page.locator('#rag-processing-tab').click();
        assert.equal(await page.locator('[data-search-page="rag"]').isVisible(), true);
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
        if (await list.count()) {
          const metrics = await list.evaluate(el => ({ height: el.clientHeight, scroll: el.scrollHeight }));
          if (metrics.scroll > metrics.height) assert.equal(metrics.height >= 360 && metrics.height <= 760, true);
        }
        const overflow = await page.locator('#workspace-search').evaluate(el => el.scrollWidth > el.clientWidth + 1);
        assert.equal(overflow, false, width + ' 像素下子页不应横向溢出：' + name);
        await page.locator('#search-breadcrumb button').click();
      }
    }
    await page.evaluate(() => Workspace.open('search', 'rag'));
    assert.equal(await page.locator('[data-search-page="rag"]').isVisible(), true);
    await page.locator('#search-breadcrumb button').click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#search-overview [data-search-target="enrich"]').click();
    await page.locator('#enrich-scan').click();
    await page.waitForFunction(() => window.__navigationMessages.includes('enrich:scan'));
    assert.equal(await page.locator('#enrich-status').isVisible(), true);
    assert.equal(await page.locator('#rag-enabled').isVisible(), false);
    await page.screenshot({ path: '/tmp/chrome-tab-search-enrich.png' });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
