/* 统一审阅收件箱和主动推荐，支持改选目录与显式记住规则。 */
(function (global) {
  "use strict";

  function mount() {
    var card = document.getElementById("auto-organize-card");
    if (!card) return { refresh: function () {} };
    var toggle = document.getElementById("auto-organize-enabled");
    var status = document.getElementById("auto-organize-status");
    var body = document.getElementById("auto-organize-body");
    var reviewButton = document.getElementById("auto-organize-review");
    var reviewStatus = document.getElementById("auto-review-status");
    var reviewReply = document.getElementById("auto-review-reply");
    var reviewReplyText = document.getElementById("auto-review-reply-text");
    var reviewChecked = document.getElementById("auto-review-checked");
    var reviewCheckedLabel = document.getElementById(
      "auto-review-checked-label",
    );
    var reviewCheckedList = document.getElementById("auto-review-checked-list");
    var rulesBody = document.getElementById("auto-organize-rules");
    var relearn = document.getElementById("auto-organize-relearn");
    var history = document.getElementById("auto-organize-history");
    var undo = document.getElementById("auto-history-undo");
    var historyFeedback = document.getElementById("auto-history-feedback");
    var pendingCount = document.getElementById("auto-pending-count");
    var ruleCount = document.getElementById("auto-rule-count");
    var historyCount = document.getElementById("auto-history-count");
    var tabs = Array.from(card.querySelectorAll("[data-auto-tab]"));
    var panels = {
      pending: document.getElementById("auto-pending-panel"),
      rules: document.getElementById("auto-rules-panel"),
      history: document.getElementById("auto-history-panel"),
    };
    var historyLimit = 20;
    var busy = false;
    var drafts = new Map();
    var reviewDrafts = new Map();
    var openFolderPicker = null;

    function el(tag, text, className) {
      var node = document.createElement(tag);
      if (text) node.textContent = text;
      if (className) node.className = className;
      return node;
    }

    async function send(type, extra) {
      var result = await chrome.runtime.sendMessage(
        Object.assign({ type: type }, extra),
      );
      if (!result || !result.ok)
        throw new Error(
          (result && result.error) || "后台未响应，请重新加载扩展",
        );
      return result.data;
    }

    function renderRules(rules) {
      var list = el("div", "", "auto-rule-list");
      if (!rules.length) {
        list.append(
          el(
            "p",
            "归档时勾选“记住此页面范围”，即可为后续收藏启用规则。",
            "auto-empty",
          ),
        );
      }
      rules.forEach(function (rule) {
        var row = el("div", "", "auto-rule");
        row.append(el("span", rule.key, "auto-rule-domain"));
        row.append(el("span", "→", "auto-rule-arrow"));
        row.append(
          el(
            "span",
            rule.stale ? "目录已失效" : rule.path,
            "auto-rule-folder" + (rule.stale ? " is-stale" : ""),
          ),
        );
        row.append(
          el(
            "span",
            rule.remembered
              ? rule.site
                ? "站点偏好"
                : "已记住"
              : rule.source === "learned"
                ? "历史参考"
                : "旧规则已停用",
            "auto-rule-source",
          ),
        );
        var remove = el("button", "移除", "auto-rule-remove");
        remove.type = "button";
        remove.dataset.autoRule = rule.key;
        remove.setAttribute("aria-label", "移除 " + rule.key + " 的归档规则");
        row.append(remove);
        list.append(row);
      });
      return list;
    }

    function folderPicker(item, folders, selected, onSelect, actionLabel) {
      var field = el("div", "", "auto-folder-field");
      var trigger = el("button", "", "auto-folder-trigger");
      trigger.type = "button";
      trigger.setAttribute("aria-haspopup", "listbox");
      trigger.setAttribute("aria-expanded", "false");
      var value = el("span", "", "auto-folder-value");
      trigger.append(value);
      field.append(trigger);
      var panel = null;

      function label() {
        var folder = folders.get(selected);
        value.textContent =
          actionLabel || (folder ? folder.path : "选择归档目录");
        trigger.classList.toggle("is-empty", !folder);
        trigger.title = value.textContent;
        trigger.setAttribute(
          "aria-label",
          (actionLabel || "选择归档目录") +
            " · " +
            (item.title || item.host) +
            (folder ? " · " + folder.path : ""),
        );
      }
      function close(restore) {
        if (!panel) return;
        panel.remove();
        panel = null;
        document.removeEventListener("pointerdown", outside, true);
        window.removeEventListener("scroll", onScroll, true);
        window.removeEventListener("resize", onScroll);
        trigger.setAttribute("aria-expanded", "false");
        if (restore) trigger.focus();
        openFolderPicker = null;
      }
      function outside(event) {
        if (panel.contains(event.target) || trigger.contains(event.target))
          return;
        close(false);
      }
      function onScroll(event) {
        if (!panel.contains(event.target)) close(false);
      }
      function choose(folder) {
        selected = folder.id;
        label();
        onSelect(selected);
        close(true);
      }
      function place() {
        var rect = trigger.getBoundingClientRect();
        var width = panel.offsetWidth;
        var height = panel.offsetHeight;
        var left = Math.max(
          8,
          Math.min(rect.right - width, innerWidth - width - 8),
        );
        var below = innerHeight - rect.bottom - 8;
        var top =
          below >= height || below >= rect.top - 8
            ? rect.bottom + 6
            : rect.top - height - 6;
        panel.style.left = left + "px";
        panel.style.top = Math.max(8, top) + "px";
      }
      function open() {
        if (openFolderPicker) openFolderPicker();
        panel = el("div", "", "auto-folder-popover");
        panel.setAttribute("role", "listbox");
        panel.setAttribute("aria-label", "归档目录");
        var search = el("input", "", "auto-folder-search");
        search.type = "search";
        search.placeholder = "搜索目录";
        search.setAttribute("aria-label", "搜索归档目录");
        var options = el("div", "", "auto-folder-options");
        panel.append(search, options);
        /* 弹层挂在 body 下，阻止冒泡，避免被工作台的“点外部关闭”逻辑误判。 */
        panel.addEventListener("click", function (event) {
          event.stopPropagation();
        });

        function renderOptions() {
          var query = search.value.trim().toLowerCase();
          options.replaceChildren();
          var count = 0;
          Array.from(folders.values())
            .filter(function (folder) {
              return folder.selectable;
            })
            .forEach(function (folder) {
              if (query && folder.path.toLowerCase().indexOf(query) < 0) return;
              count += 1;
              var option = el("button", "", "auto-folder-option");
              option.type = "button";
              option.setAttribute("role", "option");
              option.dataset.autoFolder = folder.id;
              if (folder.id === selected)
                option.setAttribute("aria-selected", "true");
              var parts = folder.path.split(" / ");
              var leaf = parts.pop();
              if (parts.length)
                option.append(
                  el(
                    "span",
                    parts.join(" / ") + " / ",
                    "auto-folder-option-parent",
                  ),
                );
              option.append(el("span", leaf, "auto-folder-option-leaf"));
              option.addEventListener("click", function () {
                choose(folder);
              });
              options.append(option);
            });
          if (!count) options.append(el("p", "未找到匹配目录", "auto-empty"));
        }

        function escape(event) {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          close(true);
        }
        search.addEventListener("input", renderOptions);
        search.addEventListener("keydown", function (event) {
          if (event.key === "Enter") {
            event.preventDefault();
            options.querySelector(".auto-folder-option")?.click();
          } else {
            escape(event);
          }
        });
        panel.addEventListener("keydown", escape);

        renderOptions();
        panel.style.visibility = "hidden";
        document.body.append(panel);
        place();
        panel.style.visibility = "";
        options
          .querySelector('[aria-selected="true"]')
          ?.scrollIntoView({ block: "nearest" });
        trigger.setAttribute("aria-expanded", "true");
        search.focus();
        openFolderPicker = function () {
          close(false);
        };
        document.addEventListener("pointerdown", outside, true);
        window.addEventListener("scroll", onScroll, true);
        window.addEventListener("resize", onScroll);
      }

      trigger.addEventListener("click", function () {
        if (panel) {
          close(true);
          return;
        }
        open();
      });
      trigger.addEventListener("keydown", function (event) {
        if (event.key === "ArrowDown" && !panel) {
          event.preventDefault();
          open();
        }
      });
      label();
      return field;
    }

    function showReviewStatus(message) {
      reviewStatus.hidden = false;
      reviewStatus.textContent = message;
    }

    function renderReview(item, planId, folders) {
      var row = el("div", "", "auto-suggestion auto-review-row");
      var draft = reviewDrafts.get(item.id);
      if (!draft || draft.planId !== planId) draft = { planId: planId };
      var main = el("div", "", "auto-suggestion-main");
      var title = item.title || "未命名收藏";
      main.append(el("strong", title, "auto-suggestion-title"));
      var path = el("p", "", "auto-review-path");
      var target = el("strong");
      path.append(item.from + " → ", target);
      main.append(path);
      var reason = el("p", "", "auto-review-path");
      main.append(reason);
      var controls = el(
        "div",
        "",
        "auto-suggestion-controls auto-review-controls",
      );
      var field = folderPicker(
        item,
        folders,
        draft.folderId || item.folderId,
        function (id) {
          draft.folderId = id;
          reviewDrafts.set(item.id, draft);
          updateTarget();
        },
        "改选目录",
      );
      controls.append(field);
      var remember = el("input", "", "pipeline-select");
      remember.type = "checkbox";
      remember.checked = draft.rememberSite === true;
      remember.addEventListener("change", function () {
        draft.rememberSite = remember.checked;
        reviewDrafts.set(item.id, draft);
      });
      if (item.site) {
        var preference = el("label", "", "auto-remember");
        preference.title =
          item.site +
          " 的收藏将优先归到所选目录，收件箱开启自动归档时可直接移动。";
        preference.append(remember, "记住此站点");
        controls.append(preference);
      }
      var actions = el("div", "", "auto-suggestion-actions");
      var confirmButton;
      function confirmLabel() {
        if (draft.folderId) return "归档到所选目录";
        return item.createsFolder ? "创建并归档" : "采纳";
      }
      function updateTarget() {
        var selected = folders.get(draft.folderId);
        target.textContent = selected
          ? selected.path
          : (item.createsFolder ? "新建 " : "") + item.to;
        reason.textContent = selected ? "你手动选择了这个目录" : item.why || "";
        reason.hidden = !reason.textContent;
        confirmButton.textContent = confirmLabel();
        confirmButton.setAttribute("aria-label", confirmLabel() + "：" + title);
      }
      [true, false].forEach(function (adopt) {
        var label = adopt ? confirmLabel() : "忽略";
        var button = el(
          "button",
          label,
          "auto-action" + (adopt ? " adopt" : ""),
        );
        button.type = "button";
        if (adopt) confirmButton = button;
        button.setAttribute("aria-label", label + "：" + title);
        button.addEventListener("click", function () {
          act(
            async function () {
              var state = await send("organizer:review:decide", {
                planId: planId,
                id: item.id,
                adopt: adopt,
                folderId: draft.folderId,
                rememberSite: remember.checked,
              });
              showReviewStatus(
                adopt
                  ? remember.checked
                    ? "已确认并记住此站点的归档位置。"
                    : "已确认归档位置。"
                  : "已忽略，收藏保留原位。",
              );
              return state;
            },
            function () {
              if (document.activeElement === document.body)
                (
                  body.querySelector(".auto-review-row button") || reviewButton
                ).focus();
            },
          );
        });
        actions.append(button);
      });
      updateTarget();
      controls.append(actions);
      row.append(main, controls);
      return row;
    }

    function renderPending(state, pending, reviewItems) {
      var folders = new Map(
        (state.folders || []).map(function (folder) {
          return [folder.id, folder];
        }),
      );
      var list = el("div", "", "auto-pending-list");
      reviewItems.forEach(function (item) {
        list.append(renderReview(item, state.review.id, folders));
      });
      pending.forEach(function (item) {
        var row = el("div", "", "auto-suggestion");
        var draft = drafts.get(item.id) || {};
        var main = el("div", "", "auto-suggestion-main");
        var heading = el(
          "strong",
          item.title || item.host,
          "auto-suggestion-title",
        );
        heading.title = heading.textContent;
        main.append(heading);
        var meta = el("p", "", "auto-suggestion-meta");
        meta.textContent =
          (item.currentFolder || "其他书签") +
          " · " +
          item.host +
          (item.path
            ? ""
            : item.analyzed
              ? " · 暂无推荐目录"
              : state.aiReady
                ? " · 等待分析"
                : " · 可手动选择目录");
        if (item.why) meta.textContent += "（" + item.why + "）";
        if (item.withSummary) meta.textContent += " · 已读取公开摘要";
        meta.title = meta.textContent;
        main.append(meta);
        var controls = el("div", "", "auto-suggestion-controls");
        var selected =
          draft.folderId === undefined ? item.folderId : draft.folderId;
        if (!folders.get(selected)?.selectable) selected = "";
        var field = folderPicker(item, folders, selected, function (id) {
          selected = id;
          draft.folderId = id;
          drafts.set(item.id, draft);
          adopt.disabled = !state.enabled || !selected;
        });
        controls.append(field);
        var label = el("label", "", "auto-remember");
        var remember = el("input", "", "pipeline-select");
        remember.type = "checkbox";
        remember.checked = draft.remember === true;
        label.append(remember, "记住此页面范围");
        controls.append(label);
        var actions = el("div", "", "auto-suggestion-actions");
        var adopt = el("button", "归档", "auto-action adopt");
        adopt.type = "button";
        adopt.dataset.autoAdopt = item.id;
        adopt.disabled = !state.enabled || !selected;
        remember.addEventListener("change", function () {
          draft.remember = remember.checked;
          drafts.set(item.id, draft);
        });
        adopt.addEventListener("click", function () {
          act(function () {
            return send("auto:adopt", {
              id: item.id,
              folderId: selected,
              remember: remember.checked,
            });
          });
        });
        actions.append(adopt);
        var dismiss = el("button", "忽略", "auto-action");
        dismiss.type = "button";
        dismiss.dataset.autoDismiss = item.id;
        actions.append(dismiss);
        controls.append(actions);
        row.append(main, controls);
        list.append(row);
      });
      return list;
    }

    function render(state) {
      if (!state) return;
      if (openFolderPicker) openFolderPicker();
      toggle.checked = !!state.enabled;
      if (state.enabled && !state.aiReady) {
        status.textContent =
          "已启用 · 已确认规则照常归档；配置 AI 后可分析待整理收藏";
      } else if (state.enabled) {
        var line = state.totalRules
          ? "已启用 · 记住 " +
            state.totalRules +
            " 条归档规则 · 已自动归档 " +
            state.filed +
            " 条"
          : "已启用 · 暂无规则，可整理“其他书签”获取建议";
        status.textContent = line;
      } else {
        status.textContent = "已暂停 · 新收藏保留原位";
      }
      var records = state.archiveRecords || [];
      var reply = state.review ? state.review.reply || "" : "";
      if (reviewReplyText.textContent !== reply) {
        reviewReplyText.textContent = reply;
        reviewReply.open = false;
      }
      reviewReply.hidden = !reply;
      var checked = state.review?.checked || [];
      reviewChecked.hidden = !checked.length;
      reviewCheckedLabel.textContent =
        "查看本次检查的收藏（" + checked.length + " 条）";
      reviewCheckedList.replaceChildren(
        ...checked.map(function (item) {
          var row = el("li");
          row.append(
            el("strong", item.title || "未命名收藏"),
            el(
              "p",
              item.from +
                " · " +
                item.result +
                (item.why ? " · " + item.why : ""),
              "auto-review-path",
            ),
          );
          return row;
        }),
      );
      var reviewItems = state.review ? state.review.items : [];
      var reviewIds = new Set(
        reviewItems.map(function (item) {
          return item.id;
        }),
      );
      reviewDrafts.forEach(function (draft, id) {
        if (!reviewIds.has(id) || draft.planId !== state.review?.id)
          reviewDrafts.delete(id);
      });
      var pending = state.pending.filter(function (item) {
        return !reviewIds.has(item.id);
      });
      var count = pending.length + reviewItems.length;
      pendingCount.textContent = count;
      ruleCount.textContent = state.rules.length;
      historyCount.textContent = records.length;
      undo.disabled = !state.canUndo;
      body.replaceChildren();
      var pendingIds = new Set(
        state.pending.map(function (item) {
          return item.id;
        }),
      );
      drafts.forEach(function (draft, id) {
        if (!pendingIds.has(id)) drafts.delete(id);
      });
      if (count) body.append(renderPending(state, pending, reviewItems));
      else
        body.append(
          el(
            "p",
            "暂无待确认建议。可点击「AI 推荐整理」或「整理其他书签」。",
            "auto-empty",
          ),
        );
      rulesBody.replaceChildren(renderRules(state.rules));
      if (history) {
        history.replaceChildren();
        if (!records.length)
          history.append(
            el("p", "暂无归档记录，成功归档后会显示在这里。", "auto-empty"),
          );
        records.slice(0, historyLimit).forEach(function (item) {
          var row = el("div", "", "auto-archive-record");
          var title = el("div", "", "auto-archive-title");
          title.append(el("strong", item.title || "未命名书签"));
          title.append(
            el(
              "span",
              item.state === "restored"
                ? "已撤销"
                : item.error
                  ? "恢复跳过"
                  : "已归档",
              "auto-rule-source",
            ),
          );
          row.append(
            title,
            el("p", item.from + " → " + item.to, "auto-archive-path"),
          );
          if (item.error) row.append(el("p", item.error, "auto-review-path"));
          if (item.why)
            row.append(
              el(
                "p",
                item.why === "domain-rule"
                  ? "命中已确认的归档规则"
                  : item.why === "confirmed"
                    ? "已确认归档建议"
                    : item.why,
                "auto-suggestion-meta",
              ),
            );
          if (item.movedAt) {
            var time = el(
              "time",
              new Date(item.movedAt).toLocaleString("zh-CN", { hour12: false }),
              "auto-archive-time",
            );
            time.dateTime = new Date(item.movedAt).toISOString();
            row.append(time);
          }
          history.append(row);
        });
        if (records.length > historyLimit) {
          var more = el("button", "查看更多记录", "btn-ghost");
          more.type = "button";
          more.addEventListener("click", function () {
            historyLimit += 20;
            render(state);
          });
          history.append(more);
        }
      }
    }

    function selectTab(name, focus) {
      tabs.forEach(function (tab) {
        var active = tab.dataset.autoTab === name;
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
        panels[tab.dataset.autoTab].hidden = !active;
        if (active && focus) tab.focus();
      });
    }
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        selectTab(tab.dataset.autoTab);
      });
      tab.addEventListener("keydown", function (event) {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].indexOf(event.key) < 0)
          return;
        event.preventDefault();
        var names = ["pending", "rules", "history"];
        var index = names.indexOf(tab.dataset.autoTab);
        selectTab(
          event.key === "Home"
            ? names[0]
            : event.key === "End"
              ? names[names.length - 1]
              : names[
                  (index +
                    (event.key === "ArrowLeft" ? -1 : 1) +
                    names.length) %
                    names.length
                ],
          true,
        );
      });
    });

    async function refresh() {
      try {
        var state = await send("auto:status");
        if (!busy) render(state);
      } catch (e) {
        status.textContent = e.message;
      }
    }

    async function act(fn, done) {
      if (busy) return;
      busy = true;
      try {
        var state = await fn();
        if (state) render(state);
      } catch (e) {
        status.textContent = e.message;
      } finally {
        busy = false;
        if (done) done();
      }
    }

    toggle.addEventListener("change", function () {
      act(function () {
        return send("auto:toggle", { enabled: toggle.checked });
      });
    });

    document
      .getElementById("auto-organize-scan")
      .addEventListener("click", function () {
        selectTab("pending");
        act(function () {
          return send("auto:scan");
        });
      });

    reviewButton.addEventListener("click", function () {
      if (busy) return;
      selectTab("pending");
      showReviewStatus("正在分析最近收藏…");
      reviewButton.disabled = true;
      act(async function () {
        try {
          var state = await send("organizer:review");
          var review = state.review;
          var preferences = review.matchedPreferences
            ? " · " + review.matchedPreferences + " 条命中站点偏好"
            : "";
          showReviewStatus(
            review.invalidReply
              ? (review.reply
                  ? "AI 回复格式有误，可以展开查看原文。"
                  : "AI 暂时无法返回整理建议。") + preferences
              : "已分析 " +
                  review.analyzed +
                  " 条" +
                  preferences +
                  " · " +
                  (review.items.length
                    ? review.items.length + " 条建议"
                    : "暂无移动建议"),
          );
          return state;
        } catch (e) {
          showReviewStatus(e.message);
        } finally {
          reviewButton.disabled = false;
        }
      });
    });

    undo.addEventListener("click", function () {
      if (busy) return;
      undo.disabled = true;
      historyFeedback.textContent = "正在恢复原目录…";
      act(async function () {
        try {
          var journal = await send("organizer:undo");
          var outcome = journal.outcome;
          historyFeedback.textContent =
            "本次已恢复 " +
            outcome.restored +
            " 条" +
            (outcome.skipped ? "，跳过 " + outcome.skipped + " 条" : "") +
            "。";
        } catch (e) {
          historyFeedback.textContent = e.message;
        } finally {
          undo.disabled = false;
        }
        return send("auto:status");
      });
    });

    relearn.addEventListener("click", function () {
      if (busy) return;
      status.textContent = "正在从现有书签学习域名归属…";
      act(function () {
        return send("auto:relearn");
      });
    });

    card.addEventListener("click", function (event) {
      var rule = event.target.closest("[data-auto-rule]");
      if (rule) {
        act(function () {
          return send("auto:rule:remove", { key: rule.dataset.autoRule });
        });
        return;
      }
      var dismiss = event.target.closest("[data-auto-dismiss]");
      if (dismiss) {
        act(function () {
          return send("auto:dismiss", { id: dismiss.dataset.autoDismiss });
        });
      }
    });
    document.addEventListener("workspace:view", function (event) {
      if (event.detail === "search") refresh();
    });
    document.addEventListener("workspace:search-page", function (event) {
      if (event.detail === "organize") refresh();
    });
    if (chrome.runtime.onMessage)
      chrome.runtime.onMessage.addListener(function (message) {
        if (message.type === "auto:updated") refresh();
      });
    refresh();
    return { refresh: refresh };
  }

  global.AutoOrganizerUI = { mount: mount };
})(typeof self !== "undefined" ? self : window);
