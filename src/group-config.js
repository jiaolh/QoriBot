export const GROUP_DEFAULTS = {
  messageTtlMs: 12 * 3600000, maxBytes: 32 * 1048576, contextMessages: 60,
  contextWindowMs: 30 * 60000, maxContextChars: 12000,
  batchDelayMs: 2000, batchMaxWaitMs: 6000, maxBatchMessages: 10,
  dailyTokenLimit: 200000, groups: {},
};
export const GROUP_POLICY = {
  mode: 'light', alias: '', promptId: '', replyProviderId: '', judgeProviderId: '',
  cooldownMs: 30000, minJudgeIntervalMs: 15000, maxRepliesHour: 24, maxJudgesHour: 120,
  dailyTokenLimit: 0, quietStart: '', quietEnd: '', ignoreSenderIds: [],
};
export function groupPolicy(config, id) { return { ...GROUP_POLICY, ...config?.groups?.[id] }; }
export function isMentioned(message, botId) {
  if (message.rawEventType === 'GROUP_AT_MESSAGE_CREATE') return true;
  if (message.mentions?.some(item => item.is_you === true)) return true;
  return Boolean(botId && message.content?.match(/<@!?([^>\s]+)>/g)?.some(item => item.replace(/^<@!?|>$/g, '') === botId));
}
export function isQuiet(policy, now = Date.now()) {
  if (!policy.quietStart || !policy.quietEnd || policy.quietStart === policy.quietEnd) return false;
  const time = new Date(now + 8 * 3600000).toISOString().slice(11, 16);
  return policy.quietStart < policy.quietEnd
    ? time >= policy.quietStart && time < policy.quietEnd
    : time >= policy.quietStart || time < policy.quietEnd;
}
export function validateGroupChat(value, providers, prompts) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('群聊配置格式错误。');
  value = { ...GROUP_DEFAULTS, ...value };
  const ranges = {
    messageTtlMs: [3600000, 7 * 86400000], maxBytes: [1048576, 536870912], contextMessages: [5, 200],
    contextWindowMs: [60000, 43200000], maxContextChars: [1000, 60000], batchDelayMs: [0, 10000],
    batchMaxWaitMs: [1, 30000], maxBatchMessages: [1, 30], dailyTokenLimit: [1000, 100000000],
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) throw new Error(`群聊 ${key} 需要 ${min}–${max} 之间的整数。`);
  }
  if (value.batchDelayMs > value.batchMaxWaitMs) throw new Error('消息合并静默时间不能超过最长等待时间。');
  if (!value.groups || typeof value.groups !== 'object' || Array.isArray(value.groups) || Object.keys(value.groups).length > 1000) throw new Error('群配置最多 1000 个。');
  const cleaned = {};
  for (const [id, raw] of Object.entries(value.groups)) {
    if (!id || id.length > 150 || ['__proto__', 'constructor', 'prototype'].includes(id) || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('群标识或配置格式错误。');
    if (Object.keys(raw).some(key => !Object.hasOwn(GROUP_POLICY, key))) throw new Error('群配置包含不支持的选项。');
    const row = groupPolicy({ groups: { [id]: raw } }, id);
    if (!['light', 'observe', 'active'].includes(row.mode)) throw new Error('群聊模式错误。');
    for (const key of ['alias', 'promptId', 'replyProviderId', 'judgeProviderId']) if (typeof row[key] !== 'string' || row[key].length > 100) throw new Error('群备注或模型选项格式错误。');
    if (row.promptId && !prompts.some(p => p.id === row.promptId)) throw new Error('群提示词已不存在，请重新选择。');
    for (const key of ['replyProviderId', 'judgeProviderId']) if (row[key] && !providers.some(p => p.id === row[key])) throw new Error('群 API 配置已不存在，请重新选择。');
    for (const [key, max] of [['cooldownMs', 3600000], ['minJudgeIntervalMs', 3600000], ['maxRepliesHour', 1000], ['maxJudgesHour', 10000], ['dailyTokenLimit', 100000000]]) {
      if (!Number.isInteger(row[key]) || row[key] < (key.includes('Hour') ? 1 : 0) || row[key] > max) throw new Error(`群聊 ${key} 数值错误。`);
    }
    for (const key of ['quietStart', 'quietEnd']) if (typeof row[key] !== 'string' || (row[key] && !/^([01]\d|2[0-3]):[0-5]\d$/.test(row[key]))) throw new Error('免打扰时间格式错误。');
    if (Boolean(row.quietStart) !== Boolean(row.quietEnd)) throw new Error('免打扰开始和结束时间需一起填写。');
    if (!Array.isArray(row.ignoreSenderIds) || row.ignoreSenderIds.length > 100 || row.ignoreSenderIds.some(item => typeof item !== 'string' || !item || item.length > 150)) throw new Error('忽略成员列表格式错误。');
    cleaned[id] = row;
  }
  return { ...value, groups: cleaned };
}
