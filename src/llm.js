export class LLMError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
  }
}

function statusMessage(status) {
  if (status === 401) return '大模型 API Key 无效或已过期，请检查当前 API 配置。';
  if (status === 403) return '当前 Key 无权调用这个模型，请检查模型授权。';
  if (status === 404) return '大模型地址或模型名称不存在，请检查 Base URL、模型名称，并查询可用模型。';
  if (status === 429) return '大模型请求过于频繁或额度不足，请稍后再试。';
  if (status >= 500) return '大模型服务暂时不可用，请稍后再试。';
  return `大模型请求失败（HTTP ${status}），请检查模型名称和请求参数。`;
}

export class LLMClient {
  constructor(config, { fetchImpl = fetch, signal, onUsage } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.signal = signal;
    this.onUsage = onUsage;
  }

  async request(path, body) {
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = this.signal ? AbortSignal.any([timeout, this.signal]) : timeout;
    try {
      const response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        redirect: 'error',
      });
      if (!response.ok) throw new LLMError(statusMessage(response.status), response.status);
      try { return await response.json(); } catch (error) {
        if (signal.aborted) throw error;
        throw new LLMError('大模型返回了无法解析的数据，请稍后再试。');
      }
    } catch (error) {
      if (error instanceof LLMError) throw error;
      if (this.signal?.aborted) throw new LLMError('机器人正在停止，请稍后再试。');
      if (timeout.aborted || error.name === 'TimeoutError') throw new LLMError('大模型响应超时，请稍后再试或缩短问题。');
      throw new LLMError('无法连接大模型服务，请检查网络和 LLM_BASE_URL。');
    }
  }

  async complete(messages) {
    if (this.config.protocol === 'anthropic') return (await this.completeAnthropic(messages)).text;
    const body = {
      model: this.config.model,
      messages,
      stream: false,
      max_tokens: this.config.maxTokens,
    };
    if (this.config.temperature !== undefined) body.temperature = this.config.temperature;
    const data = await this.request('/chat/completions', body);
    this.onUsage?.({ inputTokens: data.usage?.prompt_tokens || 0, outputTokens: data.usage?.completion_tokens || 0, searches: 0, reported: Number.isFinite(data.usage?.prompt_tokens) && Number.isFinite(data.usage?.completion_tokens) });
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new LLMError('大模型没有返回文本回答，请重试或检查模型配置。');
    }
    return content.trim();
  }

  async completeAnthropic(messages) {
    if (this.config.webSearch && !supportsOfficialSearch(this.config)) throw new LLMError('当前接口没有已确认的官方联网搜索支持。');
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = this.signal ? AbortSignal.any([timeout, this.signal]) : timeout;
    const client = new Anthropic({ apiKey: this.config.apiKey, baseURL: this.config.baseUrl, maxRetries: 0, timeout: this.config.timeoutMs, fetch: (url, options) => this.fetchImpl(url, { ...options, redirect: 'error' }) });
    const body = {
      model: this.config.model, max_tokens: this.config.maxTokens, stream: false,
      system: messages.filter(item => item.role === 'system').map(item => item.content).join('\n'),
      messages: messages.filter(item => item.role !== 'system').map(item => ({ role: item.role, content: item.content })),
    };
    if (this.config.temperature !== undefined) body.temperature = this.config.temperature;
    if (this.config.webSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];
    const blocks = [];
    let data;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        data = await client.messages.create(body, { signal });
        blocks.push(...data.content);
        const searches = data.content.filter(block => block.type === 'server_tool_use' && block.name === 'web_search').length;
        this.onUsage?.({ inputTokens: data.usage?.input_tokens || 0, outputTokens: data.usage?.output_tokens || 0, searches, reported: Number.isFinite(data.usage?.input_tokens) && Number.isFinite(data.usage?.output_tokens) });
        if (data.stop_reason !== 'pause_turn') break;
        // 官方服务端搜索暂停时，原样回传工具结果继续，不在本机执行搜索。
        body.messages.push({ role: 'assistant', content: data.content });
      }
      if (data.stop_reason === 'pause_turn') throw new LLMError('官方搜索耗时较长，已达到本次继续次数限制，请缩短问题再试。');
      const errorBlock = blocks.find(block => block.type === 'web_search_tool_result' && !Array.isArray(block.content) && block.content?.type === 'web_search_tool_result_error');
      if (errorBlock) throw new LLMError('官方联网搜索暂时失败或达到搜索次数限制，请稍后再试。');
      const finalBlocks = data.content.filter(block => block.type === 'text');
      let text = finalBlocks.map(block => block.text).join('\n').trim();
      if (!text) throw new LLMError('模型没有返回文本回答，请重试。');
      const sources = [];
      for (const block of finalBlocks) for (const citation of block.citations || []) {
        if (citation.url && /^https?:\/\//.test(citation.url) && !sources.some(source => source.url === citation.url)) sources.push({ title: citation.title || '来源', url: citation.url });
      }
      if (!sources.length) for (const block of blocks) if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) for (const result of block.content) {
        if (result.url && /^https?:\/\//.test(result.url) && !sources.some(source => source.url === result.url)) sources.push({ title: result.title || '来源', url: result.url });
      }
      if (sources.length) text += '\n\n参考来源：\n' + sources.slice(0, 6).map((source, index) => `${index + 1}. ${source.title}\n${source.url}`).join('\n');
      return { text, searched: blocks.some(block => block.type === 'server_tool_use' && block.name === 'web_search'), sources };
    } catch (error) {
      if (error instanceof LLMError) throw error;
      if (this.signal?.aborted) throw new LLMError('机器人正在停止，请稍后再试。');
      if (timeout.aborted || error.name?.includes('Timeout')) throw new LLMError('大模型或官方搜索响应超时，请稍后再试。');
      if (error.status) throw new LLMError(statusMessage(error.status), error.status);
      throw new LLMError('无法连接大模型服务，请检查网络和 Base URL。');
    }
  }

  async listModels() {
    if (supportsOfficialSearch(this.config)) {
      // DeepSeek 的模型列表使用 OpenAI 兼容地址，与 Messages 入口不同。
      const client = new LLMClient({ ...this.config, baseUrl: 'https://api.deepseek.com/v1', protocol: 'openai' }, { fetchImpl: this.fetchImpl, signal: this.signal });
      return client.listModels();
    }
    const data = await this.request('/models');
    if (!Array.isArray(data?.data)) throw new LLMError('模型列表格式异常，请在平台页面查询模型名称。');
    return [...new Set(data.data.map(item => item.id).filter(id => typeof id === 'string'))].sort();
  }
}
import Anthropic from '@anthropic-ai/sdk';
import { supportsOfficialSearch } from './settings.js';

