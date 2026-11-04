/* 共享错误分类：网络错误有限重试，访问条件与确定性错误不循环请求。 */
(function (global) {
  'use strict';
  function classify(code, attempts) {
    code = String(code || 'unknown'); attempts = Number(attempts) || 0;
    var kind = 'stopped', limit = 0, message = '无法自动处理，请检查错误后再操作', allowManual = true;
    var raw = code.replace(/^ai_/, '');
    if (/^(timeout|network)$/.test(raw)) { kind = 'retryable'; limit = 2; message = '临时网络异常，最多自动处理 2 次；连续失败后需检查站点或网络'; }
    else if (/^http_(408|500|502|503|504)$/.test(raw)) { kind = 'retryable'; limit = 5; message = '服务临时异常，最多自动处理 5 次'; }
    else if (/^(daily_limit|http_429)$/.test(raw)) { kind = 'paused'; message = '额度或限流暂停，等待恢复，不参与批量重试'; allowManual = false; }
    else if (/^(private|login_wall|dynamic_shell|no_content|http_401|http_403|waiting_permission|waiting_open|waiting_auth|ai_config|cloud_unavailable|unauthorized|client_blocked|http_409|outcome_unknown|network_suspected)$/.test(raw)) {
      kind = 'manual'; message = ['http_409', 'outcome_unknown'].includes(raw) ? '上次写入结果不确定，需核验，禁止自动重发' : raw === 'network_suspected' ? '本地网络或 VPN 链路疑似异常，检查网络后单项重试' : raw === 'client_blocked' ? '浏览器或扩展拦截，需检查客户端' : '需要登录、授权、配置或打开页面采集'; allowManual = !['http_409', 'outcome_unknown'].includes(raw);
    } else if (/^(unsupported|not_html)$/.test(raw)) { kind = 'manual'; message = '该地址或内容不支持自动采集，需要人工处理'; allowManual = false;
    } else if (/^(http_400|http_404|http_410|http_422)$/.test(raw)) { message = '地址失效或内容不支持，已停止自动重试'; allowManual = false; }
    var auto = kind === 'retryable' && attempts < limit;
    return { kind: kind, auto: auto, bulk: auto, limit: limit, allowManual: allowManual,
      delay: Math.min(3600000, 300000 * Math.pow(2, Math.max(0, attempts - 1))),
      message: kind === 'retryable' && !auto ? '自动重试已达上限，请检查网络或站点后单独重试' : message };
  }
  function resumed(code, at, now) {
    code = String(code || '').replace(/^ai_/, '');
    if (!at) return false;
    var current = new Date(now || Date.now()), previous = new Date(at);
    if (code === 'daily_limit') return current.toDateString() !== previous.toDateString();
    if (code === 'http_429') return current.toISOString().slice(0, 10) !== previous.toISOString().slice(0, 10);
    return false;
  }
  function category(code) {
    var raw = String(code || '').replace(/^ai_/, '');
    if (/^(timeout|network|network_suspected)$/.test(raw)) return { key: 'network', label: '网络' };
    if (/^(http_408|http_5\d\d)$/.test(raw)) return { key: 'service', label: '服务端' };
    if (/^(http_401|http_403|login_wall)$/.test(raw)) return { key: 'login', label: '需登录' };
    if (/^(private|waiting_permission|waiting_open|waiting_auth|unauthorized)$/.test(raw)) return { key: 'auth', label: '待授权' };
    if (/^(dynamic_shell|no_content)$/.test(raw)) return { key: 'content', label: '无正文' };
    if (/^(daily_limit|http_429)$/.test(raw)) return { key: 'quota', label: '额度' };
    if (/^(ai_config|config)$/.test(raw)) return { key: 'ai', label: 'AI 配置' };
    if (/^(http_400|http_404|http_409|http_410|http_422|unsupported|not_html)$/.test(raw)) return { key: 'invalid', label: '地址/内容不支持' };
    if (/^client_blocked$/.test(raw)) return { key: 'blocked', label: '被拦截' };
    return { key: 'other', label: '其他' };
  }
  function dailyResource(item) {
    if (!item || item.code !== 'daily_limit') return '';
    if (String(item.reason || '').startsWith('AI 请求失败：')) return 'ai';
    if (String(item.reason || '').startsWith('正文采集失败：')) return 'capture';
    return '';
  }
  global.RetryPolicy = { classify: classify, resumed: resumed, category: category, dailyResource: dailyResource };
})(typeof self !== 'undefined' ? self : window);
