import test from 'node:test';
import assert from 'node:assert/strict';
import { LLMClient } from '../src/llm.js';
import { checkToolSupport } from '../src/llm/tool-check.js';

const base = { apiKey: 'fake-key', baseUrl: 'https://example.com/v1', model: 'independent-model', maxTokens: 512, timeoutMs: 1000 };
const definition = { name: 'local_demo', description: '本机测试', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, additionalProperties: false } };
const openai = (content, calls) => Response.json({ choices: [{ message: { content, ...(calls ? { tool_calls: calls, reasoning_content: '需要原样续传的内容' } : {}) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const use = (id, args = '{"a":1,"b":2}') => ({ id, type: 'function', function: { name: 'local_demo', arguments: args } });
const anthropic = content => Response.json({ id: 'demo', type: 'message', role: 'assistant', model: base.model, content, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } });

test('两种协议均能验证工具选择和结果回传；不依赖预约插件或特定模型', async () => {
  for (const protocol of ['openai', 'anthropic']) {
    const requests = [];
    const client = new LLMClient({ ...base, protocol }, { fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length === 1) {
        const code = body.messages.at(-1).content.match(/code=([a-f0-9-]+)/)[1];
        const call = { id: 'check-1', name: 'qoribot_capability_check' };
        return protocol === 'openai'
          ? openai(null, [{ ...use(call.id), function: { name: call.name, arguments: JSON.stringify({ code }) } }])
          : anthropic([{ type: 'tool_use', ...call, input: { code } }]);
      }
      const output = JSON.parse(protocol === 'openai' ? body.messages.at(-1).content : body.messages.at(-1).content[0].content);
      return protocol === 'openai' ? openai(output.receipt) : anthropic([{ type: 'text', text: output.receipt }]);
    } });
    assert.equal((await checkToolSupport(client)).supported, true);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].tools.length, 1);
  }
});

test('普通文字回答、拒绝tools和伪造回执均不能通过兼容检查', async () => {
  const textOnly = new LLMClient(base, { fetchImpl: async () => openai('支持工具，测试通过') });
  assert.equal((await checkToolSupport(textOnly)).supported, false);
  const rejected = new LLMClient(base, { fetchImpl: async () => new Response('secret fake-key', { status: 400 }) });
  const result = await checkToolSupport(rejected);
  assert.equal(result.supported, false); assert.match(result.message, /工具调用/); assert.ok(!result.message.includes('fake-key'));
  rejected.fetchImpl = async () => new Response('secret fake-key', { status: 401 });
  await assert.rejects(checkToolSupport(rejected), /Key/);
});

test('工具标识先整批验证，任意重复或缺失均不产生执行效果', async () => {
  for (const protocol of ['openai', 'anthropic']) for (const badId of ['one', '']) {
    let executed = 0;
    const client = new LLMClient({ ...base, protocol }, { fetchImpl: async () => protocol === 'openai'
      ? openai(null, [use('one'), use(badId)])
      : anthropic([{ type: 'tool_use', id: 'one', name: 'local_demo', input: {} }, { type: 'tool_use', id: badId, name: 'local_demo', input: {} }]) });
    await assert.rejects(client.complete([], { tools: [definition], execute: () => { executed++; } }), /标识无效或重复/);
    assert.equal(executed, 0);
  }
});

test('参数键顺序变化也只执行一次，后续请求保留思考字段但回复不泄露', async () => {
  const requests = [];
  let executed = 0;
  const client = new LLMClient(base, { fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    if (requests.length < 3) return openai(null, [use('call-' + requests.length, requests.length === 1 ? '{"a":1,"b":2}' : '{"b":2,"a":1}')]);
    assert.equal(body.messages.find(message => message.role === 'assistant').reasoning_content, '需要原样续传的内容');
    return openai('已完成');
  } });
  assert.equal(await client.complete([], { tools: [definition], execute: () => { executed++; return { ok: true }; } }), '已完成');
  assert.equal(executed, 1);
});

test('Anthropic 工具请求也响应停止信号并清理挂起请求', async () => {
  const stop = new AbortController();
  const client = new LLMClient({ ...base, protocol: 'anthropic' }, { signal: stop.signal, fetchImpl: async (_url, options) => {
    stop.abort(); options.signal.throwIfAborted();
  } });
  await assert.rejects(client.complete([], { tools: [definition], execute: () => { throw new Error('不应执行'); } }), /正在停止/);
});
