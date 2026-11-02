/* 各网站统一按具体页面 URL 采集公开正文。 */
(function (global) {
  'use strict';
  function failure(message, state, retryable, code) { var error = new Error(message); error.state = state; error.retryable = !!retryable; error.code = code || state; return error; }
  async function permitted(origin) {
    return !!(typeof chrome !== 'undefined' && chrome.permissions && await chrome.permissions.contains({ origins: [origin + '/*'] }));
  }
  async function read(doc, cfg, force) {
    var info = doc.identity;
    if (!await permitted(info.origin)) throw failure('等待授权访问网页站点', 'waiting_permission', false);
    var pages = await PageInfo.getMany([info.canonicalUrl], null, { force: !!force });
    var page = pages[ContentIndex.normUrl(info.canonicalUrl)];
    if (!page || page.status !== 'ok' || page.refreshError) {
      var reason = page && (page.refreshError || page.reason) || 'network';
      var policy = RetryPolicy.classify(reason, 0);
      throw failure(policy.message, policy.kind === 'manual' ? 'waiting_open' : 'failed', policy.auto, reason);
    }
    return Object.assign({}, page, { captureState: page.text ? 'partial' : 'metadata',
      captureNote: page.truncated ? '页面或正文达到采集上限，已保存部分内容' : '从公开 HTML 提取正文，动态内容和附件可能未包含' });
  }
  global.CaptureAdapters = { read: read, failure: failure };
})(typeof self !== 'undefined' ? self : window);
