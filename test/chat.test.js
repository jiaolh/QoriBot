import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
import { ChatService, limitReply, sessionKey } from '../src/chat-service.js';
import { SessionStore } from '../src/sessions.js';
import { LLMError } from '../src/llm.js';
import { createLogger } from '../src/logger.js';

function config(extra = {}) {
  return readConfig({ QQ_APP_ID: '123', QQ_APP_SECRET: 'test-secret', LLM_API_KEY: 'test-key', LLM_MODEL: 'deepseek-flash', USER_COOLDOWN_SECONDS: '0', ...extra });
}
const silent = { info() {}, warn() {}, error() {} };
function message(id, sender = 'user-a', group) {
  return {
    kind: group ? 'group' : 'c2c', senderId: sender, messageId: id,
    rawEventType: group ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE',
    content: group ? '<@!123> 你好' : '你好',
    replyTarget: { scope: group ? 'group' : 'c2c', targetId: group || sender, msgId: id },
  };
}
function harness(options = {}) {
  const calls = [], sent = [];
  const cfg = options.config || config();
  const service = new ChatService({
    config: cfg, logger: silent, now: options.now,
    llm: { async complete(messages) { calls.push(messages); return options.complete ? options.complete(messages) : '你好呀'; } },
    send: async (target, text) => { if (options.failSend) throw new Error('send failed'); sent.push({ target, text }); },
  });
  return { service, calls, sent };
}

test('配置保留指定模型和统一 QQ 域名，拒绝无效配置', () => {
  const cfg = config();
  assert.equal(cfg.llm.model, 'deepseek-flash');
  assert.equal(cfg.qq.baseUrl, 'https://api.bot.qq.com');
  assert.equal(cfg.qq.transport, 'websocket');
  assert.throws(() => config({ LLM_API_KEY: '' }), /LLM_API_KEY/);
  assert.throws(() => config({ MAX_CONCURRENT_REQUESTS: '0' }), /MAX_CONCURRENT_REQUESTS/);
  assert.throws(() => config({ LLM_BASE_URL: 'http://example.com/v1' }), /HTTPS/);
  assert.throws(() => config({ LLM_BASE_URL: 'https://user:secret@example.com/v1' }), /账号/);
  assert.throws(() => config({ QQ_TRANSPORT: 'other' }), /QQ_TRANSPORT/);
});

test('私聊保持上下文，重复事件仅调用模型和回复一次', async () => {
  const { service, calls, sent } = harness();
  await service.handle(message('m1'));
  await service.handle(message('m1'));
  await service.handle({ ...message('m2'), content: '我刚才说什么？' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].slice(1), [
    { role: 'user', content: '你好' }, { role: 'assistant', content: '你好呀' },
    { role: 'user', content: '我刚才说什么？' },
  ]);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].target.msgId, 'm1');
});

test('群成员、不同群和私聊记忆独立；只回复群 @ 事件', async () => {
  const { service, calls } = harness();
  await service.handle(message('same-id', 'user-a', 'group-1'));
  await service.handle(message('m2', 'user-b', 'group-1'));
  await service.handle(message('same-id', 'user-a', 'group-2'));
  await service.handle(message('m4', 'user-a'));
  await service.handle({ ...message('m5', 'user-a', 'group-1'), rawEventType: 'GROUP_MESSAGE_CREATE' });
  assert.equal(calls.length, 4);
  assert.ok(calls.every(messages => messages.length === 2));
  assert.equal(calls[0][1].content, '你好');
});

test('帮助与模型指令不调用模型；重置只清空当前用户会话', async () => {
  const { service, calls, sent } = harness();
  await service.handle(message('m1'));
  await service.handle({ ...message('m2'), content: '/help' });
  await service.handle({ ...message('m3'), content: '/model' });
  await service.handle({ ...message('m4'), content: '/reset' });
  await service.handle(message('m5'));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].length, 2);
  assert.match(sent[2].text, /deepseek-flash/);
  assert.match(sent[3].text, /已重置/);
});

