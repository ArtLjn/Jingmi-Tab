/* 真实浏览器模拟虚拟列表，验证分段采集、去重和滚动位置恢复。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const executablePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const root = path.resolve(__dirname, '..');
test('通用页面采集支持不同域名、有无块 ID 的虚拟正文并恢复原位', { skip: !fs.existsSync(executablePath), timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><title>模拟长文档</title></head><body>
      <div role="document" id="editor" style="height:200px;overflow:auto"><div style="height:2000px"><div id="block" style="position:sticky;top:0"></div></div></div>
      <script>const editor=document.querySelector('#editor'),block=document.querySelector('#block');
      function render(){const i=Math.min(9,Math.floor(editor.scrollTop/200));block.innerHTML='<p'+(location.pathname.includes('without-ids')?'':' data-block-id="b'+i+'"')+'>第'+i+'段，文档内容 '+i+'</p>';}
      editor.addEventListener('scroll',render);editor.scrollTop=600;render();</script></body></html>` }));
    const page = await context.newPage();
    for (const url of ['https://tenant.feishu.cn/docx/MOCK', 'https://example.com/articles/virtual', 'https://example.com/articles/without-ids']) {
    await page.goto(url);
    for (const name of ['content-index', 'pageinfo', 'page-capture']) await page.addScriptTag({ path: path.join(root, 'js', name + '.js') });
    const result = await page.evaluate(async () => {
      const before = document.querySelector('#editor').scrollTop;
      const captured = await PageCapture.collect({ interval: 80 });
      return { before, after: document.querySelector('#editor').scrollTop, captured, overlay: !!document.querySelector('[data-jingmi-capture]') };
    });
    assert.equal(result.before, result.after);
    for (let i = 0; i < 10; i++) assert.match(result.captured.info.text, new RegExp('第' + i + '段'));
    assert.equal(result.captured.info.blocksRead, 10);
    assert.equal(result.captured.info.captureState, 'partial');
    assert.equal(result.overlay, false);
    }
  } finally { await browser.close(); }
});
