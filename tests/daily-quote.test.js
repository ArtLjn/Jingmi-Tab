/* 每日一言：数据源解析、主题轮换、历史去重、内容过滤与降级链的回归测试。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

function context(extra = {}) {
  const c = { setTimeout, clearTimeout, AbortController, console, ...extra };
  c.self = c;
  vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(root, 'js/daily-quote.js'), 'utf8'), c);
  return c;
}

/** 用固定响应队列模拟接口，记录每次请求的地址。队列只剩一项时重复使用。 */
function fakeFetch(seq) {
  const calls = [];
  const impl = (url) => {
    calls.push(url);
    const next = seq.length > 1 ? seq.shift() : seq[0];
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve({ ok: true, json: () => Promise.resolve(next) });
  };
  impl.calls = calls;
  return impl;
}

const poem = (content, author, title) => ({ status: 'success', data: { content, origin: { author, title } } });
const hito = (hitokoto, from, fromWho) => ({ hitokoto, from, from_who: fromWho });

test('解析：诗词带出「作者《篇名》」，一言拼接作者与出处且不重复书名', () => {
  const { DailyQuote } = context();
  assert.deepEqual(
    { ...DailyQuote.parsePoem(poem('空里流霜不觉飞，汀上白沙看不见。', '张若虚', '春江花月夜')) },
    { text: '空里流霜不觉飞，汀上白沙看不见。', from: '张若虚《春江花月夜》' }
  );
  assert.deepEqual(
    { ...DailyQuote.parseHitokoto(hito('我喝过你喝的西北风，这算不算很穷。', '网络', '')) },
    { text: '我喝过你喝的西北风，这算不算很穷。', from: '网络' }
  );
  // 作者与出处同名属于灌水数据，只保留一个
  assert.equal(DailyQuote.parseHitokoto(hito('要是爬太高，跌下来会很疼。', '咸鱼君ps', '咸鱼君ps')).from, '咸鱼君ps');
  assert.equal(DailyQuote.parseHitokoto(hito('要是爬太高，跌下来会很疼。', '某歌', '某人')).from, '某人《某歌》');
  assert.throws(() => DailyQuote.parsePoem({ status: 'fail' }));
  assert.throws(() => DailyQuote.parseHitokoto({}));
});

test('去重：标点与空白归一化后视为同一句，历史按最新在前且截断', () => {
  const { DailyQuote } = context();
  assert.equal(DailyQuote.normalize(' 慢慢来，比较快。 '), DailyQuote.normalize('慢慢来比较快'));
  assert.equal(DailyQuote.wasUsed(['慢慢来比较快'], '慢慢来，比较快。'), true);
  assert.equal(DailyQuote.wasUsed(['别的句子'], '慢慢来，比较快。'), false);
  assert.equal(DailyQuote.wasUsed([], '慢慢来，比较快。'), false);

  let history = [];
  for (let i = 0; i < DailyQuote.HISTORY_MAX + 5; i++) history = DailyQuote.remember(history, '句子' + i);
  assert.equal(history.length, DailyQuote.HISTORY_MAX);
  assert.equal(history[0], DailyQuote.normalize('句子' + (DailyQuote.HISTORY_MAX + 4)));
  // 重复写入不产生重复项
  assert.equal(DailyQuote.remember(history, '句子5').filter((k) => k === '句子5').length, 1);
});

test('过滤：过短、过长、政治指向与低俗内容一律判为不可用', () => {
  const { DailyQuote } = context();
  assert.equal(DailyQuote.isAcceptable({ text: '你好' }), false);
  assert.equal(DailyQuote.isAcceptable({ text: '好'.repeat(81) }), false);
  assert.equal(DailyQuote.isAcceptable({ text: '慢慢来，比较快一点。', from: '' }), true);
  // 正文或出处命中政治人物 / 低俗词都丢弃
  assert.equal(DailyQuote.isAcceptable({ text: '没有调查，没有发言权。', from: '毛泽东' }), false);
  assert.equal(DailyQuote.isAcceptable({ text: '毛泽东说过的一句话在此', from: '' }), false);
  assert.equal(DailyQuote.isAcceptable({ text: '这真是个傻逼世界啊朋友', from: '' }), false);
  // 纯英文 / 符号句不适合中文新标签页
  assert.equal(DailyQuote.isAcceptable({ text: 'Discover, Create and Use.', from: '' }), false);
  assert.equal(DailyQuote.isAcceptable({ text: 'abc', from: '' }), false);
  assert.equal(DailyQuote.isAcceptable(null), false);
});

test('轮换：相邻日期首选主题不同，且每个源都会被轮到', () => {
  const { DailyQuote } = context();
  const seen = new Set();
  for (let day = 0; day < DailyQuote.THEMES.length; day++) {
    const plan = DailyQuote.planFor(day);
    assert.equal(plan.length, DailyQuote.THEMES.length);
    assert.notEqual(plan[0].id, DailyQuote.planFor(day + 1)[0].id);
    assert.equal(new Set(plan.map((t) => t.id)).size, plan.length);
    seen.add(plan[0].id);
  }
  assert.equal(seen.size, DailyQuote.THEMES.length);
});

test('地址：带上品类并追加随机参数，避免命中服务端短时缓存', () => {
  const { DailyQuote } = context();
  const scene = DailyQuote.THEMES.find((t) => t.id === 'scene');
  const url = DailyQuote.urlFor(scene, 'abc123');
  assert.ok(url.startsWith('https://v1.hitokoto.cn/?c=h&c=j&c=f'));
  assert.ok(url.endsWith('_=abc123'));
  assert.ok(DailyQuote.urlFor(DailyQuote.THEMES[0], 'x').includes('one.json?_=x'));
});

