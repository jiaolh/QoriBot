export class LLMError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
  }
}

export function statusMessage(status) {
  if (status === 401) return '大模型 API Key 无效或已过期，请检查当前 API 配置。';
  if (status === 403) return '当前 Key 无权调用这个模型，请检查模型授权。';
  if (status === 404) return '大模型地址或模型名称不存在，请检查 Base URL、模型名称，并查询可用模型。';
  if (status === 429) return '大模型请求过于频繁或额度不足，请稍后再试。';
  if (status >= 500) return '大模型服务暂时不可用，请稍后再试。';
  return `大模型请求失败（HTTP ${status}），请检查模型名称和请求参数。`;
}

export function assertToolCalls(calls) {
  if (!Array.isArray(calls)) throw new LLMError('模型返回的工具调用格式无效，未执行插件。');
  if (calls.length > 4) throw new LLMError('模型一次请求了过多工具，未执行插件。');
  const ids = new Set();
  for (const call of calls) {
    if (typeof call.id !== 'string' || !call.id || ids.has(call.id)) {
      throw new LLMError('模型返回的工具调用标识无效或重复，未执行插件。');
    }
    ids.add(call.id);
  }
}

export function validToolArguments(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && JSON.stringify(value).length <= 12000;
}
