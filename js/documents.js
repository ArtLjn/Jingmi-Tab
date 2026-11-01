/* 文档身份与版本：一个网页可关联多个收藏，飞书按租户、类型和文档 token 区分。 */
(function (global) {
  'use strict';
  function identity(value) {
    var url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) throw new Error('不支持的网页地址');
    if (url.username || url.password) throw new Error('网页地址不能含登录凭据');
    var host = url.hostname.toLowerCase();
    var feishu = /(^|\.)(feishu\.cn|larksuite\.com)$/.test(host);
    var match = feishu && url.pathname.match(/^\/(docx|docs|wiki|sheets|base)\/([a-zA-Z0-9_-]+)\/?$/);
    if (match) return { key: 'feishu:' + url.origin + ':' + match[1] + ':' + match[2],
      canonicalUrl: url.origin + '/' + match[1] + '/' + match[2], provider: 'feishu', kind: match[1], token: match[2], origin: url.origin };
    /* 只去已知追踪参数，保留查询语义与 SPA 路由。 */
    Array.from(url.searchParams.keys()).forEach(function (key) { if (/^utm_|^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key); });
    url.searchParams.sort();
    return { key: 'web:' + url.href, canonicalUrl: url.href, provider: 'web', kind: 'page', origin: url.origin };
  }
  async function hash(value) {
    var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest)).map(function (n) { return n.toString(16).padStart(2, '0'); }).join('');
  }
  async function forUrl(url) {
    var info = identity(url);
    var alias = await AgentDB.getMeta('doc:alias:' + info.key);
    if (alias && alias.identity) return Object.assign({}, alias.identity, { id: alias.id });
    if (typeof alias === 'string') { var stored = await get(alias); return Object.assign({}, stored && stored.identity || info, { id: alias }); }
    return Object.assign(info, { id: await hash(info.key) });
  }
  function get(id) { return AgentDB.getRecord('documents', id); }
  function update(id, fn) { return AgentDB.updateRecord('documents', id, fn); }
  async function groups(rows) {
    var result = new Map();
    for (var row of rows) {
      if (!ContentIndex.isWeb(row.url)) continue;
      var info; try { info = await forUrl(row.url); } catch (e) { continue; }
      var group = result.get(info.id) || { info: info, rows: [] };
      group.rows.push(row); result.set(info.id, group);
    }
    return result;
  }
  async function reconcile(rows) {
    var grouped = await groups(rows);
    var classes = typeof Organizer !== 'undefined' ? await Organizer.records(rows) : {};
    var pages = await AgentDB.getPages(rows.map(function (r) { return ContentIndex.normUrl(r.url); }));
    for (var pair of grouped) {
      var info = pair[1].info;
      var refs = pair[1].rows.map(function (row) { return { id: String(row.id), url: row.url, title: row.title, folder: row.folder || '', addedAt: row.added || 0 }; });
      var classificationSignature = JSON.stringify(refs.map(function (r) { var c = classes[r.id] || {}; return [r.id, c.category, c.tags, c.type]; }));
      var old = await get(info.id);
      var page = pair[1].rows.map(function (row) { return pages[ContentIndex.normUrl(row.url)]; }).filter(function (p) { return p && p.status === 'ok'; }).sort(function (a, b) { return (b.fetchedAt || 0) - (a.fetchedAt || 0); })[0];
      await update(info.id, function (current) {
        var doc = current || { id: info.id, identity: info, title: refs[0].title, captureState: 'pending', syncState: 'pending', createdAt: Date.now() };
        var changed = JSON.stringify(doc.bookmarks) !== JSON.stringify(refs) || doc.classificationSignature !== classificationSignature;
        doc.classificationSignature = classificationSignature;
        doc.bookmarks = refs; doc.deleted = false;
        if (page && (!doc.fetchedAt || page.fetchedAt > doc.fetchedAt)) {
          Object.assign(doc, { text: page.text || '', desc: page.desc || '', title: page.title || refs[0].title,
            fetchedAt: page.fetchedAt, source: page.source || 'public', coverage: page.coverage || (page.text ? 'partial' : 'metadata'),
            captureState: page.text ? 'partial' : 'metadata', captureNote: page.captureNote || (page.coverage ? '公开 HTML 提取；动态内容、附件可能缺失' : '旧版采集记录，覆盖范围尚未验证') });
          changed = true;
        }
        if (changed) { doc.revision = (doc.revision || 0) + 1; doc.syncState = 'pending'; }
        return doc;
      });
      pair[1].changed = !old || old.deleted || old.classificationSignature !== classificationSignature || JSON.stringify(old.bookmarks) !== JSON.stringify(refs) || !!(page && page.fetchedAt > (old.fetchedAt || 0));
    }
    var existing = await AgentDB.allRecords('documents');
    for (var doc of existing) if (!grouped.has(doc.id) && !doc.deleted) await update(doc.id, function (current) { return Object.assign(current, { deleted: true, bookmarks: [], revision: (current.revision || 0) + 1, syncState: 'pending' }); });
    return grouped;
  }
  async function capture(id, info) {
    var contentHash = await hash(info.text || info.desc || '');
    return update(id, function (doc) {
      if (!doc) throw new Error('文档已不存在');
      var changed = doc.contentHash !== contentHash || doc.coverage !== info.coverage || doc.source !== info.source;
      Object.assign(doc, info, { id: id, contentHash: contentHash, checkedAt: Date.now(), fetchedAt: info.fetchedAt || Date.now() });
      if (changed) { doc.revision = (doc.revision || 0) + 1; doc.syncState = 'pending'; }
      return doc;
    });
  }
  async function alias(from, to) {
    /* 仅官方接口解析出的 wiki -> docx 映射调用这里；不按标题或相似内容合并。 */
    var destination = await forUrl(to);
    await AgentDB.setMeta('doc:alias:' + identity(from).key, { id: destination.id, identity: destination });
    return destination;
  }
  function captureLabel(doc) {
    if (!doc) return '仅标题';
    return ({ pending: '等待采集', metadata: '仅元数据', partial: '部分正文', ready: '正文已采集', waiting_open: '待打开文档', waiting_auth: '待页面授权', waiting_permission: '待站点授权', failed: '采集失败' })[doc.captureState] || '仅标题';
  }
  function syncLabel(doc) { return ({ pending: '待同步', synced: '已入库', excluded: '未上传登录内容', failed: '同步失败', deleted: '已移除', paused: '已暂停' })[doc && doc.syncState] || '未入库'; }
  async function hydrate(rows) {
    for (var row of rows) {
      if (!ContentIndex.isWeb(row.url)) continue;
      var info;
      try { info = await forUrl(row.url); } catch (e) { row.contentStatus = '不支持的地址'; row.syncStatus = '未入库'; continue; }
      var doc = await get(info.id);
      row.documentId = info.id;
      if (!doc || doc.deleted) continue;
      if ((doc.text || doc.desc) && (doc.fetchedAt || 0) >= (row.contentAt || 0)) { row.text = doc.text || ''; row.desc = doc.desc || ''; row.pageTitle = doc.title || ''; }
      row.contentStatus = captureLabel(doc); row.syncStatus = syncLabel(doc); row.contentAt = doc.fetchedAt || 0;
      row.captureNote = doc.captureNote || ''; row.captureSource = doc.source || ''; row.sourceUpdatedAt = doc.sourceUpdatedAt || 0;
      row.hay = [row.title, row.url, row.folder, row.site, row.pageTitle, row.desc, row.text].join(' ').toLowerCase();
    }
    return rows;
  }
  global.Documents = { identity: identity, hash: hash, forUrl: forUrl, get: get, update: update,
    groups: groups, reconcile: reconcile, capture: capture, alias: alias, hydrate: hydrate,
    captureLabel: captureLabel, syncLabel: syncLabel };
})(typeof self !== 'undefined' ? self : window);
