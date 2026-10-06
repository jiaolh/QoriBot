import { randomUUID } from 'node:crypto';

// 只验证工具选择与结果回传，不连接真实插件、聊天目标或数据库。
export async function checkToolSupport(client) {
  const code = randomUUID(), receipt = randomUUID();
  let executed = false;
  const session = {
    tools: [{
      name: 'qoribot_capability_check', description: '取得本机测试回执，仅用于验证接口工具调用。',
      parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false },
    }],
    execute: async (name, args) => {
      if (name !== 'qoribot_capability_check' || args.code !== code || Object.keys(args).length !== 1) return { ok: false, error: '测试参数不匹配。' };
      executed = true;
      return { ok: true, receipt };
    },
    summary: () => '测试未完成结果回传。',
  };
  try {
    const text = await client.complete([
      { role: 'system', content: '这是本机工具兼容测试。先调用提供的工具取得真实 receipt，然后只输出 receipt 的值。不要猜测，不要输出输入 code。' },
      { role: 'user', content: `请用 qoribot_capability_check 查询 code=${code} 的回执。` },
    ], session);
    const supported = executed && text.includes(receipt);
    return {
      supported,
      message: supported ? '本次测试通过：模型能调用工具并读取执行结果。' : '本次测试未通过：模型没有完成工具调用及结果回传，请确认模型和中转接口支持工具调用。',
    };
  } catch (error) {
    if (![400, 422].includes(error.status)) throw error;
    return { supported: false, message: error.message };
  }
}
