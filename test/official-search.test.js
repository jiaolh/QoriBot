import test from 'node:test';
import assert from 'node:assert/strict';
import { LLMClient } from '../src/llm.js';

const config = { apiKey: 'fake-key', protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash', webSearch: true, maxTokens: 1024, timeoutMs: 1000 };
function response(content, stop_reason = 'end_turn') {
  return Response.json({ id: 'test', type: 'message', role: 'assistant', model: 'deepseek-flash', content, stop_reason, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 10 } });
}

test('使用官方 SDK 调用 DeepSeek 原生搜索工具，输出回答和引用', async () => {
  let request; const usage = [];
  const client = new LLMClient(config, { onUsage: value => usage.push(value), fetchImpl: async (url, options) => {
    request = { url: String(url), body: JSON.parse(options.body), headers: new Headers(options.headers) };
    return response([
      { type: 'server_tool_use', id: 'search-1', name: 'web_search', input: { query: '最新新闻' } },
      { type: 'web_search_tool_result', tool_use_id: 'search-1', content: [] },
      { type: 'text', text: '官方搜索回答', citations: [{ type: 'web_search_result_location', url: 'https://example.com/news', title: '新闻来源' }] },
    ]);
  } });
  const answer = await client.complete([{ role: 'system', content: '中文回答' }, { role: 'user', content: '查询新闻' }]);
  assert.equal(request.url, 'https://api.deepseek.com/anthropic/v1/messages');
  assert.equal(request.headers.get('x-api-key'), 'fake-key');
  assert.deepEqual(request.body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]);
  assert.equal(request.body.system, '中文回答');
  assert.match(answer, /官方搜索回答/); assert.match(answer, /https:\/\/example.com\/news/);
  assert.equal(usage[0].searches, 1);
  const fallback = new LLMClient(config, { fetchImpl: async () => response([
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: '官方结果来源', url: 'https://example.com/source' }] },
    { type: 'text', text: '没有单独引用的回答' },
  ]) });
  assert.match(await fallback.complete([{ role: 'user', content: '搜索' }]), /https:\/\/example.com\/source/);
});

test('官方搜索暂停原样续传；工具失败不能伪装成搜索成功', async () => {
  const first = [{ type: 'server_tool_use', id: 'search-1', name: 'web_search', input: { query: '问题' } }];
  let count = 0;
  const client = new LLMClient(config, { fetchImpl: async (_url, options) => {
    count++;
    if (count === 1) return response(first, 'pause_turn');
    assert.deepEqual(JSON.parse(options.body).messages.at(-1), { role: 'assistant', content: first });
    return response([{ type: 'text', text: '继续后完成' }]);
  } });
  assert.equal(await client.complete([{ role: 'user', content: '搜索' }]), '继续后完成');
  const failed = new LLMClient(config, { fetchImpl: async () => response([{ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'unavailable' } }, { type: 'text', text: '没有搜索的回答' }]) });
  await assert.rejects(failed.complete([{ role: 'user', content: '搜索' }]), /官方联网搜索暂时失败/);
});
