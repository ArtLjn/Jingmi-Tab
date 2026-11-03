/* 收录纯策略：只描述下一动作，不直接上传或删除。 */
(function (global) {
  'use strict';
  var VERSION = 2;
  function personal(doc) { return !!(doc.userAnnotations && doc.userAnnotations.length); }
  function privateDoc(doc) { return !!doc.private || ['capture', 'feishu_api'].includes(doc.source); }
  function usable(doc) { return !!String(doc.text || '').trim() && !/^(failed|waiting_)/.test(doc.captureState || '') && !doc.captureError; }
  function evaluate(doc, cfg, context) {
    context = context || {}; var now = context.now || Date.now();
    var receipt = context.receipt;
    var previous = !!(receipt && receipt.quality === 'body');
    function result(state, action, reason, delay) { return { state: state, action: action, reason: reason || '', dueAt: delay ? now + delay : 0, previous: previous, policyVersion: VERSION }; }
    if (doc.deleted || !(doc.bookmarks || []).length) return result('excluded', 'delete', 'deleted');
    var annotationsChanged = receipt && receipt.annotations !== undefined && receipt.annotations !== JSON.stringify(doc.userAnnotations || []);
    var preservedBody = previous && !!String(doc.text || '').trim() && receipt.contentHash === doc.contentHash && !/^http_(404|410)$/.test(context.error && context.error.code || doc.captureError || '');
    if (personal(doc) || annotationsChanged && (usable(doc) || preservedBody) && (!privateDoc(doc) || cfg.includePrivate)) {
      var annotated = result('eligible', 'upsert', 'personal');
      annotated.includeBody = (!privateDoc(doc) || !!cfg.includePrivate) && (usable(doc) || preservedBody);
      return annotated;
    }
    if (receipt && receipt.quality === 'personal') {
      if (usable(doc) && (!privateDoc(doc) || cfg.includePrivate)) return Object.assign(result('eligible', 'upsert', 'body'), { includeBody: true });
      return result('metadata', 'delete', 'personal_removed');
    }
    if (privateDoc(doc) && !cfg.includePrivate) return result('excluded', 'delete', 'private');
    var error = context.error;
    var code = error && error.code || doc.captureError || '';
    if (/^http_(404|410)$/.test(code) && doc.accessCondition) return result('deferred', 'hold', 'waiting_auth');
    if (code === 'http_404') {
      var candidate = doc.invalidCandidate;
      var observed = error && error.observedAt || now;
      var confirmed = candidate && observed > candidate.lastSeenAt && now - candidate.firstSeenAt >= 864e5;
      if (confirmed && !privateDoc(doc)) return result('invalid', cfg.cleanupEnabled ? 'delete' : 'hold', code, 7 * 864e5);
      var verdict = result('deferred', 'hold', code, 864e5);
      if (candidate) verdict.dueAt = candidate.firstSeenAt + 864e5 > now ? candidate.firstSeenAt + 864e5 : now + 1800e3;
      verdict.candidate = candidate || { firstSeenAt: now, lastSeenAt: observed, count: 1 };
      return verdict;
    }
    if (code === 'http_410') return result('invalid', cfg.cleanupEnabled ? 'delete' : 'hold', code, 7 * 864e5);
    if (code) {
      if (['unsupported', 'not_html', 'no_content'].includes(code)) return result(previous ? 'deferred' : 'metadata', 'hold', code);
      var delay = /^(timeout|network|network_suspected)$/.test(code) ? 1800e3 : /^http_(408|5\d\d)$/.test(code) ? 7200e3 : /^(daily_limit|http_429)$/.test(code) ? 864e5 : 0;
      return result('deferred', 'hold', code, delay);
    }
    if (usable(doc)) return Object.assign(result('eligible', 'upsert', 'body'), { includeBody: true });
    return result(previous ? 'deferred' : 'metadata', 'hold', 'no_body');
  }
  global.IngestPolicy = { VERSION: VERSION, evaluate: evaluate, usable: usable, personal: personal, privateDoc: privateDoc };
})(typeof self !== 'undefined' ? self : window);
