export const PRIVATE_POLICY = {
  enabled: true, alias: '', promptId: '', replyProviderId: '', cooldownMs: null,
  maxRepliesHour: 0, dailyTokenLimit: 0, quietStart: '', quietEnd: '',
};

export function privatePolicy(config, id) { return { ...PRIVATE_POLICY, ...config?.users?.[id] }; }

export function validPrivateId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 150 &&
    !/[\s<>"'\\/]/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);
}

export function validatePrivateChat(value, providers, prompts) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'users')) throw new Error('个人模式配置格式错误。');
  const users = value.users ?? {};
  if (!users || typeof users !== 'object' || Array.isArray(users) || Object.keys(users).length > 1000) throw new Error('私聊配置最多 1000 位用户。');
  const cleaned = {};
  for (const [id, raw] of Object.entries(users)) {
    if (!validPrivateId(id) || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('私聊用户标识或配置格式错误。');
    if (Object.keys(raw).some(key => !Object.hasOwn(PRIVATE_POLICY, key))) throw new Error('私聊配置包含不支持的选项。');
    const row = privatePolicy({ users: { [id]: raw } }, id);
    if (typeof row.enabled !== 'boolean') throw new Error('私聊回复开关格式错误。');
    for (const key of ['alias', 'promptId', 'replyProviderId']) if (typeof row[key] !== 'string' || row[key].length > 100) throw new Error('私聊备注或模型选项格式错误。');
    if (row.promptId && !prompts.some(p => p.id === row.promptId)) throw new Error('私聊提示词已不存在，请先在个人模式页重新选择。');
    if (row.replyProviderId && !providers.some(p => p.id === row.replyProviderId)) throw new Error('私聊 API 配置已不存在，请先在个人模式页重新选择。');
    for (const [key, max] of [['cooldownMs', 3600000], ['maxRepliesHour', 1000], ['dailyTokenLimit', 100000000]]) {
      if (key === 'cooldownMs' && row[key] === null) continue;
      if (!Number.isInteger(row[key]) || row[key] < 0 || row[key] > max) throw new Error(`私聊 ${key} 数值错误。`);
    }
    for (const key of ['quietStart', 'quietEnd']) if (typeof row[key] !== 'string' || (row[key] && !/^([01]\d|2[0-3]):[0-5]\d$/.test(row[key]))) throw new Error('私聊免打扰时间格式错误。');
    if (Boolean(row.quietStart) !== Boolean(row.quietEnd)) throw new Error('私聊免打扰开始和结束时间需一起填写。');
    cleaned[id] = row;
  }
  return { users: cleaned };
}
