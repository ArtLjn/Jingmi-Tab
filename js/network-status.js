/* 网络诊断只提供链路线索，不读取或修改 VPN，不将健康检查当业务成功。 */
(function (global) {
  'use strict';
  var KEY = 'network:diagnosis'; var inflight = null;
  async function read() { return await AgentDB.getMeta(KEY) || { origins: {}, until: 0 }; }
  async function observe(url, code) {
    if (!/^(timeout|network)$/.test(code)) return;
    var origin; try { origin = new URL(url).origin; } catch (e) { return; }
    await AgentDB.updateMeta(KEY, function (value) {
      value = value || { origins: {} }; value.origins = value.origins || {};
      Object.keys(value.origins).forEach(function (key) { if (Date.now() - value.origins[key] > 120e3) delete value.origins[key]; });
      value.origins[origin] = Date.now(); return value;
    });
  }
  async function diagnose(cfg, force) {
    if (inflight) return inflight;
    inflight = (async function () {
      var state = await read(); var now = Date.now();
      if (!force && state.checkedAt && now - state.checkedAt < 60000) return state;
      var offline = global.navigator && navigator.onLine === false;
      var health = 'unknown';
      /* 只使用已经存在且已知语义的账号服务健康入口，不猜自定义 RAG 的接口。 */
      if (!offline && cfg && cfg.baseUrl === 'https://api.jingmi.lllcnm.cn/api/rag') {
        var ctrl = new AbortController(); var timer = setTimeout(function () { ctrl.abort(); }, 4000);
        try {
          var response = await fetch('https://api.jingmi.lllcnm.cn/health', { credentials: 'omit', redirect: 'error', signal: ctrl.signal });
          var data = response.ok ? await response.json() : null;
          health = data && data.ok === true ? 'reachable' : 'unreachable';
        } catch (e) { health = 'unreachable'; } finally { clearTimeout(timer); }
      }
      var failedOrigins = Object.keys(state.origins || {}).filter(function (key) { return now - state.origins[key] < 120e3; });
      var suspected = offline || (failedOrigins.length >= 2 && health === 'unreachable');
      state = Object.assign(state, { checkedAt: now, service: health, reason: offline ? 'offline' : suspected ? 'network_suspected' : 'unknown', until: suspected ? now + 300e3 : 0 });
      await AgentDB.setMeta(KEY, state); return state;
    })();
    try { return await inflight; } finally { inflight = null; }
  }
  async function waiting() { var state = await read(); return state.until > Date.now(); }
  async function reset() { await AgentDB.setMeta(KEY, { origins: {}, until: 0 }); }
  global.NetworkStatus = { read: read, observe: observe, diagnose: diagnose, waiting: waiting, reset: reset };
})(typeof self !== 'undefined' ? self : window);
