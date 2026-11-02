/* 真实浏览器表单验证，使用隔离测试账号与接口替身，不访问真实扩展或服务。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DOMParser } = require('linkedom');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '..');
const executablePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('邀请码只在注册显示，空值不请求，错误提示明确且提交后不保留口令', { skip: !fs.existsSync(executablePath), timeout: 20000 }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    const doc = new DOMParser().parseFromString(fs.readFileSync(path.join(root, 'newtab.html'), 'utf8'), 'text/html');
    await page.setContent('<style>[hidden]{display:none!important}</style>' + doc.querySelector('#workspace-account').outerHTML + doc.querySelector('#account-modal').outerHTML);
    await page.evaluate(() => {
      window.model = { backup: {} };
      window.calls = [];
      window.Backup = {
        readStatus: async () => ({}), updateStatus: async () => ({}), originPattern: () => 'https://example.test/*',
        async authRegister(cfg, username, password, invite) {
          calls.push({ username, invite });
          const e = new Error('无效邀请'); e.code = 'invalid_invite'; throw e;
        }
      };
      window.Settings = { save: async () => {} };
    });
    await page.addScriptTag({ path: path.join(root, 'js/backup-ui.js') });
    await page.evaluate(() => BackupUI.mount({ getSettings: () => model, persist() {} }));
    await page.click('#workspace-account');
    assert.equal(await page.locator('#backup-invite').isVisible(), false);
    await page.click('#backup-register');
    assert.equal(await page.locator('#backup-invite').isVisible(), true);
    assert.equal(await page.locator('#backup-invite').getAttribute('required'), '');
    await page.fill('#backup-username', 'test@example.com');
    await page.fill('#backup-password', 'test-password');
    await page.fill('#backup-confirm-password', 'test-password');
    await page.click('#backup-register');
    assert.equal(await page.evaluate(() => calls.length), 0);
    await page.fill('#backup-invite', '仅测试的邀请码');
    await page.click('#backup-register');
    await page.waitForFunction(() => document.querySelector('#backup-status').textContent.includes('邀请码无效'));
    assert.equal(await page.locator('#backup-invite').inputValue(), '');
    assert.equal(await page.evaluate(() => JSON.stringify(model).includes('仅测试的邀请码')), false);
    await page.click('#backup-back-login');
    assert.equal(await page.locator('#backup-invite').isVisible(), false);
    assert.equal(await page.locator('#backup-invite').getAttribute('required'), null);
  } finally { await browser.close(); }
});
