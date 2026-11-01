const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DOMParser } = require('linkedom');
const { png } = require('./helpers/images');
const full = png(3840, 2160); const preview = png(1100, 619);
const medium = png(1280, 853); const thumb = png(640, 427);
const detail = 'https://www.uhdpaper.com/2026/01/quiet-night-4k.html';
const detailHtml = `<a id="_4k" href="https://img.uhdpaper.com/wallpaper/quiet-night-7@5@a-pc-4k.jpg">3840x2160</a><script>var dlqry='https://img.uhdpaper.com/wallpaper/quiet-night-7@5@a';var wpuhd='-wallpaper-uhdpaper.com-';document.getElementById("_4k");</script>`;
function card(url = detail) { return `<article class="post-outer-container"><a href="${url}" aria-label="Quiet Night"></a><h2>Quiet Night</h2><img src="https://img.uhdpaper.com/wallpaper/quiet-night-7@5@a-thumb.jpg?dl"><b>4K</b></article>`; }
function fixture(fetch) {
  const c = { URL, DOMParser, Map, Set, Blob, Response, AbortController, setTimeout, clearTimeout, fetch };
  c.window = c;
  c.Image = class {
    set src(url) {
      if (!url) return;
      Promise.resolve(c.fetch(url, { credentials: 'omit' })).then(async response => {
        if (!(response.headers.get('content-type') || '').startsWith('image/')) throw new Error('非图片');
        const bytes = Buffer.from(await response.arrayBuffer()); this.naturalWidth = bytes.readUInt32BE(16); this.naturalHeight = bytes.readUInt32BE(20);
        if (this.onload) this.onload();
      }).catch(() => { if (this.onerror) this.onerror(); });
    }
  };
  c.createImageBitmap = async blob => { const bytes = Buffer.from(await blob.arrayBuffer()); return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), close() {} }; };
  vm.createContext(c);
  for (const name of ['wallpaper-uhd', 'wallpaper-sources', 'wallpaper-photos', 'wallpaper-pixabay', 'wallpaper-assist', 'wallpaper-cn', 'wallpaper-search', 'wallpaper']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', name + '.js'), 'utf8'), c);
  return c;
}
test('新图源解析真实目录卡片、去重并排除站外链接', () => {
  const c = fixture(); const result = c.UhdWallpaper.parseList(card() + card() + card('https://evil.example/2026/01/other.html') + '<a class="blog-pager-older-link" href="/search?updated-max=2026-01-01&amp;q=anime">Next</a>');
  assert.equal(result.items.length, 1); assert.equal(result.items[0].provider, 'uhdpaper');
  assert.equal(result.next, 'https://www.uhdpaper.com/search?updated-max=2026-01-01&q=anime');
  assert.equal(c.UhdWallpaper.searchTerm('动漫'), 'anime');
  assert.equal(c.UhdWallpaper.searchTerm('动漫女孩 星空'), 'anime girl space');
});
test('按站点游标分页，缓存复用，搜索词和末页独立保存', async () => {
  const calls = []; const c = fixture(async url => {
    calls.push(url); return new Response(card() + (calls.length === 1 ? '<a class="blog-pager-older-link" href="/search?updated-max=CURSOR&amp;q=anime">Next</a>' : ''));
  });
  const first = await c.UhdWallpaper.list({ query: '动漫', page: 1 }); assert.equal(first.hasMore, true);
  await c.UhdWallpaper.list({ query: '动漫', page: 1 }); assert.equal(calls.length, 1);
  const second = await c.UhdWallpaper.list({ query: '动漫', page: 2 }); assert.equal(second.hasMore, false);
  assert.match(calls[0], /q=anime/); assert.match(calls[1], /updated-max=CURSOR/);
  assert.equal((await c.UhdWallpaper.list({ query: '动漫', page: 3 })).length, 0);
});
test('读取公开下载规则而不执行页面脚本，优先 8K 并限制下载域名', () => {
  const c = fixture(); const html = detailHtml + '<script>document.getElementById("_8k");throw new Error("不得执行")</script><a href="https://evil.example/wallpaper/image-8k.jpg">8K</a>';
  const urls = c.UhdWallpaper.parseDownloads(html);
  assert.match(urls[0], /^https:\/\/image-5\.uhdpaper\.com\/wallpaper\/quiet-night-8k-wallpaper-uhdpaper.com-7@5@a\.jpg\?dl=$/);
  assert.ok(urls.every(url => new URL(url).hostname.endsWith('.uhdpaper.com')));
});
test('原图经真实尺寸校验后入库，UHD 下载不接收或发送哲风 Token', async () => {
  const calls = []; const c = fixture(async (url, init) => {
    calls.push({ url, init }); return new Response(url === detail ? detailHtml : full, { headers: { 'content-type': url === detail ? 'text/html' : 'image/png' } });
  });
  const result = await c.WallpaperSource.fetchImage({ provider: 'uhdpaper', detail }, { token: '不应发送的令牌' });
  assert.equal(result.width, 3840); assert.equal(result.height, 2160); assert.equal(result.original, true);
  assert.equal(calls.length, 2); assert.match(calls[1].url, /\?dl=$/);
  for (const call of calls) { assert.equal(call.init.credentials, 'omit'); assert.doesNotMatch(JSON.stringify(call), /不应发送的令牌/); }
});
test('1100px 图片不能冒充原图，原图失败不下载列表缩略图', async () => {
  const calls = []; const c = fixture(async url => { calls.push(url); return new Response(url === detail ? detailHtml : preview, { headers: { 'content-type': url === detail ? 'text/html' : 'image/png' } }); });
  await assert.rejects(c.UhdWallpaper.fetchImage({ detail }), /UHD_LOW_RESOLUTION/);
  await assert.rejects(c.UhdWallpaper.resolveImage({ detail }), /UHD_LOW_RESOLUTION/);
  assert.ok(calls.every(url => !url.includes('-thumb')));
});
test('被重定向到 HTML 的下载链接不会写入图片库，8K 故障可退到实测 4K', async () => {
  const c = fixture(async url => {
    if (url === detail) return new Response(detailHtml + '"_8k"');
    if (url.includes('-8k')) return new Response('<html>暂时无法下载</html>', { headers: { 'content-type': 'text/html' } });
    return new Response(full, { headers: { 'content-type': 'image/png' } });
  });
  assert.equal((await c.UhdWallpaper.fetchImage({ detail })).width, 3840);
  c.fetch = async url => new Response(url === detail ? detailHtml : '<html>无图片</html>', { headers: { 'content-type': 'text/html' } });
  await assert.rejects(c.UhdWallpaper.fetchImage({ detail }), /UHD_NOT_IMAGE/);
});
test('哲风作为可选图源保留，未登录时仍明确标记为预览', async () => {
  const c = fixture(async () => new Response(preview, { headers: { 'content-type': 'image/png' } }));
  const result = await c.WallpaperSource.fetchImage({ provider: 'haowallpaper', id: '123456', large: 'https://img.haowallpaper.com/pre_cache_file/sample.png' });
  assert.equal(result.original, false);
});
test('在线应用只返回地址和尺寸，不创建 Blob 或要求写离线图库', async () => {
  const c = fixture(async url => new Response(url === detail ? detailHtml : full, { headers: { 'content-type': url === detail ? 'text/html' : 'image/png' } }));
  c.createImageBitmap = () => { throw new Error('在线模式不读取 Blob 解码器'); };
  const result = await c.WallpaperSource.resolveImage({ provider: 'uhdpaper', detail });
  assert.equal(result.width, 3840); assert.equal(result.original, true); assert.equal(result.blob, undefined);
});
test('Wallpaper Cave 搜索主题并筛出 4K，去除不足像素与站外图片', async () => {
  const calls = []; const c = fixture(async url => {
    calls.push(url);
    if (url.includes('/search?')) return new Response('<a href="/anime-4k-wallpapers"><img class="thumbnail"></a>');
    return new Response('<img class="wimg" width="3840" height="2160" src="/wp/wp1.jpg" alt="Anime 4K"><img class="wimg" width="1920" height="1080" src="/wp/wp2.jpg"><img class="wimg" width="3840" height="2160" src="https://evil.example/wp/wp3.jpg">');
  });
  const result = await c.WallpaperSource.list({ provider: 'wallpapercave', query: '动漫' });
  assert.equal(result.length, 1); assert.match(calls[0], /q=anime%204k/); assert.equal(result[0].originalUrl, 'https://wallpapercave.com/wp/wp1.jpg');
});
test('Bing 精选支持中文标题筛选并使用 UHD 地址，分页不伪造后续结果', async () => {
  const c = fixture(async () => new Response(JSON.stringify({ images: [
    { title: '山间日出', copyright: '雪山', startdate: '20261031', urlbase: '/th?id=OHR.Mountain_ZH-CN1234' },
    { title: '城市夜景', copyright: '城市', startdate: '20261030', urlbase: '/th?id=OHR.City_ZH-CN5678' }
  ] }), { headers: { 'content-type': 'application/json' } }));
  const result = await c.WallpaperSource.list({ provider: 'bing', query: '山' });
  assert.equal(result.length, 1); assert.match(result[0].originalUrl, /_UHD.jpg/); assert.equal(result.hasMore, false);
  assert.equal((await c.WallpaperSource.list({ provider: 'bing', query: '山', page: 2 })).length, 0);
});

