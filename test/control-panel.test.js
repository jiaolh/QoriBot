import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { projectRoot } from '../src/config.js';
import { SettingsStore } from '../src/settings.js';
import { MemoryDatabase } from '../src/memory-db.js';
import { createControlPanel } from '../src/server.js';
import { ChatService } from '../src/chat-service.js';

function temporary(t, cleanup) {
  mkdirSync(resolve(projectRoot, '.cache/test'), { recursive: true });
  const root = mkdtempSync(resolve(projectRoot, '.cache/test/run-'));
  t.after(async () => { if (cleanup) await cleanup(); rmSync(root, { recursive: true, force: true }); });
  return root;
}

test('配置持久化、提示词切换和 API Key 隐藏及保留', t => {
  const root = temporary(t), store = new SettingsStore(root);
  assert.equal(store.public().providers[0].apiKey, undefined);
  store.update({ providers: store.public().providers.map(provider => ({ ...provider, apiKey: provider.id === 'default' ? 'fake-test-key' : '' })), activePromptId: 'coding' });
  assert.equal(store.runtime({ requireQQ: false }).chat.promptId, 'coding');
  store.update({ providers: store.public().providers });
  assert.equal(store.runtime({ requireQQ: false }).llm.apiKey, 'fake-test-key');
  assert.equal(new SettingsStore(root).value.activePromptId, 'coding');
  assert.ok(!JSON.stringify(store.public()).includes('fake-test-key'));
  assert.throws(() => store.update({ providers: store.public().providers.map(provider => ({ ...provider, webSearch: true })) }), /官方联网搜索/);
});

test('SQLite 记忆重启后保留，可停用、清空和缩小保存轮数', t => {
  let memory;
  const root = temporary(t, () => memory?.close()), settings = new SettingsStore(root);
  const path = join(root, 'data/memory.sqlite');
  memory = new MemoryDatabase(path, () => settings.value.limits);
  const key = 'private-user:general', meta = { kind: 'c2c', senderId: 'test-user', targetId: 'test-user', promptId: 'general' };
  memory.commit(key, '你好', '你好呀', settings.value.limits, meta);
  memory.commit(key, '第二轮', '第二个回答', settings.value.limits, meta);
  memory.close(); memory = new MemoryDatabase(path, () => settings.value.limits);
  assert.equal(memory.history(key).length, 4);
  const row = memory.list().rows[0];
  memory.edit(row.id, { alias: '测试用户', enabled: false });
  assert.deepEqual(memory.history(key), []);
  memory.commit(key, '不会保存', '也不会保存');
  assert.equal(memory.detail(row.id).messages.length, 4);
  memory.edit(row.id, { enabled: true });
  settings.value.limits.historyRounds = 1; memory.applyLimits();
  assert.equal(memory.history(key).length, 2);
  memory.reset(key); assert.deepEqual(memory.history(key), []);
  assert.equal(memory.detail(row.id).alias, '测试用户');
});

test('会话容量上限移除最早会话；过期后清空正文保留停用设置', t => {
  let memory;
  const root = temporary(t, () => memory?.close()), settings = new SettingsStore(root); let now = 100000;
  settings.value.limits.maxSessions = 2; settings.value.limits.sessionTtlMs = 60000;
  memory = new MemoryDatabase(join(root, 'data/memory.sqlite'), () => settings.value.limits, () => now);
  memory.commit('a', 'A', 'A'); now++; memory.commit('b', 'B', 'B'); now++; memory.commit('c', 'C', 'C');
  assert.equal(memory.stats().sessions, 2); assert.deepEqual(memory.history('a'), []);
  const row = memory.list().rows[0]; memory.edit(row.id, { enabled: false, alias: '保留备注' });
  now += 60001; memory.prune(true);
  assert.equal(memory.detail(row.id).messages.length, 0); assert.equal(memory.detail(row.id).enabled, 0); assert.equal(memory.detail(row.id).alias, '保留备注');
});

test('提示词与 API 热切换：在途回答保留原配置，各套记忆隔离，回复长度限制生效', async t => {
  let memory;
  const root = temporary(t, () => memory?.close()), settings = new SettingsStore(root);
  settings.update({ providers: settings.public().providers.map(item => ({ ...item, apiKey: 'test-only-key' })), limits: { cooldownMs: 0, maxReplyBytes: 512 } });
  memory = new MemoryDatabase(join(root, 'data/memory.sqlite'), () => settings.value.limits);
  const calls = [], sent = []; let finish;
  const service = new ChatService({
    config: settings.runtime({ requireQQ: false }), sessions: memory,
    getConfig: () => settings.runtime({ requireQQ: false }),
    getLLM: cfg => ({ complete: messages => {
      calls.push({ provider: cfg.llm.id, prompt: cfg.chat.promptId, messages });
      return calls.length === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve('甲'.repeat(600));
    } }), send: async (_target, content) => sent.push(content), logger: { info() {}, warn() {}, error() {} },
  });
  const message = id => ({ kind: 'c2c', senderId: 'user', messageId: id, content: '问题', replyTarget: { scope: 'c2c', targetId: 'user', msgId: id } });
  const pending = service.handle(message('1'));
  settings.update({ activePromptId: 'coding', activeProviderId: 'deepseek', limits: { maxReplyBytes: 3600 } });
  finish('旧配置回答'); await pending;
  await service.handle(message('2'));
  assert.equal(calls[1].provider, 'deepseek'); assert.equal(calls[1].prompt, 'coding'); assert.equal(calls[1].messages.length, 2);
  assert.ok(Buffer.byteLength(sent[1]) > 512);
  settings.update({ activePromptId: 'general' }); await service.handle(message('3'));
  assert.equal(calls[2].messages[2].content, '旧配置回答'); assert.equal(memory.stats().sessions, 2);
});

