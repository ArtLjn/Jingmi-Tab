/* 分类元数据读写：旧版记录继续兼容；收藏补全会写入标签，仅供检索与同步读取。 */
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
  global.Organizer = { get: get, records: records };
})(typeof self !== 'undefined' ? self : window);
