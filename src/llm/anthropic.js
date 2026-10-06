import Anthropic from '@anthropic-ai/sdk';
import { supportsOfficialSearch } from '../settings.js';
import { LLMError, statusMessage, assertToolCalls, validToolArguments } from './errors.js';

export class AnthropicAdapter {
  constructor(client) {
    this.client = client;
    const { config } = client;
    // 一个模型会话复用 SDK；仍允许测试和运行时替换 fetchImpl。
    this.sdk = new Anthropic({
      apiKey: config.apiKey, baseURL: config.baseUrl, maxRetries: 0, timeout: config.timeoutMs,
      fetch: (url, options) => client.fetchImpl(url, { ...options, redirect: 'error' }),
    });
  }

  async request(history, tools = []) {
    const { config, signal: stopSignal } = this.client;
    if (config.webSearch && !supportsOfficialSearch(config)) throw new LLMError('当前接口没有已确认的官方联网搜索支持。');
    const body = {
      model: config.model, max_tokens: config.maxTokens, stream: false,
      system: history.filter(item => item.role === 'system').map(item => item.content).join('\n'),
      messages: history.filter(item => item.role !== 'system'),
    };
    if (config.temperature !== undefined) body.temperature = config.temperature;
    if (tools.length) {
      body.tools = tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
      body.tool_choice = { type: 'auto', disable_parallel_tool_use: true };
    }
    if (config.webSearch) (body.tools ||= []).push({ type: 'web_search_20250305', name: 'web_search', max_uses: 3 });
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const signal = stopSignal ? AbortSignal.any([timeout, stopSignal]) : timeout;
    try { return await this.sdk.messages.create(body, { signal }); }
    catch (error) {
      if (error instanceof LLMError) throw error;
      if (stopSignal?.aborted) throw new LLMError('机器人正在停止，请稍后再试。');
      if (timeout.aborted || error.name?.includes('Timeout')) throw new LLMError('大模型或官方搜索响应超时，请稍后再试。');
      if (tools.length && [400, 422].includes(error.status)) throw new LLMError('当前接口拒绝了工具调用请求，请确认该模型及中转接口支持 tools；也请检查模型参数。', error.status);
      if (error.status) throw new LLMError(statusMessage(error.status), error.status);
      throw new LLMError('无法连接大模型服务，请检查网络和 Base URL。');
    }
  }

  usage(data) {
    return {
      inputTokens: data.usage?.input_tokens || 0, outputTokens: data.usage?.output_tokens || 0,
      searches: (data.content || []).filter(block => block.type === 'server_tool_use' && block.name === 'web_search').length,
      reported: Number.isFinite(data.usage?.input_tokens) && Number.isFinite(data.usage?.output_tokens),
    };
  }

  inspect(data) {
    if (!Array.isArray(data.content)) throw new LLMError('模型返回的消息格式无效，请检查接口配置。');
    if (data.content.some(block => block.type === 'web_search_tool_result' && !Array.isArray(block.content) && block.content?.type === 'web_search_tool_result_error')) {
      throw new LLMError('官方联网搜索暂时失败或达到搜索次数限制，请稍后再试。');
    }
    const uses = data.content.filter(block => block.type === 'tool_use');
    assertToolCalls(uses);
    const calls = uses.map(use => ({ id: use.id, name: use.name, args: use.input, invalid: !validToolArguments(use.input) }));
    return { calls, assistant: { role: 'assistant', content: data.content }, blocks: data.content, pause: data.stop_reason === 'pause_turn' };
  }

  appendResults(history, outputs) {
    history.push({ role: 'user', content: outputs.map(({ id, result }) => ({ type: 'tool_result', tool_use_id: id, content: JSON.stringify(result) })) });
  }

  answer(data, blocks = data.content) {
    const finalBlocks = data.content.filter(block => block.type === 'text');
    let text = finalBlocks.map(block => block.text).join('\n').trim();
    if (!text) throw new LLMError('模型没有返回文本回答，请重试。');
    const sources = [];
    const add = source => {
      if (/^https?:\/\//.test(source.url || '') && !sources.some(item => item.url === source.url)) sources.push({ title: source.title || '来源', url: source.url });
    };
    for (const block of finalBlocks) for (const citation of block.citations || []) add(citation);
    if (!sources.length) for (const block of blocks) {
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) block.content.forEach(add);
    }
    if (sources.length) text += '\n\n参考来源：\n' + sources.slice(0, 6).map((source, index) => `${index + 1}. ${source.title}\n${source.url}`).join('\n');
    return { text, searched: blocks.some(block => block.type === 'server_tool_use' && block.name === 'web_search'), sources };
  }
}
