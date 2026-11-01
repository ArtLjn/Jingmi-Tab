/* 中文图库适配：保留中文搜索词，读取公开静态壁纸与站点提供的高清链接。 */
(function (global) {
  'use strict';
  var HOSTS = { wallpic: 'https://www.wallpic.cn', tenwallpaper: 'https://www.10wallpaper.com' };
  var cache = new Map(); var TTL = 15 * 60 * 1000;
  function safeUrl(value, provider, image) {
    if (!value) return '';
    try {
      var url = new URL(value, HOSTS[provider]);
      if (!HOSTS[provider] || url.origin !== HOSTS[provider] || url.username || url.password) return '';
      if (image && !(provider === 'wallpic' ? /^\/wp-content\/uploads\/.+\.(?:jpe?g|png|webp)$/i : /^\/wallpaper\/.+\.(?:jpe?g|png|webp)$/i).test(url.pathname)) return '';
      return url.href;
    } catch (e) { return ''; }
  }
  function queryFor(query, provider) {
    var text = String(query || '').trim();
    var words = { '人物精选': '美女', '唯美人物插画': '少女', '国风美女': '国风', '人物写真': '美女', '真人美女': '美女', '女明星': '美女', '氛围写真': '写真', '人像': '写真', '动漫美女': '动漫', '二次元': '动漫', '自然风光': '风景' };
    text = words[text] || text;
    if (provider === 'tenwallpaper' && text === '国风') text = '中国风';
    return text;
  }
  function parseList(html, provider, current) {
    var doc = new DOMParser().parseFromString(html, 'text/html'); var items = []; var seen = new Set();
    var selector = provider === 'wallpic' ? '.posts-item .item-thumbnail a[href], a.thmb[href]' : 'a[href*="/cn/view/"]';
    doc.querySelectorAll(selector).forEach(function (link) {
      var detail = safeUrl(link.getAttribute('href'), provider); var img = link.querySelector('img');
      if (!img || !detail || !(provider === 'wallpic' ? /^\/\d+\.html$/ : /^\/cn\/view\/[^/]+\.html$/).test(new URL(detail).pathname) || seen.has(detail)) return;
      var thumb = safeUrl(img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('src'), provider, true);
      var title = String(img.getAttribute('alt') || link.getAttribute('title') || '').replace(/-4K\s*高清免费壁纸[\s\S]*$|\s*浏览[:：][\s\S]*$/g, '').trim();
      if (!thumb || /手机|动态|头像|表情包/.test(title) || link.querySelector('.wallpaper-cam-dynamic-badge')) return;
      if (provider === 'tenwallpaper' && !/[4-9]K|\b\d{2}K\b/i.test(title)) return;
      var size = link.textContent.match(/(\d{3,5})\s*[x×]\s*(\d{3,5})/i);
      if (size && (Number(size[1]) < 3840 || Number(size[2]) < 2160)) return;
      seen.add(detail);
      items.push({ provider: provider, id: new URL(detail).pathname, sourceKey: provider + ':' + detail,
        title: title || '中文高清壁纸', detail: detail, image: thumb, thumb: thumb });
    });
    var next = ''; var currentUrl = new URL(current || HOSTS[provider]);
    var number = Number((currentUrl.pathname.match(/\/page\/(\d+)\/?$/) || [])[1]) || 1;
    doc.querySelectorAll('a[href]').forEach(function (link) {
      var url = safeUrl(link.getAttribute('href'), provider);
      if (!url) return;
      var parsed = new URL(url); var base = currentUrl.pathname.replace(/\/page\/\d+\/?$/, '').replace(/\/$/, '');
      if (parsed.pathname.replace(/\/$/, '') === base + '/page/' + (number + 1)) next = url;
    });
    return { items: items, next: next };
  }
  function parseOriginals(html, provider) {
    var doc = new DOMParser().parseFromString(html, 'text/html'); var urls = [];
    var selector = provider === 'wallpic' ? 'img[data-wallpaper-macbook-image], img[data-wallpaper-macbook-preview-image]' : 'a[download]';
    doc.querySelectorAll(selector).forEach(function (node) {
      var url = safeUrl(node.getAttribute(provider === 'wallpic' ? 'src' : 'href'), provider, true);
      if (!url || urls.indexOf(url) >= 0) return;
      if (provider === 'tenwallpaper') {
        var size = new URL(url).pathname.match(/\/wallpaper\/(\d+)x(\d+)\//);
        if (!size || Number(size[1]) < 3840 || Number(size[2]) < 2160) return;
      }
      urls.push(url);
    });
    /* 优先 4K，避免仅为背景加载体积更大的 8K 文件。 */
    if (provider === 'tenwallpaper') urls.sort(function (a, b) {
      function area(url) { var s = new URL(url).pathname.match(/\/(\d+)x(\d+)\//); return Number(s[1]) * Number(s[2]); }
      return area(a) - area(b);
    });
    return urls;
  }
  async function read(url) {
    var controller = new AbortController(); var timer = setTimeout(function () { controller.abort(); }, 15000);
    try {
      var response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response.text();
    } finally { clearTimeout(timer); }
  }
  async function list(options) {
    options = options || {}; var provider = options.provider;
    if (!HOSTS[provider]) throw new Error('WALLPAPER_SOURCE_UNAVAILABLE');
    var query = queryFor(options.query, provider); var number = Math.max(1, Number(options.page) || 1);
    var key = provider + ':' + query; var state = cache.get(key);
    if (!state || Date.now() - state.at > TTL || options.fresh) {
      var first = provider === 'wallpic' ? HOSTS[provider] + '/pc-pic/pc-static' : HOSTS[provider] + '/cn/search/4K/';
      if (query) first = HOSTS[provider] + (provider === 'wallpic' ? '/search/' : '/cn/search/') + encodeURIComponent(query) + '/';
      state = { at: Date.now(), pages: [], next: first }; cache.set(key, state);
    }
    while (state.pages.length < number && state.next) {
      var current = state.next; var parsed = parseList(await read(current), provider, current);
      parsed.items.hasMore = !!parsed.next; state.pages.push(parsed.items); state.next = parsed.next;
    }
    var result = state.pages[number - 1];
    if (result) return result;
    result = []; result.hasMore = false; return result;
  }
  async function resolveImage(item) {
    var detail = safeUrl(item.detail, item.provider);
    if (!detail || !(item.provider === 'wallpic' ? /^\/\d+\.html$/ : /^\/cn\/view\/[^/]+\.html$/).test(new URL(detail).pathname)) throw new Error('UHD_ORIGINAL_UNAVAILABLE');
    var urls = parseOriginals(await read(detail), item.provider); var last;
    for (var url of urls) {
      try {
        var image = await UhdWallpaper.probeImage(url);
        if (image.width < 3840 || image.height < 2160) throw new Error('UHD_LOW_RESOLUTION');
        return Object.assign(image, { provider: item.provider, original: true });
      } catch (e) { last = e; }
    }
    throw last || new Error('UHD_ORIGINAL_UNAVAILABLE');
  }
  global.ChineseWallpapers = { list: list, resolveImage: resolveImage, parseList: parseList, parseOriginals: parseOriginals, queryFor: queryFor };
})(window);
