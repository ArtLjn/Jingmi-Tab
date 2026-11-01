/* 壁纸搜索编排：中文人物意图、多图源召回、去重和持续分页。 */
(function (global) {
  'use strict';
  var sessions = new Map(); var SIZE = 24; var TTL = 15 * 60 * 1000;
  function terms(query) {
    var text = String(query || '').trim();
    if (text === '唯美人物插画' || text === '人物精选') return ['fantasy girl', 'girl illustration', 'anime girl'];
    if (/^(?:国风|古风)(?:美女|人物)$/.test(text)) return ['chinese fantasy girl', 'chinese girl illustration'];
    if (/氛围写真|氛围人像/.test(text)) return ['moody portrait', 'fashion portrait', 'model'];
    if (/^(?:动漫|二次元)(?:美女|女孩|女生)$/.test(text)) return ['anime girl'];
    if (/^(?:真人)?(?:美女|美人|女人|女性|美女壁纸)$/.test(text)) return ['woman', 'model', 'portrait'];
    if (/^(?:人物|美女|女性|人像)?(?:写真|摄影)$|^人像$|^模特$/.test(text)) return ['model', 'portrait', 'photoshoot'];
    if (/^(?:女明星|明星)$/.test(text)) return ['actress', 'celebrity'];
    /* 自由描述：拆成概念词组合，海外图源直接用英文检索式。 */
    if (global.WallpaperAssist) {
      var english = WallpaperAssist.enVariants(text);
      if (english.length) return english;
    }
    return [text];
  }
  function photoIntent(query) { return /美女|写真|人像|模特|女明星|女性|真人|\bwom[ae]n\b|\bmodel\b|\bportrait\b|\bphotoshoot\b/i.test(query) && !/动漫|二次元|插画|国风|古风|幻想|奇幻|\banime\b|illustration/i.test(query); }
  function relevant(item, query) {
    if (query === '人物精选') {
      if (relevant(item, '唯美人物插画')) return true;
      return ['wallpic', 'tenwallpaper'].indexOf(item.provider) >= 0
        && /美女|少女|女孩|女性|写真|人像|女演员|女明星|女星/.test(item.title || '')
        && !/卡通|海绵宝宝|蜡笔小新|喜羊羊|男孩|男子|少年|男人/.test(item.title || '');
    }
    if (query === '唯美人物插画') {
      var title = [item.title, item.tags, item.author].filter(Boolean).join(' ');
      return /美女|少女|女孩|女性|仙子|女神|御姐|精灵|\bgirls?\b|\bwom[ae]n\b|\bfemale\b/i.test(title)
        && /插画|动漫|二次元|国风|古风|幻想|奇幻|精灵|仙子|\bart(?:work)?\b|illustration|fantasy|anime|render|wlop/i.test(title)
        && !/真人|写真|明星|卡通|海绵宝宝|蜡笔小新|喜羊羊|photoshoot|celebrity|actress|\bcartoon\b/i.test(title);
    }
    if (!photoIntent(query)) return true;
    return !/动漫|二次元|插画|卡通|\banime\b|\bmarvel\b|\bcomic\b|\bfantasy\b|\bwarrior\b|wonder woman|invisible woman|women'?s day/i.test(item.title || '');
  }
  function streamsFor(options) {
    var provider = options.provider || 'all'; var variants = terms(options.query); var streams = [];
    /* 国内图库吃中文：描述式检索优先用中文概念组合，没识别出概念就沿用原词。 */
    var chinese = global.WallpaperAssist ? WallpaperAssist.zhVariants(options.query) : [];
    var domesticQuery = chinese.length ? chinese[0] : (options.query || '');
    if (provider === 'all' || provider === 'domestic' || provider === 'wallpic' || provider === 'tenwallpaper') {
      ['wallpic', 'tenwallpaper'].forEach(function (name) {
        if (provider === 'all' || provider === 'domestic' || provider === name) streams.push({ provider: name, query: domesticQuery, page: 1, buffer: [], more: true, weight: 3 });
      });
    }
    if (provider === 'all' || provider === 'uhdpaper') variants.forEach(function (query) { streams.push({ provider: 'uhdpaper', query: query, page: 1, buffer: [], more: true }); });
    if (provider === 'all' || provider === 'wallpapercave') streams.push({ provider: 'wallpapercave', query: variants[0], page: 1, buffer: [], more: true });
    if (provider === 'all' && ['唯美人物插画', '人物精选'].indexOf(options.query) < 0 && !photoIntent(options.query || '')) streams.push({ provider: 'bing', query: options.query || '', page: 1, buffer: [], more: true });
    if (provider === 'all') ['pexels', 'unsplash'].forEach(function (name) { if (options.keys && options.keys[name]) streams.push({ provider: name, query: variants[0], page: 1, buffer: [], more: true }); });
    if (provider === 'all') { if (options.keys && options.keys.pixabay) streams.push({ provider: 'pixabay', query: variants[0], page: 1, buffer: [], more: true }); }
    return streams;
  }
  async function list(options, fetchPage) {
    options = Object.assign({}, options || {});
    var recommended = !String(options.query || '').trim() && options.preference !== 'all' && ['all', 'domestic'].indexOf(options.provider || 'all') >= 0;
    if (recommended) options.query = options.preference === 'illustration' ? '唯美人物插画' : '人物精选';
    options.recommended = recommended;
    var number = Math.max(1, Number(options.page) || 1);
    var key = (options.provider || 'all') + ':' + String(options.query || '').trim() + ':' + JSON.stringify(options.keys || {});
    var state = sessions.get(key);
    if (!state || Date.now() - state.at > TTL || (options.fresh && number === 1)) {
      state = { at: Date.now(), streams: streamsFor(options), pages: [], seen: new Set(), errors: new Map() }; sessions.set(key, state);
    }
    var pending = (state.pending || Promise.resolve()).catch(function () {}).then(function () { return fill(state, options, fetchPage, number); });
    state.pending = pending;
    return pending;
  }
  async function fill(state, options, fetchPage, number) {
    if (state.pages[number - 1]) return state.pages[number - 1];
    while (state.pages.length < number) {
      var items = [];
      /* 一页最多三轮补充；无关结果不会让翻页陷入无限请求。 */
      for (var round = 0; round < 3 && items.length < SIZE; round++) {
        var ready = state.streams.filter(function (stream) { return stream.more && !stream.buffer.length; });
        var results = await Promise.allSettled(ready.map(async function (stream) {
          var page = await fetchPage({ provider: stream.provider, query: stream.query, page: stream.page, fresh: !!options.fresh && stream.page === 1, keys: options.keys });
          stream.page++; stream.more = page.hasMore === undefined ? page.length >= 12 : page.hasMore;
          stream.buffer = page.filter(function (item) { return relevant(item, options.query || ''); });
          state.errors.delete(stream.provider); return stream;
        }));
        results.forEach(function (result, i) {
          if (result.status === 'rejected') { ready[i].more = false; state.errors.set(ready[i].provider, result.reason && result.reason.message || '图源暂不可用'); }
        });
        var advanced = true;
        while (items.length < SIZE && advanced) {
          advanced = false;
          state.streams.forEach(function (stream) {
            for (var take = 0; take < (stream.weight || 1) && items.length < SIZE && stream.buffer.length; take++) {
              var item = stream.buffer.shift(); advanced = true;
              var id = item.sourceKey || item.provider + ':' + item.id;
              if (!state.seen.has(id)) { state.seen.add(id); items.push(item); }
            }
          });
        }
        if (!state.streams.some(function (stream) { return stream.more || stream.buffer.length; })) break;
      }
      if (!items.length && state.errors.size && state.pages.length === 0 && state.streams.every(function (stream) { return !stream.more; })) throw new Error('WALLPAPER_SOURCES_UNAVAILABLE');
      /* 长描述按命中概念重排，同分保持图源原有配额顺序。 */
      if (global.WallpaperAssist) items = WallpaperAssist.rank(items, options.query || '');
      items.hasMore = state.streams.some(function (stream) { return stream.more || stream.buffer.length; });
      items.searchTerms = terms(options.query).map(function (word) { return UhdWallpaper.searchTerm(word); });
      items.recommendation = options.recommended ? options.query : '';
      items.sourceErrors = Array.from(state.errors.keys());
      state.pages.push(items); state.at = Date.now();
      if (!items.hasMore && state.pages.length < number) return [];
    }
    return state.pages[number - 1];
  }
  global.WallpaperSearch = { list: list, terms: terms, relevant: relevant };
})(window);
