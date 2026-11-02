/* 使用真实面板验证收件箱入口与建议按钮，不依赖其他工作台模块。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { DOMParser } = require('linkedom');
const root = path.resolve(__dirname, '..');
const executablePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('浏览器验证：收件箱扫描入口、AI 建议确认与后台更新', { skip: !fs.existsSync(executablePath), timeout: 20000 }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    const doc = new DOMParser().parseFromString(fs.readFileSync(path.join(root, 'newtab.html'), 'utf8'), 'text/html');
    await page.setContent('<div class="search-subpage" data-search-page="organize">' + doc.querySelector('#auto-organize-card').outerHTML + '</div>');
    await page.addStyleTag({ path: path.join(root, 'css/newtab.css') });
    await page.evaluate(() => {
      window.calls = [];
      window.chrome = { runtime: {
        onMessage: { addListener(fn) { window.update = fn; } },
        async sendMessage(message) {
          window.calls.push(message.type);
          return { ok: true, data: { enabled: true, aiReady: true, totalRules: 0, filed: 0, rules: [],
            archiveRecords: Array.from({ length: 25 }, (_, i) => ({ title: '归档记录 ' + i, from: '其他书签', to: '工作 / 项目', movedAt: 100000 - i, state: i ? 'moved' : 'restored' })),
            pending: message.type === 'auto:scan' ? [{ id: 'x', title: '测试收藏', host: 'example.com', folderId: '7', path: '工作 / 项目', why: '内容属于项目' }] : [] } };
        }
      } };
    });
    await page.addScriptTag({ path: path.join(root, 'js/auto-organizer-ui.js') });
    await page.evaluate(() => AutoOrganizerUI.mount());
    await page.locator('.auto-archive-record').first().waitFor();
    assert.equal(await page.locator('.auto-archive-record').count(), 20);
    assert.match(await page.locator('#auto-organize-history').textContent(), /已撤销/);
    assert.match(await page.locator('#auto-organize-history').textContent(), /其他书签 → 工作 \/ 项目/);
    await page.getByRole('button', { name: '查看更多记录' }).click();
    assert.equal(await page.locator('.auto-archive-record').count(), 25);
    assert.equal(await page.locator('#auto-organize-history').evaluate(el => el.getBoundingClientRect().height >= 360 && el.getBoundingClientRect().height <= 760 && el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto'), true);
    await page.click('#auto-organize-scan');
    await page.locator('#auto-organize-details').evaluate(node => { node.open = true; });
    // 展开会刷新，扫描后检查建议和操作。
    await page.click('#auto-organize-scan');
    await page.locator('[data-auto-adopt="x"]').waitFor();
    assert.match(await page.locator('#auto-organize-body').textContent(), /内容属于项目/);
    await page.click('[data-auto-adopt="x"]');
    assert.equal(await page.evaluate(() => calls.includes('auto:adopt')), true);
    await page.evaluate(() => update({ type: 'auto:updated' }));
    assert.equal(await page.evaluate(() => calls.at(-1)), 'auto:status');
  } finally { await browser.close(); }
});
