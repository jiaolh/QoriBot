import { LLMError, assertToolCalls, validToolArguments } from './errors.js';

// Chat Completions 协议；模型品牌和插件实现均不影响这里的转换。
export class OpenAIAdapter {
  constructor(client) { this.client = client; }

  async request(messages, tools = []) {
    const { config } = this.client;
    const body = { model: config.model, messages, stream: false, max_tokens: config.maxTokens };
    if (config.temperature !== undefined) body.temperature = config.temperature;
    if (tools.length) {
      body.tools = tools.map(tool => ({ type: 'function', function: tool }));
      body.tool_choice = 'auto';
      body.parallel_tool_calls = false;
    }
    try { return await this.client.request('/chat/completions', body); }
    catch (error) {
      if (tools.length && [400, 422].includes(error.status)) {
        throw new LLMError('当前接口拒绝了工具调用请求，请确认该模型及中转接口支持 tools；也请检查模型参数。', error.status);
      }
      throw error;
    }
  }

  usage(data) {
    const usage = data.usage;
    return {
      inputTokens: usage?.prompt_tokens || 0, outputTokens: usage?.completion_tokens || 0, searches: 0,
      reported: Number.isFinite(usage?.prompt_tokens) && Number.isFinite(usage?.completion_tokens),
    };
  }

  inspect(data) {
    const message = data?.choices?.[0]?.message;
    const uses = message?.tool_calls ?? [];
    assertToolCalls(uses);
    const calls = uses.map(use => {
      let args;
      try {
        if (use.type !== 'function' || typeof use.function?.arguments !== 'string' || use.function.arguments.length > 12000) throw new Error();
        args = JSON.parse(use.function.arguments);
        if (!validToolArguments(args)) throw new Error();
      } catch { return { id: use.id, invalid: true }; }
      return { id: use.id, name: use.function.name, args };
    });
    const assistant = {
      role: 'assistant', content: message?.content || null, tool_calls: uses,
      ...(message?.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
    };
    return { calls, assistant, blocks: [], pause: false };
  }

  appendResults(history, outputs) {
    for (const { id, result } of outputs) history.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(result) });
  }

  answer(data) {
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new LLMError('大模型没有返回文本回答，请重试或检查模型配置。');
    return { text: content.trim(), searched: false, sources: [] };
  }
}
