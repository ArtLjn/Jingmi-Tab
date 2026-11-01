/* UHD Paper：解析公开列表与页面提供的桌面下载地址，只接收实测达到 4K 的图片。 */
(function (global) {
  'use strict';
  var HOST = 'https://www.uhdpaper.com';
  var pages = new Map();
  var TTL = 30 * 60 * 1000;
  var WORDS = { '动漫美女': 'anime girl', '二次元美女': 'anime girl', '真人美女': 'woman', '美女': 'woman', '美人': 'woman', '人像': 'portrait', '写真': 'photoshoot', '模特': 'model', '女明星': 'actress', '女性': 'woman', '女人': 'woman', '动漫': 'anime', '二次元': 'anime', '风景': 'scenery', '自然': 'nature', '星空': 'space', '太空': 'space', '极简': 'minimal', '赛博朋克': 'cyberpunk', '赛博': 'cyberpunk', '夜景': 'night city', '雪山': 'mountain', '海洋': 'ocean', '游戏': 'game', '猫咪': 'cat', '抽象': 'abstract', '女孩': 'girl', '城市': 'city', '森林': 'forest', '湖泊': 'lake', '海边': 'beach', '天空': 'sky', '暗黑': 'dark', '科技': 'technology', '蓝色': 'blue', '粉色': 'pink', '紫色': 'purple', '绿色': 'green' };
  function searchTerm(text) {
    var value = String(text || '').trim();
    Object.keys(WORDS).sort(function (a, b) { return b.length - a.length; }).forEach(function (word) { value = value.split(word).join(' ' + WORDS[word] + ' '); });
    return value.replace(/\s+/g, ' ').trim();
  }
  function pageUrl(value) {
    try { var url = new URL(value, HOST); return url.origin === HOST && !url.username && !url.password ? url.href : ''; } catch (e) { return ''; }
  }
  function imageUrl(value) {
    try {
      var url = new URL(value, HOST);
      if (url.username || url.password || url.protocol !== 'https:' || !/(^|\.)uhdpaper\.com$/.test(url.hostname) || !url.pathname.startsWith('/wallpaper/')) return '';
      return url.href;
    } catch (e) { return ''; }
  }
  function parseList(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var items = []; var seen = new Set();
    doc.querySelectorAll('article.post-outer-container').forEach(function (card) {
      var link = card.querySelector('a[href]'); var img = card.querySelector('img');
      var detail = link && pageUrl(link.getAttribute('href'));
      var thumb = img && imageUrl(img.getAttribute('src') || img.getAttribute('data-src'));
      if (!detail || !/\/\d{4}\/\d{2}\/[^/]+\.html/.test(new URL(detail).pathname) || !thumb || seen.has(detail)) return;
      seen.add(detail);
      var title = card.querySelector('h2');
      items.push({ provider: 'uhdpaper', id: new URL(detail).pathname, sourceKey: 'uhdpaper:' + detail,
        title: title && title.textContent.trim() || link.getAttribute('aria-label') || 'UHD 壁纸',
        detail: detail, image: thumb, thumb: thumb, resolution: /8K/.test(card.textContent) ? '8K' : '4K' });
    });
    var next = doc.querySelector('a.blog-pager-older-link');
    return { items: items, next: next ? pageUrl(next.getAttribute('href')) : '' };
  }
  async function request(url, kind) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, kind === 'image' ? 60000 : 20000);
    try {
      var response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      if (kind !== 'image') return await response.text();
      var type = response.headers.get('content-type') || '';
      if (!/^image\//i.test(type)) throw new Error('UHD_NOT_IMAGE');
      var blob = await response.blob();
      if (!blob.size || blob.size > 60 * 1024 * 1024) throw new Error('UHD_INVALID_SIZE');
      return blob;
    } catch (e) { if (e.name === 'AbortError') throw new Error('UHD_TIMEOUT'); throw e; }
    finally { clearTimeout(timer); }
  }
  async function list(options) {
    options = options || {};
    var query = searchTerm(options.query); var number = Math.max(1, Number(options.page) || 1);
    var key = query + ':' + number; var cached = pages.get(key);
    if (cached && Date.now() - cached.at < TTL && !options.fresh) return cached.items;
    var url;
    if (number === 1) {
      url = new URL('/search', HOST); url.searchParams.set('max-results', '20'); url.searchParams.set('by-date', 'true');
      if (query) url.searchParams.set('q', query);
      url = url.href;
    } else {
      var previous = pages.get(query + ':' + (number - 1));
      if (!previous) throw new Error('UHD_PAGE_EXPIRED');
      if (!previous.next) return [];
      url = previous.next;
    }
    var parsed = parseList(await request(url, 'page'));
    parsed.items.hasMore = !!parsed.next;
    pages.set(key, { at: Date.now(), items: parsed.items, next: parsed.next });
    return parsed.items;
  }
  function parseDownloads(html) {
    var out = []; var seen = new Set();
    function add(value) {
      var url = imageUrl(value);
      if (!url || !/-[48]k(?:-wallpaper-uhdpaper\.com-|-|\.)/i.test(new URL(url).pathname)) return;
      var resolved = new URL(url); resolved.searchParams.set('dl', '');
      if (!seen.has(resolved.href)) { seen.add(resolved.href); out.push(resolved.href); }
    }
    /* 站点公开脚本将 dlqry 与桌面分辨率拼成 CDN 链接；只读取字面值，不执行脚本。 */
    var base = html.match(/\bvar\s+dlqry\s*=\s*(['"])(https:\/\/img\.uhdpaper\.com\/wallpaper\/[^'"]+)\1/);
    var suffix = html.match(/\bvar\s+wpuhd\s*=\s*(['"])(-wallpaper-uhdpaper\.com-)\1/);
    var parts = base && new URL(base[2]).pathname.match(/^\/wallpaper\/(.+)-(\w+)@(\w+)@(\w+)$/);
    if (parts && suffix) {
      [8, 4].forEach(function (size) {
        if (html.indexOf('"_' + size + 'k"') < 0 && html.indexOf("'_" + size + "k'") < 0) return;
        add('https://image-' + parts[3] + '.uhdpaper.com/wallpaper/' + parts[1] + '-' + size + 'k' + suffix[2] + parts[2] + '@' + parts[3] + '@' + parts[4] + '.jpg');
      });
    }
    /* 页面直接提供新格式下载链接时，沿用明确的 4K / 8K 地址。 */
    var links = /href\s*=\s*(['"])([^'"]+)\1/gi; var match;
    while ((match = links.exec(html))) add(match[2].replace(/&amp;/g, '&'));
    return out;
  }
  function probeImage(url) {
    return new Promise(function (resolve, reject) {
      var image = new Image(); var timer = setTimeout(function () { finish(new Error('UHD_TIMEOUT')); }, 60000);
      function finish(error) {
        clearTimeout(timer); image.onload = image.onerror = null;
        if (error) { image.src = ''; reject(error); }
        else resolve({ url: url, width: image.naturalWidth, height: image.naturalHeight });
      }
      image.referrerPolicy = 'no-referrer';
      image.onload = function () { finish(); };
      image.onerror = function () { finish(new Error('UHD_NOT_IMAGE')); };
      image.src = url;
    });
  }
  async function candidates(item) {
    var detail = pageUrl(item.detail);
    if (!detail) throw new Error('UHD_INVALID_PAGE');
    var urls = parseDownloads(await request(detail, 'page'));
    if (!urls.length) throw new Error('UHD_ORIGINAL_UNAVAILABLE');
    return urls;
  }
  async function resolveImage(item) {
    var urls = await candidates(item); var failure;
    for (var url of urls) {
      try {
        var result = await probeImage(url);
        if (result.width < 3840 || result.height < 2160) throw new Error('UHD_LOW_RESOLUTION');
        return Object.assign(result, { original: true, provider: 'uhdpaper' });
      } catch (e) { failure = e; }
    }
    throw failure || new Error('UHD_ORIGINAL_UNAVAILABLE');
  }
  async function fetchImage(item) {
    var urls = await candidates(item);
    if (typeof createImageBitmap !== 'function') throw new Error('UHD_CANNOT_VERIFY');
    var failure;
    for (var url of urls) {
      try {
        var blob = await request(url, 'image'); var bitmap;
        try { bitmap = await createImageBitmap(blob); } catch (e) { throw new Error('UHD_NOT_IMAGE'); }
        var width = bitmap.width; var height = bitmap.height; if (bitmap.close) bitmap.close();
        if (width < 3840 || height < 2160) throw new Error('UHD_LOW_RESOLUTION');
        return { blob: blob, url: url, original: true, width: width, height: height, provider: 'uhdpaper' };
      } catch (e) { failure = e; }
    }
    throw failure || new Error('UHD_ORIGINAL_UNAVAILABLE');
  }
  global.UhdWallpaper = { list: list, resolveImage: resolveImage, probeImage: probeImage, fetchImage: fetchImage, parseList: parseList, parseDownloads: parseDownloads, searchTerm: searchTerm };
})(window);