test('出处去重：近期出现过的出处不再用，宽泛出处（网络/佚名）不参与', () => {
  const { DailyQuote } = context();
  assert.equal(DailyQuote.wasFromRecent(['苏轼《定风波》'], '苏轼《定风波》'), true);
  assert.equal(DailyQuote.wasFromRecent(['苏轼《定风波》'], '张若虚《春江花月夜》'), false);
  // 宽泛出处不挡，否则网易云、网络段子整类都会失效
  assert.equal(DailyQuote.wasFromRecent(['网络'], '网络'), false);
  assert.equal(DailyQuote.wasFromRecent(['佚名'], '佚名'), false);

  let froms = [];
  for (let i = 0; i < DailyQuote.FROM_MAX + 3; i++) froms = DailyQuote.rememberFrom(froms, '作者' + i + '《篇名》');
  assert.equal(froms.length, DailyQuote.FROM_MAX);
  assert.equal(froms[0], '作者' + (DailyQuote.FROM_MAX + 2) + '《篇名》');
  // 宽泛出处不入库
  assert.deepEqual(DailyQuote.rememberFrom(froms, '网络'), froms);
});

test('取数：首选源命中去重历史时自动重取，拿到新句即用', async () => {
  const dayIndex = 0;                                  // 该日 poem 排第一
  const firstTheme = context().DailyQuote.planFor(dayIndex)[0].id;
  const fetchImpl = fakeFetch([
    poem('空里流霜不觉飞，汀上白沙看不见。', '张若虚', '春江花月夜'),
    poem('滟滟随波千万里，何处春江无月明。', '张若虚', '春江花月夜')
  ]);
  const { DailyQuote } = context({ fetch: fetchImpl });
  const history = [DailyQuote.normalize('空里流霜不觉飞，汀上白沙看不见。')];
  const item = await DailyQuote.pick({ dayIndex, history, fetchImpl, timeout: 50 });
  assert.equal(item.source, firstTheme);
  assert.equal(item.text, '滟滟随波千万里，何处春江无月明。');
  assert.equal(fetchImpl.calls.length, 2);
});

test('取数：撞上近期出处（同一首诗）时同样重取', async () => {
  const dayIndex = 0;
  const fetchImpl = fakeFetch([
    poem('空里流霜不觉飞，汀上白沙看不见。', '张若虚', '春江花月夜'),
    poem('滟滟随波千万里，何处春江无月明。', '张若虚', '春江花月夜'),
    poem('欲穷千里目，更上一层楼。', '王之涣', '登鹳雀楼')
  ]);
  const { DailyQuote } = context({ fetch: fetchImpl });
  const item = await DailyQuote.pick({
    dayIndex, history: [], recentFroms: ['张若虚《春江花月夜》'], fetchImpl, timeout: 50
  });
  // 前两次都是同一出处，重试额度内避开后拿到别的作品
  assert.equal(item.from, '王之涣《登鹳雀楼》');
  assert.equal(item.text, '欲穷千里目，更上一层楼。');
  assert.equal(fetchImpl.calls.length, 3);
});

test('取数：源返回灌水短句时重取，重试用尽仍未达标则换下一个源', async () => {
  const dayIndex = 2;                                  // 该日 mind 排第一
  assert.equal(context().DailyQuote.planFor(dayIndex)[0].id, 'mind');
  // mind 连取三次短句判废 → poem 请求失败 → scene 拿到正常句子
  const fetchImpl = fakeFetch([
    hito('好', '网络', ''),
    hito('嗯嗯', '网络', ''),
    hito('行', '网络', ''),
    new Error('poem down'),
    hito('我喝过你喝的西北风，这算不算很穷。', '网络', '')
  ]);
  const { DailyQuote } = context({ fetch: fetchImpl });
  const item = await DailyQuote.pick({ dayIndex, history: [], fetchImpl, timeout: 50 });
  assert.equal(item.source, 'scene');
  assert.equal(item.text, '我喝过你喝的西北风，这算不算很穷。');
  assert.equal(fetchImpl.calls.length, 5);
});

test('取数：源请求失败时直接降级，全部失败则 reject 交给本地兜底', async () => {
  const dayIndex = 1;                                  // 该日 scene 排第一
  const fetchImpl = fakeFetch([
    new Error('offline'),
    hito('我喝过你喝的西北风，这算不算很穷。', '网络', '')
  ]);
  const { DailyQuote } = context({ fetch: fetchImpl });
  const item = await DailyQuote.pick({ dayIndex, history: [], fetchImpl, timeout: 50 });
  assert.equal(item.source, 'mind');
  assert.equal(fetchImpl.calls.length, 2);

  const offline = fakeFetch([new Error('offline')]);
  await assert.rejects(
    DailyQuote.pick({ dayIndex, history: [], fetchImpl: offline, timeout: 50 }),
    /all-sources-failed/
  );
});

test('本地兜底：同一天取位稳定，跳过近期用过的句子', () => {
  const { DailyQuote } = context();
  const bank = ['句子甲句子甲', '句子乙句子乙', '句子丙句子丙'];
  assert.equal(DailyQuote.pickLocal(0, [], bank), '句子甲句子甲');
  assert.equal(DailyQuote.pickLocal(0, [], bank), '句子甲句子甲');
  assert.equal(DailyQuote.pickLocal(0, [DailyQuote.normalize('句子甲句子甲')], bank), '句子乙句子乙');
  // 全部用过时也要给出一句，不能空
  const allUsed = bank.map((t) => DailyQuote.normalize(t));
  assert.equal(bank.includes(DailyQuote.pickLocal(0, allUsed, bank)), true);
});
