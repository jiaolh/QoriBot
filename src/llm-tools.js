import { LLMError } from './llm/errors.js';

const MAX_ROUNDS = 4;
const MAX_CALLS = 4;

// 忽略对象键顺序，同一轮里模型重发相同参数时复用执行结果。
function stableArguments(value) {
  if (Array.isArray(value)) return value.map(stableArguments);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableArguments(value[key])]));
  return value;
}

// 协议适配器负责消息格式；这里只管理调用、预算和结果回传。
export async function completeWithTools(client, messages, session) {
  const history = structuredClone(messages), { adapter } = client;
  if (session.system) history.unshift({ role: 'system', content: session.system });
  const results = [], seen = new Map(), blocks = [];
  let calls = 0, requests = 0;

  async function request() {
    client.signal?.throwIfAborted();
    const accounting = session.beforeRequest?.([
      ...history.map(message => ({ role: message.role, content: typeof message.content === 'string' ? message.content : JSON.stringify(message) })),
      { role: 'system', content: JSON.stringify(session.tools) },
    ]);
    if (requests++) client.onFollowup?.();
    try {
      const data = await adapter.request(history, session.tools), usage = adapter.usage(data);
      client.onUsage?.(usage);
      accounting?.finish(usage);
      return data;
    } catch (error) {
      accounting?.finish(null, error);
      throw error;
    }
  }

  async function execute(call) {
    client.signal?.throwIfAborted();
    if (call.invalid) return { ok: false, error: '工具参数格式无效，未执行。' };
    const { name, args, id } = call;
    const key = JSON.stringify([name, stableArguments(args)]);
    if (seen.has(key)) return seen.get(key);
    if (++calls > MAX_CALLS) return { ok: false, error: '本次工具调用已达上限，请分次处理。' };
    let result;
    if (!session.tools.some(tool => tool.name === name)) result = { ok: false, error: '工具不存在或插件已关闭。' };
    else {
      try { result = await session.execute(name, args, id); }
      catch { result = { ok: false, error: '插件执行未完成，请查看控制台确认实际状态，避免重复创建。' }; }
    }
    seen.set(key, result);
    results.push(result);
    return result;
  }

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const data = await request(), turn = adapter.inspect(data);
      blocks.push(...turn.blocks);
      if (turn.calls.length) {
        history.push(turn.assistant);
        const outputs = [];
        for (const call of turn.calls) outputs.push({ id: call.id, result: await execute(call) });
        adapter.appendResults(history, outputs);
        continue;
      }
      if (turn.pause) { history.push(turn.assistant); continue; }
      return adapter.answer(data, blocks).text;
    }
    return session.summary?.() || '本次工具调用达到上限，请在控制台确认实际状态。';
  } catch (error) {
    // 已执行的效果不能因后续模型失败而消失；回复数据库中的真实结果。
    if (results.some(result => result?.ok)) return session.summary?.() || '插件已执行，请在控制台查看结果。';
    if (error instanceof LLMError) throw error;
    if (client.signal?.aborted) throw new LLMError('机器人正在停止，请稍后再试。');
    throw new LLMError('模型工具调用未完成，请检查当前 API 是否支持工具调用。');
  }
}
