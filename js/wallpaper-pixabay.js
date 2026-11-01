/* Pixabay 官方图库。
   站点页面由 Cloudflare 托管挑战保护：REA 实测 https://pixabay.com/images/search/woman/
   返回 403 挑战页（cf-mitigated: challenge，只有 Turnstile 脚本，没有任何图片数据），
   直接抓 HTML 这条路走不通。因此这里只走官方 JSON 接口 https://pixabay.com/api/：
   该接口对浏览器扩展开放（access-control-allow-origin: *），但必须由用户提供自己的
   API Key，Key 仅保存在本机，只发送到 pixabay.com。

   清晰度说明（2026-11 实测，普通 Key）：
   - 响应里没有 imageURL / fullHDURL，只有 largeImageURL 与 webformatURL；
   - largeImageURL 实测解码为 1280×853，CDN 的 _1920 / _2560 / _3840 后缀一律 403，
     原图（如 4272×2848）只能登录站内下载，无法用接口直链取得；
   - 所以这里以 1280×720 为可用下限，并如实标注「高清」而不是 4K。 */
(function (global) {
  'use strict';
  var HOST = 'https://pixabay.com';
  var ENDPOINT = HOST + '/api/';
  var PAGE_SIZE = 30;
  var MIN_WIDTH = 1280;
  var MIN_HEIGHT = 720;
  var TTL = 5 * 60 * 1000;
  var cache = new Map();

  /* Pixabay 以英文索引为主，常用中文题材先按词意扩展；其余词交给通用转换表。 */
  var TERMS = {
    '人像': 'portrait woman studio',
    '人物摄影': 'portrait photography woman',
    '时装': 'fashion editorial model',
    '模特': 'fashion model runway',
    '氛围人像': 'moody portrait light',
    '美女': 'beautiful woman portrait',
    '女明星': 'actress editorial',
    '国风人物': 'chinese hanfu woman'
  };

  function term(text) {
    var value = String(text || '').trim();
    if (!value) return '';
    if (TERMS[value]) return TERMS[value];
    return UhdWallpaper.searchTerm(value);
  }

  /** 只接受 Pixabay 自家地址：预览图在 cdn.pixabay.com，大图走 pixabay.com/get/<hash>。 */
  function cdnUrl(value) {
    try {
      var url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password) return '';
      if (url.hostname === 'cdn.pixabay.com') return url.href;
      if (url.hostname === 'pixabay.com' || url.hostname === 'www.pixabay.com') {
        return url.pathname.indexOf('/get/') === 0 ? url.href : '';
      }
      return '';
    } catch (e) { return ''; }
  }

  async function request(url) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 20000);
    try {
      var response = await fetch(url, {
        credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal,
        headers: { Accept: 'application/json' }
      });
      if (response.status === 400) throw new Error('PHOTO_KEY_INVALID');
      if (response.status === 401 || response.status === 403) throw new Error('PHOTO_KEY_INVALID');
      if (response.status === 429) throw new Error('PHOTO_RATE_LIMIT');
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response.json();
    } finally { clearTimeout(timer); }
  }

  /** 接口结果 → 统一的壁纸条目；按原图像素先做一次服务端与本地双重过滤。 */
  function parse(data) {
    var hits = (data && data.hits) || [];
    return hits.filter(function (hit) {
      return Number(hit.imageWidth) >= MIN_WIDTH && Number(hit.imageHeight) >= MIN_HEIGHT;
    }).map(function (hit) {
      /* 从大到小排列，resolveImage 会按顺序探测直到命中可解码的高清图。 */
      var candidates = [hit.imageURL, hit.fullHDURL, hit.largeImageURL, hit.webformatURL]
        .map(cdnUrl).filter(Boolean);
      if (!candidates.length) return null;
      var tags = String(hit.tags || '').split(',').map(function (tag) { return tag.trim(); })
        .filter(Boolean).slice(0, 3).join('、');
      var author = String(hit.user || 'Pixabay').trim() || 'Pixabay';
      var authorUrl = hit.user_id
        ? HOST + '/users/' + encodeURIComponent(author.replace(/\s+/g, '-')) + '-' + hit.user_id + '/'
        : HOST + '/';
      return {
        provider: 'pixabay', id: String(hit.id), sourceKey: 'pixabay:' + hit.id,
        title: (tags || 'Pixabay 摄影') + ' · ' + author,
        author: author, authorUrl: authorUrl,
        detail: HOST + '/photos/' + encodeURIComponent(String(hit.id)) + '/',
        thumb: cdnUrl(hit.webformatURL) || candidates[candidates.length - 1],
        image: candidates[candidates.length - 1],
        originalUrl: candidates[0],
        candidates: candidates,
        width: Number(hit.imageWidth), height: Number(hit.imageHeight),
        /* 普通 Key 的 largeImageURL 是 1280 的流传图；只有响应带 imageURL / fullHDURL
           （完整权限 Key）时才可能更大，最终以 resolveImage 的实测解码尺寸为准。 */
        resolution: hit.imageURL || hit.fullHDURL ? '' : '1280 高清'
      };
    }).filter(Boolean);
  }

  async function list(options) {
    options = options || {};
    var key = options.keys && String(options.keys.pixabay || '').trim();
    if (!key) throw new Error('PHOTO_KEY_REQUIRED');
    var query = term(options.query);
    var page = Math.max(1, Number(options.page) || 1);
    var index = query + ':' + page;
    var saved = cache.get(index);
    if (saved && saved.key === key && Date.now() - saved.at < TTL && !options.fresh) return saved.items;

    var url = new URL(ENDPOINT);
    url.searchParams.set('key', key);
    url.searchParams.set('image_type', 'photo');
    url.searchParams.set('orientation', 'horizontal');
    /* 始终开启站点安全过滤，公开分发时不提供关闭入口。 */
    url.searchParams.set('safesearch', 'true');
    url.searchParams.set('order', 'popular');
    url.searchParams.set('per_page', String(PAGE_SIZE));
    url.searchParams.set('page', String(page));
    url.searchParams.set('min_width', String(MIN_WIDTH));
    url.searchParams.set('min_height', String(MIN_HEIGHT));
    if (query) { url.searchParams.set('q', query); url.searchParams.set('lang', 'en'); }

    var data = await request(url.href);
    var items = parse(data);
    items.hasMore = Number(data.totalHits || 0) > page * PAGE_SIZE;
    cache.set(index, { at: Date.now(), key: key, items: items });
    return items;
  }

  /** 候选地址已按从大到小排列，第一个能解码且达标的就是可得的最大图。 */
  async function resolveImage(item) {
    var candidates = (item && item.candidates && item.candidates.length
      ? item.candidates.slice()
      : [item && item.originalUrl]).map(cdnUrl).filter(Boolean);
    if (!candidates.length) throw new Error('UHD_ORIGINAL_UNAVAILABLE');
    for (var i = 0; i < candidates.length; i++) {
      var image;
      try { image = await UhdWallpaper.probeImage(candidates[i]); } catch (e) { continue; }
      if (image.width < MIN_WIDTH || image.height < MIN_HEIGHT) continue;
      var uhd = image.width >= 3840 && image.height >= 2160;
      /* 只有真的解码到 4K 才算原图；1280 的流传图明确标为预览，避免虚标清晰度。 */
      return Object.assign(image, { provider: 'pixabay', original: uhd, tier: uhd ? '4K' : 'HD' });
    }
    throw new Error('PIXABAY_LOW_RESOLUTION');
  }

  global.PixabayWallpapers = {
    list: list, resolveImage: resolveImage, parse: parse, term: term,
    host: HOST, pageSize: PAGE_SIZE, minWidth: MIN_WIDTH, minHeight: MIN_HEIGHT
  };
})(window);
