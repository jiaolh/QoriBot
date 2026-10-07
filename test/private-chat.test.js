import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectRoot } from '../src/config.js';
import { SettingsStore } from '../src/settings.js';
import { MemoryDatabase } from '../src/memory-db.js';
import { BotRuntime } from '../src/runtime.js';
import { ChatService } from '../src/chat-service.js';
import { userIdentity } from '../src/profile-memory.js';
import { createControlPanel } from '../src/server.js';

const silent = { info() {}, warn() {}, error() {} };
function temporary(t, cleanup) {
  mkdirSync(resolve(projectRoot, '.cache/test'), { recursive: true });
  const root = mkdtempSync(resolve(projectRoot, '.cache/test/private-'));
  t.after(async () => { await cleanup?.(); rmSync(root, { recursive: true, force: true }); });
  return root;
}
function fixture(t) {
  let memory, runtime;
  const root = temporary(t, async () => { await runtime?.stop(); memory?.close(); });
  const settings = new SettingsStore(root);
  settings.update({ providers: settings.public().providers.map(p => ({ ...p, apiKey: 'fake-key' })), limits: { cooldownMs: 0, autoMemory: false, maxTokens: 64 } });
  let now = Date.parse('2026-10-06T04:00:00Z');
  memory = new MemoryDatabase(resolve(root, 'data/memory.sqlite'), () => settings.value.limits, () => now);
  runtime = new BotRuntime(settings, memory, { now: () => now });
  const calls = [], sent = [];
  const service = new ChatService({ config: settings.runtime({ requireQQ: false }), sessions: memory, profiles: runtime.profiles,
    privateChats: runtime.privateChats, now: () => now, logger: silent,
    getConfig: message => message.kind === 'c2c' ? settings.privateRuntime(message.replyTarget.targetId) : settings.runtime({ requireQQ: false }),
    getLLM: cfg => ({ complete: async messages => { calls.push({ cfg, messages }); return '回答'; } }),
    send: async (target, text) => sent.push({ target, text }),
  });
  return { root, settings, memory, runtime, service, calls, sent, advance: ms => { now += ms; },
    message(id, user = 'alice', content = '你好', group = '') { return { kind: group ? 'group' : 'c2c', senderId: user, messageId: id, content,
      timestamp: new Date(now).toISOString(), rawEventType: group ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE',
      replyTarget: { scope: group ? 'group' : 'c2c', targetId: group || user, msgId: id } }; },
    reopen() { memory.close(); memory = new MemoryDatabase(resolve(root, 'data/memory.sqlite'), () => settings.value.limits, () => now); runtime.memory = memory; runtime.groups.db = memory.db; runtime.privateChats.db = memory.db; runtime.privateChats.memory = memory; runtime.profiles.db = memory.db; service.sessions = memory; },
  };
}

test('旧配置自动补齐个人模式，按用户选模型与提示词且重启保留', t => {
  const f = fixture(t), old = JSON.parse(readFileSync(f.settings.path, 'utf8'));
  delete old.privateChat; writeFileSync(f.settings.path, JSON.stringify(old));
  const settings = new SettingsStore(f.root);
  assert.deepEqual(settings.value.privateChat, { users: {} });
  assert.equal(settings.privateRuntime('alice').llm.id, 'default');
  assert.equal(settings.privateRuntime('alice').chat.promptId, 'general');
  const extra = { ...settings.public().providers[0], id: 'personal', name: '个人 API', apiKey: 'personal-test-key' };
  settings.update({ providers: [...settings.public().providers, extra], privateChat: { users: { alice: { promptId: 'coding', replyProviderId: 'personal', cooldownMs: 0 } } } });
  settings.update({ activePromptId: 'writing', activeProviderId: 'deepseek' });
  const restored = new SettingsStore(f.root);
  assert.equal(restored.privateRuntime('alice').llm.id, 'personal');
  assert.equal(restored.privateRuntime('alice').chat.promptId, 'coding');
  assert.equal(restored.privateRuntime('bob').chat.promptId, 'writing');
  assert.equal(restored.value.privateChat.users.alice.enabled, true);
  assert.ok(!JSON.stringify(restored.public()).includes('personal-test-key'));
  assert.throws(() => restored.update({ providers: restored.public().providers.filter(p => p.id !== 'personal') }), /私聊 API/);
  assert.throws(() => restored.update({ prompts: restored.value.prompts.filter(p => p.id !== 'coding') }), /私聊提示词/);
});

