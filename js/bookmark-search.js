/* AI 书签搜索编排：界面只负责展示，采集、召回和模型调用各自独立。 */
(function (global) {
  'use strict';

  function isAddressQuery(q) {
    var value = String(q || '').trim();
    if (!value || value.indexOf(' ') !== -1) return false;
    if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('www.')) return true;
    var host = value.split('/')[0].split(':')[0];
    if (host.indexOf('.') <= 0) return false;
    for (var ch of host) {
      var lower = ch.toLowerCase();
      if (!((lower >= 'a' && lower <= 'z') || (lower >= '0' && lower <= '9') || ch === '.' || ch === '-')) return false;
    }
    return true;
  }

  function isQuestion(q) {
    return ['什么', '啥', '怎么', '如何', '为什么', '哪', '多少', '几个', '是否', '吗', '呢',
      '请问', '有没有', '推荐', '列出', '总结', '解释', '说明', '介绍', '帮我找', '帮我找到']
      .some(function (word) { return String(q || '').includes(word); });
  }

  function numericIdentifiers(q) {
    var ids = [];
    var part = '';
    for (var ch of String(q || '')) {
      if (ch >= '0' && ch <= '9') part += ch;
      else if (part) { if (part.length >= 2) ids.push(part); part = ''; }
    }
    if (part.length >= 2) ids.push(part);
    return ids;
  }

  function exactMatch(hit, ql) {
    var row = hit.row || hit;
    return [row.title, row.url, row.host].some(function (value) {
      return (value || '').toLowerCase().indexOf(ql) !== -1;
    });
  }

  /* 类别词 → 常见站点名。模型改写失败或返回慢时，本地仍能召回。 */
  var LOCAL_EXPAND = {
    '电商': ['购物', '商城', '淘宝', '天猫', '京东'],
    '购物': ['电商', '商城', '淘宝', '京东'],
    '设计': ['Figma', '即时设计', 'Canva', '设计师'],
    '云服务': ['阿里云', '腾讯云', 'AWS', '华为云'],
    '文档': ['飞书', '语雀', 'Notion', '腾讯文档'],
    '项目管理': ['Jira', '禅道', 'Teambition', '飞书项目']
  };

  function localExpansions(q) {
    var out = [];
    Object.keys(LOCAL_EXPAND).forEach(function (key) {
      if (String(q || '').indexOf(key) !== -1) out = out.concat(LOCAL_EXPAND[key]);
    });
    return out;
  }

  function fallback(hits, message, answerRequested) {
    var result = { hits: hits, candidates: hits, message: message };
    if (answerRequested) result.answer = { text: message, sources: [], notice: true };
    return result;
  }

  async function run(options) {
    var rows = options.rows;
    if (global.PersonalTargets) PersonalTargets.apply(rows);
    var q = options.query;
    var ql = String(q || '').toLowerCase();
    var cfg = options.cfg;
    // 界面明确进入问答模式时，关键词、英文和省略问号的表达也要生成回答。
    var answerRequested = options.answer === true || isQuestion(q);
    var current = options.current || function () { return true; };
    var progress = options.progress || function () {};
    var onAnswer = options.onAnswer || function () {};
    var local = Bookmarks.query(rows, q, 30);
    var personal = global.PersonalTargets ? PersonalTargets.resolve(q, rows) : { rows: [], query: q };
    personal.rows.forEach(function (row) { if (!local.some(function (hit) { return hit.row.id === row.id; })) local.unshift({ row: row, score: 120 }); });
    if (global.PersonalTargets) PersonalTargets.independent(q, rows).forEach(function (row) { local.push({ row: row, score: 120 }); });
    if (personal.ambiguous) return fallback(personal.rows.map(function (row) { return { row: row, score: 120 }; }), '此称呼对应多个入口，请先选择或补充具体名称', answerRequested);
    if (personal.rows.length) local = personal.rows.map(function (row) { return { row: row, score: 120 }; });
    if (personal.rows.length || local.some(function (hit) { return String(hit.row.id).startsWith('quick:'); })) {
      if (!local.some(function (hit) { return String(hit.row.text || hit.row.retrievedText || '').trim(); })) return fallback(local, '已找到相关入口，但尚无可用正文，无法据此回答具体流程', answerRequested);
      q = personal.query;
    }
    if (isQuestion(q)) {
      var ids = numericIdentifiers(q);
      if (ids.length) {
        rows.forEach(function (row) {
          if (!ids.some(function (id) { return String(row.title || '').includes(id); })) return;
          if (!local.some(function (hit) { return String(hit.row.id) === String(row.id); })) {
            local.unshift({ row: row, score: 100 });
          }
        });
      }
    }
    if (!current()) return null;

    if (isAddressQuery(q) && (options.answer !== true || !local.length)) {
      var addressMessage = local.length ? '按地址精确匹配 · 共 ' + local.length + ' 条' : '本地没有匹配的地址收藏';
      progress(addressMessage, local);
      return fallback(local, addressMessage, options.answer === true);
    }

    progress(local.length ? '本地已找到 ' + local.length + ' 条，AI 正在回答…' : '正在查找相关收藏…', local);
    var cands = local;
    var remote = { hits: [] };
    if (!cands.length || (isQuestion(q) && cands.length >= 3)) {
      var remoteTask = options.rag && typeof Rag !== 'undefined' && Rag.available(options.rag)
        ? Rag.retrieve(options.rag, q, rows).then(function (hits) { return { hits: hits }; }, function (e) { return { hits: [], failed: true, error: e.message }; })
        : Promise.resolve({ hits: [] });
      var rewriteTask = AI.available(cfg)
        ? AI.rewrite({ cfg: cfg, query: q, signal: options.signal }).catch(function () { return { ok: false }; })
        : Promise.resolve({ ok: false });
      var results = await Promise.all([rewriteTask, remoteTask]);
      if (!current()) return null;
      var terms = [q].concat(results[0].ok ? results[0].keywords : []).concat(localExpansions(q));
      remote = results[1];
      var byBookmark = new Map();
      var fused = new Map();
      [Bookmarks.recall(rows, Array.from(new Set(terms)), 30), remote.hits].forEach(function (list) {
        list.forEach(function (hit, rank) {
          var id = String(hit.row.id);
          byBookmark.set(id, hit.source === 'rag' ? hit : byBookmark.get(id) || hit);
          fused.set(id, (fused.get(id) || 0) + 1 / (20 + rank));
        });
      });
      cands = Array.from(fused).sort(function (a, b) { return b[1] - a[1]; })
        .slice(0, 30).map(function (entry) { return byBookmark.get(entry[0]); });
      if (cands.length) progress('AI 正在回答…', cands);
    }
    if (!cands.length) return fallback([], remote.failed
      ? '云端检索暂不可用，本地也未找到相关收藏' : '没有找到相关收藏，可先采集正文后重试', answerRequested);
    if (!AI.available(cfg)) return fallback(cands, remote.failed ? 'RAG 检索失败 · ' + remote.error + ' · 已显示本地结果' : remote.hits.length ? 'RAG 已召回 ' + remote.hits.length + ' 条收藏 · 未配置 AI 回答' : '已显示本地收藏 · 未配置 AI 回答', answerRequested);

    var byId = new Map(cands.map(function (h) { return [String(h.row.id), h]; }));
    if (answerRequested && typeof BookmarkAnswer !== 'undefined' && BookmarkAnswer.available(cfg) &&
        typeof BookmarkAnswer.runStream === 'function') {
      progress('AI 正在组织回答…', cands);
      var streamed;
      var evidenceCands = [];
      var evidenceIds = new Set();
      cands.forEach(function (hit) {
        var id = String(hit.row.id);
        if (evidenceIds.has(id)) return;
        evidenceIds.add(id);
        evidenceCands.push(hit);
      });
      try {
        streamed = await BookmarkAnswer.runStream({
          cfg: cfg, query: q, cands: evidenceCands,
          shouldContinue: current, signal: options.signal,
          onDelta: function (delta, full) { onAnswer({ text: full, sources: [], streaming: true }); }
        });
      } catch (e) { streamed = { ok: false, error: 'network' }; }
      if (!current()) return null;
      if (streamed.ok && streamed.answer) {
        var answerHits = [];
        (streamed.sources || []).forEach(function (source) {
          var hit = byId.get(String(source.id));
          if (!hit || answerHits.some(function (p) { return p.row.id === hit.row.id; })) return;
          answerHits.push({ row: hit.row, score: 100, why: '' });
        });
        cands.filter(function (hit) { return exactMatch(hit, ql); }).forEach(function (hit) {
          if (!answerHits.some(function (p) { return p.row.id === hit.row.id; })) answerHits.push(hit);
        });
        var answerSources = (streamed.sources || []).map(function (source) {
          var hit = byId.get(String(source.id));
          return {
            id: source.id, marker: source.marker || 0,
            title: hit.row.title || hit.row.url, host: hit.row.host || '',
            url: hit.row.url, folder: hit.row.folder || '', why: ''
          };
        });
        onAnswer({ text: streamed.answer, sources: answerSources, streaming: false, incomplete: !!streamed.incomplete });
        return {
          hits: answerHits.length ? answerHits : cands,
          candidates: cands,
          message: answerSources.length ? 'AI 回答 · 引用 ' + answerSources.length + ' 条收藏' : 'AI 回答 · 基于收藏资料',
          answer: { text: streamed.answer, sources: answerSources, incomplete: !!streamed.incomplete }
        };
      }
      return fallback(cands, streamed.error === 'no_evidence'
        ? '收藏缺少可用内容，暂时无法回答，已显示本地结果' : 'AI 回答暂不可用（' + AI.errText(streamed.error) + '），已显示本地结果', true);
    }
    if (answerRequested) return fallback(cands, '问答模块暂不可用，请重新加载扩展后再试，已保留相关收藏', true);
    var result;
    try { result = await AI.rerank({ cfg: cfg, query: q, hits: cands, topN: 20, memoryId: options.memoryId, signal: options.signal }); }
    catch (e) { result = { ok: false, error: 'network' }; }
    if (!current()) return null;
    if (!result.ok) return { hits: cands, candidates: cands, message: AI.errText(result.error) + ' · 已按本地排序显示' };
    var picks = result.picks.filter(function (p) { return byId.has(String(p.id)); }).map(function (p) {
      return { row: byId.get(String(p.id)).row, score: 100, why: p.why };
    });
    cands.filter(function (hit) { return exactMatch(hit, ql); }).forEach(function (hit) {
      if (!picks.some(function (pick) { return pick.row.id === hit.row.id; })) picks.push(hit);
    });
    return { hits: picks.length ? picks : cands, candidates: cands, message: picks.length
      ? '找到 ' + picks.length + ' 条匹配书签' : '以下是可能相关的书签，请继续核对内容' };
  }

  global.BookmarkSearch = { run: run, isAddressQuery: isAddressQuery };
})(typeof self !== 'undefined' ? self : window);
