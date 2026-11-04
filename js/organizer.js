/* 分类元数据与收件箱的本地相似收藏召回。 */
(function (global) {
  'use strict';
  async function get(id) { return AgentDB.getMeta('class:' + id); }
  async function records(rows) {
    var out = {};
    await Promise.all(rows.map(async function (row) {
      var value = await get(row.id);
      if (value && value.url === row.url) out[row.id] = value;
    }));
    return out;
  }
  function publicSummary(page) {
    return page && page.status === 'ok' && page.source === 'public' && !page.private
      ? String(page.desc || page.text || '').trim().slice(0, 360) : '';
  }

  function evidence(row, pages, metadata) {
    var page = pages[ContentIndex.normUrl(row.url)];
    var summary = publicSummary(page);
    var meta = metadata[row.id];
    return { summary: summary, tags: summary && meta && Array.isArray(meta.tags) ? meta.tags.slice(0, 4) : [] };
  }

  function similar(rows, pages, metadata, reviewing) {
    var examples = rows.map(function (row) {
      var info = evidence(row, pages, metadata);
      return Object.assign({}, row, {
        desc: info.summary,
        hay: [row.title, info.summary].concat(Bookmarks.parseUrl(row.url).segs, info.tags).join(' ').normalize('NFKC').toLowerCase()
      });
    });
    return function (row, info) {
      var pathTerms = Bookmarks.parseUrl(row.url).segs.filter(function (term) {
        return !/^(?:\d+|api|src|index|guide|wiki)$/i.test(term) && (term.length > 2 || /[^\x00-\x7F]/.test(term));
      }).slice(0, 6);
      var queries = [row.title, info.summary].concat(info.tags, pathTerms).map(function (value) {
        return String(value || '').normalize('NFKC').trim().replace(/^(首页|登录|管理系统|文档|home|login|docs?)$/i, '');
      });
      var candidates = new Map();
      Bookmarks.recall(reviewing ? examples.filter(function (example) { return example.id !== row.id; }) : examples, queries, 12).forEach(function (hit) {
        var example = hit.row;
        if (!candidates.has(example.parentId) && candidates.size < 3) candidates.set(example.parentId, []);
        var titles = candidates.get(example.parentId);
        var title = String(example.title || '').slice(0, 80);
        if (titles && titles.length < 3 && title && !titles.includes(title)) titles.push(title);
      });
      return candidates;
    };
  }

  global.Organizer = { get: get, records: records, publicSummary: publicSummary, evidence: evidence, similar: similar };
})(typeof self !== 'undefined' ? self : window);
