/* ============================================================
   daily-quote.js —— 每日一言取数层

   职责：
     1. 多个线上数据源（今日诗词 / 一言 hitokoto 不同品类）分级降级；
     2. 主题按「一年中的第几天」轮换，让相邻日期的风格不撞；
     3. 纯本地能力：文本归一化、历史去重、低质与敏感内容过滤、断网兜底句库。

   设计取舍：
     · hitokoto 对同一 IP 有短时缓存，同一秒内多次请求会拿到同一句，
       因此每次请求都追加随机参数强制换一条（这是「每天都是同一句」的根因）；
     · 去重靠「最近 60 条已用文本」的归一化比对，而不是随机重取，
       随机重取在小句库里命中率低，会出现连续几天撞句；
     · 本地句库是现代口语化的自撰短句，刻意避开被用烂的励志腔，
       既是断网兜底，也是线上源全挂时最后的体面。

   本文件不含 DOM 与 chrome.* 调用，纯函数 + 可注入 fetch，便于单测。
   ============================================================ */
(function (global) {
  'use strict';

  var HISTORY_MAX = 60;      // 最近记住多少条，用于去重
  var FROM_MAX = 12;         // 最近记住多少个出处，避免连着几天同一首诗 / 同一部剧
  var TIMEOUT = 5000;        // 单个源的超时
  var RETRY = 3;             // 单源内遇到重复 / 低质内容时的重试次数

  var HISTORY_KEY = 'quoteHistoryV2';
  var FROM_KEY = 'quoteFromsV2';
  var CACHE_KEY = 'dailyQuoteV2';

  /* 这些出处太宽泛，不当成「重复」处理，否则一整类内容都会被挡掉。 */
  var GENERIC_FROMS = ['', '网络', '佚名', '网友', '未知', '原创', '来自网络'];

  /* 陈旧腔调黑名单：「只有……才能……」「愿你余生」这类被用烂的鸡汤是用户的核心抱怨点，
     与其展示不如换一条。宁可多请求一次，也不让新标签页回到十年前的朋友圈。 */
  var VETO_WORDS = [
    '只有', '才能', '愿你', '余生', '岁月静好', '你若', '心若', '不忘初心',
    '正能量', '加油', '梦想', '努力就', '做最好的自己', '人生就像', '人生就是',
    '你要相信', '请记住', '别放弃', '熬过去', '坚持下去', '一切都会好的'
  ];

  /* 官媒 / 公众号腔出处：句式多是标语，不适合当每日一句。 */
  var VETO_FROMS = ['光明日报', '人民日报', '新华社', '央视', '共青团', '环球时报', '观察者网', '澎湃', 'Qihoo', 'QQ空间'];

  /* ------------------------- 数据源 -------------------------
     每个源只需提供 url / 可选 cats / parse(data) -> {text, from}。
     order 决定同一天内谁先被尝试；主题轮换会在此基础上整体错位。 */
  var THEMES = [
    {
      id: 'poem',
      name: '今日诗词',
      url: 'https://v2.jinrishici.com/one.json',
      parse: parsePoem
    },
    {
      id: 'scene',
      name: '影视 · 歌词',
      url: 'https://v1.hitokoto.cn/',
      cats: ['h', 'j', 'f'],        // 影视台词 / 网易云 / 来自网络
      parse: parseHitokoto
    },
    {
      id: 'mind',
      name: '清醒 · 抖机灵',
      url: 'https://v1.hitokoto.cn/',
      cats: ['k', 'l'],             // 哲学清醒 / 抖机灵
      parse: parseHitokoto
    }
  ];

  /* ------------------------- 内容过滤 -------------------------
     新标签页是打开浏览器的「第一眼」，需要挡掉政治指向、低俗攻击与灌水句。 */
  var BLOCK_WORDS = [
    '毛泽东', '习近平', '邓小平', '江泽民', '胡锦涛', '蒋介石', '孙中山',
    '马克思', '恩格斯', '列宁', '斯大林', '希特勒', '特朗普', '普京', '金正恩',
    '共产党', '国民党', '文革', '六四', '台独', '藏独', '疆独', '法轮',
    '妈的', '他妈', '傻逼', '傻B', '操你', '草你', '婊', '贱人', '屁眼',
    '狗屎', '滚蛋', '去死', '死全家', '你妈'
  ];

  /* ------------------------- 本地兜底句库 -------------------------
     断网 / 全部源异常时使用；与线上源风格互补：有人味、有具体场景。 */
  var LOCAL_BANK = [
    '把今天过完，就已经算件了不起的事',
    '慢不是问题，停才是',
    '很多答案不在想里，在走路里',
    '情绪上来时先别做决定，先喝口水',
    '你先坐下，灵感自然会来找你',
    '把话说短，把事做长',
    '能说清楚的事，多半不算难事',
    '你不是效率低，是任务太碎',
    '别人的进度条，和你的不是同一部电影',
    '睡得够，比任何方法论都管用',
    '今天先啃最难的那块，剩下的会自己变轻',
    '焦虑的反面不是躺平，是具体',
    '世界不会因为你着急而加速',
    '允许自己做得一般，才做得长久',
    '拒绝也是一种时间管理',
    '不在深夜做决定，深夜的人不分轻重',
    '计划赶不上变化，但计划能让变化没那么慌',
    '忙起来容易，想明白难',
    '所有捷径最后都要还，还的是基础',
    '所谓自律，是给未来的自己少添点麻烦',
    '身体是唯一的硬件，别一边超频一边抱怨卡顿',
    '真正的好东西都很慢：茶、汤、关系、能力',
    '所谓成熟，不是不生气，是生气时还记得收尾',
    '给自己留一点没用的时间，那是回血的地方',
    '一天做好三件事，比列三十件更像成功',
    '专业不是不出错，是出错时知道下一步',
    '忍住的那些话，往往比说出来的更有分量',
    '问题不会因为不看它而消失，但会因为你睡饱了而变小',
    '把桌面清空，把杯子洗净，人也会清醒一点',
    '不必每次都说服别人，沉默也是一种回答',
    '想得太多的时候，就去洗个碗',
    '不着急的人往往走得更远，因为他没在跑别人的路线',
    '喜欢的句子抄下来，日子久了就是自己的',
    '不要把疲惫误认成无能',
    '先学会好好休息，再谈长期主义',
    '把事情做完，比把事做完美更有用',
    '今天的天气不支持宏大叙事，适合把小事收尾',
    '会拒绝的人，时间才真正属于自己',
    '相处舒服的关系，通常不需要用力',
    '一步走不通，就换一个方向，不是换一个自己',
    '情绪是天气，不是气候',
    '说「我试试」，比说「我不行」多一条路',
    '不必把每段关系都修好，有些只需要放下',
    '认真对待一顿饭，就不算虚度一天',
    '人需要的是节奏，不是冲刺',
    '把视线从屏幕抬起来，世界还在原地等你',
    '真正难的从来不是开始，是每天重新开始',
    '今天的你不需要完美，只需要在场'
  ];

  /* ------------------------- 纯函数 ------------------------- */

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  /** 本地日期键：2026-11-01 */
  function dateKey(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /** 一年中的第几天（1 起），用于主题轮换与句库取位。 */
  function dayOfYear(d) {
    d = d || new Date();
    var start = new Date(d.getFullYear(), 0, 0);
    return Math.floor((d - start) / 86400000);
  }

  /** 归一化：去掉空白与常见标点，只比对文字本身，防止「换个标点」绕过去重。 */
  function normalize(text) {
    return String(text == null ? '' : text)
      .replace(/[\s\u3000]/g, '')
      .replace(/[，。、！？；：""''《》（）()【】…—·,.!?;:'"()\[\]\-~～`]/g, '')
      .toLowerCase();
  }

  /** 内容是否可用：长度合理、正文与出处都不命中屏蔽词、不落进陈旧腔调。 */
  function isAcceptable(item) {
    if (!item || !item.text) return false;
    var text = item.text;
    if (text.length < 5 || text.length > 80) return false;
    // 中文新标签页上突然出现一句英文很跳，至少要有 4 个汉字
    var hanzi = text.match(/[\u4e00-\u9fa5]/g);
    if (!hanzi || hanzi.length < 4) return false;
    var from = item.from || '';
    var haystack = text + ' ' + from;
    var i;
    for (i = 0; i < BLOCK_WORDS.length; i++) {
      if (haystack.indexOf(BLOCK_WORDS[i]) !== -1) return false;
    }
    for (i = 0; i < VETO_FROMS.length; i++) {
      if (from.indexOf(VETO_FROMS[i]) !== -1) return false;
    }
    for (i = 0; i < VETO_WORDS.length; i++) {
      if (text.indexOf(VETO_WORDS[i]) !== -1) return false;
    }
    return true;
  }

  /** 该句是否已在最近历史里出现过。 */
  function wasUsed(history, text) {
    var key = normalize(text);
    if (!key || !history || !history.length) return false;
    return history.indexOf(key) !== -1;
  }

  /** 写入历史（最新在前，去重，截断到 HISTORY_MAX），返回新数组。 */
  function remember(history, text) {
    var key = normalize(text);
    var list = (history || []).filter(function (item) { return item !== key; });
    if (!key) return list;
    list.unshift(key);
    if (list.length > HISTORY_MAX) list.length = HISTORY_MAX;
    return list;
  }

  /** 出处去重：宽泛出处（网络 / 佚名…）不参与，避免误伤。 */
  function wasFromRecent(recentFroms, from) {
    var value = String(from || '').trim();
    if (!value || !recentFroms || !recentFroms.length) return false;
    if (GENERIC_FROMS.indexOf(value) !== -1) return false;
    return recentFroms.indexOf(value) !== -1;
  }

  /** 记录出处（最新在前，截断到 FROM_MAX），宽泛出处不入库。 */
  function rememberFrom(recentFroms, from) {
    var value = String(from || '').trim();
    var list = (recentFroms || []).filter(function (item) { return item !== value; });
    if (!value || GENERIC_FROMS.indexOf(value) !== -1) return list;
    list.unshift(value);
    if (list.length > FROM_MAX) list.length = FROM_MAX;
    return list;
  }

  function parseHitokoto(data) {
    if (!data || !data.hitokoto) throw new Error('empty');
    var fromWho = data.from_who || '';
    var origin = data.from || '';
    var from = '';
    // 出处与作者相同（如「咸鱼君ps《咸鱼君ps》」）属于灌水数据，只留一个
    if (fromWho && origin && fromWho !== origin) from = fromWho + '《' + origin + '》';
    else from = fromWho || origin;
    return { text: String(data.hitokoto).trim(), from: from };
  }

  function parsePoem(data) {
    if (!data || data.status !== 'success' || !data.data || !data.data.content) {
      throw new Error('empty');
    }
    var origin = data.data.origin || {};
    var from = origin.author && origin.title ? origin.author + '《' + origin.title + '》'
      : (origin.author || origin.title || '');
    return { text: String(data.data.content).trim(), from: from };
  }

  /** 拼请求地址：追加品类与随机参数（随机参数用于绕开服务端短时缓存）。 */
  function urlFor(theme, salt) {
    var url = theme.url;
    var sep = url.indexOf('?') === -1 ? '?' : '&';
    if (theme.cats && theme.cats.length) {
      url += sep + theme.cats.map(function (c) { return 'c=' + c; }).join('&');
      sep = '&';
    }
    var rand = salt != null ? salt : (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    return url + sep + '_=' + rand;
  }

  /** 当天要尝试的数据源顺序：按日序整体错位，使相邻日期的首选主题不同。 */
  function planFor(dayIndex) {
    var offset = Math.abs(dayIndex || 0) % THEMES.length;
    var plan = [];
    for (var i = 0; i < THEMES.length; i++) plan.push(THEMES[(offset + i) % THEMES.length]);
    return plan;
  }

  /** 本地兜底：从当天对应的位置开始找第一条近期没用过的句子。 */
  function pickLocal(dayIndex, history, bank) {
    var list = bank && bank.length ? bank : LOCAL_BANK;
    var start = Math.abs(dayIndex || 0) % list.length;
    for (var i = 0; i < list.length; i++) {
      var text = list[(start + i) % list.length];
      if (!wasUsed(history, text)) return text;
    }
    return list[start];
  }

  /* ------------------------- 网络层 ------------------------- */

  function request(theme, opts) {
    opts = opts || {};
    var fetchImpl = opts.fetchImpl || global.fetch;
    var timeout = opts.timeout || TIMEOUT;
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeout);
    var init = { cache: 'no-store' };
    if (ctrl) init.signal = ctrl.signal;

    var task = Promise.resolve()
      .then(function () { return fetchImpl(urlFor(theme, opts.salt)); })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) { return theme.parse(data); });

    return task.then(function (item) {
      clearTimeout(timer);
      return item;
    }, function (err) {
      clearTimeout(timer);
      throw err || new Error('network');
    });
  }

  /** 单源尝试：内容不合格优先重取，重试用尽则报错；撞历史 / 撞近期出处则在额度内重取。 */
  function attempt(theme, round, opts, history) {
    return request(theme, opts).then(function (item) {
      if (!item || !item.text) throw new Error('empty');
      if (!isAcceptable(item)) {
        if (round < RETRY) return attempt(theme, round + 1, opts, history);
        throw new Error('rejected');
      }
      var repeatedText = wasUsed(history, item.text);
      if (repeatedText && round < RETRY) {
        return attempt(theme, round + 1, opts, history);
      }
      // 同一出处（尤其热门诗篇）连着出现比换主题更伤体验：重试用尽就降级到下一个源
      if (wasFromRecent(opts.recentFroms, item.from)) {
        if (round < RETRY) return attempt(theme, round + 1, opts, history);
        throw new Error('dup-from');
      }
      return item;
    });
  }

  /**
   * 取当天的一句话。
   * @param {object} opts {dayIndex, history, recentFroms, fetchImpl, timeout}
   * @returns {Promise<{text, from, source}>} 全部源失败时 reject
   */
  function pick(opts) {
    opts = opts || {};
    var dayIndex = opts.dayIndex == null ? dayOfYear(new Date()) : opts.dayIndex;
    var history = opts.history || [];
    var plan = planFor(dayIndex);

    return new Promise(function (resolve, reject) {
      var index = 0;
      (function step() {
        if (index >= plan.length) { reject(new Error('all-sources-failed')); return; }
        var theme = plan[index++];
        attempt(theme, 1, opts, history).then(function (item) {
          resolve({ text: item.text, from: item.from || '', source: theme.id });
        }, step);
      })();
    });
  }

  global.DailyQuote = {
    THEMES: THEMES,
    LOCAL_BANK: LOCAL_BANK,
    BLOCK_WORDS: BLOCK_WORDS,
    VETO_WORDS: VETO_WORDS,
    VETO_FROMS: VETO_FROMS,
    GENERIC_FROMS: GENERIC_FROMS,
    HISTORY_MAX: HISTORY_MAX,
    FROM_MAX: FROM_MAX,
    RETRY: RETRY,
    HISTORY_KEY: HISTORY_KEY,
    FROM_KEY: FROM_KEY,
    CACHE_KEY: CACHE_KEY,
    dateKey: dateKey,
    dayOfYear: dayOfYear,
    normalize: normalize,
    isAcceptable: isAcceptable,
    wasUsed: wasUsed,
    remember: remember,
    wasFromRecent: wasFromRecent,
    rememberFrom: rememberFrom,
    parseHitokoto: parseHitokoto,
    parsePoem: parsePoem,
    urlFor: urlFor,
    planFor: planFor,
    pickLocal: pickLocal,
    request: request,
    pick: pick
  };
})(typeof self !== 'undefined' ? self : window);
