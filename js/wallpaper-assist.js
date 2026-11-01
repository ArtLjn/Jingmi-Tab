/* 描述式检索：把一整句中文描述拆成「主体 / 场景 / 光线 / 风格 / 色调」概念词，
   组合成多条检索式分别投给不同图源，并按命中概念给结果加权排序。

   设计取舍：
   - 纯词表匹配，不发请求也不要求配置，离线可用；词表只收常见摄影题材词，宁缺毋滥。
   - 不给海外图源塞中文：概念词自带英文，组合检索式时直接输出英文。
   - 排序只在同一页内做，不改变图源之间的配额，避免一个图源被压没。
   - 配置了 AI 时可以用 aiKeywords 让模型补充检索词，失败就退回词表结果。 */
(function (global) {
  'use strict';

  var WEIGHT = { subject: 3, scene: 2, style: 2, light: 1, color: 1 };

  var CONCEPTS = {
    subject: {
      '女生': 'woman', '女孩': 'girl', '女人': 'woman', '女性': 'woman', '少女': 'young woman',
      '美女': 'beautiful woman', '人像': 'portrait', '男生': 'man', '男孩': 'boy', '男人': 'man',
      '情侣': 'couple', '背影': 'back view', '侧脸': 'side profile', '儿童': 'child',
      '老人': 'elderly', '猫': 'cat', '狗': 'dog', '鸟': 'bird', '花': 'flower',
      '白裙': 'white dress', '长裙': 'long dress', '婚纱': 'wedding dress', '西装': 'suit',
      '毛衣': 'sweater', '校服': 'uniform', '汉服': 'hanfu', '连衣裙': 'dress'
    },
    scene: {
      '海边': 'beach', '沙滩': 'seaside', '海': 'ocean', '城市': 'city', '街道': 'street',
      '森林': 'forest', '雪山': 'snow mountain', '山': 'mountain', '沙漠': 'desert',
      '咖啡店': 'cafe', '咖啡馆': 'cafe', '房间': 'room', '窗边': 'window', '雨中': 'rain',
      '图书馆': 'library', '田野': 'field', '湖': 'lake', '花海': 'flower field',
      '地铁': 'subway', '书店': 'bookstore', '天空': 'sky', '公路': 'road', '古镇': 'old town'
    },
    light: {
      '日落': 'sunset', '黄昏': 'dusk', '日出': 'sunrise', '清晨': 'morning', '夜晚': 'night',
      '夜景': 'night view', '霓虹': 'neon', '逆光': 'backlight', '柔光': 'soft light',
      '剪影': 'silhouette', '晨雾': 'morning fog', '雨天': 'rainy', '阴天': 'overcast'
    },
    style: {
      '胶片': 'film', '电影感': 'cinematic', '极简': 'minimal', '复古': 'vintage', '日系': 'japanese',
      '油画': 'oil painting', '赛博朋克': 'cyberpunk', '黑白': 'monochrome', '国风': 'chinese style',
      '古风': 'chinese style', '插画': 'illustration', '动漫': 'anime', '水彩': 'watercolor',
      '写实': 'realistic', '街拍': 'street photography', '氛围': 'moody'
    },
    color: {
      '蓝调': 'blue tone', '暖色': 'warm tone', '冷色': 'cool tone', '莫兰迪': 'muted tone',
      '金色': 'golden', '粉紫': 'pink purple'
    }
  };

  var GROUPS = ['subject', 'scene', 'style', 'light', 'color'];

  /** 拆词：按词表命中，长词优先，避免「海边」和「海」重复命中。 */
  function analyze(text) {
    var value = String(text || '').trim();
    var hits = [];
    var taken = '';
    if (!value) return hits;
    GROUPS.forEach(function (group) {
      var words = Object.keys(CONCEPTS[group]).sort(function (a, b) { return b.length - a.length; });
      words.forEach(function (word) {
        if (taken.indexOf(word) >= 0) return;
        if (value.toLowerCase().indexOf(word.toLowerCase()) < 0) return;
        taken += '|' + word;
        hits.push({ group: group, zh: word, en: CONCEPTS[group][word], weight: WEIGHT[group] || 1 });
      });
    });
    /* 按出现位置重排，保留用户的描述顺序，组合出的检索式更自然。 */
    hits.sort(function (a, b) { return value.indexOf(a.zh) - value.indexOf(b.zh); });
    return hits;
  }

  function groupWords(hits, groups) {
    return hits.filter(function (hit) { return groups.indexOf(hit.group) >= 0; });
  }

  function joinWords(list, key) {
    var seen = '';
    return list.map(function (hit) { return hit[key]; }).filter(function (word) {
      if (!word || seen.indexOf('|' + word + '|') >= 0) return false;
      seen += '|' + word + '|';
      return true;
    }).join(' ');
  }

  /** 概念组合 → 3 条以内的检索式；没有命中任何概念时返回空数组。 */
  function combine(text, key) {
    var hits = analyze(text);
    if (!hits.length) return [];
    var plans = [
      hits,
      groupWords(hits, ['subject', 'scene']),
      groupWords(hits, ['subject', 'style', 'light']),
      groupWords(hits, ['scene', 'style', 'light', 'color'])
    ];
    var out = [];
    plans.forEach(function (plan) {
      var words = joinWords(plan, key);
      if (words && out.indexOf(words) < 0) out.push(words);
    });
    return out.slice(0, 3);
  }

  function zhVariants(text) { return combine(text, 'zh'); }
  function enVariants(text) { return combine(text, 'en'); }

  /** 命中加权：标题权重最高，标签与作者名次之。 */
  function score(item, text) {
    var hits = analyze(text);
    if (!hits.length) return 0;
    var title = String(item && item.title || '').toLowerCase();
    var tags = String(item && (item.tags || item.alt) || '').toLowerCase();
    var total = 0;
    hits.forEach(function (hit) {
      var weight = hit.weight;
      if (title.indexOf(hit.zh) >= 0 || title.indexOf(hit.en.toLowerCase()) >= 0) total += weight * 2;
      else if (tags.indexOf(hit.zh) >= 0 || tags.indexOf(hit.en.toLowerCase()) >= 0) total += weight;
    });
    return total;
  }

  /** 仅在有概念命中时排序，且保持同分条目的原有次序。 */
  function rank(items, text) {
    if (!items || items.length < 2) return items;
    var hits = analyze(text);
    if (hits.length < 1) return items;
    return items.map(function (item, index) { return { item: item, index: index, score: score(item, text) }; })
      .sort(function (a, b) { return b.score - a.score || a.index - b.index; })
      .map(function (row) { return row.item; });
  }

  /* 联想用的常见组合：用户只写了主体或只写了场景时，补一个搭配。 */
  var PAIRS = [
    ['女生', '海边', '日落'], ['女生', '城市', '夜景'], ['女生', '森林', '晨雾'],
    ['人像', '窗边', '柔光'], ['人像', '胶片', '复古'], ['街拍', '城市', '雨天'],
    ['风景', '雪山', '日出'], ['风景', '湖', '黄昏'], ['动漫', '少女', '天空'],
    ['情侣', '海边', '剪影'], ['猫', '窗边', '阳光'], ['古镇', '清晨', '胶片']
  ];

  /* 补词只补充氛围 / 光线 / 风格，不补会与已有场景冲突的词（例如「日落」后不再补「夜景」）。 */
  var COMPLEMENTS = ['胶片', '柔光', '剪影', '晨雾', '雨天', '复古', '电影感', '极简', '低饱和', '逆光'];

  /* 与已有场景冲突的补词不出现：「夜景」后面不会再补「晨雾」。 */
  var CONFLICT = { '晨雾': ['夜景', '夜晚', '霓虹'], '逆光': ['夜景', '夜晚'], '柔光': ['霓虹'] };

  /**
   * 本地联想：取用户描述最靠前的两个概念做种子，再补一个还没写到的维度词。
   * 不整句照抄，否则多条建议只是把原句越接越长。
   */
  function suggest(text, limit) {
    var value = String(text || '').trim();
    var max = Math.max(1, limit || 4);
    var hits = analyze(value);
    if (!hits.length) return PAIRS.slice(0, max).map(function (pair) { return pair.join(' '); });
    var seed = hits.slice(0, 2).map(function (hit) { return hit.zh; });
    var used = hits.map(function (hit) { return hit.zh; });
    var out = [];
    COMPLEMENTS.forEach(function (word) {
      if (used.indexOf(word) >= 0) return;
      if ((CONFLICT[word] || []).some(function (clash) { return used.indexOf(clash) >= 0; })) return;
      var phrase = seed.concat([word]).join(' ');
      if (out.indexOf(phrase) < 0) out.push(phrase);
    });
    return out.slice(0, max);
  }

  /**
   * AI 联想：让模型把口语描述压成 3-5 个检索短语。
   * 只做检索词，不生成图片描述，也不返回站外链接。
   */
  var AI_SYSTEM = [
    '你是壁纸检索助手。把用户的一句描述转成 3-5 个适合图库搜索的短语。',
    '要求：',
    '- 每个短语 2-5 个词，用空格分隔，优先中文；不要标点、序号、引号',
    '- 保留主体（人物 / 动物 / 景物），再补场景、光线、风格',
    '- 不要解释，不要编造不存在的专有名词',
    '只输出 JSON：{"q":["海边 女生 日落","女生 背影 胶片"]}'
  ].join('\n');

  async function aiKeywords(cfg, text) {
    var query = String(text || '').trim();
    if (!query) return { ok: false, error: 'empty_query' };
    if (!global.AI || typeof AI.chat !== 'function') return { ok: false, error: 'not_configured' };
    if (!AI.available(cfg)) return { ok: false, error: 'not_configured' };
    var result = await AI.chat(cfg, AI_SYSTEM, query, { maxTokens: 160, temperature: 0.3, timeout: 8000 });
    if (!result || !result.ok) return { ok: false, error: (result && result.error) || 'bad_response' };
    var parsed = null;
    try { parsed = JSON.parse(String(result.content || '').trim()); } catch (e) { parsed = null; }
    var list = parsed && Array.isArray(parsed.q) ? parsed.q : [];
    var words = list.map(function (item) { return String(item).trim(); })
      .filter(function (item) { return item && item.length <= 24; })
      .slice(0, 5);
    if (!words.length) return { ok: false, error: 'no_keywords' };
    return { ok: true, keywords: words };
  }

  global.WallpaperAssist = {
    analyze: analyze, zhVariants: zhVariants, enVariants: enVariants,
    score: score, rank: rank, suggest: suggest, aiKeywords: aiKeywords
  };
})(window);
