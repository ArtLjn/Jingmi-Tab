/* 可变书签树替身，统一维护父节点、顺序和跨页面数据库。 */
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const { IDBFactory } = require('fake-indexeddb');
const root = path.resolve(__dirname, '../..');
function fixture(options = {}) {
  let tree = options.tree || [{ id: '0', title: '', children: [
    { id: '1', parentId: '0', title: '书签栏', children: [] },
    { id: '2', parentId: '0', title: '其他书签', children: [
      { id: '3', title: '财务接口 A', url: 'https://example.com/a' },
      { id: '4', title: '财务接口 B', url: 'https://example.com/b' },
      { id: '5', title: '学习资料', url: 'https://example.com/c' },
      { id: '10', title: '托管目录', unmodifiable: 'managed', children: [{ id: '11', title: '托管链接', url: 'https://example.com/managed' }] }
    ] }
  ] }];
  let next = 100;
  function normalize(nodes, parentId) { nodes.forEach((n, index) => { n.index = index; if (parentId !== undefined) n.parentId = parentId; if (n.children) normalize(n.children, n.id); }); }
  normalize(tree);
  function node(id) { let found; (function walk(nodes) { for (const n of nodes) { if (n.id === id) found = n; if (n.children) walk(n.children); } })(tree); return found; }
  const clone = value => structuredClone(value);
  const bookmarks = {
    getTree: async () => clone(tree),
    getChildren: async id => clone(node(id).children),
    get: async ids => {
      const list = Array.isArray(ids) ? ids : [ids];
      return list.map(id => { const found = node(String(id)); if (!found) throw new Error('书签不存在'); return clone(found); });
    },
    create: async data => {
      const parent = node(data.parentId); if (!parent || !parent.children) throw new Error('目标不存在');
      const n = { id: String(next++), title: data.title, parentId: data.parentId };
      if (data.url) n.url = data.url; else n.children = [];
      parent.children.push(n); normalize(tree); return clone(n);
    },
    move: async (id, data) => {
      if (options.fail && options.fail(id, data)) throw new Error('模拟移动失败');
      const current = node(id); const source = node(current.parentId); const target = node(data.parentId);
      if (!target || !target.children) throw new Error('目标不存在');
      source.children.splice(source.children.findIndex(n => n.id === id), 1);
      target.children.splice(Math.min(data.index === undefined ? target.children.length : data.index, target.children.length), 0, current);
      normalize(tree); return clone(current);
    }
  };
  const c = { URL, crypto: webcrypto, TextEncoder, TextDecoder, FormData, Response, AbortController, setTimeout, clearTimeout,
    indexedDB: options.db || new IDBFactory(), chrome: { bookmarks }, fetch: options.fetch };
  c.self = c; vm.createContext(c);
  for (const name of ['db', 'bookmarks', 'content-index', 'documents', 'pageinfo', 'capture-adapters', 'ai', 'organizer', 'organizer-moves', 'rag', 'sync-engine', 'bookmark-answer', 'bookmark-search']) vm.runInContext(fs.readFileSync(path.join(root, 'js', name + '.js'), 'utf8'), c);
  return { c, node, tree, bookmarks };
}
module.exports = { fixture };
