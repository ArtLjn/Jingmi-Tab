/* 专业摄影图库的官方 API；使用用户自己的 Key，图片请求不携带 API 凭证。 */
(function (global) {
  'use strict';
  var cache = new Map();
  var HOSTS = { pexels: 'https://api.pexels.com', unsplash: 'https://api.unsplash.com' };
  function urlOn(value, hosts) {
    try { var url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && hosts.indexOf(url.hostname) >= 0 ? url.href : ''; } catch (e) { return ''; }
  }
  async function request(provider, path, keys) {
    var key = keys && keys[provider]; if (!key) throw new Error('PHOTO_KEY_REQUIRED');
    var controller = new AbortController(); var timer = setTimeout(function () { controller.abort(); }, 20000);
    try {
      var response = await fetch(HOSTS[provider] + path, { credentials: 'omit', signal: controller.signal,
        headers: { Accept: 'application/json', Authorization: provider === 'unsplash' ? 'Client-ID ' + key : key } });
      if (response.status === 401 || response.status === 403) throw new Error('PHOTO_KEY_INVALID');
      if (response.status === 429) throw new Error('PHOTO_RATE_LIMIT');
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    } finally { clearTimeout(timer); }
  }
  function parse(provider, data) {
    var photos = provider === 'pexels' ? data.photos || [] : Array.isArray(data) ? data : data.results || [];
    return photos.filter(function (photo) { return photo.width >= 3840 && photo.height >= 2160; }).map(function (photo) {
      var original = urlOn(provider === 'pexels' ? photo.src && photo.src.original : photo.urls && photo.urls.raw, provider === 'pexels' ? ['images.pexels.com'] : ['images.unsplash.com']);
      var thumb = urlOn(provider === 'pexels' ? photo.src && photo.src.medium : photo.urls && photo.urls.small, provider === 'pexels' ? ['images.pexels.com'] : ['images.unsplash.com']);
      if (!original || !thumb) return null;
      var detail = urlOn(provider === 'pexels' ? photo.url : photo.links && photo.links.html, provider === 'pexels' ? ['www.pexels.com', 'pexels.com'] : ['unsplash.com']);
      var author = provider === 'pexels' ? photo.photographer : photo.user && photo.user.name;
      var authorUrl = urlOn(provider === 'pexels' ? photo.photographer_url : photo.user && photo.user.links && photo.user.links.html, provider === 'pexels' ? ['www.pexels.com', 'pexels.com'] : ['unsplash.com']);
      if (provider === 'unsplash' && authorUrl) { var attribution = new URL(authorUrl); attribution.searchParams.set('utm_source', 'jingmi_newtab'); attribution.searchParams.set('utm_medium', 'referral'); authorUrl = attribution.href; }
      return { provider: provider, id: String(photo.id), sourceKey: provider + ':' + photo.id,
        title: (photo.alt || photo.description || photo.alt_description || '摄影作品') + (author ? ' · ' + author : ''),
        author: author || provider, authorUrl: authorUrl || detail, detail: detail,
        thumb: thumb, image: thumb, originalUrl: original, resolution: photo.width >= 7680 ? '8K' : '4K+',
        tracking: provider === 'unsplash' && photo.links ? urlOn(photo.links.download_location, ['api.unsplash.com']) : '' };
    }).filter(Boolean);
  }
  async function list(options) {
    var provider = options.provider; var key = options.keys && options.keys[provider]; if (!key) throw new Error('PHOTO_KEY_REQUIRED');
    var query = UhdWallpaper.searchTerm(options.query); var page = Math.max(1, options.page || 1); var index = provider + ':' + query + ':' + page;
    var saved = cache.get(index); if (saved && saved.key === key && Date.now() - saved.at < 300000 && !options.fresh) return saved.items;
    var path = provider === 'pexels' ? query ? '/v1/search' : '/v1/curated' : query ? '/search/photos' : '/photos';
    var url = new URL(path, HOSTS[provider]); url.searchParams.set('page', page); url.searchParams.set('per_page', '30');
    if (query) url.searchParams.set('query', query);
    if (query || provider === 'pexels') url.searchParams.set('orientation', 'landscape');
    if (provider === 'pexels') url.searchParams.set('size', 'large');
    else { url.searchParams.set('order_by', query ? 'relevant' : 'latest'); if (query) url.searchParams.set('content_filter', 'high'); }
    var data = await request(provider, url.pathname + url.search, options.keys); var items = parse(provider, data);
    items.hasMore = provider === 'pexels' ? !!data.next_page : Array.isArray(data) ? data.length >= 30 : page < (data.total_pages || 0);
    cache.set(index, { at: Date.now(), key: key, items: items }); return items;
  }
  async function resolveImage(item, options) {
    var url = urlOn(item.originalUrl, item.provider === 'pexels' ? ['images.pexels.com'] : ['images.unsplash.com']);
    if (!url) throw new Error('UHD_ORIGINAL_UNAVAILABLE');
    var image = await UhdWallpaper.probeImage(url);
    if (image.width < 3840 || image.height < 2160) throw new Error('UHD_LOW_RESOLUTION');
    if (item.provider === 'unsplash' && item.tracking && /^https:\/\/api\.unsplash\.com\/photos\/[^/]+\/download(?:\?|$)/.test(item.tracking)) {
      var track = new URL(item.tracking);
      await request('unsplash', track.pathname + track.search, options && options.keys).catch(function () {});
    }
    return Object.assign(image, { provider: item.provider, original: true });
  }
  global.PhotoWallpapers = { list: list, resolveImage: resolveImage, parse: parse };
})(window);