test('美女会扩展为人物与模特，动漫美女保留动漫意图', () => {
  const c = fixture();
  assert.equal(c.UhdWallpaper.searchTerm('美女'), 'woman');
  assert.deepEqual(Array.from(c.WallpaperSearch.terms('美女')), ['woman', 'model', 'portrait']);
  assert.deepEqual(Array.from(c.WallpaperSearch.terms('动漫美女')), ['anime girl']);
  assert.equal(c.WallpaperSearch.relevant({ title: 'Wonder Woman' }, '美女'), false);
  assert.equal(c.WallpaperSearch.relevant({ title: 'Model Photoshoot' }, '美女'), true);
});
test('聚合搜索合并人物同义词和多个图源，去重并容忍单个图源故障', async () => {
  const c = fixture(); const calls = [];
  const result = await c.WallpaperSearch.list({ provider: 'all', query: '美女' }, async options => {
    calls.push(options);
    if (options.provider === 'wallpapercave') throw new Error('模拟图源故障');
    const rows = [{ provider: 'uhdpaper', id: 'shared', sourceKey: 'uhdpaper:shared', title: 'Model Portrait' }, { provider: 'uhdpaper', id: options.query, sourceKey: 'uhdpaper:' + options.query, title: 'Fashion Photoshoot' }];
    rows.hasMore = false; return rows;
  });
  assert.equal(calls.length, 6); assert.equal(result.length, 5);
  assert.equal(new Set(result.map(item => item.sourceKey)).size, 5);
  assert.deepEqual(Array.from(result.sourceErrors), ['wallpapercave']);
});
test('聚合结果持续分页且不重复，重复并发查询复用同一页', async () => {
  const c = fixture(); let calls = 0;
  const fetch = async options => {
    calls++; const rows = Array.from({ length: 20 }, (_, i) => ({ provider: options.provider, id: options.provider + options.page + '-' + i, title: '自然风光' }));
    rows.hasMore = options.page < 3; return rows;
  };
  const [first, concurrent] = await Promise.all([c.WallpaperSearch.list({ provider: 'all', query: '风景' }, fetch), c.WallpaperSearch.list({ provider: 'all', query: '风景' }, fetch)]);
  assert.equal(first.length, 24); assert.equal(calls, 5); assert.equal(concurrent, first);
  const second = await c.WallpaperSearch.list({ provider: 'all', query: '风景', page: 2 }, fetch);
  assert.equal(second.length, 24); assert.equal(second.hasMore, true);
  assert.equal(new Set(first.concat(second).map(item => item.id)).size, 48);
});
test('Wallpaper Cave 会继续读取第四个及后续图集，不在三个图集处截断', async () => {
  const calls = []; const c = fixture(async url => {
    calls.push(url);
    if (url.includes('/search?')) return new Response(Array.from({ length: 5 }, (_, i) => '<a href="/model-' + (i + 1) + '-wallpapers"><img class="thumbnail"></a>').join(''));
    const id = url.match(/model-(\d+)/)[1];
    return new Response('<img class="wimg" width="3840" height="2160" src="/wp/wp' + id + '.jpg" alt="Model Portrait">');
  });
  const rows = await c.OtherWallpapers.list({ provider: 'wallpapercave', query: '美女', page: 1 });
  assert.equal(rows.length, 5); assert.ok(calls.some(url => url.includes('/model-5-wallpapers')));
});

