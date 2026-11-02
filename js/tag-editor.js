/* 快捷入口编辑：只收人工信息，不把书签选择塞进入口表单。 */
(function (global) {
  'use strict';
  var dialog;

  function node(tag, text) {
    var el = document.createElement(tag);
    if (text != null) el.textContent = text;
    return el;
  }

  function splitAliases(value) {
    return String(value || '').split(/[,，、\n]+/).map(function (item) { return item.trim(); }).filter(Boolean);
  }

  function open(options) {
    options = options || {};
    if (dialog) dialog.remove();
    var tag = options.tag || {};
    var editing = !!tag.id;
    var fields = {};
    var labelTouched = false;

    dialog = node('dialog');
    dialog.className = 'tag-editor organizer-dialog';
    dialog.addEventListener('click', function (ev) { ev.stopPropagation(); });
    dialog.addEventListener('keydown', function (ev) { ev.stopPropagation(); });

    var form = node('form');
    form.noValidate = true;
    form.append(node('h2', editing ? '编辑快捷入口' : options.alias ? '绑定「' + options.alias + '」' : '添加书签备注'));
    form.append(node('p', editing ? '名称、别名和说明由你维护，网页摘要不会覆盖。' : '选一个书签，给它加上自己的名称、别名或说明。'));

    function field(key, title, value, multiline) {
      var label = node('label');
      label.className = 'field';
      label.append(node('span', title));
      var input = node(multiline ? 'textarea' : 'input');
      input.name = key;
      input.className = 'text-input';
      input.value = value || '';
      input.setAttribute('aria-label', title);
      if (multiline) input.rows = 2; else input.type = 'text';
      label.append(input);
      form.append(label);
      fields[key] = input;
      return input;
    }

    var urlInput;
    if (tag.url) {
      /* 从书签进入时网址已经确定，折叠起来，避免先看到一屏表单。 */
      var urlGroup = node('details');
      urlGroup.className = 'tag-editor-url';
      var urlSummary = node('summary');
      urlSummary.append(node('span', '网址'), node('em', tag.host || QuickTags.hostOf(QuickTags.normalizeUrl(tag.url)) || ''));
      urlGroup.append(urlSummary);
      var urlField = node('label');
      urlField.className = 'field';
      urlField.append(node('span', '修改网址'));
      urlInput = node('input');
      urlInput.type = 'text';
      urlInput.name = 'url';
      urlInput.className = 'text-input';
      urlInput.value = tag.url || '';
      urlInput.setAttribute('aria-label', '网址');
      urlField.append(urlInput);
      urlGroup.append(urlField);
      form.append(urlGroup);
    } else {
      urlInput = field('url', '网址', tag.url);
    }

    var labelInput = field('label', '快捷名称', tag.label);
    labelInput.addEventListener('input', function () { labelTouched = true; });

    var aliasInput = field('aliases', '别名', (tag.aliases || (options.alias ? [options.alias] : [])).join('、'));
    aliasInput.placeholder = '如 007、OA';
    form.append(node('p', '多个别名用逗号或顿号分隔，@ 后输入任意一个都能找到。', 'hint'));

    var noteInput = field('note', '个人说明', tag.note, true);
    noteInput.placeholder = '例如：公司内部入口，办理报销和请假';

    /* 没有现成网址时，先在书签里搜一个目标，而不是让用户手动拼网址。 */
    if (!tag.url && options.rows && options.rows.length) {
      var picker = node('div');
      picker.className = 'tag-picker';
      picker.append(node('span', '从书签选择', 'tag-picker-label'));
      var search = node('input');
      search.type = 'search';
      search.className = 'text-input';
      search.placeholder = '搜索标题或网址';
      search.setAttribute('aria-label', '搜索书签');
      var results = node('div');
      results.className = 'tag-picker-results';
      results.hidden = true;
      picker.append(search, results);
      function choose(row) {
        var url = QuickTags.normalizeUrl(row.url);
        var existing = QuickTags.list().filter(function (item) { return item.url === url; })[0];
        if (existing) {
          /* 同一网址已经有备注，切换为编辑并把刚输入的别名带过去。 */
          var merged = Array.from(new Set((existing.aliases || []).concat(splitAliases(aliasInput.value))));
          open({ tag: Object.assign({}, existing, { aliases: merged }), saved: options.saved });
          return;
        }
        urlInput.value = row.url;
        if (!labelTouched || !labelInput.value.trim()) labelInput.value = row.title || row.host || '';
        search.value = row.title || row.host || row.url;
        results.hidden = true;
        results.replaceChildren();
        error.textContent = '';
        preview();
      }
      search.addEventListener('input', function () {
        var q = search.value.trim().toLowerCase();
        results.replaceChildren();
        if (!q) { results.hidden = true; return; }
        var seen = {};
        var matches = options.rows.filter(function (row) {
          if (!row.url || seen[row.url]) return false;
          var hay = [row.title, row.url, row.host, row.folder].join(' ').toLowerCase();
          if (hay.indexOf(q) < 0) return false;
          seen[row.url] = true;
          return true;
        }).slice(0, 5);
        if (!matches.length) {
          var empty = node('p', '没有找到匹配的书签，可以在下方直接填写网址。');
          empty.className = 'hint';
          results.append(empty);
        } else {
          var tagged = QuickTags.list();
          matches.forEach(function (row) {
            var existing = tagged.some(function (item) { return item.url === QuickTags.normalizeUrl(row.url); });
            var option = node('button');
            option.type = 'button';
            option.className = 'tag-picker-result';
            option.append(node('span', row.title || row.host || row.url), node('small', existing ? '已有备注' : (row.host || '')));
            option.addEventListener('click', function () { choose(row); });
            results.append(option);
          });
        }
        results.hidden = false;
      });
      form.insertBefore(picker, urlInput.closest('.field'));
    }

    var output = node('p', '', 'hint');
    output.setAttribute('aria-live', 'polite');
    var error = node('p', '', 'rag-alert');
    error.setAttribute('role', 'alert');

    function values() {
      return {
        url: urlInput.value,
        label: labelInput.value,
        aliases: splitAliases(aliasInput.value),
        note: noteInput.value
      };
    }

    function preview() {
      var value = values();
      var conflicts = QuickTags.conflicts(value, tag.id);
      output.textContent = '@' + (value.aliases[0] || value.label || '名称') + ' → ' + (value.label || '入口')
        + ' · ' + (QuickTags.hostOf(QuickTags.normalizeUrl(value.url)) || '填写网址')
        + (conflicts.length ? '。此称呼还用于：' + conflicts.map(function (item) { return item.label + '（' + item.url + '）'; }).join('、') : '');
    }

    /* 新建时没填名称，用网址的 host 兜底，和 @ 里直接输入网址的行为一致。 */
    urlInput.addEventListener('blur', function () {
      if (editing || labelTouched || labelInput.value.trim()) return;
      var host = QuickTags.hostOf(QuickTags.normalizeUrl(urlInput.value));
      if (host) labelInput.value = host;
    });
    form.addEventListener('input', preview);

    var actions = node('div');
    actions.className = 'row';
    var cancel = node('button', '取消');
    cancel.type = 'button';
    cancel.className = 'btn-ghost';
    var save = node('button', '保存');
    save.type = 'submit';
    save.className = 'btn-primary';
    cancel.addEventListener('click', function () { dialog.close(); });
    actions.append(cancel, save);
    form.append(output, error, actions);

    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      if (save.disabled) return;
      save.disabled = true;
      cancel.disabled = true;
      var result = await QuickTags.save(values(), tag.id, tag.revision || 0);
      save.disabled = false;
      cancel.disabled = false;
      if (!result.ok) { error.textContent = result.error; return; }
      dialog.close();
      if (options.saved) options.saved(result.tag);
    });

    dialog.append(form);
    document.body.append(dialog);
    preview();
    dialog.showModal();
    (tag.url ? labelInput : urlInput).focus();
  }

  global.TagEditor = { open: open };
})(typeof self !== 'undefined' ? self : window);
