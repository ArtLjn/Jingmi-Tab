/* ============================================================
   newtab.js —— 新标签页交互逻辑
   模块：时钟 / 农历日期 / 搜索 / 背景切换 / 设置面板
   ============================================================ */
(function () {
  'use strict';

  /* ------------------------- 常量 ------------------------- */
  var ENGINES = {
    bing: { label: '必应', url: 'https://www.bing.com/search?q=' },
    baidu: { label: '百度', url: 'https://www.baidu.com/s?wd=' },
    google: { label: 'Google', url: 'https://www.google.com/search?q=' },
    sogou: { label: '搜狗', url: 'https://www.sogou.com/web?query=' }
  };
  var ENGINE_ORDER = ['bing', 'baidu', 'google', 'sogou'];

  /* 每日一言的句库 / 数据源 / 去重逻辑见 js/daily-quote.js（DailyQuote 模块），
     本文件只负责取当天结果并渲染，保持 DOM 层轻量。 */

  var LUNAR_DAYS = [
    '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
    '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
    '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'
  ];

  /* ------------------------- DOM ------------------------- */
  var $ = function (sel) { return document.querySelector(sel); };

  var els = {
    bg: $('#bg-image'),
    bgLoader: $('#bg-loader'),
    clock: $('#clock'),
    timePreview: $('#time-preview'),
    dateLine: $('#date-line'),
    dateSolar: $('#date-solar'),
    dateDot: $('#date-dot'),
    dateLunar: $('#date-lunar'),
    searchForm: $('#search-form'),
    searchInput: $('#search-input'),
    acPanel: $('#ac-panel'),
    engineChip: $('#engine-chip'),
    swAi: $('#sw-ai'),
    aiBase: $('#ai-base'),
    aiKey: $('#ai-key'),
    aiModel: $('#ai-model'),
    aiFastModel: $('#ai-fast-model'),
    aiStrongModel: $('#ai-strong-model'),
    aiTest: $('#ai-test'),
    aiStatus: $('#ai-status'),
    quote: $('#quote'),
    settingsBtn: $('#settings-btn'),
    panel: $('#panel'),
    panelClose: $('#panel-close'),
    fileInput: $('#file-input'),
    gallery: $('#gallery'),
    galleryEmpty: $('#gallery-empty'),
    urlInput: $('#url-input'),
    urlApply: $('#url-apply'),
    swatches: $('#swatches'),
    wpProvider: $('#wp-provider'),
    wpSourceLink: $('#wp-source-link'),
    wpSourceNote: $('#wp-source-note'),
    wpPhotoSettings: $('#wp-photo-settings'),
    wpPhotoKey: $('#wp-photo-key'),
    wpPhotoLabel: $('#wp-photo-key-label'),
    wpPhotoHelp: $('#wp-photo-key-help'),
    wpHaoSettings: $('#wp-hao-settings'),
    wpQuery: $('#wp-query'),
    wpSearch: $('#wp-search'),
    wpGrid: $('#wp-grid'),
    wpStatus: $('#wp-status'),
    wpPrev: $('#wp-prev'),
    wpPage: $('#wp-page'),
    wpMore: $('#wp-more'),
    wpToken: $('#wp-token'),
    wpAuth: $('#wp-auth'),
    wpQuality: $('#wp-quality'),
    wpSave: $('#wp-save'),
    wpHistoryWrap: $('#wp-history-wrap'),
    wpHistory: $('#wp-history'),
    wpHistoryClear: $('#wp-history-clear'),
    wpSuggest: $('#wp-suggest'),
    blurRange: $('#blur-range'),
    blurValue: $('#blur-value'),
    scrimRange: $('#scrim-range'),
    scrimValue: $('#scrim-value'),
    swMotion: $('#sw-motion'),
    swH24: $('#sw-h24'),
    swSeconds: $('#sw-seconds'),
    swDate: $('#sw-date'),
    swLunar: $('#sw-lunar'),
    swSearch: $('#sw-search'),
    swSuggest: $('#sw-suggest'),
    swQuote: $('#sw-quote'),
    swTags: $('#sw-tags'),
    swTagAi: $('#sw-tag-ai'),
    engines: $('#engines'),
    resetBtn: $('#reset-btn'),
    toast: $('#toast'),
    dropHint: $('#drop-hint')
  };

  /* ------------------------- 状态 ------------------------- */
  var settings = null;
  var ragSettingsUI = null;
  var currentObjectUrl = null;   // 当前用于背景的 blob URL
  var bgPaintSeq = 0;            // 背景图片解码序号，避免慢图覆盖新选择
  var galleryUrls = [];          // 缩略图 blob URL，重渲染时释放
  var saveTimer = null;
  var clockTimer = null;
  var toastTimer = null;
  var ambientMotion = null;

  /* 书签检索：全量行常驻内存，输入时纯本地打分，不发消息、不联网 */
  var bmRows = [];
  var bmReady = false;
  var acHits = [];               // 当前检索结果
  var acActions = [];            // 末尾的兜底动作（用引擎搜索）
  var acIndex = 0;               // 当前选中项
  var acBanner = '';             // 面板顶部说明行（AI 模式专用）
  var aiAnswer = null;           // AI 问答结果：{ text, sources[], streaming }
  var answerRenderTimer = 0;     // 流式输出节流，避免每收到一段就重绘整个面板

  function applyStreamingAnswer(partial) {
    aiAnswer = partial || null;
    if (answerRenderTimer) return;
    answerRenderTimer = setTimeout(function () {
      answerRenderTimer = 0;
      renderPanel();
    }, 60);
  }

  function resetAnswer() {
    aiAnswer = null;
    clearTimeout(answerRenderTimer);
    answerRenderTimer = 0;
  }
  var aiBusy = false;            // 正在等模型返回，避免重复触发
  var aiSeq = 0;                 // 请求序号，用于丢弃过期响应
  var aiController = null;
  function cancelAI() {
    if (aiController) aiController.abort();
    aiController = null;
  }
  var aiCands = [];              // 最近一次 AI 检索用到的本地候选，供「看全部」复用

  /* 普通搜索联想：全网建议词，防抖与竞态由 session 内部处理 */
  var suggest = null;            // SearchSuggest.Session
  var suggestRecent = null;      // 最近搜索存储（空输入时展示）
  var suggestState = { status: 'idle', query: '', items: [] };
  var suggestNote = '';          // 联想来源说明（当前引擎失败退到必应时标注）
  var blurTimer = null;              // 失焦延时收面板；重新聚焦要撤销它

  /* 快捷标签（@）：手动标签常驻在 QuickTags 里，候选每次打开即时重算 */
  var tagTopSites = [];          // chrome.topSites 结果，浏览器自己统计的常访站点
  var tagGroups = { pinned: [], ai: [], candidates: [] };
  var tagCreate = null;          // URL 形态查询对应的「新建标签」条目
  var tagReady = false;          // QuickTags 已加载完成
  var creatingTag = false;       // 新建防重入
  var tagManager = null;         // 工作台「快捷标签」页实例
  var composing = false;         // 输入法组合中，暂不重算候选

  /* 在线壁纸：分页与加载状态 */
  var wallpaperApplySequence = 0;
  var wpState = { query: '', page: 1, loading: false, items: [], hasMore: true, sequence: 0 };
  var wpThumbObserver = null;
  var wpGridFitTimer = 0;

  /* ------------------------- 工具 ------------------------- */
  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      Settings.save(settings);
    }, 180);
  }

  function toast(text, duration) {
    if (!els.toast) return;
    els.toast.textContent = text;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      els.toast.classList.remove('show');
    }, duration || 2000);
  }

  function dayOfYear(d) {
    var start = new Date(d.getFullYear(), 0, 0);
    return Math.floor((d - start) / 86400000);
  }

  /* ------------------------- 时钟 ------------------------- */
  function renderClock() {
    var now = new Date();
    var h = now.getHours();
    var m = now.getMinutes();
    var s = now.getSeconds();
    var html;

    if (settings.clock.h24) {
      html = pad(h) + ':' + pad(m);
    } else {
      html = (h % 12 || 12) + ':' + pad(m);
    }
    if (settings.clock.seconds) {
      html += '<span class="sec">:' + pad(s) + '</span>';
    }
    if (!settings.clock.h24) {
      html += '<span class="meridiem">' + (h < 12 ? 'AM' : 'PM') + '</span>';
    }
    els.clock.innerHTML = html;
    if (els.timePreview) els.timePreview.innerHTML = html;
  }

  function startClock() {
    renderClock();
    clearInterval(clockTimer);
    // 对齐到整秒，避免时间“跳帧”
    var delay = 1000 - (Date.now() % 1000);
    setTimeout(function () {
      renderClock();
      clockTimer = setInterval(renderClock, 1000);
    }, delay);
  }

  /* ------------------------- 日期 / 农历 ------------------------- */
  function lunarLabel(date) {
    try {
      var month = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long' }).format(date);
      var dayStr = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { day: 'numeric' }).format(date);
      var dayNum = parseInt(dayStr, 10);
      if (!month || isNaN(dayNum) || !LUNAR_DAYS[dayNum - 1]) return '';
      return month + LUNAR_DAYS[dayNum - 1];
    } catch (e) {
      return '';
    }
  }

  function renderDate() {
    var now = new Date();
    var solar = now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日' +
      ' ' + new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(now);
    els.dateSolar.textContent = solar;

    var lunar = lunarLabel(now);
    els.dateLunar.textContent = lunar;
    els.dateLunar.classList.toggle('is-hidden', !settings.show.lunar || !lunar);
    els.dateDot.classList.toggle('is-hidden', !settings.show.lunar || !lunar);
  }

  /* ------------------------- 每日一言 -------------------------
     取数与去重策略全部收敛在 js/daily-quote.js（DailyQuote 模块）：
       · 数据源：今日诗词 + 一言 hitokoto 不同品类，按日序轮换并逐级降级；
       · 去重：最近 60 条历史文本归一化比对，另有近期出处表避免同首诗连发；
       · 过滤：政治指向 / 低俗 / 灌水句直接丢弃；
       · 兜底：全部源失败时用本地现代句库。
     本文件只做三件事：读历史、请求当天一句、渲染 + 按天缓存。 */
  /* 模块没加载成功时不要连累整页：这里做一层最小兜底 */
  var QUOTE_MODULE = (typeof DailyQuote !== 'undefined') ? DailyQuote : null;
  var QUOTE_CACHE_KEY = QUOTE_MODULE ? QUOTE_MODULE.CACHE_KEY : 'dailyQuoteV2';
  var QUOTE_HISTORY_KEY = QUOTE_MODULE ? QUOTE_MODULE.HISTORY_KEY : 'quoteHistoryV2';
  var QUOTE_FROM_KEY = QUOTE_MODULE ? QUOTE_MODULE.FROM_KEY : 'quoteFromsV2';
  var QUOTE_FALLBACK_TEXT = '把今天过完，就已经算件了不起的事';
  var quoteState = { date: '', text: '', from: '', source: '' };  // 内存缓存
  var quoteFetching = false;       // 防止 30s 轮询重入
  var quoteHistory = null;         // 归一化后的历史文本（懒加载）
  var quoteRecentFroms = null;     // 近期出处，避免连着几天同一首诗 / 同一部剧

  function quoteDateKey(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /** 把去重用的历史文本与出处读进内存（只读一次）。 */
  function primeHistory(cb) {
    if (quoteHistory && quoteRecentFroms) { cb(); return; }
    try {
      chrome.storage.local.get([QUOTE_HISTORY_KEY, QUOTE_FROM_KEY], function (res) {
        quoteHistory = (res && res[QUOTE_HISTORY_KEY]) || [];
        quoteRecentFroms = (res && res[QUOTE_FROM_KEY]) || [];
        cb();
      });
    } catch (e) {
      quoteHistory = [];
      quoteRecentFroms = [];
      cb();
    }
  }

  function showQuote(text, from) {
    els.quote.textContent = '「' + text + '」';
    els.quote.title = from ? '—— ' + from : '';
  }

  function saveQuoteState() {
    try {
      var payload = {};
      payload[QUOTE_CACHE_KEY] = quoteState;
      chrome.storage.local.set(payload);
    } catch (e) { /* 缓存失败不影响显示 */ }
  }

  /** 当天第一次打开（换日）时请求一条新的，并把结果写进去重历史与当天缓存。 */
  function fetchDailyQuote(today) {
    if (quoteFetching) return;
    if (!QUOTE_MODULE) { showQuote(QUOTE_FALLBACK_TEXT, ''); return; }
    quoteFetching = true;
    QUOTE_MODULE.pick({ history: quoteHistory || [], recentFroms: quoteRecentFroms || [] })
      .then(function (item) {
        quoteState = { date: today, text: item.text, from: item.from, source: item.source };
        showQuote(item.text, item.from);
        quoteHistory = QUOTE_MODULE.remember(quoteHistory, item.text);
        quoteRecentFroms = QUOTE_MODULE.rememberFrom(quoteRecentFroms, item.from);
        try {
          var payload = {};
          payload[QUOTE_HISTORY_KEY] = quoteHistory;
          payload[QUOTE_FROM_KEY] = quoteRecentFroms;
          chrome.storage.local.set(payload);
        } catch (e) { /* 忽略 */ }
        saveQuoteState();
        quoteFetching = false;
      })
      .catch(function () {
        // 全部源失败：留在本地句库，今天内不再反复请求
        quoteState = { date: today, text: '', from: '', source: 'local' };
        showQuote(localQuoteText(), '');
        quoteFetching = false;
      });
  }

  /** 本地兜底句：模块可用时取句库里近期没出现过的，否则用固定一句。 */
  function localQuoteText() {
    if (!QUOTE_MODULE) return QUOTE_FALLBACK_TEXT;
    return QUOTE_MODULE.pickLocal(QUOTE_MODULE.dayOfYear(new Date()), quoteHistory);
  }

  function renderQuote() {
    var today = quoteDateKey(new Date());

    // 1. 内存缓存命中（含当天已失败的情况）：直接渲染，零开销
    if (quoteState.date === today) {
      showQuote(quoteState.text || localQuoteText(), quoteState.from);
      return;
    }

    // 2. 先给本地兜底句，避免等待时空白
    showQuote(localQuoteText(), '');

    // 3. 先把去重历史读进内存，再查当天缓存，缺失才请求接口
    if (!QUOTE_MODULE) return;
    primeHistory(function () {
      try {
        chrome.storage.local.get(QUOTE_CACHE_KEY, function (res) {
          var cached = res && res[QUOTE_CACHE_KEY];
          if (cached && cached.date === today && cached.text) {
            quoteState = cached;
            showQuote(cached.text, cached.from);
            return;
          }
          fetchDailyQuote(today);
        });
      } catch (e) {
        fetchDailyQuote(today);
      }
    });
  }

  /* ------------------------- 背景 ------------------------- */
  function gradientCss(key) {
    var g = GRADIENTS[key] || GRADIENTS.mist;
    return g.css;
  }

  /** 常驻显示当前背景的真实来源与像素，避免把公开预览误认为 4K 原图。 */
  function updateWallpaperQuality(row) {
    if (!els.wpQuality) return;
    var online = settings.bg.mode === 'url' && settings.bg.online && settings.bg.online.url === settings.bg.url ? settings.bg.online : null;
    els.wpSave.disabled = !online;
    if (settings.bg.mode === 'url') {
      var sourceNames = { wallpic: 'Wallpic', tenwallpaper: '10wallpaper 中文', uhdpaper: 'UHD Paper', wallpapercave: 'Wallpaper Cave', bing: 'Bing', haowallpaper: '哲风', pexels: 'Pexels', unsplash: 'Unsplash', pixabay: 'Pixabay' };
      els.wpQuality.textContent = online
        ? '当前背景：' + (sourceNames[online.provider] || '在线图源') + ' · ' + (online.original ? '在线高清原图' : '在线预览（非原图）') + ' · ' + online.width + '×' + online.height
        : '当前背景：网络图片链接（分辨率未检测）';
      return;
    }
    if (settings.bg.mode !== 'image') {
      els.wpQuality.textContent = '当前背景：渐变背景';
      return;
    }
    if (!row) {
      els.wpQuality.textContent = '当前背景：未读取到图片缓存';
      return;
    }

    var rowId = row.id;
    function render() {
      // 图片解码期间可能已切换背景，不回写过期状态。
      if (settings.bg.mode !== 'image' || settings.bg.imageId !== rowId) return;
      var size = row.width && row.height ? ' · ' + row.width + '×' + row.height : '';
      var kind = row.original
        ? (row.provider === 'uhdpaper' ? 'UHD Paper 原图' : '原图')
        : (row.sourceKey ? '公开预览（非原图）' : '本地 / 旧版图片');
      els.wpQuality.textContent = '当前背景：' + kind + size;
    }

    if ((row.width && row.height) || typeof createImageBitmap !== 'function') {
      render();
      return;
    }
    createImageBitmap(row.blob).then(function (bmp) {
      row.width = bmp.width;
      row.height = bmp.height;
      bmp.close && bmp.close();
      render();
    }).catch(render);
  }

  function showGradientBackground() {
    bgPaintSeq++;
    if (els.bgLoader) els.bgLoader.classList.remove('is-on');
    els.bg.style.backgroundImage = gradientCss(settings.bg.gradient);
    els.bg.style.backgroundColor = '#10161f';
    updateWallpaperQuality(null);
  }

  /* 图片先解码再交给 CSS 背景，加载层负责镜片扫光，避免大图解码时的白闪。 */
  function paintBackground(url) {
    var seq = ++bgPaintSeq;
    /* 缓存的图片通常瞬间完成，延迟 120ms 再显示加载层，避免闪一下扫光。 */
    var showTimer = setTimeout(function () {
      if (seq === bgPaintSeq && els.bgLoader) els.bgLoader.classList.add('is-on');
    }, 120);
    var probe = new Image();
    probe.decoding = 'async';
    probe.fetchPriority = 'high';
    probe.referrerPolicy = 'no-referrer';
    function settle(ok) {
      clearTimeout(showTimer);
      if (seq !== bgPaintSeq) return;
      if (ok) {
        els.bg.style.backgroundImage = 'url("' + url.replace(/"/g, '%22') + '")';
        els.bg.style.backgroundColor = '#000';
      }
      if (els.bgLoader) els.bgLoader.classList.remove('is-on');
    }
    probe.onload = function () {
      var decoded = probe.decode ? probe.decode().catch(function () {}) : Promise.resolve();
      decoded.then(function () { settle(true); });
    };
    probe.onerror = function () { settle(false); };
    probe.src = url;
  }

  function applyBackground() {
    wallpaperApplySequence++;
    var bg = settings.bg;

    // 清掉上一次的 blob URL，避免内存泄漏
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }

    if (bg.mode === 'image' && bg.imageId != null) {
      ImageStore.get(bg.imageId).then(function (row) {
        if (!row || !row.blob) {
          // 图片被删了，回退到渐变
          settings.bg.mode = 'gradient';
          persist();
          showGradientBackground();
          return;
        }
        currentObjectUrl = URL.createObjectURL(row.blob);
        paintBackground(currentObjectUrl);
        updateWallpaperQuality(row);
      });
    } else if (bg.mode === 'url' && bg.url) {
      paintBackground(bg.url);
      updateWallpaperQuality(null);
    } else {
      showGradientBackground();
    }

    document.documentElement.style.setProperty('--bg-blur', bg.blur + 'px');
    document.documentElement.style.setProperty('--scrim', String(bg.scrim / 100));
  }

  function applyMotionPreference() {
    var enabled = !settings.bg || settings.bg.motion !== false;
    if (typeof AmbientMotion === 'undefined') return;
    if (!ambientMotion) ambientMotion = AmbientMotion.mount({ enabled: enabled });
    else ambientMotion.setEnabled(enabled);
  }

  /* ------------------------- 设置面板渲染 ------------------------- */
  function renderSwatches() {
    els.swatches.innerHTML = '';
    Object.keys(GRADIENTS).forEach(function (key) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'swatch';
      btn.title = GRADIENTS[key].name;
      btn.style.background = GRADIENTS[key].css;
      btn.dataset.key = key;
      btn.addEventListener('click', function () {
        settings.bg.mode = 'gradient';
        settings.bg.gradient = key;
        persist();
        applyBackground();
        syncActive();
        toast('已切换背景：' + GRADIENTS[key].name);
      });
      els.swatches.appendChild(btn);
    });
  }

  function renderEngines() {
    els.engines.innerHTML = '';
    ENGINE_ORDER.forEach(function (key) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = ENGINES[key].label;
      btn.dataset.key = key;
      btn.addEventListener('click', function () {
        settings.engine = key;
        persist();
        syncActive();
        applyMode();
        resetSuggestForEngine();
      });
      els.engines.appendChild(btn);
    });
  }

  function renderGallery() {
    ImageStore.list().then(function (rows) {
      galleryUrls.forEach(function (u) { URL.revokeObjectURL(u); });
      galleryUrls = [];
      els.gallery.innerHTML = '';

      els.galleryEmpty.classList.toggle('is-hidden', rows.length > 0);

      rows.forEach(function (row) {
        var url = URL.createObjectURL(row.blob);
        galleryUrls.push(url);

        var item = document.createElement('div');
        item.className = 'thumb' + (settings.bg.mode === 'image' && settings.bg.imageId === row.id ? ' is-active' : '');
        item.style.backgroundImage = 'url("' + url + '")';
        item.title = (row.name || '') +
          (row.width && row.height ? ' · ' + row.width + '×' + row.height : '') +
          (row.original ? ' · 原图离线缓存' : '');

        item.addEventListener('click', function () {
          settings.bg.mode = 'image';
          settings.bg.imageId = row.id;
          persist();
          applyBackground();
          syncActive();
          toast('已应用该背景');
        });

        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'del';
        del.textContent = '×';
        del.title = '删除';
        del.addEventListener('click', function (ev) {
          ev.stopPropagation();
          ImageStore.remove(row.id).then(function () {
            if (settings.bg.mode === 'image' && settings.bg.imageId === row.id) {
              settings.bg.mode = 'gradient';
              settings.bg.imageId = null;
              persist();
              applyBackground();
            }
            renderGallery();
            toast('已删除');
          });
        });

        item.appendChild(del);
        els.gallery.appendChild(item);
      });
      scheduleWpGridFit();
    });
  }

  /** 同步面板里的选中态 & 开关显示 */
  function syncActive() {
    Array.prototype.forEach.call(els.swatches.children, function (el) {
      el.classList.toggle('is-active',
        settings.bg.mode === 'gradient' && el.dataset.key === settings.bg.gradient);
    });
    Array.prototype.forEach.call(els.engines.children, function (el) {
      el.classList.toggle('is-active', el.dataset.key === settings.engine);
    });
    Array.prototype.forEach.call(els.gallery.children, function (el) {
      el.classList.toggle('is-active',
        settings.bg.mode === 'image' && el.dataset.id === String(settings.bg.imageId));
    });
  }

  function applyVisibility() {
    els.dateLine.classList.toggle('is-hidden', !settings.show.date);
    els.searchForm.classList.toggle('is-hidden', !settings.show.search);
    els.quote.classList.toggle('is-hidden', !settings.show.quote);
    els.dateLunar.classList.toggle('is-hidden', !(settings.show.date && settings.show.lunar && lunarLabel(new Date())));
    els.dateDot.classList.toggle('is-hidden', !(settings.show.date && settings.show.lunar && lunarLabel(new Date())));
  }

  /* ------------------------- 在线壁纸 ------------------------- */
  function syncWallpaperProvider() {
    var sources = { domestic: ['https://www.wallpic.cn/', '聚合 Wallpic 与 10wallpaper 中文站，保留中文关键词，筛选电脑静态壁纸。'], wallpic: ['https://www.wallpic.cn/', '国风、动漫与人物题材；排除手机与动态壁纸，使用前校验实际像素。'], tenwallpaper: ['https://www.10wallpaper.com/cn/', '中文关键词搜索，读取站点公开的 4K / 5K 下载地址。'], pexels: ['https://www.pexels.com/', '摄影图库，需填写自己的 Pexels API Key；按原始像素筛选。'], unsplash: ['https://unsplash.com/', '摄影图库，需填写自己的 Unsplash Access Key；展示作者与来源。'], pixabay: ['https://pixabay.com/', '官方 JSON 接口图库，需填写自己的 Pixabay API Key；整站页面受 Cloudflare 防护，故不抓网页，只按真实解码尺寸标注 4K 或高清。'], all: ['https://www.wallpic.cn/', '优先展示中文图库；默认推荐人物插画与国内写真，可切换全部题材或直接搜索。'], uhdpaper: ['https://www.uhdpaper.com/', '支持全站搜索，常见中文关键词自动转换。'], wallpapercave: ['https://wallpapercave.com/', '搜索相关主题，从匹配图集中筛选 4K 图片。'], bing: ['https://www.bing.com/', '最近 8 天精选，可按标题、地点和日期筛选。'], haowallpaper: ['https://haowallpaper.com/', '支持关键词搜索；未登录时仅能使用公开预览。'] };
    var provider = sources[settings.wallpaper.provider] ? settings.wallpaper.provider : 'all';
    els.wpProvider.value = provider;
    var professional = ['pexels', 'unsplash', 'pixabay'].indexOf(provider) >= 0; els.wpPhotoSettings.hidden = !professional;
    if (professional) {
      var labels = { pexels: ['Pexels API Key', 'https://www.pexels.com/api/'], unsplash: ['Unsplash Access Key', 'https://unsplash.com/developers'], pixabay: ['Pixabay API Key', 'https://pixabay.com/api/docs/'] };
      els.wpPhotoKey.value = settings.wallpaper.keys[provider] || '';
      els.wpPhotoLabel.textContent = labels[provider][0];
      els.wpPhotoHelp.href = labels[provider][1];
    }
    els.wpHaoSettings.hidden = provider !== 'haowallpaper';
    els.wpSourceLink.href = sources[provider][0]; els.wpSourceNote.textContent = sources[provider][1];
    els.wpQuery.placeholder = provider === 'bing' ? '筛选最近 8 天的标题、地点或日期…'
      : provider === 'pixabay' ? '搜索人像、时装、风景，或直接写一整句描述…'
        : '搜索唯美女生、国风人物、动漫、风景…';
    document.querySelectorAll('[data-wallpaper-preference]').forEach(function (button) { button.setAttribute('aria-pressed', String(!wpState.query && ['all', 'domestic'].indexOf(provider) >= 0 && button.dataset.wallpaperPreference === settings.wallpaper.preference)); });
  }

  /* ------------------------- 搜索联想 ------------------------- */
  var suggestTimer = 0;
  var suggestSeq = 0;

  function applyWallpaperSuggest(text) {
    els.wpQuery.value = text;
    wpState.query = text;
    els.wpSuggest.hidden = true;
    loadWallpapers(true);
  }

  function renderWallpaperSuggestChips(list, loading) {
    els.wpSuggest.innerHTML = '';
    var show = !!list.length || !!loading;
    els.wpSuggest.hidden = !show;
    if (loading) {
      var dot = document.createElement('span');
      dot.className = 'wp-suggest-loading';
      dot.textContent = '联想中…';
      els.wpSuggest.appendChild(dot);
    }
    list.forEach(function (text) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'wp-suggest-chip';
      chip.textContent = text;
      chip.addEventListener('click', function () { applyWallpaperSuggest(text); });
      els.wpSuggest.appendChild(chip);
    });
  }

  /* 本地联想即时出结果；配置了 AI 时额外提供一个让模型改写的入口。 */
  function refreshWallpaperSuggest() {
    if (!els.wpSuggest || typeof WallpaperAssist === 'undefined') return;
    var text = els.wpQuery.value.trim();
    if (text.length < 2) { els.wpSuggest.hidden = true; els.wpSuggest.innerHTML = ''; return; }
    var list = WallpaperAssist.suggest(text, 4);
    renderWallpaperSuggestChips(list, false);
    if (list.length && AI.available(settings.ai)) {
      var ai = document.createElement('button');
      ai.type = 'button';
      ai.className = 'wp-suggest-chip wp-suggest-ai';
      ai.textContent = 'AI 联想';
      ai.addEventListener('click', function () { runWallpaperAiSuggest(text); });
      els.wpSuggest.appendChild(ai);
    }
  }

  function runWallpaperAiSuggest(text) {
    var seq = ++suggestSeq;
    renderWallpaperSuggestChips([], true);
    WallpaperAssist.aiKeywords(settings.ai, text).then(function (result) {
      if (seq !== suggestSeq) return;
      if (!result.ok) { toast('AI 联想不可用：' + AI.errText(result.error)); refreshWallpaperSuggest(); return; }
      renderWallpaperSuggestChips(result.keywords, false);
      var ai = document.createElement('button');
      ai.type = 'button'; ai.className = 'wp-suggest-chip wp-suggest-ai'; ai.textContent = 'AI 联想';
      ai.addEventListener('click', function () { runWallpaperAiSuggest(text); });
      els.wpSuggest.appendChild(ai);
    }).catch(function () {
      if (seq === suggestSeq) { toast('AI 联想失败，已保留本地建议'); refreshWallpaperSuggest(); }
    });
  }

  function setWpStatus(text) {
    if (els.wpStatus) els.wpStatus.textContent = text;
  }

  /* 只加载进入视口附近的缩略图；首屏不再一次请求整页 24 张图。 */
  function loadWpThumb(btn, item) {
    if (btn.dataset.wpThumb || !item) return;
    btn.dataset.wpThumb = '1';
    var show = function (url) {
      btn.style.backgroundImage = 'url("' + url + '")';
      btn.classList.remove('is-loading');
    };
    var probe = new Image();
    probe.decoding = 'async';
    probe.referrerPolicy = 'no-referrer';
    probe.onload = function () {
      var decoded = probe.decode ? probe.decode().catch(function () {}) : Promise.resolve();
      decoded.then(function () { show(item.thumb); });
    };
    probe.onerror = function () {
      var full = new Image();
      full.decoding = 'async';
      full.referrerPolicy = 'no-referrer';
      full.onload = function () {
        var decoded = full.decode ? full.decode().catch(function () {}) : Promise.resolve();
        decoded.then(function () { show(item.image); });
      };
      full.onerror = function () { btn.classList.remove('is-loading'); };
      full.src = item.image;
    };
    probe.src = item.thumb;
  }

  function mountWpThumb(btn, item) {
    if (!('IntersectionObserver' in window)) { loadWpThumb(btn, item); return; }
    if (!wpThumbObserver) {
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          observer.unobserve(entry.target);
          loadWpThumb(entry.target, entry.target._wpItem);
        });
      }, { root: els.wpGrid, rootMargin: '180px 0px' });
      wpThumbObserver = observer;
    }
    btn._wpItem = item;
    wpThumbObserver.observe(btn);
  }

  /* 卡片跟随左列拉高后，壁纸墙只显示完整行：
     先算能放下几整行，再把剩余高度均摊进行距，避免最后一行被裁成半截。 */
  function fitWpGridRows() {
    var grid = els.wpGrid;
    var cell = grid && grid.firstElementChild;
    if (!cell) return;
    grid.style.rowGap = '';
    /* 单列布局下卡片按内容高度收尾，保持原来的滚动窗口，不做行距拉伸。 */
    if (window.matchMedia && window.matchMedia('(max-width: 900px)').matches) return;
    var cellHeight = 0;
    for (var i = 0; i < grid.children.length; i++) {
      cellHeight = Math.max(cellHeight, grid.children[i].getBoundingClientRect().height);
    }
    var available = grid.getBoundingClientRect().height;
    if (!cellHeight || !available) return;
    var baseGap = parseFloat(getComputedStyle(grid).rowGap) || 0;
    var rows = Math.max(1, Math.floor((available + baseGap) / (cellHeight + baseGap)));
    var extra = available - rows * cellHeight - (rows - 1) * baseGap;
    if (rows > 1 && extra > 0.5) {
      /* 行距上限 22px：高度很富余时保留一点底部留白，避免缩略图被拉得过散。 */
      grid.style.rowGap = Math.min(baseGap + extra / (rows - 1), 22).toFixed(2) + 'px';
    }
  }

  function scheduleWpGridFit() {
    clearTimeout(wpGridFitTimer);
    wpGridFitTimer = setTimeout(fitWpGridRows, 60);
  }

  function renderWpGrid() {
    if (wpThumbObserver) { wpThumbObserver.disconnect(); wpThumbObserver = null; }
    els.wpGrid.innerHTML = '';

    wpState.items.forEach(function (item) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wp-item is-loading';
      var sourceNames = { wallpic: 'Wallpic', tenwallpaper: '10wallpaper 中文', uhdpaper: 'UHD Paper', wallpapercave: 'Wallpaper Cave', bing: 'Bing', haowallpaper: '哲风', pexels: 'Pexels', unsplash: 'Unsplash', pixabay: 'Pixabay' };
      /* 有作者署名的图源（Pexels / Unsplash / Pixabay）用一条署名替代角标，
         避免两个标签在小缩略图上互相压盖。 */
      var credited = !!(item.author && item.authorUrl);
      if (!credited) {
        var badge = document.createElement('span'); badge.className = 'wp-source-badge'; badge.textContent = sourceNames[item.provider] || '高清图源'; badge.setAttribute('aria-hidden', 'true'); btn.appendChild(badge);
      }
      btn.title = item.title + (item.provider === 'uhdpaper' ? ' · 原生 ' + (item.resolution || '4K') : '');

      // 缩略图进入视口后再取；失败则退回原图（图床有防盗链，必须去掉 Referer）
      mountWpThumb(btn, item);

      btn.addEventListener('click', function () { applyOnlineWallpaper(item, btn); });
      if (item.author && item.authorUrl) {
        var tile = document.createElement('div'); tile.className = 'wp-photo-tile';
        var credit = document.createElement('a'); credit.className = 'wp-photo-credit';
        credit.textContent = item.author; credit.title = item.author + ' · ' + sourceNames[item.provider];
        credit.href = item.authorUrl; credit.target = '_blank'; credit.rel = 'noopener noreferrer';
        tile.append(btn, credit); els.wpGrid.appendChild(tile);
      } else els.wpGrid.appendChild(btn);
    });
    scheduleWpGridFit();
  }

  function syncWpPagination() {
    els.wpPrev.disabled = wpState.loading || wpState.page <= 1;
    els.wpMore.disabled = wpState.loading || !wpState.hasMore;
    els.wpPage.textContent = '第 ' + wpState.page + ' 页';
  }

  function loadWallpapers(reset, requestedPage) {
    if ((wpState.loading && !reset) || !window.WallpaperSource) return;
    var sequence = ++wpState.sequence;
    var page = Math.max(1, requestedPage || (reset ? 1 : wpState.page));
    if (reset) {
      wpState.items = [];
      wpState.hasMore = true;
      renderWpGrid();
    }
    wpState.loading = true;
    setWpStatus('正在加载第 ' + page + ' 页…');
    syncWpPagination();

    syncWallpaperProvider();
    window.WallpaperSource.list({ provider: settings.wallpaper.provider, query: wpState.query, page: page, keys: settings.wallpaper.keys, preference: settings.wallpaper.preference })
      .then(function (items) {
        if (sequence !== wpState.sequence) return;
        wpState.loading = false;
        /* 下一页没有数据时保留当前页，避免用户看到突然空掉的图库。 */
        if (!items.length && page > 1 && wpState.items.length && items.hasMore !== true) {
          wpState.hasMore = false;
          setWpStatus('已经是最后一页 · 本页 ' + wpState.items.length + ' 张');
          syncWpPagination();
          return;
        }
        wpState.page = page;
        wpState.items = items;
        wpState.hasMore = items.hasMore === undefined ? items.length >= window.WallpaperSource.pageSize : items.hasMore;
        renderWpGrid();
        var expansion = items.recommendation ? ' · 精选：' + items.recommendation : items.searchTerms && items.searchTerms.length > 1 ? ' · 扩展检索 ' + items.searchTerms.join(' / ') : '';
        var partial = items.sourceErrors && items.sourceErrors.length ? ' · 部分图源暂不可用' : '';
        setWpStatus(items.length
          ? '第 ' + page + ' 页 · 本页 ' + items.length + ' 张' + expansion + partial + '，点击在线使用'
          : items.hasMore ? '本页暂未匹配，可继续下一页' : '没有找到相关壁纸，可试试人物写真、模特或其他图源');
        syncWpPagination();
      })
      .catch(function (err) {
        if (sequence !== wpState.sequence) return;
        wpState.loading = false;
        setWpStatus(err && err.message === 'PHOTO_KEY_REQUIRED' ? '请填写自己的图库 API Key，或切换「全部高清图源」直接搜索' : err && err.message === 'PHOTO_KEY_INVALID' ? '图库 Key 无效或没有访问权限，请检查配置' : err && err.message === 'PHOTO_RATE_LIMIT' ? '图库请求额度暂时用完，请稍后重试或切换图源' : err && err.message === 'EMPTY'
          ? '没有找到相关壁纸'
          : '加载失败：请确认已作为扩展运行且网络可用');
        syncWpPagination();
      });
  }

  /** 用户点击后才申请 cookies 权限，并且只读取哲风的 userData Cookie。 */
  function importWallpaperToken() {
    // optional permissions 未授权前 chrome.cookies 不存在，不能在这里提前检查它。
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id ||
        !chrome.permissions || typeof chrome.permissions.request !== 'function') {
      toast('请在 Chrome 扩展中使用此按钮，或手动填写 Token');
      return;
    }

    els.wpAuth.disabled = true;
    var request;
    try {
      // 必须保持在点击事件的同步调用栈中，不能先跨异步再申请权限。
      request = chrome.permissions.request({ permissions: ['cookies'] });
    } catch (e) {
      els.wpAuth.disabled = false;
      toast('Cookie 权限申请失败，请手动填写 Token');
      return;
    }

    Promise.resolve(request).then(function (granted) {
      if (!granted) {
        els.wpAuth.disabled = false;
        toast('未授权读取 Cookie，可手动填写 Token');
        return;
      }
      if (!chrome.cookies || typeof chrome.cookies.get !== 'function') {
        els.wpAuth.disabled = false;
        toast('Cookie 接口仍未启用，请重新加载扩展后重试');
        return;
      }
      function finish(cookie) {
        var failed = chrome.runtime && chrome.runtime.lastError;
        var token = !failed && cookie
          ? window.WallpaperSource.tokenFromUserData(cookie.value)
          : '';
        els.wpAuth.disabled = false;
        if (!token) {
          toast('未读到哲风登录状态，请先登录本站后重试');
          return;
        }
        settings.wallpaper = settings.wallpaper || {};
        settings.wallpaper.token = token;
        els.wpToken.value = token;
        persist();
        toast('已读取登录状态，请重新点击壁纸下载原图');
      }

      chrome.cookies.get({
        url: 'https://haowallpaper.com/',
        name: 'userData'
      }, function (cookie) {
        var failed = chrome.runtime && chrome.runtime.lastError;
        if (cookie || failed) { finish(cookie); return; }
        // 用户也可能登录在 www 子域，host-only Cookie 需要按该 origin 再查一次。
        chrome.cookies.get({
          url: 'https://www.haowallpaper.com/',
          name: 'userData'
        }, finish);
      });
    }).catch(function () {
      els.wpAuth.disabled = false;
      toast('读取登录状态失败，请手动填写 Token');
    });
  }

  /* ------------------------- 使用历史 ------------------------- */
  var HISTORY_LIMIT = 12;

  function historyEntries() {
    if (!Array.isArray(settings.wallpaper.history)) settings.wallpaper.history = [];
    return settings.wallpaper.history;
  }

  function historyWhen(at) {
    if (!at) return '';
    var diff = Date.now() - Number(at);
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.max(1, Math.round(diff / 60000)) + ' 分钟前';
    if (diff < 86400000) return Math.round(diff / 3600000) + ' 小时前';
    var date = new Date(at);
    return (date.getMonth() + 1) + ' 月 ' + date.getDate() + ' 日';
  }

  /* 只记录在线图源的应用记录：本地图片已经在图库里，重复列出没有意义。 */
  function recordWallpaperHistory(item, got) {
    var key = item.sourceKey || ('haowallpaper:' + item.id);
    var entry = {
      key: key, provider: item.provider || 'haowallpaper',
      title: String(item.title || '在线壁纸').slice(0, 80),
      thumb: item.thumb || item.image || '', detail: item.detail || '',
      url: got.url, width: got.width || 0, height: got.height || 0,
      original: !!got.original, at: Date.now()
    };
    var list = historyEntries().filter(function (row) { return row.key !== key; });
    list.unshift(entry);
    settings.wallpaper.history = list.slice(0, HISTORY_LIMIT);
    persist();
    renderWpHistory();
  }

  function renderWpHistory() {
    if (!els.wpHistory || !els.wpHistoryWrap) return;
    var list = historyEntries();
    els.wpHistoryWrap.hidden = !list.length;
    els.wpHistory.innerHTML = '';
    list.forEach(function (entry) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'wp-history-item';
      button.title = entry.title + (entry.width && entry.height ? ' · ' + entry.width + '×' + entry.height : '');
      var shot = document.createElement('span');
      shot.className = 'wp-history-shot';
      if (entry.thumb) shot.style.backgroundImage = 'url("' + entry.thumb + '")';
      var when = document.createElement('span');
      when.className = 'wp-history-when';
      when.textContent = historyWhen(entry.at);
      button.append(shot, when);
      button.addEventListener('click', function () { reuseHistoryEntry(entry); });
      els.wpHistory.appendChild(button);
    });
    scheduleWpGridFit();
  }

  /* 历史条目自带已解析的地址，恢复时不再请求图源，秒回。 */
  function reuseHistoryEntry(entry) {
    settings.bg.mode = 'url';
    settings.bg.url = entry.url;
    settings.bg.online = {
      url: entry.url, width: entry.width, height: entry.height, original: !!entry.original,
      provider: entry.provider, sourceKey: entry.key, id: entry.key, detail: entry.detail,
      title: entry.title, author: '', authorUrl: '', originalUrl: ''
    };
    els.urlInput.value = entry.url;
    persist(); applyBackground(); syncActive();
    toast('已恢复历史背景' + (entry.width && entry.height ? ' · ' + entry.width + '×' + entry.height : ''));
  }

  function measureWallpaper(got) {
    if ((got.width && got.height) || typeof createImageBitmap !== 'function') {
      return Promise.resolve(got);
    }
    return createImageBitmap(got.blob).then(function (bmp) {
      got.width = bmp.width;
      got.height = bmp.height;
      bmp.close && bmp.close();
      return got;
    }).catch(function () { return got; });
  }

  function wallpaperError(error) {
    var messages = { UHD_LOW_RESOLUTION: '返回的图片不足 4K，已保留当前背景，请换一张', UHD_NOT_IMAGE: '图源没有返回可用原图，请换一张重试', UHD_TIMEOUT: '原图加载超时，已保留当前背景，请重试', UHD_CANNOT_VERIFY: '当前浏览器无法校验原图，请更新 Chrome', UHD_ORIGINAL_UNAVAILABLE: '此壁纸的 4K 原图暂不可用，请换一张' };
    return messages[error && error.message] || '图片加载失败，请重试；当前背景已保留';
  }
  async function applyOnlineWallpaper(item, btn) {
    var sequence = ++wallpaperApplySequence;
    if (btn) btn.classList.add('is-applying');
    try {
      var key = item.sourceKey || 'haowallpaper:' + item.id;
      var current = settings.bg.online;
      var got = current && current.sourceKey === key && current.url === settings.bg.url && settings.bg.mode === 'url' ? current
        : await WallpaperSource.resolveImage(item, { token: settings.wallpaper.token, keys: settings.wallpaper.keys });
      if (sequence !== wallpaperApplySequence) return;
      settings.bg.online = { url: got.url, width: got.width, height: got.height, original: !!got.original,
        provider: item.provider || 'haowallpaper', sourceKey: key, id: item.id, detail: item.detail, title: item.title, author: item.author || '', authorUrl: item.authorUrl || '', originalUrl: item.originalUrl || '' };
      settings.bg.mode = 'url'; settings.bg.url = got.url;
      els.urlInput.value = got.url; persist(); applyBackground(); syncActive();
      recordWallpaperHistory(item, got);
      toast('已在线应用' + (got.original ? '高清原图' : '预览') + ' · ' + got.width + '×' + got.height);
    } catch (e) { if (sequence === wallpaperApplySequence) toast(wallpaperError(e)); }
    finally { if (btn) btn.classList.remove('is-applying'); }
  }

  function saveWallpaperOffline(item, btn) {
    if (btn) btn.classList.add('is-loading');
    var token = settings.wallpaper && settings.wallpaper.token
      ? settings.wallpaper.token.trim()
      : '';
    var sourceKey = item.sourceKey || 'haowallpaper:' + item.id;
    var cached = null;
    toast('正在检查离线缓存…');

    return ImageStore.findBySource(sourceKey).then(function (row) {
      cached = row;
      // 已有原图始终直接复用；没有 Token 时也不重复下载公开预览。
      var reusable = item.provider !== 'haowallpaper'
        ? row && row.original && row.width >= 3840 && row.height >= 2160
        : row && (row.original || !token);
      if (reusable) {
        return {
          id: row.id, cached: true, original: !!row.original,
          width: row.width, height: row.height
        };
      }

      toast(item.provider !== 'haowallpaper' ? '正在下载并校验 4K / 8K 原图…' : token ? '正在下载高清原图…' : '正在下载壁纸预览…');
      return window.WallpaperSource.fetchImage(item, { token: token, resolved: item.resolved })
        .then(measureWallpaper)
        .then(function (got) {
          // 在线图片直接保存站点原始 Blob，绝不做二次 JPEG 压缩。
          var meta = {
            sourceKey: sourceKey,
            provider: item.provider || 'haowallpaper',
            detailUrl: item.detail || '',
            original: !!got.original,
            width: got.width || 0,
            height: got.height || 0
          };
          if (cached) {
            meta.id = cached.id;
            meta.createdAt = cached.createdAt;
          }
          return ImageStore.add(got.blob, item.title, meta).then(function (id) {
            return {
              id: id, cached: false, original: !!got.original,
              originalError: got.originalError || '',
              originalStage: got.originalStage || '',
              originalHost: got.originalHost || '',
              width: got.width, height: got.height
            };
          });
        });
    }).then(function (result) {
      renderGallery();
      var size = result.width && result.height
        ? ' · ' + result.width + '×' + result.height
        : '';
      if (result.cached) {
        toast('已使用离线缓存' + (result.original ? ' · 原图' : ' · 预览') + size);
      } else if (result.original) {
        toast('已保存到离线图库 · 原图' + size);
      } else if (result.originalError === 'AUTH_REQUIRED') {
        toast('Token 无效或已过期，已使用公开预览' + size);
      } else if (result.originalError) {
        var reason = result.originalError === 'NOT_STATIC_IMAGE'
          ? '动态壁纸或图片格式不支持'
          : result.originalError;
        var where = result.originalStage ? result.originalStage : '处理';
        var host = result.originalHost ? '（' + result.originalHost + '）' : '';
        toast('原图' + where + '失败' + host + '：' + reason + '；已使用公开预览' + size, 6000);
      } else {
        toast('已应用并缓存公开预览' + size);
      }
    }).catch(function (err) {
      toast(wallpaperError(err));
    }).then(function () {
      if (btn) btn.classList.remove('is-loading');
    });
  }

  /* ------------------------- 图片导入 ------------------------- */
  /** 仅在本地图片超过 8K 时等比缩小；其余情况保留原文件与原始编码 */
  function normalizeImage(file) {
    return new Promise(function (resolve) {
      if (typeof createImageBitmap !== 'function') { resolve(file); return; }
      createImageBitmap(file).then(function (bmp) {
        var max = 7680;
        var scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
        // 文件大不等于需要重压缩。无需缩小时直接保留原图，
        // 避免把 PNG / WebP 重新编码成 JPEG 后损失细节和透明通道。
        if (scale >= 1) {
          bmp.close && bmp.close();
          resolve(file);
          return;
        }
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bmp.width * scale));
        canvas.height = Math.max(1, Math.round(bmp.height * scale));
        var ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        bmp.close && bmp.close();
        canvas.toBlob(function (blob) {
          resolve(blob || file);
        }, 'image/jpeg', 0.9);
      }).catch(function () { resolve(file); });
    });
  }

  function handleFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast('请选择图片文件'); return; }
    toast('正在处理图片…');
    normalizeImage(file).then(function (blob) {
      return ImageStore.add(blob, file.name || '图片');
    }).then(function (id) {
      settings.bg.mode = 'image';
      settings.bg.imageId = id;
      persist();
      applyBackground();
      renderGallery();
      syncActive();
      toast('背景已更新');
    }).catch(function () {
      toast('图片保存失败');
    });
  }

  /* ------------------------- 搜索 ------------------------- */
  function looksLikeUrl(q) {
    return /^[\w-]+(\.[\w-]+)+([\/?#].*)?$/.test(q) && q.indexOf(' ') === -1;
  }

  /* ------------------------- 书签检索 ------------------------- */
  var DOT_COLORS = ['#5b9cf5', '#3fb99a', '#a78bfa', '#e0a34a', '#e07a8b', '#4fb3c9'];
  var AC_LIMIT = 8;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function dotColor(seed) {
    var h = 0;
    var s = String(seed || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return DOT_COLORS[h % DOT_COLORS.length];
  }

  function relTime(ms) {
    if (!ms) return '';
    var d = Math.floor((Date.now() - ms) / 864e5);
    if (d <= 0) return '今天';
    if (d === 1) return '昨天';
    if (d < 7) return d + ' 天前';
    if (d < 30) return Math.floor(d / 7) + ' 周前';
    if (d < 365) return Math.floor(d / 30) + ' 个月前';
    return Math.floor(d / 365) + ' 年前';
  }

  /**
   * 读书签并拍平成索引行。
   * 新标签页本身是扩展页面、拥有 bookmarks 权限，直接读比走消息快得多；
   * 合并独立保存的页面内容；后台独立维护书签元数据，页面不反向覆盖它。
   */
  function loadBookmarks() {
    if (typeof chrome === 'undefined' || !chrome.bookmarks || !Bookmarks) return;

    chrome.bookmarks.getTree(async function (tree) {
      if (chrome.runtime.lastError) return;
      bmRows = Bookmarks.flatten(tree);
      await ContentIndex.hydrate(bmRows);
      var classes = await Organizer.records(bmRows);
      bmRows.forEach(function (row) { if (classes[row.id]) row.hay += ' ' + classes[row.id].tags.join(' ').toLowerCase(); });
      if (typeof BookmarkEnrich !== 'undefined') await BookmarkEnrich.applySummaries(bmRows);
      bmReady = true;
      if (suggest) suggest.invalidate();      /* 书签变了，旧的联想缓存不能再用 */
      /* 管理页正开着时同步刷新候选，避免书签变动后列表停在旧数据 */
      if (tagManager && !$('#workspace-tags').hidden) tagManager.refresh();
      if (document.activeElement === els.searchInput) onInput();
    });
  }

  /** 常访站点：浏览器自己统计的访问频次，不用申请 history 权限 */
  function loadTopSites() {
    if (typeof chrome === 'undefined' || !chrome.topSites || !chrome.topSites.get) return;
    try {
      chrome.topSites.get(function (items) {
        if (chrome.runtime && chrome.runtime.lastError) return;
        tagTopSites = Array.isArray(items) ? items : [];
        if (isTagMode() && document.activeElement === els.searchInput) refreshTagPanel();
      });
    } catch (e) { /* 未授权时静默降级：只用书签候选 */ }
  }

  /* 中文输入法常打出全角问号/斜杠，前缀识别必须同时接受半角与全角。 */
  var PREFIX_MODE = { '?': '?', '？': '?', '/': '/', '／': '/', '@': '@', '＠': '@' };

  function prefixMode() {
    return PREFIX_MODE[els.searchInput.value.trim().charAt(0)] || '';
  }

  function isAIMode() {
    return prefixMode() === '?';
  }

  function isBookmarkMode() {
    return prefixMode() === '/';
  }

  /** @ 只在首字符触发：@ 在 Gmail / 微博里是 handle 前缀，任意位置触发会打断正常搜索 */
  function isTagMode() {
    if (!settings || !settings.tags || !settings.tags.enabled) return false;
    return prefixMode() === '@';
  }

  function queryText() {
    return els.searchInput.value.trim().replace(/^[?？\/／@＠]+/, '').trim();
  }

  function engineLabel() {
    return (ENGINES[settings.engine] || ENGINES.bing).label;
  }

  /** 输入框外观跟模式联动：/ 检索书签，? 使用 AI，@ 快捷标签，其余输入直接搜索网页 */
  function applyMode() {
    var ai = isAIMode();
    var bookmark = isBookmarkMode();
    var tag = isTagMode();
    els.searchForm.classList.toggle('is-ai', ai);
    els.searchForm.classList.toggle('is-bookmarks', bookmark && !ai);
    els.searchForm.classList.toggle('is-tags', tag && !ai && !bookmark);
    els.engineChip.textContent = ai ? 'AI' : bookmark ? '书签' : tag ? '标签' : engineLabel();
  }

  function clearPanel() {
    aiSeq++;
    cancelAI();
    aiBusy = false;
    acHits = [];
    acActions = [];
    acBanner = '';
    resetAnswer();
    acIndex = -1;
    tagGroups = { pinned: [], ai: [], candidates: [] };
    tagCreate = null;
    if (suggest) suggest.cancel();       /* 作废在途联想，避免收起后又弹回来 */
    suggestState = { status: 'idle', query: '', items: [] };
    els.acPanel.classList.remove('is-open');
    els.acPanel.innerHTML = '';
  }

  /** 输入变化的统一入口：/ 模式即时检索书签，@ 模式匹配标签，AI 模式只等回车 */
  function onInput() {
    applyMode();

    /* 输入法组合期间不重算候选，否则中文拼音中间态会让列表来回跳 */
    if (composing) return;

    if (isAIMode()) {
      aiSeq++;              /* 作废进行中的请求 */
      cancelAI();
      aiBusy = false;
      resetAnswer();
      var q = queryText();
      acHits = [];
      acActions = q ? [{ q: q, ai: true }] : [];
      acIndex = q ? 0 : -1;
      acBanner = q
        ? '描述内容、用途或收藏时间，回车在书签中查找'
        : '例如：之前收藏的那个在线压缩图片工具';
      renderPanel();
      return;
    }

    if (!isBookmarkMode()) {
      if (isTagMode()) { refreshTagPanel(); return; }
      refreshSuggest();
      return;
    }

    refreshPanel();
  }

  function refreshPanel() {
    aiSeq++;
    cancelAI();
    aiBusy = false;
    acHits = [];
    acActions = [];
    resetAnswer();
    acIndex = -1;
    acBanner = '';

    /* 普通搜索绝不展示书签候选，避免回车被第一条书签截获 */
    if (!isBookmarkMode()) { clearPanel(); return; }

    var q = queryText();
    if (!q) {
      acBanner = '输入关键词检索书签';
      renderPanel();
      return;
    }
    if (!bmReady) {
      acBanner = '书签加载中…';
      renderPanel();
      return;
    }

    acHits = Bookmarks.query(bmRows, q, AC_LIMIT, Date.now());
    acIndex = acHits.length ? 0 : -1;
    acBanner = acHits.length ? '' : '没有匹配书签，可在「书签空间」同步内容，或用 ? 描述要找的内容';

    renderPanel();
  }

  /* ------------------------- 普通搜索联想（全网） -------------------------
     与 / 书签检索共用同一个 ac-panel 管线，但候选来源不同：
       · 普通输入 = 当前搜索引擎的联想接口，输入会发给对应引擎
       · / = 纯本地书签检索，不联网
       · 空输入聚焦时只展示本机的「最近搜索」，不发请求
     130ms 防抖，只认最后一次输入，过期响应直接丢弃；
     面板状态：idle（空输入/最近搜索）→ loading → ready | empty | error。 */

  var ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.2 4.2"/></svg>';

  function isSuggestMode() {
    return !isAIMode() && !isBookmarkMode() && !isTagMode();
  }

  function suggestEnabled() {
    return !!(settings && (!settings.suggest || settings.suggest.enabled !== false));
  }

  /** 普通模式不剥前缀：@ 关闭后它就是一个普通字符 */
  function suggestQuery() {
    return els.searchInput.value.trim();
  }

  function ensureSuggest() {
    if (suggest) return suggest;
    if (typeof SearchSuggest === 'undefined') return null;

    try { suggestRecent = SearchSuggest.createRecent(localStorage); }
    catch (e) { suggestRecent = null; }

    suggest = SearchSuggest.createSession({
      delay: 130,
      limit: 8,
      onState: function (state) {
        if (!isSuggestMode()) return;      /* 模式已切换，别抢面板 */
        renderSuggest(state);
      },
      providers: [
        { id: 'web', run: requestWebSuggest }
      ]
    });
    return suggest;
  }

  /**
   * 全网联想：请求当前搜索引擎的建议词；失败时（离线、接口变更、被墙）
   * 退到必应并标注来源，避免用户以为联想坏了。
   * 输入内容会发给对应引擎的联想接口——这是全网联想的必要代价；
   * 纯本地的书签检索仍由 / 提供。
   */
  function requestWebSuggest(q) {
    var engine = settings.engine || 'bing';
    var fail = function () { throw new Error('suggest_failed'); };

    var ask = function (name) {
      return SearchSuggest.request({ engine: name, query: q }).then(function (list) {
        return (list || []).map(function (text) {
          return { kind: 'query', text: text, source: 'web', score: 60 };
        });
      });
    };

    return ask(engine).then(function (items) {
      return items;
    }, function () {
      if (engine === 'bing') return fail();
      return ask('bing').then(function (items) {
        suggestNote = '必应联想 · ' + engineLabel() + '联想不可用';
        return items;
      }, fail);
    });
  }

  function refreshSuggest() {
    if (!suggestEnabled() || !isSuggestMode()) { clearPanel(); return; }
    var engine = ensureSuggest();
    if (!engine) { clearPanel(); return; }

    /* @ 关了以后它仍是账号前缀：不做全网联想，避免为一句 handle 发请求 */
    if (/^[@＠]/.test(els.searchInput.value.trim())) { clearPanel(); return; }

    suggestNote = '';
    var q = suggestQuery();
    if (!q) { engine.cancel(); renderSuggestRecent(); return; }
    engine.update(q);
  }

  /** 换引擎后旧建议词要全部作废，否则还会显示上一个引擎的结果 */
  function resetSuggestForEngine() {
    suggestNote = '';
    if (!suggest) return;
    suggest.invalidate();
    if (document.activeElement === els.searchInput && isSuggestMode() && suggestQuery()) refreshSuggest();
  }

  /** 空输入聚焦时给出最近搜索，而不是一个空面板 */
  function renderSuggestRecent() {
    if (!ensureSuggest()) { clearPanel(); return; }
    var items = SearchSuggest.fromRecent(suggestRecent.list(), '', 5);
    if (!items.length) { clearPanel(); return; }
    renderSuggest({ status: 'recent', query: '', items: items });
  }

  /** 删除单条最近搜索；删空后面板自动收起 */
  function removeRecentAt(i) {
    var item = acHits[i];
    if (!suggestRecent || !item || item.source !== 'recent') return;
    suggestRecent.remove(item.text);
    renderSuggestRecent();
  }

  function markHtml(text, q) {
    if (typeof SearchSuggest === 'undefined') return esc(text);
    return SearchSuggest.segments(text, q).map(function (part) {
      return part.hit ? '<mark class="ac-hl">' + esc(part.text) + '</mark>' : esc(part.text);
    }).join('');
  }

  function sourceLabel(item) {
    if (item.source === 'recent') {
      return '最近搜索' + (item.hits > 1 ? ' · 用过 ' + item.hits + ' 次' : '');
    }
    return '';
  }

  /**
   * 联想面板。复用 acHits / acActions 两个槽位，方向键与回车逻辑不必写第二套：
   * 候选 = acHits，末尾的「用 X 搜索」= acActions[0]。
   * keepSelection：方向键移动时重新渲染要保留当前选中项。
   */
  function renderSuggest(state, keepSelection) {
    suggestState = state;
    resetAnswer();

    var q = state.query || '';
    var items = state.items || [];
    var loading = state.status === 'loading';

    acHits = items;
    acActions = q ? [{ q: q }] : [];
    if (!keepSelection) acIndex = -1;     /* 默认不选中：回车搜当前输入，按 ↓ 才进入候选 */
    var total = acHits.length + acActions.length;
    if (acIndex >= total) acIndex = total - 1;
    acBanner = '';

    var html = '';

    if (loading) html += '<div class="ac-head">正在联想…</div>';
    else if (state.status === 'recent') html += '<div class="ac-head">最近搜索 · ↑↓ 选择</div>';
    else if (state.status === 'ready') {
      var from = suggestNote || engineLabel() + '联想';
      html += '<div class="ac-head">' + esc(from) + ' · ↑↓ 选择，回车搜索</div>';
    }

    if (loading) {
      for (var k = 0; k < 3; k++) {
        html += '<div class="ac-skel" aria-hidden="true"><i></i><b style="width:' + (44 + k * 14) + '%"></b></div>';
      }
    }

    items.forEach(function (item, i) {
      var sub = sourceLabel(item);

      html += '<div class="ac-item' + (i === acIndex ? ' is-sel' : '') + '" data-i="' + i + '" role="option" aria-selected="false">' +
        '<span class="ac-glyph">' + ICON_SEARCH + '</span>' +
        '<div class="ac-body">' +
          '<div class="ac-title">' + markHtml(item.text, q) + '</div>' +
          (sub ? '<div class="ac-sub">' + esc(sub) + '</div>' : '') +
        '</div>' +
        (item.source === 'recent'
          ? '<span class="ac-pill is-icon ac-del" role="button" title="删除这条搜索记录" data-del="' + i + '">×</span>'
          : '') +
      '</div>';
    });

    if (state.status === 'empty') {
      html += '<div class="ac-empty">' + ICON_SEARCH +
        '<strong>没有找到「' + esc(q) + '」的联想</strong>' +
        '<span>回车直接用 ' + esc(engineLabel()) + ' 搜索，或换个更短的关键词</span>' +
      '</div>';
    }

    if (state.status === 'error') {
      html += '<div class="ac-empty is-err">' + ICON_SEARCH +
        '<strong>联想暂时不可用</strong>' +
        '<span>网络或接口异常，回车仍可直接用 ' + esc(engineLabel()) + ' 搜索</span>' +
      '</div>';
    }

    if (q) {
      if (items.length) html += '<div class="ac-sep"></div>';
      html += '<div class="ac-act' + (acIndex === acHits.length ? ' is-sel' : '') + '" data-a="0" role="option" aria-selected="' + (acIndex === acHits.length) + '">' + ICON_SEARCH +
        '<span>用 ' + esc(engineLabel()) + ' 搜索 “' + esc(q) + '”</span>' +
        '<kbd class="ac-kbd">↵</kbd>' +
      '</div>';
    }

    els.acPanel.setAttribute('aria-label', '搜索联想');
    els.acPanel.setAttribute('aria-busy', loading ? 'true' : 'false');
    els.acPanel.innerHTML = html;
    els.acPanel.classList.add('is-open');
  }

  /* ------------------------- 快捷标签（@） -------------------------
     手动标签是"人的决定"，落库保存；自动候选是"活的信号"，每次输入即时重算。
     面板结构：固定区（手写顺序）→ 常用区（系统推荐）→ 新建行。 */

  function refreshTagPanel(options) {
    options = options || {};
    aiSeq++;
    cancelAI();
    resetAnswer();
    aiBusy = false;
    acActions = [];
    acBanner = '';
    acIndex = -1;

    if (!tagReady) {
      acHits = [];
      tagCreate = null;
      tagGroups = { pinned: [], ai: [], candidates: [] };
      acBanner = '标签加载中…';
      acIndex = -1;
      renderTagPanel();
      return;
    }

    var q = queryText();
    var ctx = { rows: bmRows, topSites: tagTopSites };
    var aiCfg = settings && settings.tags && settings.tags.aiSuggest === false ? null : (settings && settings.ai);
    var extras = typeof TagSuggest !== 'undefined'
      ? TagSuggest.entries(ctx, aiCfg)
      : [];

    var prev = options.preserveSelection && acHits[acIndex] && acHits[acIndex].tag;
    var prevId = prev ? prev.id : '';
    var prevUrl = prev ? prev.url : '';

    tagGroups = QuickTags.search(q, ctx, extras);
    tagCreate = QuickTags.createCandidate(q);

    /* 复用现有 acHits 管线：视觉顺序与键盘顺序必须一致 */
    acHits = tagGroups.pinned.concat(tagGroups.ai).concat(tagGroups.candidates).map(function (e) {
      return { tag: e, row: { title: e.label, url: e.url, host: e.host, site: e.label } };
    });
    if (tagCreate) {
      acHits.push({
        create: true,
        tag: tagCreate,
        row: { title: tagCreate.label, url: tagCreate.url, host: tagCreate.host, site: tagCreate.label }
      });
    }

    if (prevId || prevUrl) {
      acIndex = -1;
      for (var i = 0; i < acHits.length; i++) {
        var t = acHits[i].tag;
        if (!t) continue;
        if ((prevId && t.id === prevId) || (prevUrl && t.url === prevUrl)) { acIndex = i; break; }
      }
    }
    if (acIndex < 0 || acIndex >= acHits.length) {
      /* 输入完整地址 = 明确想创建，默认选中新建条目；否则选第一条 */
      acIndex = tagCreate ? acHits.length - 1 : (acHits.length ? 0 : -1);
    }

    renderTagPanel();

    /* AI 推荐：先用缓存渲染，过期时后台刷新，不阻塞当前输入 */
    if (typeof TagSuggest !== 'undefined' && settings && settings.tags && settings.tags.aiSuggest !== false) {
      TagSuggest.ensure(ctx, settings.ai).then(function (updated) {
        if (!updated) return;
        if (!isTagMode() || document.activeElement !== els.searchInput) return;
        refreshTagPanel({ preserveSelection: true });
      });
    }
  }

  function renderTagPanel() {
    var q = queryText();
    var html = '';
    var idx = 0;

    if (acBanner) html += '<div class="ac-head">' + esc(acBanner) + '</div>';

    if (tagGroups.pinned.length) {
      html += '<div class="ac-head">固定 · 按使用频率</div>';
      tagGroups.pinned.forEach(function (e) {
        var sub = e.host + (e.hits ? ' · 用过 ' + e.hits + ' 次' : '');
        html += '<div class="ac-item' + (idx === acIndex ? ' is-sel' : '') + '" data-i="' + idx + '" role="option">' +
          '<span class="ac-idx">' + (idx + 1) + '</span>' +
          '<div class="ac-body">' +
            '<div class="ac-title">' + esc(e.label) + '</div>' +
            '<div class="ac-sub">' + esc(sub) + '</div>' +
          '</div>' +
          '<span class="ac-pill is-icon" role="button" title="删除这个标签" data-act="del" data-id="' + esc(e.id) + '">×</span>' +
        '</div>';
        idx++;
      });
    }

    if (tagGroups.ai.length) {
      html += '<div class="ac-sec">AI 推荐</div>';
      tagGroups.ai.forEach(function (e) {
        html += '<div class="ac-item' + (idx === acIndex ? ' is-sel' : '') + '" data-i="' + idx + '" role="option">' +
          '<span class="ac-dot" style="background:' + dotColor(e.host) + '"></span>' +
          '<div class="ac-body">' +
            '<div class="ac-title">' + esc(e.label) + '<span class="ac-badge">AI</span></div>' +
            '<div class="ac-sub">' + esc(e.host) + '</div>' +
          '</div>' +
          '<span class="ac-pill" role="button" title="固定为快捷标签" data-act="pin" data-id="' + esc(e.id) + '">固定</span>' +
        '</div>';
        idx++;
      });
    }

    if (tagGroups.candidates.length) {
      html += '<div class="ac-sec">' + (q ? '相关推荐' : '常用 · 按使用频率') + '</div>';
      tagGroups.candidates.forEach(function (e) {
        html += '<div class="ac-item' + (idx === acIndex ? ' is-sel' : '') + '" data-i="' + idx + '" role="option">' +
          '<span class="ac-dot" style="background:' + dotColor(e.host) + '"></span>' +
          '<div class="ac-body">' +
            '<div class="ac-title">' + esc(e.label) + '</div>' +
            '<div class="ac-sub">' + esc(e.host) + '</div>' +
          '</div>' +
          '<span class="ac-pill" role="button" title="固定为快捷标签" data-act="pin" data-id="' + esc(e.id) + '">固定</span>' +
        '</div>';
        idx++;
      });
    }

    if (tagCreate) {
      html += '<div class="ac-item is-create' + (idx === acIndex ? ' is-sel' : '') + '" data-i="' + idx + '" role="option">' +
        '<span class="ac-idx">＋</span>' +
        '<div class="ac-body">' +
          '<div class="ac-title">把「' + esc(tagCreate.label) + '」创建为快捷标签</div>' +
          '<div class="ac-sub">' + esc(tagCreate.host) + ' · 回车立即创建并打开</div>' +
        '</div>' +
        '<span class="ac-pill" role="button" title="创建快捷标签" data-act="create">新建</span>' +
      '</div>';
      idx++;
    }

    if (!tagGroups.pinned.length && !tagGroups.ai.length && !tagGroups.candidates.length && !tagCreate && !acBanner) {
      html += '<div class="ac-head">' + (q ? '没有匹配的标签' : '还没有快捷标签') + '</div>';
    }

    if (!tagCreate) {
      html += '<div class="ac-sep"></div>';
      html += '<div class="ac-act" data-new="1">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
          '<path d="M12 5v14M5 12h14"/></svg>' +
        '<span>' + (q ? '把「' + esc(q) + '」创建为快捷标签需要完整网址' : '输入网址即可创建，例如 oa.hongdi.com') + '</span>' +
      '</div>';
    }

    els.acPanel.innerHTML = html;
    els.acPanel.classList.add('is-open');
  }

  function tagEntryById(id) {
    var all = tagGroups.pinned.concat(tagGroups.ai).concat(tagGroups.candidates);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  /* 面板内的鼠标动作：固定 / 删除 / 新建，不打断输入框焦点 */
  function tagAction(act, id) {
    if (act === 'create') { createTagFromQuery(); return; }

    var entry = tagEntryById(id);
    if (!entry) return;

    if (act === 'pin') {
      var res = QuickTags.add({ url: entry.url, label: entry.label });
      if (!res.ok) { toast(res.error === 'full' ? '标签已满，先删掉几个' : '这个地址无法设为标签'); return; }
      toast('已固定「' + res.tag.label + '」');
      QuickTags.flush();
      refreshTagPanel();
      return;
    }

    if (act === 'del') {
      if (entry.kind === 'manual') {
        QuickTags.remove(entry.id);
        toast('已删除「' + entry.label + '」');
      } else {
        var n = QuickTags.dismiss(entry);
        toast(n >= QuickTags.LIMITS.DISMISS_LIMIT ? '不再推荐这个站点' : '已隐藏，重复隐藏 ' + n + '/' + QuickTags.LIMITS.DISMISS_LIMIT + ' 次后不再出现');
      }
      refreshTagPanel();
    }
  }

  /** 回车在没有候选时也能建标签：@oa.hongdi.com → 新建并跳转 */
  async function createTagFromQuery() {
    if (creatingTag) return;
    var q = queryText();
    if (!q) { toast('在 @ 后面输入网址'); return; }

    creatingTag = true;
    try {
      /* 必须等读盘完成再写：否则读回的旧状态会覆盖刚建的标签 */
      if (!tagReady) {
        await QuickTags.load();
        tagReady = true;
      }

      var res = QuickTags.add({ url: q });
      if (!res.ok) {
        toast(res.error === 'full' ? '标签已满，先删掉几个' : '请把网址写完整，例如 oa.hongdi.com');
        renderTagPanel();
        return;
      }
      QuickTags.touch({ kind: 'manual', id: res.tag.id });
      toast(res.existed ? '已存在，直接打开' : '已创建「' + res.tag.label + '」');

      /* 页面马上要卸载，防抖写入会被取消，必须显式落盘 */
      await QuickTags.flush();
      location.href = res.tag.url;
    } finally {
      creatingTag = false;
    }
  }

  /** 当前账号的 RAG 代理配置：固定后台地址 + 会话令牌 + 服务端集合 */
  function ragCfg() {
    return (typeof Rag !== 'undefined' && Rag.withAuth)
      ? Rag.withAuth(settings.rag, settings.backup)
      : settings.rag;
  }

  async function runAI() {
    if (aiBusy) return;
    var q = queryText();
    if (!q || !bmReady) {
      acBanner = q ? '书签加载中…' : '在问号后面描述你要找的内容';
      renderPanel();
      return;
    }
    var cfg = settings.ai;
    if (!AI.available(cfg) && !(typeof Rag !== 'undefined' && Rag.available(ragCfg()))) {
      acHits = Bookmarks.query(bmRows, q, AC_LIMIT);
      acActions = [{ q: q }];
      acIndex = 0;
      acBanner = '请先在左下角登录账号（启用 RAG），或在设置里配置 AI';
      resetAnswer();
      renderPanel();
      return;
    }
    var seq = ++aiSeq;
    cancelAI();
    aiController = new AbortController();
    var signal = aiController.signal;
    aiBusy = true;
    resetAnswer();
    acActions = [{ q: q }];
    try {
      var mid = await memoryPick(q);
      if (seq !== aiSeq) return;
      if (AI.available(cfg) && typeof AgentDB !== 'undefined') {
        await AgentDB.setMeta('ai:foreground', { seq: seq, until: Date.now() + 25000 });
      }
      var result = await BookmarkSearch.run({
        rows: bmRows, query: q, cfg: cfg, rag: ragCfg(), signal: signal, memoryId: mid,
        current: function () { return seq === aiSeq; },
        onAnswer: function (partial) { if (seq === aiSeq) applyStreamingAnswer(partial); },
        progress: function (message, hits) {
          if (seq !== aiSeq) return;
          acHits = hits.slice(0, AC_LIMIT);
          acIndex = 0;
          acBanner = message;
          renderPanel();
        }
      });
      if (!result || seq !== aiSeq) return;
      aiCands = result.candidates;
      acHits = result.hits.slice(0, AC_LIMIT);
      acActions = [];
      if (aiCands.length) acActions.push({ q: q, local: true });
      acActions.push({ q: q });
      acIndex = 0;
      acBanner = result.message;
      clearTimeout(answerRenderTimer);
      answerRenderTimer = 0;
      aiAnswer = result.answer || null;
    } catch (e) {
      if (seq !== aiSeq) return;
      acHits = Bookmarks.query(bmRows, q, AC_LIMIT);
      acActions = [{ q: q }];
      acIndex = 0;
      acBanner = 'AI 暂不可用 · 已按本地排序显示';
      resetAnswer();
    } finally {
      if (typeof AgentDB !== 'undefined') AgentDB.updateMeta('ai:foreground', function (active) {
        return active && active.seq === seq ? null : active;
      }).catch(function () {});
      if (seq === aiSeq) { aiController = null; aiBusy = false; renderPanel(); }
    }
  }

  /* ------------------------- 选择记忆 ------------------------- */
  /* 记「这句意图最后打开了哪条」。同一句意图再来时告诉模型，让它越用越准 */
  var PICKS_META = 'picks';
  var PICKS_MAX = 200;

  function memKey(q) {
    return String(q || '').trim().toLowerCase().slice(0, 60);
  }

  function readPicks() {
    if (typeof AgentDB === 'undefined') return Promise.resolve({});
    return AgentDB.getMeta(PICKS_META)
      .then(function (m) { return m || {}; })
      .catch(function () { return {}; });
  }

  function recordPick(query, id) {
    if (!query || !id || typeof AgentDB === 'undefined') return Promise.resolve();
    return readPicks().then(function (all) {
      var k = memKey(query);
      all[k] = all[k] || {};
      all[k][id] = (all[k][id] || 0) + 1;
      all[k].__t = Date.now();

      var keys = Object.keys(all);
      if (keys.length > PICKS_MAX) {
        keys.sort(function (a, b) { return (all[a].__t || 0) - (all[b].__t || 0); });
        keys.slice(0, keys.length - PICKS_MAX).forEach(function (old) { delete all[old]; });
      }
      return AgentDB.setMeta(PICKS_META, all);
    }).catch(function () {});
  }

  function memoryPick(query) {
    return readPicks().then(function (all) {
      var slot = all[memKey(query)];
      if (!slot) return '';
      var best = '';
      var top = 0;
      Object.keys(slot).forEach(function (id) {
        if (id === '__t') return;
        if (slot[id] > top) { top = slot[id]; best = id; }
      });
      return best;
    }).catch(function () { return ''; });
  }

  /* ------------------------- AI 设置 ------------------------- */
  function readAIConfig() {
    return {
      enabled: els.swAi.checked,
      baseUrl: els.aiBase.value.trim(),
      apiKey: els.aiKey.value.trim(),
      model: els.aiModel.value.trim(),
      fastModel: els.aiFastModel.value.trim(),
      strongModel: els.aiStrongModel.value.trim(),
      timeout: 12000
    };
  }

  function setAIStatus(text, isErr) {
    els.aiStatus.textContent = text || '';
    els.aiStatus.style.color = isErr ? 'rgba(255,150,150,0.9)' : 'rgba(150,225,175,0.9)';
  }

  function persistAI() {
    settings.ai = Object.assign({}, settings.ai, readAIConfig());
    persist();
    if (typeof AI !== 'undefined') AI.clearCache();
    if (typeof TagSuggest !== 'undefined') TagSuggest.invalidate();
  }

  /** 必须在用户手势的同步栈里调用，跨消息或 setTimeout 都会丢失手势 */
  function requestOrigin(baseUrl) {
    try {
      var pat = AI.originPattern(baseUrl);
      if (!pat) return Promise.resolve(false);
      return chrome.permissions.request({ origins: [pat] }).catch(function () { return false; });
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  function testAIConnection() {
    var cfg = readAIConfig();
    if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
      setAIStatus('三个字段都要填', true);
      return;
    }

    setAIStatus('测试中…');

    /* 先申请权限（仍在点击的同步栈内），再做真实请求 */
    requestOrigin(cfg.baseUrl).then(function (granted) {
      if (!granted) { setAIStatus('未授权访问该地址', true); return; }

      persistAI();

      var probe = [{
        row: { id: 'probe', title: '连接测试', url: 'https://example.com', folder: '测试', added: Date.now() },
        score: 10
      }];

      AI.rerank({
        cfg: Object.assign({}, cfg, { enabled: true }),
        query: '连接测试',
        hits: probe,
        topN: 1
      }).then(function (r) {
        if (r.ok) setAIStatus('连接正常 · ' + r.ms + 'ms');
        else setAIStatus(AI.errText(r.error), true);
      });
    });
  }

  function renderPanel() {
    if (!acHits.length && !acActions.length && !aiBusy && !acBanner && !aiAnswer) {
      clearPanel();
      return;
    }

    var html = '';

    /* 有答案时标题已在卡片里，避免和顶部说明重复。 */
    if (acBanner && !(aiAnswer && aiAnswer.text)) html += '<div class="ac-head">' + esc(acBanner) + '</div>';

    if (aiAnswer && aiAnswer.text) {
      var answerSources = aiAnswer.sources || [];
      var answerMeta = aiAnswer.streaming ? '生成中…'
        : aiAnswer.incomplete ? '回答可能不完整'
          : answerSources.length ? '引用 ' + answerSources.length + ' 条收藏' : '基于本地正文';
      html += '<div class="ac-answer' + (aiAnswer.streaming ? ' is-streaming' : '') + '">' +
        '<div class="ac-answer-head"><span class="ac-answer-label">AI 回答</span><span>' + answerMeta + '</span></div>' +
        '<div class="ac-answer-text">' + esc(aiAnswer.text) + '</div>';
      if (answerSources.length) {
        html += '<div class="ac-answer-sources">' + answerSources.map(function (source, i) {
          return '<a class="ac-source" href="' + esc(source.url) + '" rel="noopener noreferrer" title="' + esc(source.host || source.url) + '">' +
            (source.marker || i + 1) + ' · ' + esc(source.title || source.host) + '</a>';
        }).join('') + '</div>';
      }
      html += '</div>';
    }

    acHits.forEach(function (h, i) {
      var r = h.row;
      var snippet = Bookmarks.snippet(r, queryText());
      var sub = '<div class="ac-sub">' + esc(r.site || r.host) + ' · ' +
        esc(r.contentStatus || '仅标题') + ' · ' + esc(r.syncStatus || '未入库') + (r.relatedBookmarks > 1 ? ' · ' + r.relatedBookmarks + ' 个收藏入口' : '') + (r.folder ? ' · ' + esc(r.folder) : '') + '</div>';
      if (r.captureNote) sub += '<div class="ac-sub">' + esc(r.captureNote) + '</div>';
      if (snippet) sub += '<div class="ac-sub ac-evidence">' + esc(snippet) + '</div>';
      if (h.why) sub += '<div class="ac-sub ac-why">' + esc(h.why) + '</div>';

      html += '<div class="ac-item' + (i === acIndex ? ' is-sel' : '') + '" data-i="' + i + '" role="option">' +
        '<span class="ac-dot" style="background:' + dotColor(r.host || r.site) + '"></span>' +
        '<div class="ac-body">' +
          '<div class="ac-title">' + esc(r.title) + '</div>' + sub +
        '</div>' +
        '<span class="ac-meta">' + (h.why ? '' : relTime(r.added)) + '</span>' +
      '</div>';
    });

    if (acActions.length) {
      if (acHits.length) html += '<div class="ac-sep"></div>';

      acActions.forEach(function (a, j) {
        var idx = acHits.length + j;
        var label = a.ai
          ? '用 AI 在书签里搜 “' + a.q + '”'
          : a.local
            ? '看本地排序的全部 ' + Math.min(aiCands.length, AC_LIMIT) + ' 条'
            : '用 ' + engineLabel() + ' 搜索 “' + a.q + '”';

        html += '<div class="ac-act' + (idx === acIndex ? ' is-sel' : '') + '" data-a="' + j + '">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
            '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.2 4.2"/></svg>' +
          '<span>' + esc(label) + '</span>' +
          (a.ai ? '<span class="ac-badge">AI</span>' : '') +
        '</div>';
      });
    }

    els.acPanel.setAttribute('aria-label', isAIMode() ? 'AI 书签检索结果' : '书签检索结果');
    els.acPanel.innerHTML = html;
    els.acPanel.classList.add('is-open');
  }

  /** 跳转前把 touch() 的防抖写入落盘，最多等 300ms，避免导航取消定时器 */
  function goAfterTag(url) {
    Promise.race([
      QuickTags.flush(),
      new Promise(function (resolve) { setTimeout(resolve, 300); })
    ]).then(function () { location.href = url; });
  }

  function activate(idx) {
    if (idx < 0) return;

    if (idx < acHits.length) {
      var hit = acHits[idx];
      if (!hit) return;

      if (hit.create) { createTagFromQuery(); return; }

      /* 普通联想：关键词候选直接搜，网址候选直接打开（书签/历史） */
      if (hit.kind === 'query') { doSearch(hit.text); return; }
      if (hit.kind === 'url') { location.href = hit.url; return; }

      var url = hit.row.url;

      /* 标签命中即回写：固定项记次数，候选记"这条真被用过"，直接影响下次排序 */
      if (hit.tag && typeof QuickTags !== 'undefined') {
        QuickTags.touch(hit.tag);
        goAfterTag(url);
        return;
      }

      /* AI 模式下记下这次选择，下次同一句意图直接告诉模型 */
      if (isAIMode() && typeof AgentDB !== 'undefined') {
        Promise.race([
          recordPick(queryText(), hit.row.id),
          new Promise(function (r) { setTimeout(r, 60); })
        ]).then(function () { location.href = url; });
        return;
      }

      location.href = url;
      return;
    }

    var act = acActions[idx - acHits.length];
    if (!act) return;

    if (act.ai) { runAI(); return; }

    if (act.local) {
      resetAnswer();
      acHits = aiCands.slice(0, AC_LIMIT);
      acActions = [{ q: act.q, ai: true }, { q: act.q }];
      acIndex = 0;
      acBanner = '本地排序 · 共 ' + aiCands.length + ' 条候选';
      renderPanel();
      return;
    }

    doSearch(act.q);
  }

  function moveSel(delta) {
    var total = acHits.length + acActions.length;
    if (!total) return;
    /* 联想模式默认不选中（-1）：向下选第一条，向上选最后一条 */
    if (acIndex < 0) acIndex = delta > 0 ? 0 : total - 1;
    else acIndex = (acIndex + delta + total) % total;
    if (isTagMode()) renderTagPanel();
    else if (isSuggestMode()) renderSuggest(suggestState, true);
    else renderPanel();
    var sel = els.acPanel.querySelector('.is-sel');
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
  }

  function doSearch(raw) {
    var q = (raw || '').trim();
    if (!q) return;

    if (/^https?:\/\//i.test(q)) { location.href = q; return; }
    if (looksLikeUrl(q)) { location.href = 'https://' + q; return; }

    var engine = ENGINES[settings.engine] || ENGINES.bing;
    if (suggestRecent) suggestRecent.record(q);   /* 搜过的词下次优先联想 */
    location.href = engine.url + encodeURIComponent(q);
  }

  function submitQuery() {
    var open = els.acPanel.classList.contains('is-open');
    if (isAIMode()) {
      /* 已有结果时，回车打开键盘选中项；首次回车才发起检索。 */
      if (open && !aiBusy && acHits.length) activate(acIndex);
      else runAI();
      return;
    }
    if (isBookmarkMode()) {
      if (open) activate(acIndex);
      return;
    }
    if (isTagMode()) {
      /* 有候选就跳转；没有候选时把输入当作网址新建标签，不做二次确认 */
      if (open && acHits.length) activate(acIndex);
      else createTagFromQuery();
      return;
    }
    if (isSuggestMode()) {
      /* 选中候选时打开/搜索它；没选中（默认）就用输入原样搜索 */
      if (open && acIndex >= 0) activate(acIndex);
      else doSearch(els.searchInput.value);
      return;
    }
    doSearch(els.searchInput.value);
  }

  /* ------------------------- 事件绑定 ------------------------- */
  function bindEvents() {
    /* 搜索框 */
    els.searchForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      submitQuery();
    });

    /* 输入即检索：普通模式纯本地打分，AI 模式只等回车 */
    els.searchInput.addEventListener('input', function () {
      onInput();
    });

    /* 中文输入法：组合结束时才补一次匹配，组合期间保持面板不动 */
    els.searchInput.addEventListener('compositionstart', function () { composing = true; });
    els.searchInput.addEventListener('compositionend', function () {
      composing = false;
      onInput();
    });

    els.searchInput.addEventListener('keydown', function (ev) {
      var open = els.acPanel.classList.contains('is-open');

      if (ev.key === 'ArrowDown' && open) { ev.preventDefault(); moveSel(1); return; }
      if (ev.key === 'ArrowUp' && open) { ev.preventDefault(); moveSel(-1); return; }

      /* 面板被 Esc 收起后，方向键可以把它叫回来，不用重新输入 */
      if (ev.key === 'ArrowDown' && !open && isSuggestMode() && suggestEnabled() && suggestQuery()) {
        ev.preventDefault();
        var reopened = ensureSuggest();
        if (reopened) reopened.flush(suggestQuery());
        return;
      }

      if (ev.key === 'Tab' && open) {
        ev.preventDefault();
        moveSel(ev.shiftKey ? -1 : 1);
        return;
      }

      if (ev.key === 'Escape' && open) {
        ev.preventDefault();
        ev.stopPropagation();
        clearPanel();
        return;
      }

      /* 编辑文字仍用 Backspace，Shift+Backspace 才删当前标签，避免误删 */
      if (ev.key === 'Backspace' && ev.shiftKey && open && isTagMode()) {
        ev.preventDefault();
        var cur = acHits[acIndex];
        if (cur && cur.tag) tagAction('del', cur.tag.id);
        return;
      }

      if (ev.key === 'Enter') {
        ev.preventDefault();
        submitQuery();
      }
    });

    /* 用 mousedown 而不是 click：click 前 input 已经失焦，面板可能被收掉了 */
    els.acPanel.addEventListener('mousedown', function (ev) {
      ev.preventDefault();

      /* @ 面板里的行内动作（固定 / 删除 / 新建）先于整行点击处理 */
      var pill = ev.target.closest('[data-act]');
      if (pill) { tagAction(pill.dataset.act, pill.dataset.id); return; }
      if (ev.target.closest('[data-new]')) { createTagFromQuery(); return; }

      /* 最近搜索的 × 只删记录，不触发整行搜索 */
      var del = ev.target.closest('[data-del]');
      if (del) { removeRecentAt(Number(del.getAttribute('data-del'))); return; }

      var item = ev.target.closest('.ac-item');
      var act = ev.target.closest('.ac-act');
      if (item) { activate(Number(item.dataset.i)); return; }
      if (act) activate(acHits.length + Number(act.dataset.a));
    });

    els.searchInput.addEventListener('blur', function () {
      if (blurTimer) clearTimeout(blurTimer);
      blurTimer = setTimeout(function () { blurTimer = null; clearPanel(); }, 120);
    });

    /* 空输入聚焦时先给最近搜索，避免一片空白 */
    els.searchInput.addEventListener('focus', function () {
      if (blurTimer) { clearTimeout(blurTimer); blurTimer = null; }
      if (!isSuggestMode() || !suggestEnabled()) return;
      if (!suggestQuery()) renderSuggestRecent();
    });

    /* 鼠标划过联想候选时同步选中，回车才会打开用户看到的那一条 */
    els.acPanel.addEventListener('mousemove', function (ev) {
      if (!isSuggestMode() || !acHits.length) return;
      var item = ev.target.closest ? ev.target.closest('.ac-item') : null;
      if (!item) return;
      var i = Number(item.dataset.i);
      if (i === acIndex) return;
      acIndex = i;
      Array.prototype.forEach.call(els.acPanel.querySelectorAll('.ac-item'), function (el) {
        el.classList.toggle('is-sel', Number(el.dataset.i) === i);
      });
    });

    els.engineChip.addEventListener('click', function () {
      if (isAIMode() || isBookmarkMode()) return;   /* 检索模式下显示模式标记，不切引擎 */
      var i = ENGINE_ORDER.indexOf(settings.engine);
      var next = ENGINE_ORDER[(i + 1) % ENGINE_ORDER.length];
      settings.engine = next;
      persist();
      els.engineChip.textContent = ENGINES[next].label;
      syncActive();
      resetSuggestForEngine();
    });

    /* 面板开关 */
    els.settingsBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      togglePanel(!document.body.classList.contains('panel-open'));
    });
    els.panelClose.addEventListener('click', function () { togglePanel(false); });

    document.addEventListener('click', function (ev) {
      if (!document.body.classList.contains('panel-open')) return;
      if ((ev.composedPath && ev.composedPath().indexOf(els.panel) !== -1) || ev.target.closest('.panel') || ev.target.closest('#settings-btn') || ev.target.closest('#organizer-open')) return;
      togglePanel(false);
    });

    /* 上传 */
    els.fileInput.addEventListener('change', function () {
      var f = els.fileInput.files && els.fileInput.files[0];
      handleFile(f);
      els.fileInput.value = '';
    });

    /* 图片链接 */
    els.urlApply.addEventListener('click', applyUrlInput);
    els.urlInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); applyUrlInput(); }
    });

    function applyUrlInput() {
      var url = els.urlInput.value.trim();
      if (!url) { toast('请先粘贴图片链接'); return; }
      settings.bg.mode = 'url';
      settings.bg.url = url;
      persist();
      applyBackground();
      syncActive();
      toast('已应用网络图片');
    }

    /* 在线壁纸：搜索、分页、原图 Token（只存本机） */
    els.wpProvider.addEventListener('change', function () {
      settings.wallpaper.provider = els.wpProvider.value; persist(); syncWallpaperProvider();
      if (els.wpSuggest) { els.wpSuggest.hidden = true; els.wpSuggest.innerHTML = ''; }
      wpState.query = els.wpQuery.value.trim(); loadWallpapers(true);
    });
    document.querySelectorAll('[data-wallpaper-query]').forEach(function (button) {
      button.addEventListener('click', function () {
        if (button.dataset.wallpaperProvider) { settings.wallpaper.provider = button.dataset.wallpaperProvider; persist(); }
        if (settings.wallpaper.provider === 'bing' || settings.wallpaper.provider === 'haowallpaper' || (['pexels', 'unsplash', 'pixabay'].indexOf(settings.wallpaper.provider) >= 0 && !settings.wallpaper.keys[settings.wallpaper.provider])) { settings.wallpaper.provider = 'all'; persist(); syncWallpaperProvider(); }
        els.wpQuery.value = button.dataset.wallpaperQuery; wpState.query = button.dataset.wallpaperQuery; loadWallpapers(true);
      });
    });
    document.querySelectorAll('[data-wallpaper-preference]').forEach(function (button) {
      button.addEventListener('click', function () {
        settings.wallpaper.preference = button.dataset.wallpaperPreference;
        if (['all', 'domestic'].indexOf(settings.wallpaper.provider) < 0) settings.wallpaper.provider = 'all';
        els.wpQuery.value = ''; wpState.query = ''; persist(); loadWallpapers(true);
      });
    });
    els.wpPhotoKey.addEventListener('change', function () {
      var provider = settings.wallpaper.provider;
      if (['pexels', 'unsplash', 'pixabay'].indexOf(provider) < 0) return;
      settings.wallpaper.keys[provider] = els.wpPhotoKey.value.trim(); persist(); loadWallpapers(true);
    });
    els.wpHistoryClear.addEventListener('click', function () {
      settings.wallpaper.history = []; persist(); renderWpHistory();
      toast('已清空使用历史');
    });
    els.wpSearch.addEventListener('click', function () {
      wpState.query = els.wpQuery.value.trim();
      loadWallpapers(true);
    });
    els.wpQuery.addEventListener('input', function () {
      clearTimeout(suggestTimer);
      suggestTimer = setTimeout(refreshWallpaperSuggest, 240);
    });
    els.wpQuery.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        wpState.query = els.wpQuery.value.trim();
        loadWallpapers(true);
      }
    });
    els.wpPrev.addEventListener('click', function () {
      if (wpState.loading || wpState.page <= 1) return;
      loadWallpapers(false, wpState.page - 1);
    });
    els.wpMore.addEventListener('click', function () {
      if (wpState.loading || !wpState.hasMore) return;
      loadWallpapers(false, wpState.page + 1);
    });
    els.wpSave.addEventListener('click', function () {
      var current = settings.bg.online;
      if (!current || settings.bg.mode !== 'url' || current.url !== settings.bg.url || els.wpSave.disabled) return;
      els.wpSave.disabled = true;
      saveWallpaperOffline(Object.assign({}, current, { resolved: current }), els.wpSave).finally(function () { updateWallpaperQuality(null); });
    });
    els.wpAuth.addEventListener('click', importWallpaperToken);
    els.wpToken.addEventListener('change', function () {
      settings.wallpaper = settings.wallpaper || {};
      settings.wallpaper.token = els.wpToken.value.trim();
      persist();
      toast(settings.wallpaper.token ? 'Token 已仅保存到本机' : '已清除本机 Token');
    });

    /* 滑块 */
    els.blurRange.addEventListener('input', function () {
      settings.bg.blur = Number(els.blurRange.value);
      els.blurValue.textContent = els.blurRange.value;
      document.documentElement.style.setProperty('--bg-blur', settings.bg.blur + 'px');
      persist();
    });

    els.scrimRange.addEventListener('input', function () {
      settings.bg.scrim = Number(els.scrimRange.value);
      els.scrimValue.textContent = els.scrimRange.value;
      document.documentElement.style.setProperty('--scrim', String(settings.bg.scrim / 100));
      persist();
    });

    if (els.swMotion) els.swMotion.addEventListener('change', function () {
      settings.bg.motion = els.swMotion.checked;
      persist();
      applyMotionPreference();
    });

    /* 开关 */
    els.swH24.addEventListener('change', function () {
      settings.clock.h24 = els.swH24.checked; persist(); renderClock();
    });
    els.swSeconds.addEventListener('change', function () {
      settings.clock.seconds = els.swSeconds.checked; persist(); renderClock();
    });
    els.swDate.addEventListener('change', function () {
      settings.show.date = els.swDate.checked; persist(); applyVisibility();
    });
    els.swLunar.addEventListener('change', function () {
      settings.show.lunar = els.swLunar.checked; persist(); applyVisibility();
    });
    els.swSearch.addEventListener('change', function () {
      settings.show.search = els.swSearch.checked; persist(); applyVisibility();
      if (els.swSearch.checked) els.searchInput.focus();
    });
    els.swQuote.addEventListener('change', function () {
      settings.show.quote = els.swQuote.checked; persist(); applyVisibility();
    });
    if (els.swTags) els.swTags.addEventListener('change', function () {
      settings.tags.enabled = els.swTags.checked;
      persist();
      if (!settings.tags.enabled) { els.searchInput.value = ''; clearPanel(); }
      applyMode();
      toast(settings.tags.enabled ? '已开启 @ 快捷标签' : '@ 已关闭，将按普通字符搜索');
    });
    if (els.swSuggest) els.swSuggest.addEventListener('change', function () {
      settings.suggest = { enabled: els.swSuggest.checked };
      persist();
      if (!settings.suggest.enabled) clearPanel();
      else if (document.activeElement === els.searchInput) refreshSuggest();
      toast(settings.suggest.enabled ? '已开启搜索联想' : '已关闭搜索联想');
    });
    if (els.swTagAi) els.swTagAi.addEventListener('change', function () {
      settings.tags.aiSuggest = els.swTagAi.checked;
      persist();
      if (typeof TagSuggest !== 'undefined') TagSuggest.invalidate();
      if (isTagMode() && document.activeElement === els.searchInput) refreshTagPanel({ preserveSelection: true });
      toast(els.swTagAi.checked ? '已开启 @ 面板 AI 短名' : '已关闭 @ 面板 AI 短名');
    });

    /* AI 设置 */
    els.swAi.addEventListener('change', persistAI);
    [els.aiBase, els.aiKey, els.aiModel, els.aiFastModel, els.aiStrongModel].forEach(function (el) {
      el.addEventListener('change', persistAI);
    });
    els.aiTest.addEventListener('click', testAIConnection);
    window.addEventListener('focus', function () {
      if (!bmReady) return;
      ContentIndex.hydrate(bmRows).then(function () {
          if (document.activeElement === els.searchInput && isBookmarkMode()) refreshPanel();
      });
    });

    /* 重置 */
    els.resetBtn.addEventListener('click', function () {
      var keepBackup = settings && settings.backup;
      settings = Settings.clone(Settings.DEFAULTS);
      if (keepBackup) settings.backup = keepBackup;   /* 不因重置外观而丢掉备份连接 */
      bindStateToControls();
      applyBackground();
      applyMotionPreference();
      applyVisibility();
      renderClock();
      syncActive();
      persist();
      toast('已恢复默认设置');
    });

    /* 键盘快捷键 */
    document.addEventListener('keydown', function (ev) {
      var tag = (ev.target.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'textarea';

      if (ev.key === '/' && !typing) {
        if (!settings.show.search) {
          settings.show.search = true;
          els.swSearch.checked = true;
          applyVisibility();
          persist();
        }
        ev.preventDefault();
        els.searchInput.focus();
        return;
      }
      if (ev.key === 'Escape') {
        if (els.acPanel.classList.contains('is-open')) {
          clearPanel();
        } else if (document.body.classList.contains('panel-open')) {
          togglePanel(false);
        } else if (typing) {
          els.searchInput.blur();
          els.searchInput.value = '';
        }
      }
    });

    /* 拖拽图片 */
    var dragDepth = 0;
    window.addEventListener('dragenter', function (ev) {
      if (!ev.dataTransfer || Array.prototype.indexOf.call(ev.dataTransfer.types, 'Files') === -1) return;
      dragDepth++;
      document.body.classList.add('dragging');
    });
    window.addEventListener('dragover', function (ev) {
      ev.preventDefault();
    });
    window.addEventListener('dragleave', function () {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) document.body.classList.remove('dragging');
    });
    window.addEventListener('drop', function (ev) {
      ev.preventDefault();
      dragDepth = 0;
      document.body.classList.remove('dragging');
      var files = ev.dataTransfer && ev.dataTransfer.files;
      if (files && files.length) handleFile(files[0]);
    });

    /* 粘贴图片 */
    window.addEventListener('paste', function (ev) {
      var items = ev.clipboardData && ev.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image') === 0) {
          var file = items[i].getAsFile();
          if (file) {
            ev.preventDefault();
            handleFile(file);
          }
          return;
        }
      }
    });

    /* 关闭/离开页面时把防抖中的写入落盘，避免最后 180ms 的操作丢失。
       只在确实有待写内容时落盘，避免覆盖外部（如测试或同步）写好的存储。 */
    window.addEventListener('pagehide', function () {
      if (typeof QuickTags !== 'undefined') QuickTags.flush();
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        Settings.save(settings);
      }
    });
  }

  /* 本地图库、使用历史与在线壁纸都等到外观页真正可见时再渲染，减少启动请求。 */
  function refreshAppearance() {
    renderGallery();
    renderWpHistory();
    if (!wpState.items.length && !wpState.loading) loadWallpapers(true);
  }

  function togglePanel(open) {
    document.body.classList.toggle('panel-open', !!open);
    els.panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) {
      refreshAppearance();
      scheduleWpGridFit();
    } else {
      document.dispatchEvent(new CustomEvent('workspace:close'));
    }
  }

  document.addEventListener('workspace:view', function (event) {
    if (event.detail === 'appearance') refreshAppearance();
    if (event.detail === 'search' && ragSettingsUI) {
      ragSettingsUI.bind().catch(function () { toast('RAG 设置加载失败'); });
    }
  });

  /** 把 settings 回填到面板控件 */
  function bindStateToControls() {
    els.blurRange.value = settings.bg.blur;
    els.blurValue.textContent = settings.bg.blur;
    els.scrimRange.value = settings.bg.scrim;
    els.scrimValue.textContent = settings.bg.scrim;
    if (els.swMotion) els.swMotion.checked = settings.bg.motion !== false;

    els.swH24.checked = settings.clock.h24;
    els.swSeconds.checked = settings.clock.seconds;
    els.swDate.checked = settings.show.date;
    els.swLunar.checked = settings.show.lunar;
    els.swSearch.checked = settings.show.search;
    els.swQuote.checked = settings.show.quote;
    if (els.swSuggest) els.swSuggest.checked = !(settings.suggest && settings.suggest.enabled === false);
    if (els.swTags) els.swTags.checked = !!(settings.tags && settings.tags.enabled);
    if (els.swTagAi) els.swTagAi.checked = !(settings.tags && settings.tags.aiSuggest === false);

    applyMode();

    if (ragSettingsUI) ragSettingsUI.bind().catch(function () { toast('RAG 设置加载失败'); });
    els.swAi.checked = !!settings.ai.enabled;
    els.aiBase.value = settings.ai.baseUrl || '';
    els.aiKey.value = settings.ai.apiKey || '';
    els.aiModel.value = settings.ai.model || '';
    els.aiFastModel.value = settings.ai.fastModel || '';
    els.aiStrongModel.value = settings.ai.strongModel || '';
    syncWallpaperProvider();
    els.wpToken.value = settings.wallpaper && settings.wallpaper.token
      ? settings.wallpaper.token
      : '';

    if (settings.bg.mode === 'url' && settings.bg.url) els.urlInput.value = settings.bg.url;
  }

  /* ------------------------- 启动 ------------------------- */
  function init() {
    Settings.load().then(function (s) {
      settings = s;
      ragSettingsUI = RagSettings.mount({ settings: function () { return settings; }, persist: persist });
      OrganizerUI.mount({ changed: loadBookmarks });
      if (typeof AutoOrganizerUI !== 'undefined') AutoOrganizerUI.mount();
      if (typeof BookmarkEnrichUI !== 'undefined') BookmarkEnrichUI.mount();
      if (typeof BookmarkHealthUI !== 'undefined') BookmarkHealthUI.mount();
      if (typeof TagManager !== 'undefined') {
        tagManager = TagManager.mount({
          ctx: function () { return { rows: bmRows, topSites: tagTopSites }; }
        });
      }
      if (typeof BackupUI !== 'undefined') {
        BackupUI.mount({
          getSettings: function () { return settings; },
          persist: persist,
          toast: toast
        });
      }
      bindEvents();
      if (typeof ResizeObserver !== 'undefined') {
        var wpCard = document.querySelector('.wallpaper-card');
        if (wpCard) new ResizeObserver(scheduleWpGridFit).observe(wpCard);
      }
      renderSwatches();
      renderEngines();
      bindStateToControls();
      applyBackground();
      applyMotionPreference();
      applyVisibility();
      startClock();
      renderDate();
      renderQuote();
      syncActive();
      if (typeof chrome !== 'undefined' && chrome.bookmarks) {
        var bookmarkReload;
        ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered'].forEach(function (name) {
          if (chrome.bookmarks[name]) chrome.bookmarks[name].addListener(function () { clearTimeout(bookmarkReload); bookmarkReload = setTimeout(loadBookmarks, 300); });
        });
      }
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) chrome.runtime.onMessage.addListener(function (msg) {
        if (msg && msg.type === 'enrich:updated') { loadBookmarks(); return; }
        if (msg && msg.type === 'pipeline:updated' && bmReady) ContentIndex.hydrate(bmRows).then(function () {
          if (isBookmarkMode() && document.activeElement === els.searchInput) refreshPanel();
        });
      });
      loadBookmarks();

      /* 快捷标签：手动标签从本机读，候选在输入时即时重算。
         常访站点独立加载，避免标签存储慢时推荐区一直空着。 */
      loadTopSites();
      if (typeof QuickTags !== 'undefined') {
        QuickTags.load().then(function () {
          tagReady = true;
          if (isTagMode() && document.activeElement === els.searchInput) refreshTagPanel();
        });
      }
      if (typeof TagSuggest !== 'undefined') {
        TagSuggest.load().then(function () {
          if (isTagMode() && document.activeElement === els.searchInput) refreshTagPanel({ preserveSelection: true });
        });
      }

      // 每分钟刷新一次日期（跨零点）
      setInterval(function () { renderDate(); renderQuote(); }, 30000);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
