/* ============================================================
   sw.js —— 后台 Service Worker
   职责：
     1. 维护书签索引（全量重建 + 变更后节流重建）
     2. 提供查询接口给新标签页面
     3. 可选：读取浏览历史，为「上周存的」「常点的」提供权重
   设计取舍：
     书签增量同步（监听 onMoved 逐条改路径）维护成本远高于收益——
     实测 2000 条书签全量重建不到 100ms，所以变更后统一走「节流全量重建」，
     用一次 debounce 换掉一整套容易出错的增量状态机。
   ============================================================ */

importScripts('js/profiles.js', 'js/db.js', 'js/bookmarks.js', 'js/content-index.js', 'js/quick-tags.js', 'js/personal-targets.js', 'js/network-status.js', 'js/ingest-policy.js', 'js/resource-gate.js', 'js/retry-policy.js', 'js/collection-stats.js', 'js/organizer.js', 'js/organizer-moves.js', 'js/pageinfo.js', 'js/ai.js', 'js/store.js', 'js/backup.js', 'js/bookmark-auto.js', 'js/bookmark-enrich.js', 'js/documents.js', 'js/rag.js', 'js/capture-adapters.js', 'js/sync-engine.js');

Profiles.restoreLanding().catch(function () {});

var REBUILD_DELAY = 1500;   /* 连续变更（如导入一大批）合并成一次重建 */
var HISTORY_DAYS = 90;
var HISTORY_MAX = 5000;

var rebuildTimer = null;
var rebuildPromise = null;
var memRows = null;



/* ------------------------- 索引构建 ------------------------- */

/** 只有用户显式授权后才读历史，否则返回空表 */
async function readHistory() {
  var on = await AgentDB.getMeta('historyOn');
  if (!on) return {};

  try {
    var granted = await chrome.permissions.contains({ permissions: ['history'] });
    if (!granted) return {};

    var items = await chrome.history.search({
      text: '',
      startTime: Date.now() - HISTORY_DAYS * 864e5,
      maxResults: HISTORY_MAX
    });

    var map = {};
    for (var i = 0; i < items.length; i++) {
      map[items[i].url] = { v: items[i].visitCount || 0, t: items[i].lastVisitTime || 0 };
    }
    return map;
  } catch (e) {
    return {};
  }
}

async function rebuild() {
  if (rebuildPromise) return rebuildPromise;

  rebuildPromise = (async function () {
    var tree = await chrome.bookmarks.getTree();
    var hist = await readHistory();
    var rows = Bookmarks.flatten(tree, hist);
    await ContentIndex.hydrate(rows);
    await Documents.hydrate(rows);

    await AgentDB.replaceAll(rows);
    await AgentDB.setMeta('builtAt', Date.now());
    await AgentDB.setMeta('count', rows.length);

    memRows = rows;
    return rows;
  })();

  try {
    return await rebuildPromise;
  } finally {
    rebuildPromise = null;
  }
}

function scheduleRebuild() {
  SyncEngine.markDirty(false).catch(function () {});
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(function () {
    rebuild().then(function () { return SyncEngine.run(); }).catch(function () {});
  }, REBUILD_DELAY);
}

async function ensureRows() {
  if (memRows) return memRows;
  var rows = await AgentDB.getAll();
  if (!rows.length) rows = await rebuild();
  else await ContentIndex.hydrate(rows);
  memRows = rows;
  return rows;
}

/* ------------------------- 变更监听 ------------------------- */

