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
    var pages = await PageInfo.getMany([info.canonicalUrl], null, { force: !!force, singleAttempt: !force });
    var page = pages[ContentIndex.normUrl(info.canonicalUrl)];
    var reason = page && (page.refreshError || page.reason) || '';
    var profile = page && page.publicProfile;
    /* 最多补采同源首页一次；首页只提供站点介绍，不替换原文档身份。 */
    if ((!profile || !profile.description) && /^(login_wall|dynamic_shell|no_content|http_401|http_403)$/.test(reason) && new URL(info.canonicalUrl).pathname !== '/') {
      var homeUrl = info.origin + '/';
      var homePages = await PageInfo.getMany([homeUrl], null, { force: false, singleAttempt: true });
      var home = homePages[ContentIndex.normUrl(homeUrl)];
      if (home && !home.refreshError && home.publicProfile) profile = Object.assign({}, home.publicProfile, { scope: 'site' });
    }
    if (!page || page.status !== 'ok' || page.refreshError) {
      reason = reason || 'network';
      var policy = RetryPolicy.classify(reason, 0);
      var error = failure(/^(timeout|network|network_suspected)$/.test(reason) ? '本机访问网页超时或断开，待检查网络/VPN；尚不能判定网站失效' : policy.message, policy.kind === 'manual' ? 'waiting_open' : 'failed', policy.auto, reason);
      error.operation = 'capture'; error.requestSource = 'local'; error.observedAt = page && (page.refreshCheckedAt || page.fetchedAt) || Date.now();
      error.publicProfile = profile;
      throw error;
    }
    return Object.assign({}, page, { publicProfile: profile, captureState: page.text ? 'partial' : 'metadata',
      captureNote: page.truncated ? '页面或正文达到采集上限，已保存部分内容' : '从公开 HTML 提取正文，动态内容和附件可能未包含' });
  }
  global.CaptureAdapters = { read: read, failure: failure };
})(typeof self !== 'undefined' ? self : window);