test('控制台仅本地访问、写请求验证、记忆管理与完整数据备份', async t => {
  let panel;
  const root = temporary(t, () => panel?.close()); panel = await createControlPanel({ root, port: 0 });
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(panel.origin + path, { method, headers: { 'Content-Type': 'application/json', 'X-Local-Token': panel.token }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await fetch(panel.origin + '/api/bot/start', { method: 'POST' })).status, 403);
  assert.equal((await fetch(panel.origin + '/api/settings', { headers: { Origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await call('/api/bot/start', 'POST')).status, 400);
  const cfg = (await call('/api/settings')).data;
  assert.equal(cfg.qq.appSecret, undefined);
  assert.equal((await call('/api/settings', 'PUT', { activePromptId: 'writing' })).data.activePromptId, 'writing');
  panel.memory.commit('user:writing', '你好', '你好', panel.settings.value.limits, { senderId: 'sample-user', promptId: 'writing' });
  const rows = (await call('/api/memory')).data.rows; assert.equal(rows.length, 1);
  assert.equal((await call('/api/memory/' + rows[0].id, 'PATCH', { enabled: false, alias: '备注' })).status, 200);
  const exported = (await call('/api/memory/' + rows[0].id + '/export', 'POST')).data;
  assert.ok(existsSync(resolve(root, exported.path)));
  assert.equal(JSON.parse(readFileSync(resolve(root, exported.path))).alias, '备注');
  panel.runtime.activeTests = 1;
  assert.equal((await call('/api/memory/' + rows[0].id, 'DELETE')).status, 400);
  assert.equal((await call('/api/settings', 'PUT', { limits: { historyRounds: 1 } })).status, 400);
  panel.runtime.activeTests = 0;
  const backup = (await call('/api/backup', 'POST')).data;
  assert.ok(existsSync(resolve(root, backup.path, 'memory.sqlite')));
  assert.equal(JSON.parse(readFileSync(resolve(root, backup.path, 'settings.json'))).activePromptId, 'writing');
  assert.equal((await call('/api/storage/cleanup', 'POST', { scope: '../data' })).status, 400);
  assert.equal((await call('/api/storage/cleanup', 'POST', { scope: '.cache' })).status, 200);
  assert.ok(existsSync(resolve(root, 'data/settings.json')));
});

test('控制台按选中的已保存API测试插件调用，受验证和并发限制，不创建预约或记忆', async t => {
  let panel;
  const root = temporary(t, () => panel?.close());
  panel = await createControlPanel({ root, port: 0 });
  const providers = panel.settings.public().providers.map(provider => ({ ...provider, apiKey: 'fake-key' }));
  providers.push({ ...providers[0], id: 'tool-compatible', name: '工具接口测试', protocol: 'openai', webSearch: false });
  panel.settings.update({ providers });
  const selected = providers.at(-1), before = JSON.stringify(panel.settings.value);
  const original = panel.runtime.client.bind(panel.runtime);
  let requests = 0;
  panel.runtime.client = (config, ...args) => {
    assert.equal(config.llm.id, selected.id);
    assert.equal(config.llm.webSearch, false);
    const client = original(config, ...args);
    client.fetchImpl = async (_url, options) => {
      const body = JSON.parse(options.body); requests++;
      if (requests === 1) {
        const code = body.messages.at(-1).content.match(/code=([a-f0-9-]+)/)[1];
        return Response.json({ choices: [{ message: { tool_calls: [{ id: 'test', type: 'function', function: { name: body.tools[0].function.name, arguments: JSON.stringify({ code }) } }] } }], usage: { prompt_tokens: 20, completion_tokens: 5 } });
      }
      return Response.json({ choices: [{ message: { content: JSON.parse(body.messages.at(-1).content).receipt } }], usage: { prompt_tokens: 30, completion_tokens: 10 } });
    };
    return client;
  };
  const request = () => fetch(panel.origin + '/api/tool-check', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': panel.token }, body: JSON.stringify({ providerId: selected.id }) });
  assert.equal((await fetch(panel.origin + '/api/tool-check', { method: 'POST' })).status, 403);
  const response = await request(), result = await response.json();
  assert.equal(response.status, 200, result.error);
  assert.equal(result.supported, true);
  assert.equal(requests, 2);
  assert.equal(panel.runtime.activeTests, 0);
  assert.equal(panel.runtime.testControllers.size, 0);
  assert.equal(panel.runtime.counters.inputTokens, 50);
  assert.equal(panel.runtime.groups.usedToday(), 65);
  assert.equal(JSON.stringify(panel.settings.value), before);
  assert.equal(panel.memory.stats().sessions, 0);
  assert.equal(panel.runtime.plugins.entries.get('reminders').instance.store.list().total, 0);
  panel.runtime.activeTests = panel.settings.value.limits.maxConcurrent;
  assert.equal((await request()).status, 400);
  panel.runtime.activeTests = 0;
  const html = await (await fetch(panel.origin)).text();
  assert.ok(html.includes('id="check-tools"') && html.includes('id="tools-result"'));
});
