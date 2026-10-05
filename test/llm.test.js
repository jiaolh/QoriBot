import test from 'node:test';
import assert from 'node:assert/strict';
import { LLMClient } from '../src/llm.js';

const config = { apiKey: 'fake-key', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', maxTokens: 1024, timeoutMs: 1000 };

test('向指定地址发送兼容聊天请求，不传空温度，不泄露思考内容', async () => {
  let request;
  const client = new LLMClient(config, { fetchImpl: async (url, options) => {
    request = { url, options };
    return Response.json({ choices: [{ message: { content: '  回答  ', reasoning_content: 'internal reasoning' } }] });
  } });
  const messages = [{ role: 'user', content: '你好' }];
  assert.equal(await client.complete(messages), '回答');
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.options.headers.Authorization, 'Bearer fake-key');
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(JSON.parse(request.options.body), { model: 'deepseek-flash', messages, stream: false, max_tokens: 1024 });
});

test('错误响应给出可用提示，不展示上游原文或密钥', async () => {
  for (const [status, hint] of [[401, /Key/], [403, /无权/], [404, /模型名称/], [429, /额度/], [500, /暂时不可用/]]) {
    const client = new LLMClient(config, { fetchImpl: async () => new Response('raw secret fake-key', { status }) });
    await assert.rejects(client.complete([]), error => hint.test(error.message) && !error.message.includes('fake-key') && error.status === status);
  }
});

test('模型列表去重排序，空回答和坏 JSON 报错', async () => {
  const client = new LLMClient(config, { fetchImpl: async () => Response.json({ data: [{ id: 'z' }, { id: 'a' }, { id: 'a' }] }) });
  assert.deepEqual(await client.listModels(), ['a', 'z']);
  for (const response of [Response.json({ choices: [{ message: { content: '' } }] }), new Response('<html>')]) {
    const bad = new LLMClient(config, { fetchImpl: async () => response });
    await assert.rejects(bad.complete([]), /没有返回文本|无法解析/);
  }
});

test('终止信号中断请求，并给出停止提示', async () => {
  const stop = new AbortController();
  const client = new LLMClient(config, { signal: stop.signal, fetchImpl: async (_url, options) => {
    stop.abort();
    options.signal.throwIfAborted();
  } });
  await assert.rejects(client.complete([]), /正在停止/);
});