test('请求进行中拒绝同一会话的新请求和重置，限制全局并发', async () => {
  let finish;
  const { service, calls, sent } = harness({
    config: config({ MAX_CONCURRENT_REQUESTS: '1' }),
    complete: () => new Promise(resolve => { finish = resolve; }),
  });
  const first = service.handle(message('m1'));
  await service.handle(message('m2'));
  await service.handle({ ...message('m3'), content: '/reset' });
  await service.handle(message('m4', 'user-b'));
  assert.equal(calls.length, 1);
  assert.match(sent[0].text, /上一条问题/);
  assert.match(sent[1].text, /上一条问题/);
  assert.match(sent[2].text, /较多问题/);
  finish('完成');
  await first;
  assert.equal(service.busy.size, 0);
});

test('失败的模型请求和失败的 QQ 发送不写入历史', async () => {
  const failedModel = harness({ complete: () => { throw new LLMError('超时'); } });
  await failedModel.service.handle(message('m1'));
  assert.deepEqual(failedModel.service.sessions.history(sessionKey(message('m1'))), []);
  assert.equal(failedModel.sent[0].text, '超时');
  const failedSend = harness({ failSend: true });
  await failedSend.service.handle(message('m2'));
  assert.deepEqual(failedSend.service.sessions.history(sessionKey(message('m2'))), []);
  assert.equal(failedSend.service.busy.size, 0);
});

test('空输入、过长输入和机器人消息不会调用模型', async () => {
  const { service, calls, sent } = harness({ config: config({ MAX_INPUT_CHARS: '5' }) });
  await service.handle({ ...message('m1'), content: '', attachments: [{ url: 'x' }] });
  await service.handle({ ...message('m2'), content: '超过五个字符的问题' });
  await service.handle({ ...message('m3'), senderIsBot: true });
  assert.equal(calls.length, 0);
  assert.match(sent[0].text, /文字问题/);
  assert.match(sent[1].text, /太长/);
});

test('会话按整轮裁剪、过期并限制会话总数', () => {
  let now = 0;
  const store = new SessionStore(config({ HISTORY_ROUNDS: '2', MAX_SESSIONS: '2', SESSION_TTL_MINUTES: '1' }).chat, () => now);
  store.commit('a', '1', 'A');
  store.commit('a', '2', 'B');
  store.commit('a', '3', 'C');
  assert.deepEqual(store.history('a').map(item => item.content), ['2', 'B', '3', 'C']);
  store.commit('b', '4', 'D');
  store.commit('c', '5', 'E');
  assert.deepEqual(store.history('a'), []);
  now = 60_001;
  assert.deepEqual(store.history('b'), []);
});

test('冷却期内不再调用模型，到期可再次发送', async () => {
  let now = 0;
  const { service, calls, sent } = harness({ config: config({ USER_COOLDOWN_SECONDS: '1' }), now: () => now });
  await service.handle(message('m1'));
  await service.handle(message('m2'));
  assert.equal(calls.length, 1);
  assert.match(sent[1].text, /有点快/);
  now = 1001;
  await service.handle(message('m3'));
  assert.equal(calls.length, 2);
});

test('回复按 UTF-8 字节截断，中文与 emoji 不损坏', () => {
  const text = limitReply('😀中文'.repeat(1000), 512);
  assert.ok(Buffer.byteLength(text, 'utf8') <= 512);
  assert.match(text, /已截断/);
  assert.equal(text.includes('\ufffd'), false);
});

test('日志隐藏 Key 和 AppSecret，调试日志默认关闭', () => {
  const output = [];
  const capture = { info: text => output.push(text), warn: text => output.push(text), error: text => output.push(text) };
  const logger = createLogger(['test-key', 'test-secret'], capture);
  logger.error('test-key test-secret Bearer another-secret');
  logger.debug('聊天正文');
  assert.equal(output.length, 1);
  assert.equal(output[0].includes('test-key'), false);
  assert.equal(output[0].includes('test-secret'), false);
  assert.equal(output[0].includes('another-secret'), false);
});
