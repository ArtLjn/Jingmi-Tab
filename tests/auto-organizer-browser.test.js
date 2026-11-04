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
          window.calls.push(message);
          return { ok: true, data: { enabled: true, aiReady: true, totalRules: 0, filed: 0, rules: [],
            folders: [
              { id: '1', title: '书签栏', path: '书签栏', selectable: false },
              { id: '6', parentId: '1', title: '工作', path: '书签栏 / 工作', selectable: true },
              { id: '7', parentId: '6', title: '项目', path: '书签栏 / 工作 / 项目', selectable: true },
              { id: '8', parentId: '6', title: '资料', path: '书签栏 / 工作 / 资料', selectable: true },
              ...Array.from({ length: 24 }, (_, i) => ({ id: 'f' + i, parentId: '1', title: '归档' + i, path: '书签栏 / 归档' + i, selectable: true }))
            ],
            archiveRecords: Array.from({ length: 25 }, (_, i) => ({ title: '归档记录 ' + i, from: '其他书签', to: '工作 / 项目', movedAt: 100000 - i, state: i ? 'moved' : 'restored' })),
            pending: message.type === 'auto:scan' || (message.type === 'auto:status' && window.calls.some(call => call.type === 'auto:scan') && !window.calls.some(call => call.type === 'auto:adopt'))
              ? [{ id: 'x', title: '测试收藏 ' + '超长标题'.repeat(30), host: 'example.com', folderId: '7', path: '工作 / 项目', why: '内容属于项目', withSummary: !!window.reviewed }] : [] } };
        }
      } };
    });
    await page.addScriptTag({ path: path.join(root, 'js/auto-organizer-ui.js') });
    await page.evaluate(() => AutoOrganizerUI.mount());
    await page.getByRole('tab', { name: /归档记录/ }).click();
    await page.locator('.auto-archive-record').first().waitFor();
    assert.equal(await page.locator('.auto-archive-record').count(), 20);
    assert.match(await page.locator('#auto-organize-history').textContent(), /已撤销/);
    assert.match(await page.locator('#auto-organize-history').textContent(), /其他书签 → 工作 \/ 项目/);
    await page.getByRole('button', { name: '查看更多记录' }).click();
    assert.equal(await page.locator('.auto-archive-record').count(), 25);
    assert.equal(await page.locator('#auto-organize-history').evaluate(el => el.getBoundingClientRect().height >= 360 && el.getBoundingClientRect().height <= 760 && el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto'), true);
    await page.click('#auto-organize-scan');
    // 扫描会切回待确认并刷新列表。
    await page.locator('[data-auto-adopt="x"]').waitFor();
    assert.equal(await page.locator('#auto-pending-count').textContent(), '1');
    assert.equal(await page.locator('#auto-rule-count').textContent(), '0');
    assert.equal(await page.locator('#auto-history-count').textContent(), '25');
    assert.match(await page.locator('#auto-organize-body').textContent(), /内容属于项目/);
    const target = page.getByRole('button', { name: /^选择归档目录 · 测试收藏/ });
    const remember = page.getByRole('checkbox', { name: '记住此页面范围' });
    assert.match(await target.textContent(), /书签栏 \/ 工作 \/ 项目/);
    assert.equal(await remember.isChecked(), false);
    const row = page.locator('.auto-suggestion');
    assert.equal(await row.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    const gap = await row.evaluate(node => node.querySelector('.auto-suggestion-actions').getBoundingClientRect().left -
      node.querySelector('.auto-remember').getBoundingClientRect().right);
    assert.ok(gap >= 0 && gap <= 16);
    await target.click();
    const picker = page.getByRole('listbox', { name: '归档目录' });
    await picker.waitFor();
    assert.equal(await picker.evaluate(node => node.getBoundingClientRect().height <= 252), true);
    assert.equal(await picker.locator('.auto-folder-options').evaluate(node => node.scrollHeight > node.clientHeight), true);
    const search = picker.getByRole('searchbox', { name: '搜索归档目录' });
    await search.fill('资料');
    assert.equal(await picker.getByRole('option').count(), 1);
    await page.evaluate(() => { window.docClicks = 0; document.addEventListener('click', () => { window.docClicks += 1; }); });
    await picker.getByRole('option', { name: /资料/ }).click();
    assert.equal(await page.evaluate(() => window.docClicks), 0);
    assert.match(await target.textContent(), /书签栏 \/ 工作 \/ 资料/);
    await page.setViewportSize({ width: 320, height: 740 });
    assert.equal(await row.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await target.click();
    await picker.getByRole('searchbox').press('Escape');
    assert.equal(await picker.count(), 0);
    assert.equal(await target.evaluate(node => node === document.activeElement), true);
    await target.click();
    await picker.getByRole('option', { name: '书签栏 / 工作', exact: true }).click();
    assert.match(await target.textContent(), /书签栏 \/ 工作$/);
    await remember.check();
    await page.evaluate(() => { window.reviewed = true; update({ type: 'auto:updated' }); });
    await page.getByText(/已读取公开摘要/).waitFor();
    assert.match(await target.textContent(), /书签栏 \/ 工作$/);
    assert.equal(await remember.isChecked(), true);
    await page.click('[data-auto-adopt="x"]');
    assert.deepEqual(await page.evaluate(() => calls.find(call => call.type === 'auto:adopt')),
      { type: 'auto:adopt', id: 'x', folderId: '6', remember: true });
    await page.evaluate(() => update({ type: 'auto:updated' }));
    assert.equal(await page.evaluate(() => calls.at(-1).type), 'auto:status');
  } finally { await browser.close(); }
});
