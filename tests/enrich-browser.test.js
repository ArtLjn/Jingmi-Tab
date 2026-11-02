/* 真实面板验证：全量入口、完整失败重试和统计口径。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { DOMParser } = require('linkedom');
const root = path.resolve(__dirname, '..');
const executablePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('采集面板显示五项统一收录统计，全量扫描和失败重试使用独立接口', { skip: !fs.existsSync(executablePath), timeout: 20000 }, async () => {
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
          jobs: { pending: 20, running: 1, failed: 5, paused: 0 }, records: [], pending: [], totalPending: 0, failures: [], totalFailed: 40, retryableFailed: 5 } };
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
    await page.waitForFunction(() => document.querySelector('#enrich-status').textContent.includes('收藏总数 403'));
    const text = await page.locator('#enrich-status').textContent();
    assert.equal(text, '收藏总数 403 · 已收录 260 · 未收录 143 · 任务队列 0 · 失败 84');
    assert.doesNotMatch(text, /已采集|已补全|未处理|需打开/);
    assert.equal(await page.locator('#enrich-accounting').textContent(), '未收录 143 = 队列 0 + 失败 84 + 需人工处理 40 + 暂停 10 + 待安排 9');
    await page.waitForFunction(() => document.querySelector('#pipeline-status').textContent.includes('收藏总数 403'));
    assert.equal((await page.locator('#pipeline-status').textContent()).endsWith(text), true);
    await page.click('#enrich-scan');
    assert.equal(await page.evaluate(() => calls.some(m => m.type === 'enrich:scan')), true);
    await page.click('#enrich-capture');
    assert.equal(await page.evaluate(() => calls.some(m => m.type === 'enrich:capture')), true);
    await page.locator('#enrich-details').evaluate(node => { node.open = true; });
    await page.click('#enrich-retry-unsuccessful');
    assert.equal(await page.evaluate(() => calls.some(m => m.type === 'enrich:retry-failed')), true);
    assert.match(await page.locator('#enrich-body').textContent(), /批量重试仅处理可重试项/);
  } finally { await browser.close(); }
});
