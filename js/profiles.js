/* 账号空间：独立本地存储、旧数据迁移，以及云端能力的会话校验。 */
(function (global) {
  'use strict';
  var SESSION_KEY = 'newtab.session.v1';
  var LEGACY_KEY = 'newtab.profile.legacy-owner.v1';
  var session = null;
  var initializing = null;
  var transition = Promise.resolve();
  var stale = false;
  var activeTasks = 0;
  var drained = [];
  var listeners = [];
  var controllers = new Set();
  var binding = null;
  var checkedAt = 0;
  var cloudError = null;
  var checking = null;
  var switching = Promise.resolve();
  var receivingVersion = '';
  var landingOwnerVersion = '';
  var SETTINGS = 'newtab.settings.v1';
  var PROFILE_KEYS = [SETTINGS, 'newtab.tags.v1', 'newtab.tag-suggest.v1', 'newtab.backup.status.v1'];

  function failure(message, code) { var e = new Error(message); e.code = code || 'profile_changed'; return e; }
  function base() { return global.__BACKUP_SERVER__ || 'https://api.jingmi.lllcnm.cn'; }
  function guest() { return { version: crypto.randomUUID(), user: null, token: '' }; }
  function idOf(value) { return value && value.user ? 'user-' + value.user.id : 'guest'; }
  function prefix(value) { return 'newtab.profile.' + idOf(value) + ':'; }
  function database(name, value) { return name + '-' + idOf(value); }
  function rawRead(key) {
    return new Promise(function (resolve, reject) {
      if (global.chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(key, function (result) {
          if (chrome.runtime && chrome.runtime.lastError) { reject(failure('本地数据读取失败')); return; }
          resolve(result && result[key]);
        });
      } else {
        try { resolve(JSON.parse(localStorage.getItem(key) || 'null')); } catch (e) { reject(e); }
      }
    });
  }
  function rawWrite(values) {
    return new Promise(function (resolve, reject) {
      if (global.chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set(values, function () {
          if (chrome.runtime && chrome.runtime.lastError) { reject(failure('本地数据保存失败')); return; }
          resolve();
        });
      } else {
        try { Object.keys(values).forEach(function (key) { localStorage.setItem(key, JSON.stringify(values[key])); }); resolve(); }
        catch (e) { reject(e); }
      }
    });
  }
  function assertActive(ticket) {
    if (!session || stale || (ticket && ticket.version !== session.version)) throw failure('账号已切换，请刷新后重试');
  }
  function key(name) { assertActive(); return prefix(session) + name; }
  function track(controller) { assertActive(); controllers.add(controller); return function () { controllers.delete(controller); }; }
  async function api(path, token) {
    var ctrl = new AbortController(); controllers.add(ctrl);
    var timer = setTimeout(function () { ctrl.abort(); }, 10000);
    try {
      var res = await fetch(base() + path, { headers: { Authorization: 'Bearer ' + token }, signal: ctrl.signal, credentials: 'omit', redirect: 'error' });
      if (res.status === 404) return null;
      if (res.status === 401) throw failure('登录已过期，请重新登录', 'unauthorized');
      if (!res.ok) throw failure('暂时无法确认账号服务，请稍后重试', 'service_unavailable');
      var result = await res.json();
      if (!result.ok) throw failure('账号服务返回异常', 'service_unavailable');
      return result.data;
    } finally { clearTimeout(timer); controllers.delete(ctrl); }
  }

  function openRaw(name, create) {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(name);
      req.onupgradeneeded = function () { create(req.result); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  async function copyDatabase(sourceName, targetName, entries) {
    var source = await openRaw(sourceName, function () {});
    try {
      if (!source.objectStoreNames.length) return;
      var names = Array.from(source.objectStoreNames);
      var records = {};
      await Promise.all(names.map(function (name) {
        return new Promise(function (resolve, reject) {
          var store = source.transaction(name).objectStore(name);
          var req = store.getAll();
          req.onsuccess = function () { records[name] = { rows: req.result, keyPath: store.keyPath, autoIncrement: store.autoIncrement }; resolve(); };
          req.onerror = function () { reject(req.error); };
        });
      }));
      var target = await openRaw(targetName, function (db) {
        names.forEach(function (name) { db.createObjectStore(name, { keyPath: records[name].keyPath, autoIncrement: records[name].autoIncrement }); });
      });
      try {
        await new Promise(function (resolve, reject) {
          var tx = target.transaction(names, 'readwrite');
          names.forEach(function (name) { records[name].rows.forEach(function (row) { tx.objectStore(name).put(row); }); });
          tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error); }; tx.onabort = function () { reject(tx.error); };
        });
      } finally { target.close(); }
      if (entries) entries.push(sourceName);
    } finally { source.close(); }
  }
  async function writeMeta(target, meta) {
    var db = await openRaw(database('newtab-agent', target), function (db) { db.createObjectStore('meta', { keyPath: 'k' }); });
    try {
      await new Promise(function (resolve, reject) {
        var tx = db.transaction('meta', 'readwrite');
        Object.keys(meta || {}).forEach(function (k) { tx.objectStore('meta').put({ k: k, v: meta[k] }); });
        tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error); }; tx.onabort = function () { reject(tx.error); };
      });
    } finally { db.close(); }
  }
  async function initializeSpace(target, legacyOwner) {
    var p = prefix(target);
    if (await rawRead(p + 'initialized')) return;
    var values = {};
    var migrated = legacyOwner && String(legacyOwner.id) === String(target.user.id);
    if (migrated) {
      for (var name of PROFILE_KEYS) {
        var value = await rawRead(name);
        if (value !== undefined && value !== null) values[p + name] = value;
      }
      await copyDatabase('newtab-agent', database('newtab-agent', target));
      await copyDatabase('newtab-media', database('newtab-media', target));
    } else {
      // 首次登录先取该账号的备份；读取失败时不激活空空间，避免覆盖云端数据。
      var remote = await api('/api/backup', target.token);
      if (remote) {
        if (!global.Backup) throw failure('备份模块尚未加载');
        Backup.validatePayload(remote.payload);
        values[p + SETTINGS] = remote.payload.settings;
        values[p + 'newtab.tags.v1'] = remote.payload.tags;
        await writeMeta(target, remote.payload.meta);
      }
    }
    if (values[p + SETTINGS]) {
      values[p + SETTINGS] = JSON.parse(JSON.stringify(values[p + SETTINGS]));
      delete values[p + SETTINGS].backup;
      if (values[p + SETTINGS].rag) {
        values[p + SETTINGS].rag.baseUrl = ''; values[p + SETTINGS].rag.apiKey = ''; values[p + SETTINGS].rag.collection = '';
      }
    }
    values[p + 'initialized'] = { at: Date.now(), migrated: !!migrated };
    await rawWrite(values);
  }
  async function init() {
    var saved = await rawRead(SESSION_KEY);
    if (saved && saved.version && (!saved.user || (saved.user.id && saved.token))) { session = saved; return; }
    var old = await rawRead(SETTINGS);
    var backup = old && old.backup || {};
    var token = backup.authToken || backup.token;
    session = guest();
    if (token) {
      try {
        var who = await api('/api/auth/me', token);
        if (who && who.user) {
          await rawWrite({ [LEGACY_KEY]: who.user });
          if (who.kind === 'session' && backup.authToken) {
            session = { version: crypto.randomUUID(), user: who.user, token: token };
            await initializeSpace(session, who.user);
          }
        }
      } catch (e) { /* 旧数据保留在原位置，网络恢复后登录可继续迁移。 */ }
    }
    await rawWrite({ [SESSION_KEY]: session });
  }
  function initial() { if (!initializing) initializing = init(); return initializing; }
  async function verify(force) {
    await initial(); assertActive();
    if (!session.user) { binding = null; return null; }
    if (!force && Date.now() - checkedAt < 60000) return binding;
    if (checking) return checking;
    var ticket = session;
    checking = (async function () {
      try {
        var who = await api('/api/auth/me', ticket.token);
        if (!who || who.kind !== 'session' || String(who.user.id) !== String(ticket.user.id)) throw failure('请重新登录账号', 'unauthorized');
        var conf = await api('/api/rag/config', ticket.token);
        assertActive(ticket);
        binding = conf && conf.enabled === true && /^chrome_tab_[A-Za-z0-9_-]+$/.test(conf.collection) ? {
          collection: conf.collection, token: ticket.token, version: ticket.version, unlimited: conf.unlimited === true, username: who.user.username
        } : null;
        cloudError = binding ? null : failure('后台尚未配置可用的个人 RAG 集合', 'cloud_unavailable');
        checkedAt = Date.now();
        return binding;
      } catch (e) {
        binding = null;
        cloudError = e.code === 'unauthorized' ? e : failure('暂时无法确认 RAG 账号服务，请稍后重试', 'service_unavailable');
        if (e.code === 'unauthorized') await rawWrite({ [SESSION_KEY]: guest() });
        return null;
      } finally { checking = null; }
    })();
    return checking;
  }
  async function ready() { await initial(); await transition; await verify(); assertActive(); }
  function canCloud() { return !!(session && session.user && !stale && binding && binding.version === session.version && Date.now() - checkedAt < 60000); }
  async function requireCloud(force) {
    await initial(); assertActive(); await verify(force); assertActive();
    if (!canCloud()) throw (session.user && cloudError) || failure(session.user ? '个人 RAG 集合尚未就绪，请检查账号服务' : '请先登录并绑定个人 RAG 集合', 'cloud_unavailable');
    return binding;
  }
  async function run(operation) {
    await initial(); assertActive(); activeTasks++;
    try { return await operation(); }
    finally { activeTasks--; if (!activeTasks) drained.splice(0).forEach(function (resolve) { resolve(); }); }
  }
  function receive(next) {
    if (!session || !next || next.version === session.version || next.version === receivingVersion) return;
    receivingVersion = next.version;
    stale = true; binding = null; checkedAt = 0;
    controllers.forEach(function (controller) { controller.abort(); });
    if (typeof document !== 'undefined') {
      // 清除旧账号界面后显示切换状态，避免隐藏整个文档造成黑屏。
      var notice = document.createElement('div');
      notice.setAttribute('role', 'status');
      notice.textContent = '正在切换账号并恢复工作台…';
      notice.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;background:#171b22;color:#e6e8ee;font:14px system-ui';
      document.body.replaceChildren(notice);
      // 发起切换的扩展页交由新后台恢复；此时重载会撞上 runtime.reload。
      if (landingOwnerVersion === next.version) return;
      if (global.chrome && chrome.runtime && chrome.runtime.id) {
        notice.textContent = '账号已切换，请刷新此页以载入新账号。';
        return;
      }
      location.reload();
      return;
    }
    transition = transition.then(async function () {
      if (activeTasks) await new Promise(function (resolve) { drained.push(resolve); });
      session = next; stale = false; checking = null;
      if (global.chrome && chrome.runtime && chrome.runtime.reload) chrome.runtime.reload();
      listeners.forEach(function (fn) { fn(); });
    });
  }
  function locked(operation) {
    if (global.navigator && navigator.locks) return navigator.locks.request('jingmi-profile-switch', operation);
    switching = switching.catch(function () {}).then(operation); return switching;
  }
  /* 切换账号会重启后台；先登记当前页，避免页面重载撞上扩展卸载窗口。 */
  async function rememberLanding(version) {
    if (typeof document === 'undefined' || !global.chrome || !chrome.tabs || !chrome.tabs.getCurrent) return;
    var tab = await chrome.tabs.getCurrent();
    if (tab && tab.id != null) {
      await rawWrite({ 'newtab.profile.landing.v1': { tabId: tab.id, version: version, at: Date.now() } });
      landingOwnerVersion = version;
    }
  }
  async function restoreLanding() {
    if (typeof document !== 'undefined' || !global.chrome || !chrome.tabs) return;
    await initial();
    var key = 'newtab.profile.landing.v1';
    var landing = await rawRead(key);
    if (!landing || landing.version !== session.version || Date.now() - landing.at > 60000) return;
    var tab = await chrome.tabs.get(landing.tabId).catch(function () { return null; });
    var own = chrome.runtime.getURL('');
    /* 扩展重启会关闭原扩展页；还在就导航回去，已被关闭则重新打开工作台。 */
    if (!tab) {
      await chrome.tabs.create({ url: own + 'newtab.html' }).catch(function () {});
    } else {
      /* 没有 tabs 权限时读不到 tab.url；本轮切换刚登记过 tabId，按记录直接恢复。
         能读到 URL 时仍只恢复扩展页或原生新标签页，避免劫持用户已导航的页面。 */
      var visible = [tab.url, tab.pendingUrl].filter(Boolean);
      var allowed = visible.some(function (url) { return url.indexOf(own) === 0 || /^chrome:\/\/newtab\/?$/.test(url); });
      if (!visible.length || allowed) {
        await chrome.tabs.update(landing.tabId, { url: own + 'newtab.html' }).catch(function () {});
      }
    }
    await rawWrite({ [key]: null });
  }
  async function activate(data) {
    await initial(); assertActive();
    return locked(async function () {
      var who = await api('/api/auth/me', data.token);
      if (!who || who.kind !== 'session' || String(who.user.id) !== String(data.user.id)) throw failure('账号验证失败');
      var target = { version: crypto.randomUUID(), user: who.user, token: data.token };
      var owner = await rawRead(LEGACY_KEY);
      if (!owner) {
        var old = await rawRead(SETTINGS); var legacy = old && old.backup || {};
        if (legacy.username === target.user.username) owner = target.user;
        else if (legacy.token) {
          try { var oldWho = await api('/api/auth/me', legacy.token); if (oldWho) owner = oldWho.user; } catch (e) {}
        }
        if (owner) await rawWrite({ [LEGACY_KEY]: owner });
      }
      await initializeSpace(target, owner);
      await rememberLanding(target.version);
      await rawWrite({ [SESSION_KEY]: target }); receive(target);
    });
  }
  async function logout() { await initial(); var next = guest(); await rememberLanding(next.version); await rawWrite({ [SESSION_KEY]: next }); receive(next); }
  async function read(name) { await initial(); var k = key(name); return rawRead(k); }
  async function write(name, value) { await initial(); var k = key(name); await rawWrite({ [k]: value }); }
  function changes(changed) {
    var result = {}; if (!session || stale) return result;
    var p = prefix(session);
    Object.keys(changed).forEach(function (name) { if (name.indexOf(p) === 0) result[name.slice(p.length)] = changed[name]; });
    return result;
  }
  if (global.chrome && chrome.storage && chrome.storage.onChanged) chrome.storage.onChanged.addListener(function (changed, area) {
    if (area === 'local' && changed[SESSION_KEY]) receive(changed[SESSION_KEY].newValue);
  });
  global.Profiles = { SESSION_KEY: SESSION_KEY, initial: initial, ready: ready, run: run, key: key,
    dbName: function (name) { assertActive(); return database(name, session); },
    read: read, write: write, changes: changes, assertActive: assertActive, track: track,
    current: function () { assertActive(); return session; }, canCloud: canCloud, requireCloud: requireCloud,
    cloud: function () { return canCloud() ? binding : null; }, activate: activate, logout: logout,
    restoreLanding: restoreLanding,
    onChange: function (fn) { listeners.push(fn); }
  };
})(typeof self !== 'undefined' ? self : window);