test('摄影图库未配置 Key 时不请求网络，Pexels 使用官方搜索和原始像素', async () => {
  const calls = []; const c = fixture(async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ photos: [
      { id: 1, width: 6000, height: 4000, alt: 'Woman portrait', photographer: '摄影师', photographer_url: 'https://www.pexels.com/@author', url: 'https://www.pexels.com/photo/1/', src: { original: 'https://images.pexels.com/photos/1/original.jpeg', medium: 'https://images.pexels.com/photos/1/thumb.jpeg' } },
      { id: 2, width: 1920, height: 1080 }
    ], next_page: 'https://api.pexels.com/v1/search?page=2' }), { headers: { 'content-type': 'application/json' } });
  });
  await assert.rejects(c.PhotoWallpapers.list({ provider: 'pexels', query: '美女' }), /PHOTO_KEY_REQUIRED/);
  assert.equal(calls.length, 0);
  const results = await c.PhotoWallpapers.list({ provider: 'pexels', query: '美女', keys: { pexels: 'test-pexels-key' } });
  assert.equal(results.length, 1); assert.equal(results.hasMore, true);
  assert.equal(calls[0].init.headers.Authorization, 'test-pexels-key'); assert.match(calls[0].url, /query=woman/);
  assert.equal(new URL(calls[0].url).hostname, 'api.pexels.com');
});
test('Unsplash 保留原图地址及作者署名，Key 不发送到图片 CDN', async () => {
  const calls = []; const c = fixture(async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith('https://images.unsplash.com')) return new Response(full, { headers: { 'content-type': 'image/png' } });
    if (url.includes('/download')) return new Response('{}', { headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ total_pages: 2, results: [{ id: 'photo-1', width: 5000, height: 3000, alt_description: 'Woman portrait', urls: { raw: 'https://images.unsplash.com/photo-1', small: 'https://images.unsplash.com/photo-1?w=400' }, links: { html: 'https://unsplash.com/photos/photo-1', download_location: 'https://api.unsplash.com/photos/photo-1/download' }, user: { name: '摄影师', links: { html: 'https://unsplash.com/@author' } } }] }), { headers: { 'content-type': 'application/json' } });
  });
  const keys = { unsplash: 'test-unsplash-key' };
  const rows = await c.PhotoWallpapers.list({ provider: 'unsplash', query: 'portrait', keys });
  assert.equal(rows.length, 1); assert.match(rows[0].authorUrl, /utm_source=jingmi_newtab/);
  assert.equal((await c.PhotoWallpapers.resolveImage(rows[0], { keys })).width, 3840);
  assert.ok(calls.filter(call => call.url.startsWith('https://api.unsplash.com')).every(call => call.init.headers.Authorization === 'Client-ID test-unsplash-key'));
  assert.ok(calls.filter(call => call.url.startsWith('https://images.unsplash.com')).every(call => !call.init.headers));
});
test('摄影图库授权和限流显示可识别状态，不作为空搜索结果缓存', async () => {
  const c = fixture(async () => new Response('', { status: 401 }));
  const options = { provider: 'pexels', query: 'portrait', keys: { pexels: 'test' } };
  await assert.rejects(c.PhotoWallpapers.list(options), /PHOTO_KEY_INVALID/);
  c.fetch = async () => new Response('', { status: 429 });
  await assert.rejects(c.PhotoWallpapers.list(options), /PHOTO_RATE_LIMIT/);
});
test('配置摄影 Key 后参与聚合，未配置的图库不触发无效请求', async () => {
  const c = fixture(); const calls = [];
  await c.WallpaperSearch.list({ provider: 'all', query: '风景', keys: { pexels: 'test-key' } }, async options => { calls.push(options); const rows = []; rows.hasMore = false; return rows; });
  assert.ok(calls.some(call => call.provider === 'pexels' && call.keys.pexels === 'test-key'));
  assert.equal(calls.some(call => call.provider === 'unsplash'), false);
});

