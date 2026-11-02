/* 模拟 VPN 断流与首尔服务探测，不触达外网。 */
const test = require('node:test'); const assert = require('node:assert/strict'); const { fixture } = require('./helpers/extension');
const cfg = { baseUrl: 'https://api.jingmi.lllcnm.cn/api/rag' };
test('多源站失败与健康探测失败只判疑似链路异常，探测合并并有缓存', async () => {
  let probes = 0; const { c } = fixture({ fetch: async () => { probes++; throw new Error('VPN 断流'); } });
  await c.NetworkStatus.observe('https://a.example.com/private?token=secret', 'timeout'); await c.NetworkStatus.observe('https://b.example.com/', 'network');
  const results = await Promise.all([c.NetworkStatus.diagnose(cfg), c.NetworkStatus.diagnose(cfg)]);
  assert.equal(probes, 1); assert.equal(results[0].reason, 'network_suspected'); assert.equal(await c.NetworkStatus.waiting(), true);
  assert.doesNotMatch(JSON.stringify(await c.NetworkStatus.read()), /token|secret|private/);
  await c.NetworkStatus.diagnose(cfg); assert.equal(probes, 1);
  await c.NetworkStatus.reset(); assert.equal(await c.NetworkStatus.waiting(), false);
});
test('首尔健康可达不能证明源站正常，自定义地址不猜健康接口', async () => {
  let probes = 0; const { c } = fixture({ fetch: async () => { probes++; return new Response(JSON.stringify({ ok: true })); } });
  await c.NetworkStatus.observe('https://a.example.com/', 'timeout'); const state = await c.NetworkStatus.diagnose(cfg);
  assert.equal(state.service, 'reachable'); assert.equal(state.reason, 'unknown');
  await c.NetworkStatus.reset(); const other = await c.NetworkStatus.diagnose({ baseUrl: 'https://custom.example.com' });
  assert.equal(other.service, 'unknown'); assert.equal(probes, 1);
});
test('明确离线先暂停，online 本身不作业务恢复证明', async () => {
  const { c } = fixture(); c.navigator = { onLine: false }; const result = await c.NetworkStatus.diagnose(cfg);
  assert.equal(result.reason, 'offline'); assert.equal(await c.NetworkStatus.waiting(), true);
});
