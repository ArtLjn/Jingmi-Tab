/* ============================================================
   db.js —— Agent 索引库（IndexedDB）
   用途：存放书签索引行，供新标签页面与 Service Worker 共享读取。
   说明：不依赖 window，可在 sw.js 里通过 importScripts 直接使用。
   ============================================================ */
(function (global) {
  'use strict';

  var DB_NAME = 'newtab-agent';
  var VERSION = 3;
  var S_BM = 'bookmarks';
  var S_META = 'meta';
  var S_PAGES = 'pages';

  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, VERSION);

      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(S_BM)) {
          var st = db.createObjectStore(S_BM, { keyPath: 'id' });
          st.createIndex('added', 'added');
          st.createIndex('host', 'host');
        }
        if (!db.objectStoreNames.contains(S_META)) {
          db.createObjectStore(S_META, { keyPath: 'k' });
        }
        if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' });
        /* v2：页面摘要缓存。书签标题常常看不出内容，这里存抓取到的 description */
        if (!db.objectStoreNames.contains(S_PAGES)) {
          db.createObjectStore(S_PAGES, { keyPath: 'url' });
        }
      };

      req.onsuccess = function () {
        req.result.onversionchange = function () { req.result.close(); dbPromise = null; };
        resolve(req.result);
      };
      req.onerror = function () { dbPromise = null; reject(req.error); };
    });
    return dbPromise;
  }

  function store(name, mode) {
    return open().then(function (db) {
      return db.transaction(name, mode).objectStore(name);
    });
  }

  function wrap(req) {
    return new Promise(function (res, rej) {
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { rej(req.error); };
    });
  }

  function getAll() {
    return store(S_BM, 'readonly')
      .then(function (s) { return wrap(s.getAll()); })
      .catch(function () { return []; });
  }

  function count() {
    return store(S_BM, 'readonly')
      .then(function (s) { return wrap(s.count()); })
      .catch(function () { return 0; });
  }

  /**
   * 全量替换。
   * 放在单个事务里 clear + put，避免中途有其他读取方看到空库。
   */
  function replaceAll(rows) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(S_BM, 'readwrite');
        var st = tx.objectStore(S_BM);
        st.clear();
        rows.forEach(function (r) { st.put(r); });
        tx.oncomplete = function () { resolve(rows.length); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  function getMeta(k) {
    return store(S_META, 'readonly')
      .then(function (s) { return wrap(s.get(k)); })
      .then(function (r) { return r ? r.v : null; })
      .catch(function () { return null; });
  }

  /* 元数据事务同时用于分类规则、移动日志和跨页面任务租约。 */
  function updateMeta(k, update) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(S_META, 'readwrite');
        var st = tx.objectStore(S_META);
        var value;
        var req = st.get(k);
        req.onsuccess = function () {
          try { value = update(req.result ? req.result.v : null); st.put({ k: k, v: value }); }
          catch (e) { tx.abort(); reject(e); }
        };
        tx.oncomplete = function () { resolve(value); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('保存操作已中止')); };
      });
    });
  }
  function setMeta(k, v) { return updateMeta(k, function () { return v; }); }

  /* ------------------------- 页面摘要缓存 ------------------------- */

  function getPages(urls) {
    if (!urls || !urls.length) return Promise.resolve({});
    return store(S_PAGES, 'readonly')
      .then(function (s) {
        return Promise.all(urls.map(function (u) { return wrap(s.get(u)); }));
      })
      .then(function (rows) {
        var map = {};
        rows.forEach(function (r) { if (r && r.url) map[r.url] = r; });
        return map;
      })
      .catch(function () { return {}; });
  }

  function putPage(row) {
    if (!row || !row.url) return Promise.reject(new Error('页面地址缺失'));
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(S_PAGES, 'readwrite');
        tx.objectStore(S_PAGES).put(row);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  function allRecords(name) { return store(name, 'readonly').then(function (s) { return wrap(s.getAll()); }); }
  function getRecord(name, key) { return store(name, 'readonly').then(function (s) { return wrap(s.get(key)); }); }
  function updateRecord(name, key, update) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(name, 'readwrite');
        var s = tx.objectStore(name);
        var value;
        var req = s.get(key);
        req.onsuccess = function () {
          try { value = update(req.result || null); if (value) s.put(value); else s.delete(key); }
          catch (e) { tx.abort(); reject(e); }
        };
        tx.oncomplete = function () { resolve(value); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('数据保存已中止')); };
      });
    });
  }

  function countPages() {
    return store(S_PAGES, 'readonly')
      .then(function (s) { return wrap(s.count()); })
      .catch(function () { return 0; });
  }

  global.AgentDB = {
    open: open,
    allRecords: allRecords,
    getRecord: getRecord,
    updateRecord: updateRecord,
    getAll: getAll,
    count: count,
    replaceAll: replaceAll,
    getMeta: getMeta,
    setMeta: setMeta,
    updateMeta: updateMeta,
    getPages: getPages,
    putPage: putPage,
    countPages: countPages
  };
})(typeof self !== 'undefined' ? self : window);
