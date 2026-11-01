/* 各网站统一按具体页面 URL 采集公开正文。 */
(function (global) {
  'use strict';
  function failure(message, state, retryable) { var error = new Error(message); error.state = state; error.retryable = !!retryable; return error; }
  async function permitted(origin) {
    return !!(typeof chrome !== 'undefined' && chrome.permissions && await chrome.permissions.contains({ origins: [origin + '/*'] }));
  }
  async function read(doc, cfg, force) {
    var info = doc.identity;
    if (!await permitted(info.origin)) throw failure('等待授权访问网页站点', 'waiting_permission', false);
    var pages = await PageInfo.getMany([info.canonicalUrl], null, { force: !!force });
    var page = pages[ContentIndex.normUrl(info.canonicalUrl)];
    if (page && page.refreshError) throw failure('网页更新失败，已保留旧内容，将自动重试', 'failed', true);
    if (!page || page.status !== 'ok') {
      var reason = page && page.reason || 'network';
      if (/login_wall|http_40[13]|no_content|dynamic_shell/.test(reason)) throw failure('页面需登录或动态加载，请打开后采集', 'waiting_open', false);
      throw failure('网页暂时无法读取，将自动重试', 'failed', true);
    }
    return Object.assign({}, page, { captureState: page.text ? 'partial' : 'metadata',
      captureNote: page.truncated ? '页面或正文达到采集上限，已保存部分内容' : '从公开 HTML 提取正文，动态内容和附件可能未包含' });
  }
  global.CaptureAdapters = { read: read, failure: failure };
})(typeof self !== 'undefined' ? self : window);
