/* 其他公开图源：Wallpaper Cave 全站主题搜索，Bing 最近八日精选筛选。 */
(function (global) {
  'use strict';
  var CAVE = 'https://wallpapercave.com';
  var BING = 'https://www.bing.com';
  var cache = new Map(); var TTL = 30 * 60 * 1000; var SIZE = 20;
  async function read(url, json) {
    var controller = new AbortController(); var timer = setTimeout(function () { controller.abort(); }, 20000);
    try {
      var response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return json ? await response.json() : await response.text();
    } finally { clearTimeout(timer); }
  }
  function caveUrl(value, images) {
    try {
      var url = new URL(value, CAVE);
      if (url.origin !== CAVE || url.username || url.password) return '';
      if (images && !/^\/wp\/wp\d+\.(?:jpe?g|png|webp)$/i.test(url.pathname)) return '';
      return url.href;
    } catch (e) { return ''; }
  }
  function parseCave(html, detail) {
    var doc = new DOMParser().parseFromString(html, 'text/html'); var items = []; var seen = new Set();
    doc.querySelectorAll('img.wimg').forEach(function (img) {
      var url = caveUrl(img.getAttribute('src'), true);
      if (!url || seen.has(url) || Number(img.getAttribute('width')) < 3840 || Number(img.getAttribute('height')) < 2160) return;
      seen.add(url); var id = new URL(url).pathname.split('/').pop();
      items.push({ provider: 'wallpapercave', id: id, sourceKey: 'wallpapercave:' + id,
        title: img.getAttribute('alt') || 'Wallpaper Cave 壁纸', detail: detail, originalUrl: url,
        thumb: CAVE + '/wpt/' + id, image: CAVE + '/wpt/' + id, resolution: '4K+' });
    });
    return items;
  }
  function caveAlbums(html, query) {
    var doc = new DOMParser().parseFromString(html, 'text/html'); var urls = [];
    doc.querySelectorAll('img.thumbnail').forEach(function (img) {
      var link = img.closest('a[href]'); var url = link && caveUrl(link.getAttribute('href'));
      if (url && new URL(url).pathname.endsWith('-wallpapers') && urls.indexOf(url) < 0) urls.push(url);
    });
    if (/woman|women|model|portrait/i.test(query || '') && !/anime/i.test(query || '')) {
      urls = urls.filter(function (url) { return !/anime|marvel|samurai|womens-day|women-s-day|fantasy/.test(url); });
      urls.sort(function (a, b) { return Number(/beautiful|model|portrait/.test(b)) - Number(/beautiful|model|portrait/.test(a)); });
    }
    return urls;
  }
  async function cavePage(query, number, fresh) {
    var key = 'cave:' + query; var state = cache.get(key);
    if (!state || Date.now() - state.at > TTL || fresh) {
      var words = UhdWallpaper.searchTerm(query); if (words === 'woman') words = 'women';
      if (words && !/4k|8k/i.test(words)) words += ' 4k';
      var url = query ? CAVE + '/search?q=' + encodeURIComponent(words) : CAVE + '/4k-wallpapers';
      var html = await read(url); var direct = parseCave(html, url);
      state = { at: Date.now(), items: direct, seen: new Set(direct.map(function (item) { return item.sourceKey; })), albums: direct.length ? [] : caveAlbums(html, words), next: 0 };
      cache.set(key, state);
    }
    var offset = (number - 1) * SIZE;
    for (var round = 0; state.items.length <= offset + SIZE && state.next < state.albums.length && round < 3; round++) {
      var albums = state.albums.slice(state.next, state.next + 3);
      var results = await Promise.allSettled(albums.map(async function (url) { return parseCave(await read(url), url); }));
      if (results.length && results.every(function (r) { return r.status === 'rejected'; })) throw new Error('WALLPAPER_SOURCE_UNAVAILABLE');
      state.next += albums.length;
      results.forEach(function (result) { if (result.status === 'fulfilled') result.value.forEach(function (item) {
        if (!state.seen.has(item.sourceKey)) { state.seen.add(item.sourceKey); state.items.push(item); }
      }); });
    }
    var page = state.items.slice(offset, offset + SIZE);
    page.hasMore = state.items.length > offset + SIZE || state.next < state.albums.length;
    return page;
  }
  async function bing(query) {
    var data = await read(BING + '/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=zh-CN', true);
    return (data.images || []).filter(function (image) {
      return !query || [image.title, image.copyright, image.startdate].join(' ').toLowerCase().includes(query.toLowerCase());
    }).map(function (image) {
      var base = new URL(image.urlbase, BING);
      if (base.origin !== BING || base.pathname !== '/th' || !/^OHR\.[\w.-]+$/.test(base.searchParams.get('id') || '')) return null;
      var url = new URL(base); url.searchParams.set('id', base.searchParams.get('id') + '_UHD.jpg');
      var thumb = new URL(url); thumb.searchParams.set('w', '480'); thumb.searchParams.set('h', '270'); thumb.searchParams.set('c', '1');
      return { provider: 'bing', id: image.startdate, sourceKey: 'bing:' + image.startdate,
        title: image.title + ' · ' + image.copyright, detail: BING, originalUrl: url.href,
        image: thumb.href, thumb: thumb.href, resolution: '4K' };
    }).filter(Boolean);
  }
  async function list(options) {
    options = options || {}; var provider = options.provider; var query = String(options.query || '').trim(); var key = provider + ':' + query;
    if (provider === 'wallpapercave') return cavePage(query, Math.max(1, options.page || 1), !!options.fresh);
    var saved = cache.get(key);
    if (!saved || options.fresh || Date.now() - saved.at > TTL) {
      var items = await bing(query);
      saved = { at: Date.now(), items: items }; cache.set(key, saved);
    }
    var offset = (Math.max(1, options.page || 1) - 1) * SIZE; var page = saved.items.slice(offset, offset + SIZE);
    page.hasMore = saved.items.length > offset + SIZE; return page;
  }
  async function resolveImage(item) {
    var url = item.provider === 'wallpapercave' ? caveUrl(item.originalUrl, true) : '';
    if (item.provider === 'bing') {
      var parsed = new URL(item.originalUrl);
      if (parsed.origin === BING && parsed.pathname === '/th' && /_UHD\.jpg$/.test(parsed.searchParams.get('id') || '')) url = parsed.href;
    }
    if (!url) throw new Error('UHD_ORIGINAL_UNAVAILABLE');
    var image = await UhdWallpaper.probeImage(url);
    if (image.width < 3840 || image.height < 2160) throw new Error('UHD_LOW_RESOLUTION');
    return Object.assign(image, { provider: item.provider, original: true });
  }
  global.OtherWallpapers = { list: list, resolveImage: resolveImage, parseCave: parseCave, caveAlbums: caveAlbums };
})(window);
