/* 在真实 Chrome 中验证界面与 IndexedDB，浏览器扩展 API 和 AI 服务使用本地替身。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { fixture } = require('./helpers/extension');
const { png } = require('./helpers/images');
const executablePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('浏览器回归：原有目录、RAG 正文同步、旧日志撤销和窄屏布局', { skip: !fs.existsSync(executablePath), timeout: 60000 }, async () => {
  let malformed = false;
  let aiCalls = 0;
  const cloudDocs = new Map();
  const fullWallpaper = png(3840, 2160); const thumbnail = png(320, 180); let originalDownloads = 0;
  const server = http.createServer(async (req, res) => {
    // 账号与 RAG 代理均为本地替身，整页回归不接触真实服务。
    if (req.url === '/api/auth/me' || req.url === '/api/rag/config' || req.url === '/api/backup/meta') {
      const data = req.url === '/api/auth/me' ? { kind: 'session', user: { id: 2, username: 'browser@example.invalid' } }
        : req.url === '/api/rag/config' ? { enabled: true, collection: 'chrome_tab_browser' } : null;
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, data })); return;
    }
    const ragPath = req.url.replace(/^\/api\/rag\//, '/');
    if (req.url === '/article') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<html><head><title>项目说明</title></head><body><article><h1>系统对接</h1><p>应收凭证支持订单同步。</p></article></body></html>');
      return;
    }
    if (req.url === '/v1/chat/completions') {
      let body = '';
      for await (const chunk of req) body += chunk;
      aiCalls++;
      const system = JSON.parse(body).messages[0].content;
      const rewrite = system.includes('转成 2-4');
      const classify = system.includes('分类助手');
      const answer = system.includes('私人书签库的问答助手');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: classify ? '{"items":[{"id":"1","category":"工作","type":"文档","tags":["接口"]}]}' : malformed ? '{"picks":[{"id":"1"}]}' : answer ? '这是应收凭证订单同步的项目文档。[1]' : rewrite ? '{"k":["应收凭证"]}' : '{"picks":[{"id":"1","why":"正文提到应收凭证"}]}' } }] }));
      return;
    }
    if (ragPath === '/collections' || ragPath === '/ingest' || ragPath === '/retrieve' || req.method === 'DELETE') {
      let body = Buffer.alloc(0);
      for await (const part of req) body = Buffer.concat([body, part]);
      let data = {};
      if (ragPath === '/ingest') {
        const request = new Request('http://localhost/ingest', { method: 'POST', headers: req.headers, body });
        const form = await request.formData();
        cloudDocs.set(form.get('doc_id'), { content: form.get('text'), meta: JSON.parse(form.get('metadata_json')) });
        data = { doc_id: form.get('doc_id') };
      } else if (ragPath === '/retrieve') data = { results: Array.from(cloudDocs).map(([id, doc]) => ({ doc_id: id, content: doc.content, score: 1, chunk_index: 0, metadata: { extra: doc.meta } })) };
      else if (req.method === 'DELETE') cloudDocs.delete(decodeURIComponent(req.url.split('/').pop()));
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: 'OK', data })); return;
    }
    const relative = req.url.split('?')[0];
    const file = path.resolve(root, '.' + relative);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url()); const headers = { 'access-control-allow-origin': '*' };
      if (url.origin === origin) return route.continue();
      if (url.hostname === 'api.jingmi.lllcnm.cn') return route.fulfill({ response: await route.fetch({ url: origin + url.pathname }) });
      if (url.hostname === 'api.bing.com') {
        const q = url.searchParams.get('query') || '';
        const list = q.includes('普通') ? [] : ['项目文档 - 财务接口', '项目文档在线预览'];
        return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify([q, list]) });
      }
      if (url.hostname.endsWith('uhdpaper.com')) {
        if (url.pathname.includes('/wallpaper/')) {
          const full = url.pathname.includes('-4k'); if (full) originalDownloads++;
          return route.fulfill({ status: 200, headers, contentType: 'image/png', body: full ? fullWallpaper : thumbnail });
        }
        const detail = 'https://www.uhdpaper.com/2026/01/quiet-night-4k.html';
        const body = url.pathname.endsWith('.html')
          ? `<a id="_4k" href="https://image-5.uhdpaper.com/wallpaper/quiet-night-4k.jpg">3840x2160</a>`
          : `<article class="post-outer-container"><a href="${detail}"></a><h2>${/fantasy|illustration|anime girl/.test(url.searchParams.get('q') || '') ? 'Fantasy Girl Illustration' : /woman|model|portrait/.test(url.searchParams.get('q') || '') ? 'Woman Portrait' : url.searchParams.has('q') ? 'Anime Night' : 'Quiet Night'}</h2><img src="https://img.uhdpaper.com/wallpaper/quiet-night-thumb.jpg?dl"><b>4K</b></article>`;
        return route.fulfill({ status: 200, headers, contentType: 'text/html', body });
      }
      if (url.hostname === 'api.pexels.com') return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify({ photos: [{ id: 1, width: 6000, height: 4000, alt: 'Professional Portrait', photographer: 'Studio Artist', photographer_url: 'https://www.pexels.com/@studio', url: 'https://www.pexels.com/photo/1/', src: { original: 'https://images.pexels.com/photos/1/original.png', medium: 'https://images.pexels.com/photos/1/thumb.png' } }] }) });
      if (url.hostname === 'images.pexels.com') return route.fulfill({ status: 200, headers, contentType: 'image/png', body: url.pathname.includes('thumb') ? thumbnail : fullWallpaper });
      if (url.hostname === 'www.wallpic.cn') {
        if (url.pathname.startsWith('/wp-content/uploads/')) return route.fulfill({ status: 200, headers, contentType: 'image/png', body: fullWallpaper });
        const body = /\/\d+\.html$/.test(url.pathname)
          ? '<img data-wallpaper-macbook-image="true" src="https://www.wallpic.cn/wp-content/uploads/2026/10/full.png">'
          : '<posts class="posts-item"><div class="item-thumbnail"><a href="https://www.wallpic.cn/42.html"><img data-src="https://www.wallpic.cn/wp-content/uploads/2026/10/thumb.png" alt="银发精灵少女 奇幻插画 电脑静态壁纸"></a></div></posts>';
        return route.fulfill({ status: 200, headers, contentType: 'text/html', body });
      }
      if (url.hostname === 'www.10wallpaper.com') {
        if (url.pathname.startsWith('/wallpaper/')) return route.fulfill({ status: 200, headers, contentType: 'image/png', body: url.pathname.includes('/medium/') ? thumbnail : fullWallpaper });
        const body = url.pathname.startsWith('/cn/view/')
          ? '<a download href="/wallpaper/3840x2160/2601/portrait.png">3840x2160</a>'
          : '<a href="/cn/view/portrait.html"><img src="/wallpaper/medium/2601/portrait.png" alt="国内美女 女演员 写真 5K"></a>';
        return route.fulfill({ status: 200, headers, contentType: 'text/html', body });
      }
      if (url.hostname === 'wallpapercave.com') {
        if (/^\/(wp|wpt)\//.test(url.pathname)) return route.fulfill({ status: 200, headers, contentType: 'image/png', body: url.pathname.startsWith('/wp/') ? fullWallpaper : thumbnail });
        const body = url.pathname === '/search' ? '<a href="/' + (/women|woman|model/.test(url.searchParams.get('q') || '') ? 'women' : 'anime') + '-4k-wallpapers"><img class="thumbnail"></a>' : '<img class="wimg" width="3840" height="2160" src="/wp/wp42.jpg" alt="Cave Mountain 4K">';
        return route.fulfill({ status: 200, headers, contentType: 'text/html', body });
      }
      if (url.hostname === 'www.bing.com' && url.pathname === '/HPImageArchive.aspx') return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify({ images: [{ title: '山间日出', copyright: '雪山精选', startdate: '20261031', urlbase: '/th?id=OHR.Mountain_ZH-CN1234' }] }) });
      if (url.hostname === 'www.bing.com' && url.pathname === '/th') return route.fulfill({ status: 200, headers, contentType: 'image/png', body: url.searchParams.has('w') ? thumbnail : fullWallpaper });
      if (url.hostname === 'haowallpaper.com') return route.fulfill({ status: 200, headers, contentType: 'text/html', body: '<script type="application/ld+json">{"itemListElement":[{"url":"https://haowallpaper.com/homeViewLook/123456","name":"旧图源壁纸","image":"https://img.haowallpaper.com/cache_file/test.png"}]}</script>' });
      if (url.hostname === 'img.haowallpaper.com') return route.fulfill({ status: 200, headers, contentType: 'image/png', body: thumbnail });
      return route.fulfill({ status: 200, body: '搜索引擎测试替身' });
    });
    const model = fixture({ tree: [{ id: '0', title: '', children: [
      { id: '10', parentId: '0', title: '书签栏', children: [{ id: '1', title: '项目文档', url: origin + '/article', dateAdded: 1 }] },
      { id: '20', parentId: '0', title: '其他书签', children: [] }
    ] }] });
    await context.exposeBinding('bookmarkAPI', async (_, { method, args }) => model.bookmarks[method](...args));
    await context.addInitScript(({ origin }) => {
      window.__BACKUP_SERVER__ = origin;
      localStorage.setItem('newtab.session.v1', JSON.stringify({ version: 'browser-session', user: { id: 2, username: 'browser@example.invalid' }, token: 'browser-test-session' }));
      localStorage.setItem('newtab.profile.user-2:initialized', JSON.stringify({ at: 1 }));
      window.__enrichState = {
        collection: { total: 400, collected: 185, uncollected: 215, queue: 0, failed: 1 }, enabled: true, aiReady: true, totalPending: 0, pending: [], queue: 0,
        captured: 15, totalFailed: 3, totalWeb: 400, withBody: 215,
        failures: [
          { id: 'a', title: '需要登录的页面', url: origin + '/article', reason: '正文采集失败：http_403', code: 'http_403' },
          { id: 'b', title: '超时页面', url: origin + '/article', reason: '正文采集失败：timeout', code: 'timeout' },
          { id: 'c', title: '已登录页面', url: origin + '/article', reason: '页面正文已保存', code: 'private' }
        ], recent: [], undoable: false
      };
      window.chrome.bookmarks = {
        getTree: cb => { var p = window.bookmarkAPI({ method: 'getTree', args: [] }); if (cb) p.then(cb); return p; },
        getChildren: id => window.bookmarkAPI({ method: 'getChildren', args: [id] }),
        create: data => window.bookmarkAPI({ method: 'create', args: [data] }),
        move: (id, data) => window.bookmarkAPI({ method: 'move', args: [id, data] })
      };
      const listeners = [];
      window.chrome.runtime = { onMessage: { addListener: fn => listeners.push(fn) }, sendMessage: async msg => {
        if (msg.type === 'pipeline:updated') { listeners.forEach(fn => fn(msg)); return; }
        try {
          var result;
          if (msg.type === 'enrich:status') result = window.__enrichState;
          if (msg.type === 'organizer:undo') result = await OrganizerMoves.undo();
          if (msg.type === 'organizer:status') result = await OrganizerMoves.summary();
          if (typeof SyncEngine !== 'undefined') {
            if (msg.type === 'pipeline:status') result = await SyncEngine.summary();
            if (msg.type === 'pipeline:start') result = await SyncEngine.request({ manual: true, force: !!msg.force });
            if (msg.type === 'pipeline:pause') result = await SyncEngine.pause();
            if (msg.type === 'pipeline:retry-failed') result = await SyncEngine.retryFailed();
            if (msg.type === 'pipeline:retry') result = await SyncEngine.retry(msg.documentId);
            if (msg.type === 'pipeline:changed') result = await SyncEngine.request();
          }
          return { ok: true, data: result };
        } catch (e) { return { ok: false, error: e.message }; }
      } };
      window.chrome.permissions = { request: async () => true, contains: async () => true };
      if (!localStorage.getItem('newtab.profile.user-2:newtab.settings.v1')) localStorage.setItem('newtab.profile.user-2:newtab.settings.v1', JSON.stringify({ ai: { enabled: true, baseUrl: origin + '/v1', apiKey: 'test-key', model: 'test' }, organizer: { autoMove: false }, rag: { enabled: true, baseUrl: origin, apiKey: 'test-key', collection: 'chrome_tab_browser', autoSync: false } }));
    }, { origin });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/newtab.html');
    async function backend() {
      for (const name of ['organizer-moves', 'capture-adapters', 'sync-engine']) await page.addScriptTag({ url: origin + '/js/' + name + '.js' });
    }
    await backend();
    await page.locator('#organizer-open').click();
    await page.waitForSelector('.organizer-item');
    assert.equal(await page.locator('#organizer-dialog .automation-card').count(), 0);
    assert.equal(await page.locator('.organizer-note-btn').count(), await page.locator('.organizer-item').count());
    await page.locator('.organizer-note-btn').first().click();
    await page.locator('.tag-editor').waitFor();
    await page.getByLabel('个人说明', { exact: true }).fill('书签空间直接编辑备注');
    await page.locator('.tag-editor').getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('.tag-editor').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('#organizer-list').textContent.includes('备注：书签空间直接编辑备注'));
    assert.equal(await page.evaluate(() => QuickTags.list().some(t => t.note === '书签空间直接编辑备注')), true);
    await page.locator('#organizer-query').fill('书签空间直接编辑备注');
    await page.waitForFunction(() => document.querySelectorAll('.organizer-item').length === 1);
    await page.locator('#organizer-query').fill('');
    await page.locator('#organizer-sync-settings').click();
    /* 概览进入功能子页，业务操作继续使用原控件。 */
    await page.waitForSelector('#workspace-search:not([hidden])');
    /* 失败任务已合并为同一张卡片内的标签页。 */
    assert.equal(await page.locator('#workspace-search .automation-card').count(), 4);
    assert.equal(await page.locator('#workspace-automation').count(), 0);
    assert.equal(await page.locator('#workspace-crumbs').count(), 0);
    assert.equal(await page.locator('#auto-organize-title').innerText(), 'AI 辅助收藏归档');
    await page.locator('#search-breadcrumb button').click();
    await page.locator('#search-overview [data-search-target="enrich"]').click();
    assert.equal(await page.locator('#enrich-title').innerText(), '标题、摘要与标签');
    await page.locator('#enrich-details').evaluate(el => { el.open = true; el.dispatchEvent(new Event('toggle')); });
    await page.waitForFunction(() => document.querySelector('#enrich-summary').textContent.includes('采集补全异常'));
    assert.match(await page.locator('#enrich-body').innerText(), /公开抓取无法读取正文；打开页面后点击扩展图标采集/);
    assert.equal(await page.locator('#enrich-body [data-enrich-retry]').count(), 1);
    assert.equal(await page.locator('#enrich-body [data-enrich-private]').count(), 1);
    assert.equal(await page.locator('#enrich-body a.auto-action').count(), 1);
    assert.equal(await page.locator('#index-build, #feishu-token, #feishu-authorize, #rag-auto, #rag-capture, #organizer-auto, #organizer-run, #organizer-target').count(), 0);
    assert.equal(await page.locator('#rag-enabled').isChecked(), false);
    await page.locator('#search-breadcrumb button').click();
    await page.locator('#search-overview [data-search-target="rag"]').click();
    await page.locator('#pipeline-start').click();
    await page.waitForFunction(() => document.querySelector('#pipeline-status').textContent.includes('已收录 1'), null, { timeout: 5000 }).catch(async error => { throw new Error(error.message + '；状态=' + await page.locator('#pipeline-status').textContent() + '；提示=' + await page.locator('#rag-status').textContent()); });
    assert.equal(await page.locator('#rag-enabled').isChecked(), false);
    assert.equal(model.node('1').parentId, '10');
    assert.match(Array.from(cloudDocs.values())[0].content, /应收凭证/);
    await page.screenshot({ path: '/tmp/chrome-tab-rag-bookmarks.png', animations: 'disabled' });
    await page.locator('#panel-close').click();
    await page.locator('#search-input').fill('/应收凭证');
    await page.waitForSelector('.ac-evidence');
    assert.match(await page.locator('#ac-panel').innerText(), /项目文档[\s\S]*正文[\s\S]*应收凭证/);
    assert.equal(aiCalls, 0);
    await page.reload();
    await backend();
    await page.locator('#search-input').fill('/应收凭证');
    await page.waitForSelector('.ac-evidence');
    await page.locator('#search-input').fill('?帮我找到财务接口说明');
    await page.locator('#search-input').press('Enter');
    await page.waitForFunction(() => document.querySelector('#ac-panel').textContent.includes('这是应收凭证订单同步的项目文档'), null, { timeout: 8000 }).catch(async error => { throw new Error(error.message + '；面板=' + await page.locator('#ac-panel').textContent() + '；调用=' + aiCalls + '；错误=' + JSON.stringify(errors)); });
    assert.ok(aiCalls >= 1);
    assert.match(await page.locator('#ac-panel').innerText(), /项目文档/);
    await page.waitForSelector('.ac-answer:not(.is-streaming)');
    await page.waitForFunction(() => document.querySelector('#ac-panel').textContent.includes('看本地排序的全部'));
    await page.locator('.ac-act').first().dispatchEvent('mousedown');
    await page.waitForFunction(() => document.querySelector('#ac-panel').textContent.includes('本地排序 · 共 1 条候选'), null, { timeout: 5000 }).catch(async error => { throw new Error(error.message + '；面板=' + await page.locator('#ac-panel').innerText()); });
    assert.ok(aiCalls >= 1);
    /* 中文输入法直接打全角问号/斜杠/at 也要进入对应模式。 */
    await page.locator('#search-input').fill(' ？项目文档');
    assert.equal(await page.locator('#search-form').evaluate(el => el.classList.contains('is-ai')), true);
    assert.equal(await page.locator('#engine-chip').innerText(), 'AI');
    await page.locator('#search-input').press('Enter');
    await page.waitForSelector('.ac-answer:not(.is-streaming)');
    assert.equal(await page.locator('.ac-answer-label').innerText(), 'AI 回答');
    assert.match(await page.locator('.ac-answer-text').innerText(), /订单同步/);
    await page.locator('#search-input').fill('／项目文档');
    assert.equal(await page.locator('#search-form').evaluate(el => el.classList.contains('is-bookmarks')), true);
    await page.locator('#search-input').fill('＠项目');
    assert.equal(await page.locator('#search-form').evaluate(el => el.classList.contains('is-tags')), true);
    await page.locator('#search-input').fill('');
    await page.screenshot({ path: '/tmp/chrome-tab-content-search.png' });
    malformed = true;
    await page.evaluate(() => AI.clearCache());
    await page.locator('#search-input').fill('?应收凭证接口');
    const callsBeforeMalformed = aiCalls;
    await page.locator('#search-input').press('Enter');
    await page.waitForFunction(() => document.querySelector('#ac-panel').textContent.includes('AI 回答暂不可用'));
    assert.equal(await page.locator('.ac-item').count(), 1);
    assert.equal(await page.locator('.ac-answer-label').innerText(), '检索说明');
    assert.doesNotMatch(await page.locator('.ac-answer-text').innerText(), /picks/);
    assert.equal(aiCalls - callsBeforeMalformed, 2);
    malformed = false;
    await page.locator('#organizer-open').click();
    await page.waitForSelector('.organizer-item');
    await page.locator('#organizer-folder').selectOption('10');
    assert.equal(await page.locator('.organizer-item').count(), 1);
    assert.match(await page.locator('#organizer-list-title').innerText(), /书签栏/);
    await page.locator('#organizer-folder').selectOption('20');
    assert.equal(await page.locator('.organizer-item').count(), 0);
    await page.locator('#organizer-folder').selectOption('');
    assert.equal(await page.locator('.organizer-item').count(), 1);
    assert.equal(model.node('1').parentId, '10');
    // 模拟旧版本产生的日志，确认本次升级仍能主动恢复，不接触真实书签。
    await page.evaluate(async () => {
      const row = Bookmarks.flatten(await chrome.bookmarks.getTree())[0];
      const moved = await chrome.bookmarks.move(row.id, { parentId: '20' });
      await AgentDB.setMeta('organizer:journal', { id: 'legacy', items: [{ id: row.id, title: row.title,
        before: { parentId: row.parentId, index: row.index, url: row.url, title: row.title },
        after: { parentId: moved.parentId, index: moved.index, url: moved.url, title: moved.title }, state: 'moved' }] });
    });
    await page.reload(); await backend();
    await page.locator('#organizer-open').click();
    await page.waitForSelector('#organizer-recovery:not([hidden])');
    await page.locator('#organizer-undo').click();
    await page.waitForFunction(() => document.querySelector('#organizer-status').textContent.includes('已恢复 1 条'));
    assert.equal(model.node('1').parentId, '10');
    await page.locator('#workspace-tab-search').click();
    await page.locator('#search-overview [data-search-target="rag"]').click();
    await page.locator('label.switch:has(#rag-enabled)').click();
    await page.waitForFunction(() => document.querySelector('#pipeline-status').textContent.includes('自动同步已开启'));
    await page.locator('label.switch:has(#rag-enabled)').click();
    await page.waitForFunction(() => document.querySelector('#pipeline-status').textContent.includes('已暂停'));
    assert.equal(model.node('1').parentId, '10');
    const cloud = await page.evaluate(async () => {
      const cfg = await Settings.load(); const rows = Bookmarks.flatten(await chrome.bookmarks.getTree());
      await ContentIndex.hydrate(rows);
      return { hits: (await Rag.retrieve(await Rag.resolve(cfg.rag, cfg.backup), '应收凭证', rows)).length, local: Bookmarks.query(rows, '应收凭证').length };
    });
    assert.equal(cloud.hits, 1); assert.equal(cloud.local, 1);
    await page.screenshot({ path: '/tmp/chrome-tab-rag-bookmarks-enabled.png', animations: 'disabled' });
    await page.locator('#workspace-tab-appearance').click();
    await page.locator('#panel-close').click();
    await page.locator('#settings-btn').click();
    await page.waitForSelector('.wp-item');
    assert.equal(await page.locator('.settings-stack #wp-history-wrap').count(), 1);
    assert.equal(await page.locator('#wp-provider').inputValue(), 'all');
    await page.waitForFunction(() => document.querySelector('#wp-status').textContent.includes('精选：人物精选'));
    await page.getByRole('button', { name: '唯美人物插画', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#wp-status').textContent.includes('精选：唯美人物插画'));
    assert.equal(await page.locator('.wp-item[title*="女演员"]').count(), 0);
    await page.locator('#wp-provider').selectOption('domestic');
    await page.getByRole('button', { name: '人物精选', exact: true }).click();
    await page.waitForSelector('.wp-item[title*="女演员"]');
    await page.locator('.wp-item[title*="女演员"]').click();
    await page.waitForFunction(() => document.querySelector('#wp-quality').textContent.includes('10wallpaper 中文') && document.querySelector('#wp-quality').textContent.includes('3840×2160'));
    await page.waitForFunction(() => document.querySelector('#bg-image').style.backgroundImage.includes('/wallpaper/3840x2160/2601/portrait.png'));
    assert.equal(await page.evaluate(async () => (await ImageStore.list()).length), 0);
    await page.locator('#wp-provider').selectOption('wallpic');
    await page.waitForSelector('.wp-item[title*="精灵少女"]');
    await page.locator('.wp-item').first().click();
    await page.waitForFunction(() => document.querySelector('#url-input').value.includes('wallpic.cn/wp-content/uploads/'));
    await page.locator('#wp-provider').selectOption('uhdpaper');
    await page.waitForFunction(() => document.querySelectorAll('.wp-item').length === 1);
    assert.equal(await page.locator('#wp-hao-settings').isVisible(), false);
    await page.locator('.wp-item').first().click();
    await page.waitForFunction(() => document.querySelector('#wp-quality').textContent.includes('UHD Paper') && document.querySelector('#wp-quality').textContent.includes('3840×2160'));
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('newtab.profile.user-2:newtab.settings.v1') || '{}').bg?.online?.provider === 'uhdpaper');
    const downloadsAfterOnline = originalDownloads;
    const onlineWallpaper = await page.evaluate(async () => ({ count: (await ImageStore.list()).length, settings: await Settings.load() }));
    assert.equal(onlineWallpaper.count, 0); assert.equal(onlineWallpaper.settings.bg.mode, 'url', JSON.stringify(onlineWallpaper));
    assert.equal(onlineWallpaper.settings.bg.online.width, 3840);
    await page.locator('.wp-item').first().click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已在线应用'));
    assert.ok(downloadsAfterOnline >= 1);
    assert.equal(originalDownloads, downloadsAfterOnline);
    await page.locator('#wp-save').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已保存到离线图库'));
    const storedWallpaper = await page.evaluate(async () => { const rows = await ImageStore.list(); const r = rows.find(row => row.provider === 'uhdpaper'); return { width: r.width, height: r.height, original: r.original, source: r.sourceKey }; });
    assert.equal(storedWallpaper.width, 3840); assert.equal(storedWallpaper.height, 2160); assert.equal(storedWallpaper.original, true);
    assert.match(storedWallpaper.source, /^uhdpaper:/);
    assert.equal(originalDownloads, downloadsAfterOnline + 1);
    await page.locator('#wp-query').fill('动漫');
    await page.locator('#wp-search').click();
    await page.waitForFunction(() => document.querySelector('.wp-item')?.title.includes('Anime Night'));
    await page.locator('#wp-provider').selectOption('wallpapercave');
    await page.waitForFunction(() => document.querySelector('.wp-item')?.title.includes('Cave Mountain'));
    await page.locator('.wp-item').first().click();
    await page.waitForFunction(() => document.querySelector('#url-input').value.includes('wallpapercave.com/wp/'));
    await page.locator('#wp-provider').selectOption('bing');
    await page.locator('#wp-query').fill('山');
    await page.locator('#wp-search').click();
    await page.waitForFunction(() => document.querySelector('.wp-item')?.title.includes('山间日出'));
    await page.locator('.wp-item').first().click();
    await page.waitForFunction(() => document.querySelector('#url-input').value.includes('_UHD.jpg'));
    assert.equal(await page.evaluate(async () => (await ImageStore.list()).length), 1);
    await page.locator('#wp-query').fill('');
    await page.locator('#wp-provider').selectOption('haowallpaper');
    await page.waitForFunction(() => document.querySelector('.wp-item')?.title.includes('旧图源壁纸'));
    assert.equal(await page.locator('#wp-hao-settings').isVisible(), true);
    await page.locator('#wp-provider').selectOption('uhdpaper');
    await page.waitForFunction(() => document.querySelector('.wp-item')?.title.includes('Quiet Night'));
    await page.locator('#wp-provider').selectOption('all');
    await page.getByRole('button', { name: '人物写真', exact: true }).click();
    assert.equal(await page.locator('#wp-provider').inputValue(), 'domestic');
    await page.waitForFunction(() => document.querySelector('#wp-status').textContent.includes('woman / model / portrait'));
    assert.ok(await page.locator('.wp-item').count() >= 1);
    assert.equal(await page.locator('.wp-item[title*="Anime Night"]').count(), 0);
    await page.getByRole('button', { name: '明星写真', exact: true }).click();
    await page.waitForSelector('.wp-item[title*="女演员"]');
    await page.getByRole('button', { name: '氛围写真', exact: true }).click();
    await page.waitForSelector('.wp-item[title*="女演员"]');
    await page.locator('#wp-provider').selectOption('pexels');
    await page.waitForFunction(() => document.querySelector('#wp-status').textContent.includes('请填写自己的图库 API Key'));
    assert.equal(await page.locator('#wp-photo-settings').isVisible(), true);
    await page.locator('#wp-photo-key').fill('test-pexels-key');
    await page.locator('#wp-photo-key').press('Tab');
    await page.waitForSelector('.wp-photo-credit');
    /* 署名合并进缩略图叠层后只显示作者名，来源放进 title，避免两个标签互相压盖。 */
    assert.equal(await page.locator('.wp-photo-credit').innerText(), 'Studio Artist');
    assert.match(await page.locator('.wp-photo-credit').getAttribute('title'), /Studio Artist · Pexels/);
    await page.locator('.wp-item').first().click();
    await page.waitForFunction(() => document.querySelector('#url-input').value.includes('images.pexels.com'));
    assert.equal(await page.evaluate(async () => (await ImageStore.list()).length), 1);
    await page.screenshot({ path: '/tmp/chrome-tab-4k-wallpaper.png', animations: 'disabled' });
    await page.locator('#workspace-tab-bookmarks').click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('#organizer-dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    await page.screenshot({ path: '/tmp/chrome-tab-rag-bookmarks-mobile.png', fullPage: true, animations: 'disabled' });
    if (await page.locator('#workspace-tab-search').count()) await page.locator('#panel-close').click(); else await page.locator('#organizer-close').click();
    await page.locator('#search-input').fill('项目文档');
    await page.waitForSelector('#ac-panel.is-open .ac-item');
    assert.equal(await page.locator('#ac-panel .ac-item').count(), 2);
    assert.match(await page.locator('#ac-panel').innerText(), /必应联想/);
    assert.match(await page.locator('#ac-panel .ac-hl').first().innerText(), /项目文档/);
    await page.locator('#search-input').press('ArrowDown');
    assert.equal(await page.locator('#ac-panel .ac-item.is-sel').count(), 1);
    await page.locator('#search-input').fill('普通网页搜索');
    await page.waitForFunction(() => document.querySelector('#ac-panel').textContent.includes('没有找到'));
    assert.equal(await page.locator('#ac-panel .ac-empty').count(), 1);
    await page.locator('#search-input').press('ArrowDown');
    assert.equal(await page.locator('#ac-panel .is-sel').count(), 1);
    await page.locator('#search-input').press('Enter');
    await page.waitForURL('https://www.bing.com/search?q=*');
    assert.match(page.url(), /q=/);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
