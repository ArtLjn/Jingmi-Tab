/* 真实面板验证：全量入口、完整失败重试和统计口径。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { DOMParser } = require('linkedom');
const root = path.resolve(__dirname, '..');
const executablePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('采集面板显示总书签与收录统计，全量扫描和失败重试使用独立接口', { skip: !fs.existsSync(executablePath), timeout: 20000 }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    const doc = new DOMParser().parseFromString(fs.readFileSync(path.join(root, 'newtab.html'), 'utf8'), 'text/html');
    await page.setContent(doc.querySelector('#enrich-card').outerHTML + doc.querySelector('#rag-flow-card').outerHTML);
    await page.evaluate(() => {
      window.calls = [];
      window.chrome = { runtime: { async sendMessage(message) {
        calls.push(message);
        return { ok: true, data: { collection: { total: 403, collected: 260, uncollected: 143, queue: 0, failed: 84, states: { queued: 0, failed: 84, manual: 40, paused: 10, waiting: 9 }, updates: { queued: 0, failed: 0 } }, enabled: true, totalItems: 403, capturedPages: 30, successful: 7,
          unprocessed: 350, queued: 20, processing: 1, failedCount: 5, manualCount: 20,
          jobs: { pending: 20, running: 1, failed: 5, paused: 0 }, records: [], pending: [], totalPending: 0, failures: [], totalFailed: 40, hardFailures: 40, retryableFailed: 5,
          failureTags: [{ key: 'network', label: '网络', count: 40 }] } };
      } } };
    });
    await page.addScriptTag({ path: path.join(root, 'js/retry-policy.js') });
    await page.addScriptTag({ path: path.join(root, 'js/collection-stats.js') });
    await page.addScriptTag({ path: path.join(root, 'js/bookmark-enrich-ui.js') });
    await page.addScriptTag({ path: path.join(root, 'js/rag-settings.js') });
    await page.evaluate(() => {
      BookmarkEnrichUI.mount();
      window.Rag = { withAuth: cfg => cfg, available: () => false };
      RagSettings.mount({ settings: () => ({ rag: { enabled: false } }), persist() {} });
    });
    await page.waitForFunction(() => document.querySelector('#enrich-status').textContent.includes('总书签 403'));
    const text = await page.locator('#enrich-status').textContent();
    assert.equal(text, '总书签 403 · 已收录 260 · 未收录 143');
    assert.doesNotMatch(text, /已采集|已补全|未处理|需打开/);
    assert.equal(await page.locator('#enrich-accounting').textContent(), '总书签 403 = 已收录 260 + 未收录 143');
    await page.waitForFunction(() => document.querySelector('#pipeline-status').textContent.includes('总书签 403'));
    assert.equal((await page.locator('#pipeline-status').textContent()).endsWith(text), true);
    assert.equal(await page.locator('#rag-stat-total').textContent(), '403');
    assert.equal(await page.locator('#rag-stat-collected').textContent(), '260');
    assert.equal(await page.locator('#rag-stat-uncollected').textContent(), '143');
    // 任务数字来自下方任务列表，不能再拿未收录分组的旧统计代替。
    assert.equal(await page.locator('#rag-stat-failed').textContent(), '0');
    assert.equal(await page.locator('#rag-stat-queue').textContent(), '0');
    await page.click('#enrich-scan');
    assert.equal(await page.evaluate(() => calls.some(m => m.type === 'enrich:scan')), true);
    await page.click('#enrich-capture');
    assert.equal(await page.evaluate(() => calls.some(m => m.type === 'enrich:capture')), true);
    await page.locator('#enrich-details').evaluate(node => { node.open = true; });
    assert.equal(await page.locator('#enrich-filters').isVisible(), true);
    assert.equal(await page.locator('#enrich-filters [data-filter="failures"]').getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('#enrich-filters').textContent(), /待确认\s*0/);
    assert.match(await page.locator('#enrich-filters').textContent(), /补全异常\s*40/);
    assert.deepEqual(await page.locator('#enrich-filters [data-filter]').evaluateAll(nodes => nodes.map(node => node.dataset.filter)), ['pending', 'failures', 'recent']);
    assert.match(await page.locator('#enrich-summary').textContent(), /AI 建议待确认 0 · 采集补全异常 40/);
    assert.match(await page.locator('#enrich-body').textContent(), /类型：网络 40/);
    assert.match(await page.locator('#enrich-body').textContent(), /异常项正在读取，请稍后刷新/);
    await page.locator('#enrich-filters [data-filter="pending"]').click();
    assert.match(await page.locator('#enrich-body').textContent(), /暂无待确认建议/);
    await page.locator('#enrich-filters [data-filter="recent"]').click();
    assert.match(await page.locator('#enrich-body').textContent(), /还没有成功生成的摘要/);
    await page.locator('#enrich-filters [data-filter="failures"]').click();
    await page.click('#enrich-retry-unsuccessful');
    assert.equal(await page.evaluate(() => calls.some(m => m.type === 'enrich:retry-failed')), true);
    assert.match(await page.locator('#enrich-body').textContent(), /批量重试仅处理可重试项/);
  } finally { await browser.close(); }
});
