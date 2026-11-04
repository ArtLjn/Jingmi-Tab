/* 串行执行收件箱移动与日志恢复。 */
(function (global) {
  "use strict";
  var busy = false;
  var queue = Promise.resolve();
  var LOG_KEY = "organizer:journal";
  async function move(id, destination) {
    return chrome.bookmarks.move(id, destination);
  }
  function nodesOf(tree) {
    var nodes = new Map();
    (function walk(items, blocked, path) {
      items.forEach(function (n) {
        var node = Object.assign({}, n, {
          blocked: blocked || !!n.unmodifiable,
          path: path,
        });
        nodes.set(String(n.id), node);
        if (n.children)
          walk(n.children, node.blocked, path.concat(n.title || []));
      });
    })(tree, false, []);
    return nodes;
  }
  function snapshot(node) {
    return {
      parentId: node.parentId,
      index: node.index,
      url: node.url,
      title: node.title,
    };
  }
  function same(node, state) {
    return (
      node &&
      node.parentId === state.parentId &&
      node.index === state.index &&
      node.url === state.url &&
      node.title === state.title
    );
  }
  async function exclusive(fn) {
    if (busy) throw new Error("另一个整理操作正在执行");
    busy = true;
    try {
      return await serialize(fn);
    } finally {
      busy = false;
    }
  }
  function serialize(fn) {
    var result = queue.then(fn);
    queue = result.catch(function () {});
    return result;
  }
  async function undo() {
    return exclusive(async function () {
      var journal = await AgentDB.getMeta(LOG_KEY);
      if (
        !journal ||
        !journal.items.some(function (i) {
          return i.state === "moved" || i.state === "pending";
        })
      ) {
        var history = (await AgentDB.getMeta("organizer:history")) || [];
        var index = history.length - 1;
        while (index >= 0 && !history[index].undoable) index--;
        if (index < 0) throw new Error("暂无可撤销的整理");
        journal = history[index];
        history.splice(index, 1);
        await AgentDB.setMeta("organizer:history", history);
        await AgentDB.setMeta(LOG_KEY, journal);
      }
      var entries = journal.items.filter(function (i) {
        return i.state === "moved" || i.state === "pending";
      });
      /* 收件箱逐次记录移动前的位置，按移动的逆序恢复；旧批次沿用原始索引顺序。 */
      var automatic = entries
        .filter(function (i) {
          return i.source === "auto";
        })
        .reverse();
      var legacy = entries.filter(function (i) {
        return i.source !== "auto";
      });
      legacy.sort(function (a, b) {
        return (
          String(a.before.parentId).localeCompare(String(b.before.parentId)) ||
          a.before.index - b.before.index
        );
      });
      entries = automatic.concat(legacy);
      for (var entry of entries) {
        try {
          var nodes = nodesOf(await chrome.bookmarks.getTree());
          var node = nodes.get(entry.id);
          var parent = nodes.get(entry.before.parentId);
          if (same(node, entry.before)) {
            entry.state = "restored";
          } else {
            var matches = entry.after
              ? same(node, entry.after)
              : node &&
                node.parentId === entry.destinationId &&
                node.url === entry.before.url &&
                node.title === entry.before.title;
            if (
              !matches ||
              node.blocked ||
              !parent ||
              parent.url ||
              parent.blocked
            )
              throw new Error("后续位置或内容已变化，未覆盖人工修改");
            var removedFrom = node.parentId;
            var removedIndex = node.index;
            if (entry.source === "auto")
              await AgentDB.setMeta("auto:hold:" + entry.id, {
                url: entry.before.url,
              });
            var restored = await move(entry.id, {
              parentId: entry.before.parentId,
              index: entry.before.index,
            });
            /* 本次撤销自身改变的兄弟序号同步进日志，避免误判为人工修改。 */
            journal.items.forEach(function (other) {
              if (
                other !== entry &&
                other.state === "moved" &&
                other.after &&
                other.after.parentId === removedFrom &&
                other.after.index > removedIndex
              )
                other.after.index--;
            });
            entry.state = "restored";
            entry.restored = snapshot(restored);
          }
          delete entry.error;
        } catch (e) {
          entry.error = e.message;
        }
        await AgentDB.setMeta(LOG_KEY, journal);
      }
      return Object.assign({}, journal, {
        outcome: {
          restored: entries.filter(function (entry) {
            return entry.state === "restored";
          }).length,
          skipped: entries.filter(function (entry) {
            return entry.error;
          }).length,
        },
      });
    });
  }
  async function summary() {
    var journal = await AgentDB.getMeta(LOG_KEY);
    var history = (await AgentDB.getMeta("organizer:history")) || [];
    return {
      canUndo:
        !!(
          journal &&
          journal.items.some(function (item) {
            return item.state === "moved" || item.state === "pending";
          })
        ) ||
        history.some(function (j) {
          return j.undoable;
        }),
    };
  }
  global.OrganizerMoves = {
    undo: undo,
    summary: summary,
    serialize: serialize,
  };
})(typeof self !== "undefined" ? self : window);
