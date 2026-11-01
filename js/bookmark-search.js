/* AI 书签搜索编排：界面只负责展示，采集、召回和模型调用各自独立。 */
(function (global) {
  'use strict';

  /* 地址型查询：IP、带端口的站点、完整网址和常见域名。 */
  var ADDRESS = [
    /^\d{1,3}(?:\.\d{1,3}){1,3}(?::\d{1,5})?$/,
    /^[a-z0-9.-]+:\d{1,5}$/i,
    /^(?:https?:\/\/|www\.)\S+$/i,
    /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|cn|net|org|io|co|dev|ai|app|me|cc|top|xyz|tech|cloud|site|info|biz|tv|hk|tw|jp|uk|us|de|internal|local|corp|lan)(?::\d{1,5})?(?:\/\S*)?$/i
  ];

  function isAddressQuery(q) {
    var s = String(q || '').trim();
    return !!s && ADDRESS.some(function (re) { return re.test(s); });
  }

  /* 问句直接交给 RAG + 回答，不再先花一次调用做同义词改写。 */
  var QUESTION = /什么|怎么|如何|为什么|哪|多少|是否|能不能|可不可以|吗|呢|请问|有没有|总结|解释|说明一下|介绍一下/;
  function isQuestion(q) {
    return QUESTION.test(String(q || ''));
  }

  function exactMatch(hit, ql) {
    var row = hit.row || hit;
    return [row.title, row.url, row.host].some(function (value) {
      return (value || '').toLowerCase().indexOf(ql) !== -1;
    });
  }

  async function run(options) {
    var rows = options.rows;
    var q = options.query;
    var ql = String(q || '').toLowerCase();
    var cfg = options.cfg;
    var current = options.current || function () { return true; };
    var progress = options.progress || function () {};
    var local = Bookmarks.query(rows, q, 30);

    /* 只有地址型查询走本地精确匹配：IP 不会被语义模型改错，也省掉两轮调用。
       普通关键词仍交给 AI，用户输入 ? 就是明确要模型参与筛选。 */
    if (isAddressQuery(q)) {
      if (!current()) return null;
      var addressMessage = local.length ? '按地址精确匹配 · 共 ' + local.length + ' 条' : '本地没有匹配的地址收藏';
      progress(addressMessage, local);
      return { hits: local, candidates: local, message: addressMessage };
    }

    progress('正在理解描述…', local);
    var remoteTask = options.rag && typeof Rag !== 'undefined' && Rag.available(options.rag)
      ? Rag.retrieve(options.rag, q, rows).then(function (hits) { return { hits: hits }; }, function () { return { hits: [], failed: true }; })
      : Promise.resolve({ hits: [] });
    /* 本地已有足够候选时直接交给重排，省掉一次改写往返；零召回才需要扩展词。 */
    var rewrite = { ok: false };
    /* 问句必须扩展召回：本地命中「网站」不代表命中用户真正想找的电商站点。 */
    if (AI.available(cfg) && (local.length < 3 || isQuestion(q))) {
      try { rewrite = await AI.rewrite({ cfg: cfg, query: q }); }
      catch (e) { rewrite = { ok: false }; }
    }
    var remote = await remoteTask;
    if (!current()) return null;
    var cands = Bookmarks.recall(rows, [q].concat(rewrite.ok ? rewrite.keywords : []), 30);
    var byBookmark = new Map();
    var fused = new Map();
    [cands, remote.hits].forEach(function (list) { list.forEach(function (hit, rank) {
      var id = String(hit.row.id);
      byBookmark.set(id, hit.source === 'rag' ? hit : byBookmark.get(id) || hit);
      fused.set(id, (fused.get(id) || 0) + 1 / (20 + rank));
    }); });
    cands = Array.from(fused).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 30).map(function (entry) { return byBookmark.get(entry[0]); });
    if (!cands.length) return { hits: [], candidates: [], message: remote.failed ? '云端检索暂不可用，本地未找到匹配内容' : '没有找到匹配书签，可在「书签空间」同步内容后重试' };
    progress('正在核对匹配内容…', cands);

    if (!AI.available(cfg)) return { hits: cands, candidates: cands, message: remote.failed ? '云端检索暂不可用 · 已按本地排序显示' : '已找到 ' + cands.length + ' 条候选书签' };

    var byId = new Map(cands.map(function (h) { return [String(h.row.id), h]; }));
    /* 有正文证据时优先回答问题；关键词查询由模型只返回来源，不产生答案。 */
    if (typeof BookmarkAnswer !== 'undefined' && BookmarkAnswer.available(cfg)) {
      progress('AI 正在组织回答…', cands);
      var answered;
      try { answered = await BookmarkAnswer.run({ cfg: cfg, query: q, cands: cands }); }
      catch (e) { answered = { ok: false, error: 'network' }; }
      if (!current()) return null;
      if (answered.ok && (answered.answer || (answered.sources && answered.sources.length))) {
        var picked = [];
        (answered.sources || []).forEach(function (source) {
          var hit = byId.get(String(source.id));
          if (!hit || picked.some(function (p) { return p.row.id === hit.row.id; })) return;
          picked.push({ row: hit.row, score: 100, why: source.why });
        });
        cands.filter(function (hit) { return exactMatch(hit, ql); }).forEach(function (hit) {
          if (!picked.some(function (p) { return p.row.id === hit.row.id; })) picked.push(hit);
        });
        if (answered.answer) {
          return {
            hits: picked.length ? picked : cands,
            candidates: cands,
            message: 'AI 回答 · 引用 ' + (answered.sources || []).length + ' 条收藏',
            answer: {
              text: answered.answer,
              sources: (answered.sources || []).map(function (source) {
                var hit = byId.get(String(source.id));
                return {
                  id: source.id, title: hit.row.title || hit.row.url,
                  host: hit.row.host || '', url: hit.row.url,
                  folder: hit.row.folder || '', why: source.why
                };
              })
            }
          };
        }
        if (picked.length) return { hits: picked, candidates: cands, message: '找到 ' + picked.length + ' 条匹配书签' };
      }
      /* 证据不足或模型失败：继续走原有重排，保留兜底结果。 */
    }

    progress('AI 正在筛选书签…', cands);
    var result;
    try {
      result = await AI.rerank({ cfg: cfg, query: q, hits: cands, topN: 20, memoryId: options.memoryId });
    } catch (e) { result = { ok: false, error: 'network' }; }
    if (!current()) return null;
    if (!result.ok) return { hits: cands, candidates: cands, message: AI.errText(result.error) + ' · 已按本地排序显示' };
    var picks = result.picks.filter(function (p) { return byId.has(String(p.id)); }).map(function (p) {
      return { row: byId.get(String(p.id)).row, score: 100, why: p.why };
    });
    /* 模型选中的排前面；标题、网址或主机精确命中的结果在其后补齐，避免二次隐藏。 */
    cands.filter(function (hit) { return exactMatch(hit, ql); }).forEach(function (hit) {
      if (!picks.some(function (pick) { return pick.row.id === hit.row.id; })) picks.push(hit);
    });
    return { hits: picks.length ? picks : cands, candidates: cands, message: picks.length
      ? '找到 ' + picks.length + ' 条匹配书签'
      : '以下是可能相关的书签，证据不足时请继续核对内容' };
  }

  global.BookmarkSearch = { run: run, isAddressQuery: isAddressQuery };
})(typeof self !== 'undefined' ? self : window);