function cnCard(id = 42, title = '银发精灵少女 奇幻插画 电脑静态壁纸') {
  return `<posts class="posts-item"><div class="item-thumbnail"><a href="https://www.wallpic.cn/${id}.html"><img data-src="https://www.wallpic.cn/wp-content/uploads/2026/10/${id}.webp" alt="${title}"></a></div></posts>`;
}
test('中文图库只取电脑静态卡片，拒绝手机、动态、站外图片及重复项', () => {
  const c = fixture();
  const result = c.ChineseWallpapers.parseList(cnCard() + cnCard() + cnCard(43, '汉服美女 手机静态壁纸') + cnCard(44, '国风少女 电脑动态壁纸') + cnCard(45).replace('https://www.wallpic.cn/wp-content/uploads/', 'https://evil.example/wp-content/uploads/'), 'wallpic', 'https://www.wallpic.cn/search/少女/');
  assert.equal(result.items.length, 1); assert.equal(result.items[0].sourceKey, 'wallpic:https://www.wallpic.cn/42.html');
  assert.equal(c.ChineseWallpapers.queryFor('真人美女', 'wallpic'), '美女');
  assert.equal(c.ChineseWallpapers.queryFor('国风', 'tenwallpaper'), '中国风');
});
test('国内图源保留中文关键词并按真实游标翻页，命中缓存和末页不额外请求', async () => {
  const calls = []; const c = fixture(async url => {
    calls.push(url);
    return new Response(cnCard(calls.length) + (calls.length === 1 ? '<a class="next" href="https://www.wallpic.cn/search/美女/page/2">下一页</a><a href="https://evil.example/search/美女/page/2">下一页</a>' : ''));
  });
  const options = { provider: 'wallpic', query: '美女' };
  const first = await c.ChineseWallpapers.list(options); assert.equal(first.hasMore, true);
  assert.equal(new URL(calls[0]).pathname, '/search/%E7%BE%8E%E5%A5%B3/');
  await c.ChineseWallpapers.list(options); assert.equal(calls.length, 1);
  const second = await c.ChineseWallpapers.list({ ...options, page: 2 });
  assert.equal(second.length, 1); assert.equal(second.hasMore, false); assert.ok(calls[1].endsWith('/page/2'));
  assert.equal((await c.ChineseWallpapers.list({ ...options, page: 3 })).length, 0);
  assert.equal(calls.length, 2);
});
test('国内原图仅解析公开图片与下载链接，不用页面标注替代实测像素', async () => {
  const c = fixture(async url => new Response(url.endsWith('.html') ? '<img data-wallpaper-macbook-image="true" src="https://www.wallpic.cn/wp-content/uploads/2026/10/full.webp">' : full, { headers: { 'content-type': url.endsWith('.html') ? 'text/html' : 'image/png' } }));
  const item = { provider: 'wallpic', detail: 'https://www.wallpic.cn/42.html' };
  const got = await c.WallpaperSource.resolveImage(item); assert.equal(got.width, 3840); assert.equal(got.blob, undefined);
  const urls = c.ChineseWallpapers.parseOriginals('<a download href="/wallpaper/5120x2880/2601/a.jpg"></a><a download href="/wallpaper/3840x2160/2601/a.jpg"></a><a download href="/wallpaper/1920x1080/2601/a.jpg"></a><a download href="https://evil.example/wallpaper/3840x2160/a.jpg"></a>', 'tenwallpaper');
  assert.equal(urls.length, 2); assert.match(urls[0], /3840x2160/);
  c.fetch = async url => new Response(url.endsWith('.html') ? '<img data-wallpaper-macbook-image src="https://www.wallpic.cn/wp-content/uploads/2026/10/preview.webp">' : preview, { headers: { 'content-type': url.endsWith('.html') ? 'text/html' : 'image/png' } });
  await assert.rejects(c.WallpaperSource.resolveImage(item), /UHD_LOW_RESOLUTION/);
  await assert.rejects(c.WallpaperSource.resolveImage({ ...item, detail: 'https://evil.example/42.html' }), /UHD_ORIGINAL_UNAVAILABLE/);
});
test('人物精选兼容国内写真和不同作者的女性插画，不把风格绑定到鬼刀', () => {
  const c = fixture();
  for (const title of ['银发精灵少女 奇幻插画', '古风美女 国风插画', 'Fantasy Girl Digital Art']) assert.equal(c.WallpaperSearch.relevant({ title }, '唯美人物插画'), true);
  for (const title of ['陈瑶 女演员 美女 5K', '国内美女 氛围写真 4K']) {
    assert.equal(c.WallpaperSearch.relevant({ provider: 'tenwallpaper', title }, '人物精选'), true);
    assert.equal(c.WallpaperSearch.relevant({ provider: 'tenwallpaper', title }, '唯美人物插画'), false);
  }
  for (const title of ['山间日落风景', '海绵宝宝 卡通', '蜡笔小新 美女 卡通', '少年 男孩 动漫']) assert.equal(c.WallpaperSearch.relevant({ provider: 'wallpic', title }, '人物精选'), false);
});
test('默认人物推荐国内优先，主动搜索不受推荐限制，全部题材可恢复', async () => {
  const c = fixture(); const calls = [];
  const fetchPage = async options => {
    calls.push(options); const rows = Array.from({ length: 30 }, (_, id) => ({ id, provider: options.provider, title: options.query === '风景' ? '风景' : '银发精灵少女 奇幻插画', sourceKey: options.provider + ':' + options.query + ':' + id }));
    rows.hasMore = false; return rows;
  };
  const result = await c.WallpaperSearch.list({ provider: 'all' }, fetchPage);
  assert.equal(result.recommendation, '人物精选'); assert.equal(result.length, 24);
  assert.ok(result.filter(item => ['wallpic', 'tenwallpaper'].includes(item.provider)).length > 12);
  assert.ok(calls.some(call => call.provider === 'wallpic' && call.query === '人物精选'));
  const landscape = await c.WallpaperSearch.list({ provider: 'domestic', query: '风景' }, fetchPage);
  assert.equal(landscape.length, 24); assert.equal(landscape.recommendation, '');
  const all = await c.WallpaperSearch.list({ provider: 'domestic', preference: 'all' }, fetchPage);
  assert.equal(all.recommendation, ''); assert.ok(calls.some(call => call.provider === 'wallpic' && call.query === ''));
});
test('Pixabay 走官方接口：Key 只进请求参数，写真词转英文，接受 pixabay.com/get 直链', async () => {
  const hits = [
    { id: 1, tags: 'woman, portrait, studio', user: 'Ann Lee', user_id: 9, imageWidth: 4272, imageHeight: 2848,
      largeImageURL: 'https://pixabay.com/get/g65c8/sunglasses_1280.jpg',
      webformatURL: 'https://pixabay.com/get/g9d88/sunglasses_640.jpg',
      previewURL: 'https://cdn.pixabay.com/photo/2017/09/01/21/53/sunglasses-2705642_150.jpg' },
    { id: 2, tags: 'tiny', user: 'B', imageWidth: 800, imageHeight: 600, webformatURL: 'https://pixabay.com/get/t/small_640.jpg' },
    { id: 3, tags: 'offsite', user: 'C', imageWidth: 4000, imageHeight: 2250, largeImageURL: 'https://evil.example/get/x.jpg', webformatURL: 'https://evil.example/get/y.jpg' }
  ];
  const calls = [];
  const c = fixture(async (url) => {
    if (String(url).includes('/api/')) {
      calls.push(String(url));
      return new Response(JSON.stringify({ totalHits: 100, hits }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(medium, { headers: { 'content-type': 'image/png' } });
  });
  const items = await c.PixabayWallpapers.list({ provider: 'pixabay', query: '人像', page: 2, keys: { pixabay: 'KEY123' } });
  assert.equal(items.length, 1); assert.equal(items.hasMore, true);
  assert.equal(items[0].provider, 'pixabay'); assert.equal(items[0].sourceKey, 'pixabay:1');
  assert.equal(items[0].candidates.length, 2); assert.equal(items[0].resolution, '1280 高清');
  assert.match(items[0].authorUrl, /pixabay\.com\/users\/Ann-Lee-9\/$/);
  assert.match(calls[0], /[?&]q=portrait(\+|%20)woman(\+|%20)studio/);
  assert.match(calls[0], /[?&]safesearch=true/); assert.match(calls[0], /[?&]page=2/);
  assert.match(calls[0], /[?&]min_width=1280/); assert.match(calls[0], /[?&]key=KEY123/);
  const got = await c.PixabayWallpapers.resolveImage(items[0]);
  assert.equal(got.width, 1280); assert.equal(got.original, false); assert.equal(got.tier, 'HD');
  await assert.rejects(c.PixabayWallpapers.list({ provider: 'pixabay', keys: {} }), /PHOTO_KEY_REQUIRED/);
});
test('Pixabay 固定开启安全过滤，低清图不冒充可用背景', async () => {
  const c = fixture(async (url) => {
    if (String(url).includes('/api/')) return new Response(JSON.stringify({ totalHits: 1, hits: [{ id: 5, tags: 'portrait', user: 'D', imageWidth: 3000, imageHeight: 1688, largeImageURL: 'https://pixabay.com/get/p/portrait_1280.jpg' }] }), { headers: { 'content-type': 'application/json' } });
    return new Response(thumb, { headers: { 'content-type': 'image/png' } });
  });
  const items = await c.PixabayWallpapers.list({ provider: 'pixabay', query: '人像', keys: { pixabay: 'K' } });
  assert.equal(items.length, 1);
  await assert.rejects(c.PixabayWallpapers.resolveImage(items[0]), /PIXABAY_LOW_RESOLUTION/);
});

test('描述式检索：拆概念词、中英分别组式，并按命中排序', () => {
  const c = fixture();
  const A = c.WallpaperAssist;
  assert.equal(A.zhVariants('海边日落 白裙女生背影 电影感')[0], '海边 日落 白裙 女生 背影 电影感');
  assert.equal(A.enVariants('海边日落 白裙女生背影 电影感')[0], 'beach sunset white dress woman back view cinematic');
  assert.equal(A.zhVariants('风景').length, 0);
  const items = [{ title: '城市夜景霓虹' }, { title: '海边 日落 女生 背影 胶片' }, { title: '山间晨雾' }];
  assert.equal(A.rank(items, '海边日落女生背影')[0].title, '海边 日落 女生 背影 胶片');
  assert.deepEqual(Array.from(A.suggest('海边日落', 2)), ['海边 日落 胶片', '海边 日落 柔光']);
  assert.equal(A.suggest('', 3).length, 3);
  for (const phrase of A.suggest('女生', 4)) assert.ok(phrase.split(' ').length <= 3, phrase);
});
test('聚合检索把长描述分给国内外图源，并返回排序后的结果', async () => {
  const c = fixture(); const calls = [];
  const fetchPage = async options => {
    calls.push(options);
    const rows = Array.from({ length: 12 }, (_, id) => ({ id, provider: options.provider, sourceKey: options.provider + ':' + id,
      title: id === 0 ? '海边 日落 女生 背影' : '山间晨雾与城市建筑' }));
    rows.hasMore = false; return rows;
  };
  const result = await c.WallpaperSearch.list({ provider: 'all', query: '海边日落女生背影' }, fetchPage);
  assert.ok(calls.some(call => call.provider === 'wallpic' && call.query === '海边 日落 女生 背影'));
  assert.ok(calls.filter(call => call.provider === 'uhdpaper').every(call => /[a-z]/i.test(call.query)));
  assert.match(result[0].title, /海边/);
});