if (chrome.bookmarks) {
  ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered']
    .forEach(function (evt) {
      if (chrome.bookmarks[evt]) chrome.bookmarks[evt].addListener(scheduleRebuild);
    });

  /* 收藏事件先于索引重建处理：命中域名记忆时立即归档。 */
  if (chrome.bookmarks.onCreated) {
    chrome.bookmarks.onCreated.addListener(function (id, node) {
      AutoOrganizer.onCreated(id, node).catch(function () {});
    });
    chrome.bookmarks.onCreated.addListener(function (id, node) {
      BookmarkEnrich.onCreated(id, node).catch(function () {});
    });
  }
  if (chrome.bookmarks.onChanged) chrome.bookmarks.onChanged.addListener(function (id, changes) {
    if (changes.url) chrome.bookmarks.get(String(id)).then(function (nodes) { return BookmarkEnrich.onCreated(id, nodes[0]); }).catch(function () {});
  });
  if (chrome.bookmarks.onMoved) {
    chrome.bookmarks.onMoved.addListener(function (id, info) {
      AutoOrganizer.onMoved(id, info).catch(function () {});
    });
  }
  /* 批量导入时暂停自动归档，导入结束后统一学习一次，避免逐条打扰。 */
  if (chrome.bookmarks.onImportBegan) {
    chrome.bookmarks.onImportBegan.addListener(function () { AutoOrganizer.setImporting(true); });
  }
  if (chrome.bookmarks.onImportEnded) {
    chrome.bookmarks.onImportEnded.addListener(function () {
      AutoOrganizer.setImporting(false);
      rebuild().then(async function () { await AutoOrganizer.relearn(); return AutoOrganizer.scanInbox(); }).catch(function () {});
    });
  }
}

chrome.runtime.onInstalled.addListener(function () {
  rebuild().then(function () { return SyncEngine.request(); }).catch(function () {});
  AutoOrganizer.bootstrap().catch(function () {});
  BookmarkEnrich.alarm().then(function () { return BookmarkEnrich.maintain(); }).catch(function () {});
  Backup.ensureAlarms();
  Backup.autoRun().catch(function () {});
});

chrome.runtime.onStartup.addListener(function () {
  rebuild().then(function () { return SyncEngine.request(); }).catch(function () {});
  AutoOrganizer.bootstrap().catch(function () {});
  BookmarkEnrich.alarm().then(function () { return BookmarkEnrich.maintain(); }).catch(function () {});
  Backup.ensureAlarms();
  Backup.autoRun().catch(function () {});
});

/* 后台每次启动都补建 alarm，队列与租约保存在 IndexedDB。 */
if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name === SyncEngine.ALARM) return SyncEngine.run();
    if (alarm.name === AutoOrganizer.ALARM) return AutoOrganizer.classifyPending();
    if (alarm.name === BookmarkEnrich.ALARM) return BookmarkEnrich.maintain();
    if (alarm.name === 'backup:debounce' || alarm.name === 'backup:periodic') return Backup.autoRun();
  });
  SyncEngine.alarm().catch(function () {});
  Backup.ensureAlarms();
}
/* 标签或设置变化后标脏，由 alarm 合并成一次上传；状态键自身不触发，避免循环 */
if (chrome.storage && chrome.storage.onChanged) chrome.storage.onChanged.addListener(function (changes, area) {
  try { Backup.onStorageChanged(changes, area); } catch (e) { /* ignore */ }
});
if (chrome.permissions && chrome.permissions.onAdded) chrome.permissions.onAdded.addListener(function () { SyncEngine.request({ force: true }).catch(function () {}); });
if (chrome.storage && chrome.storage.onChanged) chrome.storage.onChanged.addListener(function (changes, area) {
  var settingsKey; try { settingsKey = Profiles.key('newtab.settings.v1'); } catch (e) { return; }
  if (area === 'local' && changes[Profiles.key('newtab.tags.v1')]) {
    QuickTags.reload().then(function () { return SyncEngine.request(); }).catch(function () {});
  }
  var change = changes[settingsKey];
  if (area !== 'local' || !change) return;
  var oldRag = change.oldValue && change.oldValue.rag || {};
  var newRag = change.newValue && change.newValue.rag || {};
  if (JSON.stringify(oldRag) !== JSON.stringify(newRag)) {
    var force = ['baseUrl', 'apiKey', 'collection', 'includePrivate', 'cleanupEnabled'].some(function (key) { return oldRag[key] !== newRag[key]; });
    SyncEngine.request({ force: force }).catch(function () {});
  }

});

