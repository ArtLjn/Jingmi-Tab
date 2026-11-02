/* 后台资源门禁：原子预扣每日额度，失败关闭；重启或手动重试不重置配额。 */
(function (global) {
  'use strict';
  var LIMITS = { capture: 500, ai: 200, rag: 500 };
  async function reserve(kind) {
    if (!LIMITS[kind]) throw new Error('未知资源类型');
    var allowed = false;
    var date = new Date();
    var day = [date.getFullYear(), date.getMonth() + 1, date.getDate()].join('-');
    await AgentDB.updateMeta('guard:daily', function (value) {
      value = value && value.day === day ? value : { day: day, counts: {} };
      var used = value.counts[kind] || 0;
      if (used < LIMITS[kind]) { value.counts[kind] = used + 1; allowed = true; }
      return value;
    });
    if (!allowed) { var e = new Error('今日后台额度已用完，明日自动恢复'); e.code = 'daily_limit'; throw e; }
  }
  global.ResourceGate = { reserve: reserve, limits: LIMITS };
})(typeof self !== 'undefined' ? self : window);
