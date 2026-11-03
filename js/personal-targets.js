/* 个人入口检索投影：人工资料与网页正文分别标记来源。 */
(function (global) {
  'use strict';
  var identities = new Map();
  async function records() {
    var result = new Map();
    if (!global.QuickTags || !global.Documents) return result;
    await QuickTags.load();
    for (var tag of QuickTags.list()) {
      try {
        var info = await Documents.forUrl(tag.url);
        var items = result.get(info.id) || [];
        items.push({ label: String(tag.label || '').trim(), aliases: Array.from(new Set(tag.aliases || [])).sort(), note: String(tag.note || '').trim() });
        result.set(info.id, items);
      } catch (e) { /* 不支持的网址不参与 RAG 关联。 */ }
    }
    result.forEach(function (items) { items.sort(function (a, b) { return JSON.stringify(a).localeCompare(JSON.stringify(b)); }); });
    return result;
  }
  function describe(items) {
    return (items || []).map(function (item) {
      return '【用户填写，仅说明个人称呼和用途，不代表网页正文】\n快捷名称：' + item.label + '\n人工别名：' + item.aliases.join('、') + '\n个人备注：' + item.note;
    }).join('\n\n');
  }
  function key(url) { if (identities.has(url)) return identities.get(url); try { return global.Documents ? Documents.identity(url).key : new URL(url).href; } catch (e) { return ''; } }
  async function hydrate(rows) {
    identities.clear();
    if (global.Documents && global.QuickTags) {
      var urls = new Set(rows.map(function (r) { return r.url; }).concat(QuickTags.list().map(function (t) { return t.url; })));
      await Promise.all(Array.from(urls).map(async function (url) { try { identities.set(url, 'doc:' + (await Documents.forUrl(url)).id); } catch (e) { /* 不支持的地址不关联。 */ } }));
    }
    return apply(rows);
  }
  function apply(rows) {
    var byKey = new Map();
    if (global.QuickTags) QuickTags.list().forEach(function (tag) { var id = key(tag.url); var list = byKey.get(id) || []; list.push(tag); byKey.set(id, list); });
    rows.forEach(function (row) {
      var tags = byKey.get(key(row.url)) || [];
      if (!tags.length && !row.personalNames) return;
      row.personalNames = tags.flatMap(function (t) { return [t.label].concat(t.aliases || []); });
      row.personalNote = tags.map(function (t) { return t.note || ''; }).join(' ');
      row.personalEvidence = describe(tags.map(function (t) { return { label: t.label, aliases: t.aliases || [], note: t.note || '' }; }));
      row.hay = [row.title, row.url, row.folder, row.site, (row.segs || []).join(' '), row.pageTitle, row.desc, row.text, (row.classTags || []).join(' '), row.aiSummary, (row.aiFacts || []).join(' '), row.personalNames.join(' '), row.personalNote].join(' ').normalize('NFKC').toLowerCase();
    });
    return rows;
  }
  /* 先在本机解析内部代号；RAG 文档中的人工资料独立标注来源。 */
  function resolve(query, rows) {
    var q = String(query || ''); var normalized = global.QuickTags ? QuickTags.fold(q) : q.toLowerCase(); var hits = [];
    (rows || []).forEach(function (row) {
      (row.personalNames || []).forEach(function (name) {
        var alias = QuickTags.fold(name); if (!alias) return;
        var at = normalized.indexOf(alias);
        if (at < 0) return;
        var before = normalized[at - 1] || ''; var after = normalized[at + alias.length] || '';
        if (/^[a-z0-9]+$/.test(alias) && (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after))) return;
        hits.push({ row: row, alias: alias });
      });
    });
    var ids = new Set(); var matched = hits.filter(function (hit) { if (ids.has(hit.row.id)) return false; ids.add(hit.row.id); return true; });
    var external = normalized;
    hits.sort(function (a, b) { return b.alias.length - a.alias.length; }).forEach(function (hit) { external = external.split(hit.alias).join(hit.row.pageTitle || hit.row.title || hit.row.host || '该网站'); });
    var counts = new Map(); hits.forEach(function (hit) { var ids = counts.get(hit.alias) || new Set(); ids.add(key(hit.row.url)); counts.set(hit.alias, ids); });
    return { ambiguous: Array.from(counts.values()).some(function (ids) { return ids.size > 1; }), rows: matched.map(function (hit) { return hit.row; }), query: hits.length ? external : q };
  }
  function independent(query, rows) {
    if (!global.QuickTags) return [];
    var existing = new Set((rows || []).map(function (row) { return key(row.url); }));
    var all = QuickTags.list().filter(function (tag) { return !existing.has(key(tag.url)); }).map(function (tag) {
      return { id: 'quick:' + tag.id, title: tag.host, host: tag.host, url: tag.url, personalNames: [tag.label].concat(tag.aliases || []), personalNote: tag.note || '', text: '', desc: '', hay: '' };
    });
    var exact = new Set(resolve(query, all).rows.map(function (r) { return r.id; }));
    var matched = new Set(QuickTags.search(query, {}).pinned.map(function (t) { return 'quick:' + t.id; }));
    return all.filter(function (row) { return exact.has(row.id) || matched.has(row.id); });
  }
  global.PersonalTargets = { records: records, describe: describe, hydrate: hydrate, apply: apply, resolve: resolve, independent: independent };
})(typeof self !== 'undefined' ? self : window);