/* 主动采集登录页面：遍历可见内容块，保存覆盖说明，再进入同一后台队列。 */
chrome.action.onClicked.addListener(async function (tab) {
  var badge = '失败'; var title = '内容未保存，请重试';
  try {
    if (!ContentIndex.isWeb(tab.url)) throw new Error('此页面不支持内容索引');
    var rows = Bookmarks.flatten(await chrome.bookmarks.getTree());
    var info = await Documents.forUrl(tab.url);
    var matches = [];
    for (var row of rows) if (ContentIndex.isWeb(row.url) && (await Documents.forUrl(row.url)).id === info.id) matches.push(row);
    if (!matches.length) throw new Error('请先收藏当前页面，再点击扩展图标');
    await chrome.action.setBadgeText({ tabId: tab.id, text: '采集' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['js/content-index.js', 'js/pageinfo.js', 'js/page-capture.js'] });
    var results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async function () { return PageCapture.collect(); } });
    var captured = results[0] && results[0].result;
    if (!captured || ContentIndex.normUrl(captured.url) !== ContentIndex.normUrl(tab.url)) throw new Error('页面已跳转，请重试');
    if (!captured.info.text) throw new Error('未读取到正文，请等待页面加载后重试');
    await Documents.reconcile(rows);
    await Documents.capture(info.id, Object.assign(captured.info, { fetchedAt: Date.now() }));
    for (var match of matches) {
      await AgentDB.putPage(Object.assign({}, captured.info, { url: ContentIndex.normUrl(match.url), status: 'ok', version: ContentIndex.VERSION, fetchedAt: Date.now() }));
      await BookmarkEnrich.onCaptured(match.id, match);
    }
    await SyncEngine.enqueue(info.id, false);
    await SyncEngine.markDirty(false);
    SyncEngine.run().catch(function () {});
    memRows = null; badge = '已存'; title = '已保存部分正文及采集范围；登录内容仅在开启同步选项后上传';
  } catch (e) { title = e.message || title; }
  await chrome.action.setBadgeText({ tabId: tab.id, text: badge });
  await chrome.action.setTitle({ tabId: tab.id, title: title });
});

/* ------------------------- 消息路由 ------------------------- */

