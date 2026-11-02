/* 真实 Chrome 验证连接状态与同步开关独立，所有账号与检索响应均为替身。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const executablePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('RAG 设置显示实际检索检测结果，重新检测失败不会冒充未登录或修改同步开关', { skip: !fs.existsSync(executablePath), timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    const html = fs.readFileSync(path.join(root, 'newtab.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
    await page.setContent(html);
    await page.evaluate(() => {
      window.__calls = [];
      window.__offline = false;
      window.__settings = { rag: { enabled: true, autoSync: true }, backup: {} };
      window.Profiles = { cloud: () => ({ collection: 'chrome_tab_account', token: '测试令牌' }), requireCloud: async () => ({ collection: 'chrome_tab_account', token: '测试令牌' }) };
      window.fetch = async (url, options) => {
        window.__calls.push({ path: new URL(url).pathname, body: JSON.parse(options.body) });
        if (window.__offline) throw new Error('离线');
        return new Response(JSON.stringify({ code: 'OK', data: { results: [] } }));
      };
      window.chrome = { runtime: { sendMessage: async () => ({ ok: true, data: {} }) } };
    });
    for (const name of ['collection-stats', 'rag', 'rag-settings']) await page.addScriptTag({ path: path.join(root, 'js', name + '.js') });
    await page.evaluate(async () => {
      window.ui = RagSettings.mount({ settings: () => window.__settings, persist() {} });
      await ui.bind();
    });
    assert.match(await page.locator('#rag-connection-status').textContent(), /检索连接正常/);
    assert.equal(await page.locator('#rag-enabled').isChecked(), true);
    assert.deepEqual(await page.evaluate(() => __calls.map(call => call.path)), ['/api/rag/retrieve']);
    await page.evaluate(() => { window.__offline = true; document.querySelector('#rag-check').click(); });
    await page.waitForFunction(() => document.querySelector('#rag-connection-status').textContent.includes('无法连接'));
    assert.equal(await page.locator('#rag-enabled').isChecked(), true);
    assert.equal(await page.locator('#rag-check').isDisabled(), false);
    await page.evaluate(() => { window.__offline = false; document.querySelector('#rag-check').click(); });
    await page.waitForFunction(() => document.querySelector('#rag-connection-status').textContent.includes('检测通过'));
  } finally { await browser.close(); }
});

test('任务标签随后台状态自动分流，重试返回处理区并支持键盘切换', { skip: !fs.existsSync(executablePath), timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const html = fs.readFileSync(path.join(root, 'newtab.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
    await page.setContent(html);
    await page.addStyleTag({ path: path.join(root, 'css/newtab.css') });
    await page.evaluate(() => {
      window.__records = [{ id: '1', title: '当前任务', status: 'running', sync: 'pending' }];
      window.__listeners = [];
      window.__retryable = 0; window.__batchCalls = 0; window.__selectedIds = []; 
      window.Rag = { withAuth: cfg => cfg, resolve: async () => ({}), available: () => true };
      window.Settings = { save: async () => {} };
      window.chrome = { runtime: {
        onMessage: { addListener: listener => __listeners.push(listener) },
        sendMessage: async message => {
          if (message.type === 'pipeline:retry-failed') {
            __batchCalls++; __selectedIds = message.ids;
            await new Promise(resolve => { window.__finishBatch = resolve; });
            __records[0] = { id: '1', title: '当前任务', status: 'pending', sync: 'failed' };
            __retryable = 0;
            return { ok: true, data: { retryBatch: { queued: 1, skipped: 0 } } };
          }
          return { ok: true, data: { records: __records, retryableJobs: __retryable } };
        }
      }, permissions: { request: async () => true } };
      window.__settings = { rag: { baseUrl: 'https://example.com' }, backup: {} };
    });
    for (const name of ['collection-stats', 'workspace', 'rag-settings']) await page.addScriptTag({ path: path.join(root, 'js', name + '.js') });
    await page.evaluate(() => {
      RagSettings.mount({ settings: () => __settings, persist() {} });
      Workspace.open('search', 'rag');
    });
    await page.waitForFunction(() => document.querySelector('#rag-processing-count').textContent === '1');
    assert.match(await page.locator('#pipeline-records').textContent(), /当前任务/);
    // 模拟持久化后台通知；列表无需手动切页即可迁移。
    await page.evaluate(() => {
      __records[0] = { id: '1', title: '当前任务', status: 'waiting', sync: 'failed', error: '连接失败，等待自动重试' };
      __listeners.forEach(listener => listener({ type: 'pipeline:updated' }));
    });
    await page.waitForFunction(() => document.querySelector('#rag-failure-count').textContent === '1');
    assert.equal(await page.locator('#pipeline-records .pipeline-record').count(), 0);
    await page.locator('#rag-failures-tab').click();
    assert.match(await page.locator('#rag-failure-records').textContent(), /连接失败/);
    assert.equal(await page.locator('#search-page-detail').textContent(), '失败任务');
    assert.equal(await page.locator('#pipeline-retry').isDisabled(), true);
    // 操作栏没有可用任务时也不留空白占位。
    assert.equal(await page.locator('#rag-failure-records').evaluate(el => el.getBoundingClientRect().top - document.querySelector('.rag-failure-selection').getBoundingClientRect().bottom < 50), true);
    await page.evaluate(() => { __retryable = 1; __records[0].selectableRetry = true; __listeners.forEach(listener => listener({ type: 'pipeline:updated' })); });
    await page.locator('#rag-failure-select-all').check();
    await page.waitForFunction(() => !document.querySelector('#pipeline-retry').disabled);
    await page.locator('#pipeline-retry').click();
    await page.waitForFunction(() => __batchCalls === 1);
    assert.equal(await page.locator('#pipeline-retry').isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => __selectedIds), ['1']);
    await page.evaluate(() => { document.querySelector('#pipeline-retry').click(); });
    assert.equal(await page.evaluate(() => __batchCalls), 1);
    await page.evaluate(() => __finishBatch());
    await page.waitForFunction(() => document.querySelector('#pipeline-retry-status').textContent.includes('已重新入队 1 项'));
    assert.equal(await page.locator('#pipeline-retry').isDisabled(), true);
    // 显式重试已清除任务错误，但文档还保留上次失败状态。
    await page.evaluate(() => {
      __records[0] = { id: '1', title: '当前任务', status: 'pending', sync: 'failed' };
      __listeners.forEach(listener => listener({ type: 'pipeline:updated' }));
    });
    await page.waitForFunction(() => document.querySelector('#rag-failure-count').textContent === '0');
    assert.equal(await page.locator('#rag-processing-count').textContent(), '1');
    await page.locator('#rag-failures-tab').press('ArrowLeft');
    assert.equal(await page.locator('#rag-processing-tab').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#rag-processing-panel').isVisible(), true);
    await page.evaluate(() => { Workspace.close(); Workspace.open('search', 'rag'); });
    assert.match(await page.locator('#pipeline-records').textContent(), /当前任务/);
    // 待核验的写入即使仍标记 running，也不能自动回到处理区。
    await page.evaluate(() => {
      __records[0] = { id: '1', title: '当前任务', status: 'running', outcomeUnknown: true };
      __listeners.forEach(listener => listener({ type: 'pipeline:updated' }));
    });
    await page.waitForFunction(() => document.querySelector('#rag-failure-count').textContent === '1');
    await page.locator('#rag-processing-tab').press('End');
    assert.equal(await page.locator('#rag-failures-panel').isVisible(), true);
    await page.setViewportSize({ width: 760, height: 900 });
    assert.equal(await page.locator('.rag-task-tabs').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  } finally { await browser.close(); }
});

test('处理页只展示实际队列，手动批量处理；失败类型筛选、跨分页全选及部分选择保持一致', { skip: !fs.existsSync(executablePath), timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const html = fs.readFileSync(path.join(root, 'newtab.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
    await page.setContent(html); await page.addStyleTag({ path: path.join(root, 'css/newtab.css') });
    await page.evaluate(() => {
      window.__listeners = []; window.__starts = 0;
      window.__records = [
        { id: 'done', title: '已完成收藏', status: 'done', sync: 'synced' },
        { id: 'unqueued', title: '尚未安排', status: 'unqueued' },
        { id: 'run', title: '当前处理', status: 'running' },
        { id: 'pending', title: '排队任务', status: 'pending' },
        { id: 'waiting', title: '计划任务', status: 'waiting', dueAt: Date.now() + 99999 }
      ].concat(Array.from({ length: 25 }, (_, i) => ({ id: 'network-' + i, title: '网络失败 ' + i, status: 'failed', error: '网络异常', errorCategory: { key: 'network', label: '网络' }, selectableRetry: true })), [
        { id: 'login', title: '登录任务', status: 'paused', error: '请先登录', errorCategory: { key: 'login', label: '需登录' }, selectableRetry: true },
        { id: 'unknown', title: '待核验', status: 'paused', error: '需核验写入', outcomeUnknown: true, errorCategory: { key: 'other', label: '其他' }, selectableRetry: false }
      ]);
      window.Rag = { withAuth: cfg => cfg, resolve: async () => ({}), available: () => true, check: async () => ({ checkedAt: Date.now() }) };
      window.Settings = { save: async () => {} };
      window.__settings = { rag: { baseUrl: 'https://example.com' }, backup: {} };
      window.chrome = { runtime: { onMessage: { addListener: listener => __listeners.push(listener) }, sendMessage: async message => {
        if (message.type === 'pipeline:start') {
          __starts++;
          await new Promise(resolve => { window.__finishStart = resolve; });
          __records = __records.map(row => ['running', 'pending'].includes(row.status) ? { ...row, status: 'done' } : row);
        }
        return { ok: true, data: { records: __records } };
      } }, permissions: { request: async () => true } };
    });
    for (const name of ['collection-stats', 'workspace', 'rag-settings']) await page.addScriptTag({ path: path.join(root, 'js', name + '.js') });
    await page.evaluate(() => { RagSettings.mount({ settings: () => __settings, persist() {} }); Workspace.open('search', 'rag'); });
    await page.waitForFunction(() => document.querySelector('#rag-processing-count').textContent === '3');
    assert.equal(await page.locator('#pipeline-records .pipeline-record').count(), 3);
    assert.doesNotMatch(await page.locator('#pipeline-records').textContent(), /已完成收藏|尚未安排/);
    await page.locator('#pipeline-start').click();
    await page.waitForFunction(() => __starts === 1);
    assert.equal(await page.locator('#pipeline-start').isDisabled(), true);
    await page.evaluate(() => document.querySelector('#pipeline-start').click());
    assert.equal(await page.evaluate(() => __starts), 1);
    await page.evaluate(() => __finishStart());
    await page.waitForFunction(() => document.querySelector('#rag-processing-count').textContent === '1');
    assert.match(await page.locator('#pipeline-queue-status').textContent(), /计划等待 1/);
    await page.locator('#rag-failures-tab').click();
    await page.locator('#rag-failure-filter').selectOption('network');
    assert.equal(await page.locator('#rag-failure-records .pipeline-record').count(), 20);
    await page.locator('#rag-failure-select-all').check();
    assert.match(await page.locator('#pipeline-retry').textContent(), /25/);
    await page.getByRole('button', { name: '查看更多失败任务' }).click();
    assert.equal(await page.locator('#rag-failure-records .pipeline-select:checked').count(), 25);
    await page.locator('#rag-failure-records .pipeline-select').first().uncheck();
    assert.equal(await page.locator('#rag-failure-select-all').evaluate(el => el.indeterminate), true);
    await page.evaluate(() => __listeners.forEach(listener => listener({ type: 'pipeline:updated' })));
    await page.waitForFunction(() => document.querySelectorAll('#rag-failure-records .pipeline-select:checked').length === 24);
    await page.locator('#rag-failure-filter').selectOption('login');
    assert.equal(await page.locator('#pipeline-retry').isDisabled(), true);
    assert.equal(await page.locator('#rag-failure-records .pipeline-record').count(), 1);
    await page.locator('#rag-failure-select-all').check();
    assert.match(await page.locator('#pipeline-retry').textContent(), /1/);
    await page.locator('#rag-failure-filter').selectOption('other');
    assert.equal(await page.locator('#rag-failure-records .pipeline-select').isDisabled(), false, '不可重试的失败项仍可选择用于删除');
    assert.equal(await page.locator('#rag-failure-select-all').isDisabled(), false);
    await page.locator('#rag-failure-records .pipeline-select').check();
    assert.equal(await page.locator('#pipeline-retry').isDisabled(), true, '不可重试项不应启用重试');
    assert.equal(await page.locator('#pipeline-delete-selected').isEnabled(), true, '不可重试项可以删除');
    await page.setViewportSize({ width: 760, height: 900 });
    assert.equal(await page.locator('.rag-failure-selection').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await page.screenshot({ path: '/tmp/chrome-tab-failure-selection.png', animations: 'disabled' });
  } finally { await browser.close(); }
});

test('总书签与收录数相加一致，未收录明细完整列出任务之外的每个书签', { skip: !fs.existsSync(executablePath), timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const html = fs.readFileSync(path.join(root, 'newtab.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
    await page.setContent(html); await page.addStyleTag({ path: path.join(root, 'css/newtab.css') });
    await page.evaluate(() => {
      // 此处为构造的统计样例，用于验证每条未收录书签都能找到。
      const items = Array.from({ length: 175 }, (_, i) => ({ id: String(i), title: '未收录书签 ' + i, url: 'https://example.com/' + i, state: i < 140 ? 'failed' : 'unarranged', reason: i < 140 ? '网络异常' : '尚未安排处理任务' }));
      window.__data = { collection: { total: 403, collected: 228, uncollected: 175, queue: 99, failed: 23, uncollectedItems: items, uncollectedBreakdown: { queue: 0, failed: 140, manual: 0, unarranged: 35 } }, records: items.slice(0, 140).map(item => ({ ...item, status: 'failed', error: '网络异常' })) };
      window.chrome = { runtime: { sendMessage: async () => ({ ok: true, data: __data }) } };
      window.Rag = { check: async () => ({ checkedAt: Date.now() }) };
    });
    for (const name of ['collection-stats', 'workspace', 'rag-settings']) await page.addScriptTag({ path: path.join(root, 'js', name + '.js') });
    await page.evaluate(() => { RagSettings.mount({ settings: () => ({ rag: {}, backup: {} }), persist() {} }); Workspace.open('search', 'rag'); });
    await page.waitForFunction(() => document.querySelector('#rag-stat-total').textContent === '403');
    assert.equal(await page.locator('#rag-stat-collected').textContent(), '228');
    assert.equal(await page.locator('#rag-stat-uncollected').textContent(), '175');
    assert.equal(await page.locator('#rag-stat-failed').textContent(), await page.locator('#rag-failure-count').textContent());
    assert.equal(await page.locator('#rag-stat-queue').textContent(), await page.locator('#rag-processing-count').textContent());
    assert.equal(await page.locator('#rag-stat-failed').textContent(), '140');
    assert.equal(await page.locator('#rag-stat-queue').textContent(), '0');
    assert.equal(await page.locator('#rag-uncollected-details').getAttribute('open'), null);
    assert.equal(await page.locator('#rag-uncollected-breakdown').isVisible(), true, '未收录分类默认可见，不需要展开明细');
    await page.locator('#rag-uncollected-details > summary').click();
    assert.equal(await page.locator('#rag-uncollected-items .pipeline-record').count(), 175);
    assert.match(await page.locator('#rag-uncollected-breakdown').textContent(), /未收录 175 个书签 = 处理中 0 \+ 处理失败 140 \+ 需补充条件 0 \+ 未安排 35/);
    assert.match(await page.locator('#rag-uncollected-items').textContent(), /未收录书签 174/);
    await page.locator('#rag-uncollected-details > summary').click();
    assert.equal(await page.locator('#rag-uncollected-breakdown').isVisible(), true, '收起明细仍保留分类数字');
    await page.evaluate(() => {
      __data.collection.uncollectedBreakdown = { queue: 0, failed: 132, manual: 43, unarranged: 0 };
      document.dispatchEvent(new CustomEvent('workspace:search-page', { detail: 'rag' }));
    });
    await page.waitForFunction(() => document.querySelector('#rag-uncollected-breakdown').textContent.includes('处理失败 132 + 需补充条件 43'));
    await page.setViewportSize({ width: 760, height: 900 });
    assert.equal(await page.locator('#rag-stats').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    assert.equal(await page.locator('#rag-uncollected-breakdown').isVisible(), true);
    await page.screenshot({ path: '/tmp/chrome-tab-counts-and-details.png', animations: 'disabled' });
  } finally { await browser.close(); }
});
