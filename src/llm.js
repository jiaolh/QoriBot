import { LLMError, statusMessage } from './llm/errors.js';
import { OpenAIAdapter } from './llm/openai.js';
import { AnthropicAdapter } from './llm/anthropic.js';
import { completeWithTools } from './llm-tools.js';
import { supportsOfficialSearch } from './settings.js';

// 保持原有导入接口；错误定义不再与工具循环相互引用。
export { LLMError, statusMessage } from './llm/errors.js';

export class LLMClient {
  constructor(config, { fetchImpl = fetch, signal, onUsage } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.signal = signal;
    this.onUsage = onUsage;
    this.adapter = config.protocol === 'anthropic' ? new AnthropicAdapter(this) : new OpenAIAdapter(this);
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

  async complete(messages, tools) {
    if (tools?.tools?.length) return completeWithTools(this, messages, tools);
    if (tools?.system) messages = [...messages, { role: 'system', content: tools.system }];
    if (this.config.protocol === 'anthropic') return (await this.completeAnthropic(messages)).text;
    const data = await this.adapter.request(messages);
    this.onUsage?.(this.adapter.usage(data));
    return this.adapter.answer(data).text;
  }

  async completeAnthropic(messages) {
    const history = structuredClone(messages), blocks = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const data = await this.adapter.request(history);
      this.onUsage?.(this.adapter.usage(data));
      const turn = this.adapter.inspect(data);
      blocks.push(...turn.blocks);
      if (!turn.pause) return this.adapter.answer(data, blocks);
      // 官方搜索暂停时原样续传，搜索仍由上游执行。
      history.push(turn.assistant);
    }
    throw new LLMError('官方搜索耗时较长，已达到本次继续次数限制，请缩短问题再试。');
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