test('个人设置校验拒绝错误标识、字段、范围与不完整免打扰', t => {
  const f = fixture(t);
  for (const privateChat of [null, [], { unknown: true }, { users: [] }, { users: JSON.parse('{"__proto__":{}}') }, { users: { 'bad/id': {} } },
    { users: { alice: { enabled: 'false' } } }, { users: { alice: { mode: 'active' } } }, { users: { alice: { cooldownMs: -1 } } },
    { users: { alice: { maxRepliesHour: 1.5 } } }, { users: { alice: { dailyTokenLimit: 100000001 } } },
    { users: { alice: { quietStart: '23:00' } } }, { users: { alice: { quietStart: '24:00', quietEnd: '06:00' } } }]) {
    assert.throws(() => f.settings.update({ privateChat }));
  }
  assert.deepEqual(f.settings.value.privateChat.users, {});
  f.settings.update({ privateChat: { users: { alice: { quietStart: '23:00', quietEnd: '06:00', cooldownMs: null } } } });
  assert.equal(f.settings.privateRuntime('alice').chat.cooldownMs, 0);
});

test('私聊独立人格、去重和近期记忆隔离，其他用户与群聊继续跟随全局', async t => {
  const f = fixture(t);
  f.settings.update({ privateChat: { users: { alice: { promptId: 'coding', replyProviderId: 'deepseek' } } } });
  await f.service.handle(f.message('1'));
  await f.service.handle(f.message('1'));
  await f.service.handle(f.message('2'));
  await f.service.handle(f.message('3', 'bob'));
  await f.service.handle(f.message('4', 'alice', '你好', 'group-one'));
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls[0].cfg.llm.id, 'deepseek');
  assert.equal(f.calls[1].messages.length, 4);
  assert.equal(f.calls[2].cfg.chat.promptId, 'general');
  assert.equal(f.calls[3].cfg.chat.promptId, 'general');
  assert.equal(f.calls[3].messages.length, 2);
  assert.deepEqual(f.runtime.privateChats.list().map(row => row.userId).sort(), ['alice', 'bob']);
  f.settings.update({ privateChat: { users: { alice: { promptId: 'writing' } } } });
  await f.service.handle(f.message('5'));
  assert.equal(f.calls.at(-1).messages.length, 2);
  assert.equal(f.runtime.privateChats.detail('alice').sessions.length, 2);
});

test('关闭回复与跨午夜免打扰均静默，解除后可回复', async t => {
  const f = fixture(t);
  f.settings.update({ privateChat: { users: { alice: { enabled: false }, bob: { quietStart: '11:00', quietEnd: '13:00' } } } });
  await f.service.handle(f.message('1')); await f.service.handle(f.message('2', 'alice', '/help'));
  await f.service.handle(f.message('3', 'bob')); assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
  assert.equal(f.memory.stats().sessions, 0); assert.equal(f.runtime.privateChats.list().length, 2);
  f.settings.update({ privateChat: { users: { alice: {}, bob: { quietStart: '23:00', quietEnd: '06:00' } } } });
  f.advance(12 * 3600000); await f.service.handle(f.message('4', 'bob')); assert.equal(f.calls.length, 0);
  f.advance(7 * 3600000); await f.service.handle(f.message('5', 'bob')); await f.service.handle(f.message('6'));
  assert.equal(f.calls.length, 2);
});

test('私聊频率限制按用户且重启保留，管理指令不计次数', async t => {
  const f = fixture(t);
  f.settings.update({ privateChat: { users: { alice: { cooldownMs: 1000, maxRepliesHour: 2 } } } });
  await f.service.handle(f.message('1')); await f.service.handle(f.message('2')); assert.equal(f.calls.length, 1);
  assert.match(f.sent.at(-1).text, /有点快/);
  f.advance(1001); await f.service.handle(f.message('3')); await f.service.handle(f.message('4'));
  assert.match(f.sent.at(-1).text, /本小时/);
  await f.service.handle(f.message('5', 'alice', '/model')); assert.match(f.sent.at(-1).text, /当前模型/);
  assert.equal(f.runtime.privateChats.repliesHour('alice'), 2);
  f.reopen(); assert.equal(f.runtime.privateChats.gate('alice'), 'hour');
  await f.service.handle(f.message('6', 'bob')); assert.equal(f.calls.length, 3);
  f.advance(3600001); await f.service.handle(f.message('7')); assert.equal(f.calls.length, 4);
});