var HANDLERS = {
  'organizer:status': function () { return OrganizerMoves.summary(); },
  'auto:scan': function () { return AutoOrganizer.scanInbox(); },
  'auto:status': function () { return AutoOrganizer.status(); },
  'auto:toggle': function (msg) { return AutoOrganizer.toggle(msg.enabled); },
  'auto:relearn': async function () { memRows = null; return AutoOrganizer.relearn(); },
  'auto:rule:remove': function (msg) { return AutoOrganizer.removeRule(msg.key); },
  'auto:dismiss': function (msg) { return AutoOrganizer.dismiss(msg.id); },
  'auto:adopt': async function (msg) {
    var result = await AutoOrganizer.adopt(msg.id);
    memRows = null;
    await SyncEngine.markDirty(false);
    SyncEngine.run().catch(function () {});
    return result;
  },
  'enrich:status': function () { return BookmarkEnrich.status(); },
  'enrich:toggle': function (msg) { return BookmarkEnrich.toggle(msg.enabled); },
  'enrich:scan': async function () { await BookmarkEnrich.scan({ mode: 'enrich' }); return BookmarkEnrich.status(); },
  'enrich:capture': async function () { await BookmarkEnrich.scan({ mode: 'capture' }); return BookmarkEnrich.status(); },
  'enrich:retry-failed': async function () { await BookmarkEnrich.scan({ retryFailed: true }); return BookmarkEnrich.status(); },
  'enrich:apply': async function (msg) { var result = await BookmarkEnrich.apply(msg.id); memRows = null; chrome.runtime.sendMessage({ type: 'enrich:updated' }).catch(function () {}); return result; },
  'enrich:apply-all': async function () { var result = await BookmarkEnrich.applyAll(); memRows = null; chrome.runtime.sendMessage({ type: 'enrich:updated' }).catch(function () {}); return result; },
  'enrich:undo': async function () { var result = await BookmarkEnrich.undoLast(); memRows = null; chrome.runtime.sendMessage({ type: 'enrich:updated' }).catch(function () {}); return result; },
  'enrich:dismiss': function (msg) { return BookmarkEnrich.dismiss(msg.id); },
  'enrich:retry': function (msg) { return BookmarkEnrich.retry(msg.id); },
  'enrich:suggest-private': function (msg) { return BookmarkEnrich.suggestPrivate(msg.id); },
  'pipeline:audit': function () { return SyncEngine.audit(); },
  'pipeline:clean': function (msg) { return SyncEngine.clean(msg.ids); },
  'pipeline:recapture': function (msg) { return SyncEngine.recapture(msg.documentId); },
  'pipeline:verify': function (msg) { return SyncEngine.verify(msg.documentId); },
  'pipeline:network-retry': function () { return SyncEngine.networkRetry(); },
  'pipeline:status': function () { return SyncEngine.summary(); },
  'pipeline:start': function (msg) { return SyncEngine.request({ manual: true, force: !!msg.force }); },
  'pipeline:retry-failed': function (msg) { return SyncEngine.retryFailed(msg.ids); },
  'pipeline:delete-failed': function (msg) { return SyncEngine.deleteFailed(msg.ids); },
  'pipeline:retry': function (msg) { return SyncEngine.retry(msg.documentId); },
  'pipeline:changed': function () { return SyncEngine.request(); },
  'pipeline:pause': function () { return SyncEngine.pause(); },
  'organizer:undo': async function () { var result = await OrganizerMoves.undo(); memRows = null; await SyncEngine.markDirty(false); SyncEngine.run().catch(function () {}); return result; },
  /** 页面首次加载时调用，确保索引已就绪并取回全量行（页面自己做内存检索，零往返） */
  'bm:load': async function () {
    var rows = await ensureRows();
    return { rows: rows, total: rows.length, builtAt: await AgentDB.getMeta('builtAt') };
  },

  'bm:query': async function (msg) {
    var rows = await ensureRows();
    var now = Date.now();
    return {
      hits: Bookmarks.query(rows, msg.q, msg.limit || 30, now),
      total: rows.length
    };
  },

  'bm:rebuild': async function () {
    var rows = await rebuild();
    return { total: rows.length };
  },

  'bm:stat': async function () {
    return {
      count: await AgentDB.count(),
      builtAt: await AgentDB.getMeta('builtAt'),
      historyOn: !!(await AgentDB.getMeta('historyOn')),
      hasHistoryPermission: await chrome.permissions.contains({ permissions: ['history'] }).catch(function () { return false; })
    };
  },

  /**
   * 开关历史加权。
   * 注意：权限申请必须由页面在点击回调里同步调用 chrome.permissions.request()，
   * 在这里跨消息调用会丢失用户手势、必然失败。所以本接口只校验和落库，
   * 页面负责先申请权限、拿到后再发这条消息。
   */
  'bm:history': async function (msg) {
    if (msg.on) {
      var granted = await chrome.permissions
        .contains({ permissions: ['history'] })
        .catch(function () { return false; });
      if (!granted) return { ok: false, error: 'permission_not_granted' };
    }
    await AgentDB.setMeta('historyOn', !!msg.on);
    memRows = null;
    await rebuild();
    return { ok: true };
  },

  'backup:status': async function () {
    return { status: await Backup.readStatus() };
  },
  'backup:schedule': function () {
    Backup.ensureAlarms();
    return { ok: true };
  },
  'backup:run': function () {
    return Backup.autoRun();
  }
};

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  var fn = msg && HANDLERS[msg.type];
  if (!fn) return false;

  fn(msg, sender).then(
    function (data) { sendResponse({ ok: true, data: data }); },
    function (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); }
  );

  return true;   /* 保持消息通道，等异步 sendResponse */
});

/* online 只唤醒诊断，不证明 VPN 或服务链路已经恢复。 */
if (typeof addEventListener === 'function') addEventListener('online', function () { SyncEngine.networkRetry(false).catch(function () {}); });
