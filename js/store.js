/* ============================================================
   store.js —— 设置持久化 + 背景图片存储（IndexedDB）
   说明：优先用 chrome.storage.local（扩展环境），
        在普通网页/预览环境下自动降级为 localStorage，方便本地调试。
   ============================================================ */
(function (global) {
  'use strict';

  /* ------------------------- 默认设置 ------------------------- */
  var DEFAULTS = {
    bg: {
      mode: 'gradient',   // gradient | image | url
      gradient: 'mist',
      imageId: null,
      url: '',
      online: null,
      blur: 0,
      scrim: 12,
      motion: true
    },
    clock: { h24: true, seconds: false },
    show: { date: true, lunar: true, search: true, quote: true },
    engine: 'bing',
    /* 普通输入时的全网联想（走当前搜索引擎的 suggest 接口） */
    suggest: { enabled: true },
    /* @ 快捷标签：enabled 关掉后 @ 退回普通搜索字符 */
    tags: { enabled: true },
    ai: {
      enabled: false,
      baseUrl: 'http://43.155.217.74:9000/v1',
      apiKey: '',
      model: 'qwen3.6-flash',
      fastModel: '',
      strongModel: '',
      timeout: 12000
    },
    rag: {
      enabled: false,
      baseUrl: 'https://rag.lllcnm.cn',
      apiKey: '',
      collection: '',
      retrieveTimeout: 5000,
      includePrivate: false,
      autoSync: true,
      autoCapture: true,
      refreshDays: 7
    },
    wallpaper: {
      provider: 'all',
      preference: 'portraits',
      keys: { pexels: '', unsplash: '', pixabay: '' },
      // 在线壁纸使用历史：只存地址与尺寸，最多 12 条，按最近使用排序。
      history: [],
      // 哲风登录 Token 仅保存在本机，用于官方原图接口；绝不写入图片元数据。
      token: ''
    }
  };

  var STORAGE_KEY = 'newtab.settings.v1';
  var hasChromeStorage =
    typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  /** 深合并：以 defaults 为骨架，用已存设置覆盖 */
  function merge(defaults, saved) {
    var out = clone(defaults);
    if (!saved || typeof saved !== 'object') return out;
    Object.keys(out).forEach(function (key) {
      var d = out[key];
      var s = saved[key];
      if (s === undefined || s === null) return;
      if (d && typeof d === 'object' && !Array.isArray(d)) {
        out[key] = merge(d, s);
      } else {
        out[key] = s;
      }
    });
    return out;
  }

  function load() {
    return new Promise(function (resolve) {
      if (hasChromeStorage) {
        chrome.storage.local.get(STORAGE_KEY, function (res) {
          resolve(merge(DEFAULTS, res && res[STORAGE_KEY]));
        });
      } else {
        var raw = null;
        try { raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { raw = null; }
        resolve(merge(DEFAULTS, raw));
      }
    });
  }

  function save(settings) {
    return new Promise(function (resolve) {
      if (hasChromeStorage) {
        var payload = {};
        payload[STORAGE_KEY] = settings;
        chrome.storage.local.set(payload, function () { resolve(); });
      } else {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) {}
        resolve();
      }
    });
  }

  /* ------------------------- 背景图片库 ------------------------- */
  var DB_NAME = 'newtab-media';
  var STORE = 'images';
  var VERSION = 1;
  var dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function tx(mode) {
    return openDB().then(function (db) {
      return db.transaction(STORE, mode).objectStore(STORE);
    });
  }

  /**
   * 保存图片。meta 可带 sourceKey / original / width / height；
   * 传入已有 id 时用 put 升级原记录，避免预览图和原图重复占空间。
   */
  function addImage(blob, name, meta) {
    return tx('readwrite').then(function (store) {
      return new Promise(function (resolve, reject) {
        var row = Object.assign({ blob: blob, name: name || '图片', createdAt: Date.now() }, meta || {});
        row.blob = blob;
        row.name = name || '图片';
        var req = row.id ? store.put(row) : store.add(row);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function listImages() {
    return tx('readonly').then(function (store) {
      return new Promise(function (resolve, reject) {
        var req = store.getAll();
        req.onsuccess = function () {
          var rows = req.result || [];
          rows.sort(function (a, b) { return b.createdAt - a.createdAt; });
          resolve(rows);
        };
        req.onerror = function () { reject(req.error); };
      });
    }).catch(function () { return []; });
  }

  function getImage(id) {
    if (id === null || id === undefined) return Promise.resolve(null);
    return tx('readonly').then(function (store) {
      return new Promise(function (resolve, reject) {
        var req = store.get(id);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    }).catch(function () { return null; });
  }

  /** 按来源查找离线缓存，原图优先、其次取最新记录。 */
  function findImageBySource(sourceKey) {
    if (!sourceKey) return Promise.resolve(null);
    return tx('readonly').then(function (store) {
      return new Promise(function (resolve, reject) {
        var req = store.getAll();
        req.onsuccess = function () {
          var rows = (req.result || []).filter(function (row) {
            return row.sourceKey === sourceKey;
          });
          rows.sort(function (a, b) {
            if (!!a.original !== !!b.original) return a.original ? -1 : 1;
            return b.createdAt - a.createdAt;
          });
          resolve(rows[0] || null);
        };
        req.onerror = function () { reject(req.error); };
      });
    }).catch(function () { return null; });
  }

  function deleteImage(id) {
    return tx('readwrite').then(function (store) {
      return new Promise(function (resolve) {
        var req = store.delete(id);
        req.onsuccess = function () { resolve(); };
        req.onerror = function () { resolve(); };
      });
    }).catch(function () {});
  }

  /* ------------------------- 预设渐变背景 ------------------------- */
  var GRADIENTS = {
    mist: {
      name: '晨雾',
      css: 'radial-gradient(90% 75% at 16% 4%, rgba(185, 211, 229, .72) 0%, rgba(185, 211, 229, 0) 68%), radial-gradient(85% 80% at 88% 92%, rgba(70, 91, 133, .58) 0%, rgba(70, 91, 133, 0) 72%), linear-gradient(145deg, #7795ae 0%, #415d78 46%, #1c2b40 100%)'
    },
    dusk: {
      name: '暮山',
      css: 'radial-gradient(85% 72% at 78% 8%, rgba(197, 164, 205, .58) 0%, rgba(197, 164, 205, 0) 68%), radial-gradient(90% 85% at 12% 94%, rgba(75, 91, 145, .56) 0%, rgba(75, 91, 145, 0) 72%), linear-gradient(145deg, #806f98 0%, #4e506f 48%, #242b45 100%)'
    },
    forest: {
      name: '林间',
      css: 'radial-gradient(88% 76% at 18% 6%, rgba(174, 201, 176, .52) 0%, rgba(174, 201, 176, 0) 70%), radial-gradient(82% 78% at 86% 90%, rgba(39, 94, 86, .55) 0%, rgba(39, 94, 86, 0) 72%), linear-gradient(145deg, #6f9282 0%, #3f675b 48%, #193a35 100%)'
    },
    sand: {
      name: '沙丘',
      css: 'radial-gradient(90% 76% at 22% 5%, rgba(232, 207, 171, .62) 0%, rgba(232, 207, 171, 0) 70%), radial-gradient(86% 82% at 84% 94%, rgba(117, 83, 78, .48) 0%, rgba(117, 83, 78, 0) 72%), linear-gradient(145deg, #b89a7c 0%, #7c675b 48%, #3c3438 100%)'
    },
    ocean: {
      name: '深海',
      css: 'radial-gradient(90% 76% at 76% 6%, rgba(137, 204, 219, .58) 0%, rgba(137, 204, 219, 0) 70%), radial-gradient(88% 82% at 12% 92%, rgba(39, 92, 139, .58) 0%, rgba(39, 92, 139, 0) 72%), linear-gradient(145deg, #568da6 0%, #2e617b 48%, #143247 100%)'
    },
    graphite: {
      name: '石墨',
      css: 'radial-gradient(92% 78% at 20% 5%, rgba(177, 188, 204, .42) 0%, rgba(177, 188, 204, 0) 70%), radial-gradient(86% 82% at 84% 94%, rgba(65, 78, 105, .5) 0%, rgba(65, 78, 105, 0) 72%), linear-gradient(145deg, #697585 0%, #414c5c 48%, #202936 100%)'
    },
    aurora: {
      name: '极光',
      css: 'radial-gradient(88% 72% at 18% 84%, rgba(76, 188, 167, .62) 0%, rgba(76, 188, 167, 0) 70%), radial-gradient(88% 74% at 82% 12%, rgba(139, 133, 214, .62) 0%, rgba(139, 133, 214, 0) 70%), linear-gradient(145deg, #385f70 0%, #2d465f 48%, #20283f 100%)'
    },
    ember: {
      name: '余烬',
      css: 'radial-gradient(88% 74% at 82% 86%, rgba(220, 137, 112, .58) 0%, rgba(220, 137, 112, 0) 70%), radial-gradient(86% 74% at 16% 8%, rgba(160, 120, 160, .52) 0%, rgba(160, 120, 160, 0) 70%), linear-gradient(145deg, #765a70 0%, #554354 48%, #2d2939 100%)'
    }
  };

  global.Settings = {
    DEFAULTS: DEFAULTS,
    clone: clone,
    load: load,
    save: save,
    merge: merge
  };

  global.ImageStore = {
    add: addImage,
    list: listImages,
    get: getImage,
    findBySource: findImageBySource,
    remove: deleteImage
  };

  global.GRADIENTS = GRADIENTS;
})(typeof self !== 'undefined' ? self : window);