test('切换提示词时同一私聊仍只允许一个在途请求，发送失败不计成功次数', async t => {
  const f = fixture(t); let release;
  f.service.getLLM = () => ({ complete: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.service.handle(f.message('1'));
  f.settings.update({ privateChat: { users: { alice: { promptId: 'coding' } } } });
  await f.service.handle(f.message('2')); assert.match(f.sent.at(-1).text, /上一条问题/);
  release('完成'); await pending;
  f.service.getLLM = () => ({ complete: async () => '回答' });
  f.service.send = async () => { throw new Error('send failed'); };
  await f.service.handle(f.message('3'));
  assert.equal(f.runtime.privateChats.repliesHour('alice'), 1);
});

test('修改私聊发送间隔后新设置立即生效，不保留旧冷却截止时间', async t => {
  const f = fixture(t);
  f.settings.update({ privateChat: { users: { alice: { cooldownMs: 60000 } } } });
  await f.service.handle(f.message('1')); await f.service.handle(f.message('2')); assert.equal(f.calls.length, 1);
  f.settings.update({ privateChat: { users: { alice: { cooldownMs: 0 } } } });
  await f.service.handle(f.message('3')); assert.equal(f.calls.length, 2);
  f.settings.update({ privateChat: { users: { alice: { cooldownMs: 1000 } } } });
  await f.service.handle(f.message('4')); assert.equal(f.calls.length, 2);
  f.advance(1001); await f.service.handle(f.message('5')); assert.equal(f.calls.length, 3);
});

test('私聊预算记录实际或估算用量，失败保留用量，重启保留且按北京时间归日', async t => {
  const f = fixture(t);
  const run = (usage, fail = false, user = 'alice') => {
    const client = f.runtime.client(f.settings.privateRuntime(user), new AbortController().signal);
    client.fetchImpl = async () => fail ? new Response('failed', { status: 500 }) : Response.json({ choices: [{ message: { content: '回答' } }], ...(usage ? { usage } : {}) });
    return client.complete([{ role: 'user', content: '你好' }]);
  };
  await run({ prompt_tokens: 20, completion_tokens: 10 }); assert.equal(f.runtime.privateChats.usedToday('alice'), 30);
  await run(null); const estimated = f.runtime.privateChats.usedToday('alice'); assert.ok(estimated > 30);
  await assert.rejects(run(null, true)); assert.ok(f.runtime.privateChats.usedToday('alice') > estimated);
  const used = f.runtime.privateChats.usedToday('alice');
  f.settings.update({ privateChat: { users: { alice: { dailyTokenLimit: used + 1 } } } });
  await assert.rejects(run({ prompt_tokens: 1, completion_tokens: 1 }), /私聊模型预算/);
  assert.equal(f.runtime.privateChats.usedToday('alice'), used);
  await run({ prompt_tokens: 3, completion_tokens: 2 }, false, 'bob');
  assert.equal(f.runtime.privateChats.usedToday('bob'), 5);
  assert.equal(f.runtime.groups.usedToday(), used + 5);
  f.reopen(); assert.equal(f.runtime.privateChats.usedToday('alice'), used);
  f.advance(12 * 3600000); assert.equal(f.runtime.privateChats.usedToday(), 0);
});

test('私聊工具的每轮请求与长期记忆整理分别计入个人预算', async t => {
  const f = fixture(t), config = f.settings.privateRuntime('alice');
  const client = f.runtime.client(config, new AbortController().signal); let requests = 0;
  client.fetchImpl = async () => {
    requests++;
    return Response.json({ choices: [{ message: requests === 1 ? { tool_calls: [{ id: 'tool-one', type: 'function', function: { name: 'demo', arguments: '{}' } }] } : { content: '工具完成' } }], usage: { prompt_tokens: 20, completion_tokens: 10 } });
  };
  await client.complete([{ role: 'user', content: '测试工具' }], { tools: [{ name: 'demo', description: '测试', parameters: { type: 'object', properties: {} } }], execute: async () => ({ ok: true }) });
  assert.equal(requests, 2); assert.equal(f.runtime.privateChats.usedToday('alice'), 60);
  const learningClient = f.runtime.client({ ...config, llm: { ...config.llm, maxTokens: 64 } }, new AbortController().signal);
  learningClient.fetchImpl = async () => Response.json({ choices: [{ message: { content: '{"notes":null}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  await learningClient.complete([{ role: 'user', content: '整理资料' }]);
  assert.equal(f.runtime.privateChats.usedToday('alice'), 75);
  assert.equal(f.runtime.groups.usedToday(), 75);
});

test('个人模式控制台接口、搜索、作用域清理和备份可用，写入要求本机验证和空闲', async t => {
  let panel;
  const root = temporary(t, () => panel?.close()); panel = await createControlPanel({ root, port: 0 });
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(panel.origin + path, { method, headers: { 'Content-Type': 'application/json', 'X-Local-Token': panel.token }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const meta = { kind: 'c2c', senderId: 'alice', targetId: 'alice', promptId: 'general' };
  panel.memory.commit('alice:general', '私聊问题', '私聊回答', panel.settings.value.limits, meta);
  panel.memory.commit('alice:coding', '代码问题', '代码回答', panel.settings.value.limits, { ...meta, promptId: 'coding' });
  panel.memory.commit('group:alice', '群问题', '群回答', panel.settings.value.limits, { ...meta, kind: 'group', targetId: 'group' });
  const profile = panel.profiles.ensure(userIdentity('c2c', 'alice', 'alice')); panel.profiles.edit(profile, { notes: '- 喜欢中文' });
  panel.runtime.privateChats.discover('alice'); panel.runtime.privateChats.sent('alice');
  panel.runtime.privateChats.reserve('alice', [{ content: '问题' }], 64);
  assert.equal((await call('/api/settings', 'PUT', { privateChat: { users: { alice: { alias: '私聊测试', promptId: 'coding' }, future: {} } } })).status, 200);
  const list = (await call('/api/private?q=' + encodeURIComponent('私聊测试'))).data; assert.equal(list.rows.length, 1); assert.equal(list.rows[0].rounds, 2);
  assert.equal((await call('/api/private/future')).status, 200);
  const detail = (await call('/api/private/alice')).data; assert.equal(detail.profileId, profile); assert.equal(detail.sessions.length, 2);
  assert.equal((await call('/api/private/unknown')).status, 400);
  assert.equal((await call('/api/private/bad%2Fid')).status, 400);
  assert.equal((await fetch(panel.origin + '/api/private/alice/clear', { method: 'POST' })).status, 403);
  panel.runtime.activeTests = 1;
  assert.equal((await call('/api/private/alice/clear', 'POST')).status, 400);
  assert.equal((await call('/api/settings', 'PUT', { privateChat: { users: {} } })).status, 400);
  panel.runtime.activeTests = 0;
  assert.equal((await call('/api/private/alice/clear', 'POST')).data.cleared, 2);
  assert.ok((await call('/api/private/alice')).data.sessions.every(session => session.messages.length === 0));
  assert.equal(panel.memory.history('group:alice').length, 2); assert.equal(panel.profiles.get(profile).notes, '- 喜欢中文');
  assert.ok(panel.runtime.privateChats.usedToday('alice') > 0); assert.equal(panel.runtime.privateChats.repliesHour('alice'), 1);
  const backup = (await call('/api/backup', 'POST')).data;
  assert.equal(JSON.parse(readFileSync(resolve(root, backup.path, 'settings.json'), 'utf8')).privateChat.users.alice.alias, '私聊测试');
  const html = await (await fetch(panel.origin)).text(); assert.match(html, /id="page-private"/); assert.match(html, /private\.js\?v=[a-f0-9]{12}/);
  assert.equal((await fetch(panel.origin + '/private.js')).status, 200);
});
