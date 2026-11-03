/* 网站资料：将已知身份和公开描述用于找入口，不推断私有页面内容。 */
(function (global) {
  'use strict';
  function useful(value) {
    var text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length >= 2 && !/^(?:登录|登陆|注册|sign in|log in|login|loading[. …]*|加载中|untitled|无标题|首页|home|https?:\/\/\S+|[\d._-]+(?:\.pdf)?)$/i.test(text);
  }
  function build(doc) {
    if (!doc.identity || !doc.identity.canonicalUrl) return null;
    var titles = Array.from(new Set((doc.bookmarks || []).map(function (ref) { return String(ref.title || '').trim(); }).filter(useful))).sort();
    var profile = doc.publicProfile;
    var description = profile && useful(profile.description) ? profile.description : '';
    /* 旧缓存的公开描述同样可用；登录采集的描述不在这里隐式授权。 */
    if (!description && doc.source === 'public' && !doc.captureError && useful(doc.desc)) description = doc.desc;
    if (!titles.length && !description) return null;
    return { titles: titles, description: description,
      sourceUrl: description ? profile && profile.sourceUrl || doc.identity.canonicalUrl : '',
      scope: description ? profile && profile.scope || 'page' : 'bookmark',
      evidence: description ? 'public_description' : 'bookmark_identity' };
  }
  function describe(profile) {
    if (!profile) return '';
    return '【网站资料，仅用于识别入口；未采集的正文与私有内容未知】\n收藏名称：' + profile.titles.join('、') +
      (profile.description ? '\n' + (profile.scope === 'site' ? '网站公开介绍（不代表当前文档内容）' : '页面公开描述') + '：' + profile.description + '\n介绍来源：' + profile.sourceUrl : '\n依据：书签名称和收藏目录，网站具体用途信息可能不足');
  }
  global.SiteProfile = { build: build, describe: describe, useful: useful };
})(typeof self !== 'undefined' ? self : window);
