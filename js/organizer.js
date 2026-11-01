/* 兼容旧版分类元数据，仅供检索与同步读取，不再自动分类或移动目录。 */
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
