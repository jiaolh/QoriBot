import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { projectRoot, readConfig } from './config.js';
import { DEFAULT_PROMPT_PRESETS } from './prompts.js';
import { validateGroupChat, groupPolicy } from './group-config.js';

export const SEARCH_DOCS = 'https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/#using-web-search-in-claude-code';
export function supportsOfficialSearch(provider) {
  try {
    const url = new URL(provider.baseUrl);
    return provider.protocol === 'anthropic' && url.origin === 'https://api.deepseek.com' && url.pathname.replace(/\/$/, '') === '/anthropic';
  } catch { return false; }
}

function finite(value, name, min, max, integer = true) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`${name} 需要填写 ${min}–${max} 之间的${integer ? '整数' : '数字'}。`);
}
function safeUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} 不是有效地址。`); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) throw new Error(`${name} 需要 HTTPS 地址，本机调试允许 HTTP。`);
  if (value.length > 500) throw new Error(`${name} 过长。`);
}
function text(value, name, max, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max) throw new Error(`${name} 不能为空且不能超过 ${max} 字符。`);
}

export function validateSettings(value) {
  value.limits = { autoMemory: true, userMemoryChars: 4000, maxProfileBytes: 8 * 1048576, ...value.limits };
  if (value.version !== 2 || !Array.isArray(value.providers) || !value.providers.length || value.providers.length > 20) throw new Error('API 配置格式错误。');
  const ids = new Set();
  for (const provider of value.providers) {
    text(provider.id, 'API ID', 100); if (ids.has(provider.id)) throw new Error('API ID 重复。'); ids.add(provider.id);
    text(provider.name, 'API 名称', 80); text(provider.apiKey, 'API Key', 1000, true);
    text(provider.model, '模型名称', 150); safeUrl(provider.baseUrl, 'Base URL');
    if (!['openai', 'anthropic'].includes(provider.protocol)) throw new Error('不支持的 API 协议。');
    if (typeof provider.webSearch !== 'boolean') throw new Error('搜索开关格式错误。');
    if (provider.webSearch && !supportsOfficialSearch(provider)) throw new Error('官方联网搜索需要 DeepSeek 官方 Anthropic 接口，请使用 DeepSeek 预设。');
  }
  if (!ids.has(value.activeProviderId)) throw new Error('请选定一个有效的 API 配置。');
  if (!Array.isArray(value.prompts) || !value.prompts.length || value.prompts.length > 100) throw new Error('至少保留一套提示词，最多保存 100 套。');
  ids.clear();
  for (const prompt of value.prompts) {
    text(prompt.id, '提示词 ID', 100); if (ids.has(prompt.id)) throw new Error('提示词 ID 重复。'); ids.add(prompt.id);
    text(prompt.name, '提示词名称', 80); text(prompt.content, '提示词内容', 20000);
  }
  if (!ids.has(value.activePromptId)) throw new Error('请选定一套有效的提示词。');
  text(value.qq.appId, 'AppID', 100, true); text(value.qq.appSecret, 'AppSecret', 1000, true); safeUrl(value.qq.baseUrl, 'QQ API 地址');
  if (!['websocket', 'webhook'].includes(value.qq.transport)) throw new Error('QQ 接入方式错误。');
  finite(value.qq.webhook.port, 'Webhook 端口', 1, 65535);
  if (!/^\/[\w/.-]*$/.test(value.qq.webhook.path)) throw new Error('Webhook 路径错误。');
  const limits = value.limits;
  if (typeof limits.autoMemory !== 'boolean') throw new Error('自动记忆开关格式错误。');
  for (const [key, name, min, max, integer] of [
    ['historyRounds', '记忆轮数', 1, 50, true], ['sessionTtlMs', '记忆过期时间', 60000, 2592000000, true],
    ['maxSessions', '最大会话数', 1, 10000, true], ['maxContextChars', '上下文字符', 1000, 200000, true],
    ['maxInputChars', '输入字符', 1, 20000, true], ['maxReplyBytes', '回复字节', 512, 4000, true],
    ['maxConcurrent', '同时请求数', 1, 32, true], ['cooldownMs', '发送间隔', 0, 60000, true],
    ['maxTokens', '生成 tokens', 64, 8192, true], ['timeoutMs', '请求超时', 1000, 180000, true],
    ['maxMemoryBytes', '记忆总容量', 1048576, 1073741824, true],
    ['userMemoryChars', '每位用户长期记忆', 500, 12000, true], ['maxProfileBytes', '长期记忆总容量', 1048576, 536870912, true],
  ]) finite(limits[key], name, min, max, integer);
  if (limits.temperature !== null) finite(limits.temperature, '温度', 0, 2, false);
  value.groupChat = validateGroupChat(value.groupChat || {}, value.providers, value.prompts);
  if(value.plugins!==undefined&&(!value.plugins||typeof value.plugins!=='object'||Array.isArray(value.plugins)))throw new Error('插件配置格式错误。');
  value.plugins = { reminders:{enabled:true}, ...value.plugins };
  if(Object.keys(value.plugins).length>50)throw new Error('插件配置格式错误。');
  for(const [id,config] of Object.entries(value.plugins))if(!/^[a-z][a-z0-9-]{0,40}$/.test(id)||!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).some(key=>key!=='enabled')||typeof config.enabled!=='boolean')throw new Error('插件开关格式错误。');
  return value;
}

export class SettingsStore {
  constructor(root = projectRoot) {
    this.root = root;
    this.path = resolve(root, 'data/settings.json');
    mkdirSync(resolve(root, 'data'), { recursive: true });
    if (existsSync(this.path)) {
      const saved = JSON.parse(readFileSync(this.path,'utf8'));
      const original = JSON.stringify(saved); this.value = validateSettings(saved);
      if (JSON.stringify(this.value) !== original) this.persist(this.value);
    }
    else {
      const env = existsSync(resolve(root, '.env')) ? parseEnv(readFileSync(resolve(root, '.env'), 'utf8')) : {};
      const cfg = readConfig(env, { requireQQ: false, requireLLM: false, requireModel: false });
      this.value = validateSettings({
        version: 2, qq: cfg.qq,
        providers: [
          { id: 'default', name: '通用对话 API', protocol: 'openai', ...cfg.llm, model: cfg.llm.model || 'deepseek-flash', webSearch: false },
          { id: 'deepseek', name: 'DeepSeek 官方搜索', protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: '', model: 'deepseek-flash', webSearch: true },
        ], activeProviderId: 'default',
        prompts: DEFAULT_PROMPT_PRESETS.map(prompt => ({ ...prompt, content: prompt.id === 'general' ? cfg.chat.systemPrompt : prompt.content })), activePromptId: 'general',
        limits: { ...cfg.chat, systemPrompt: undefined, ...cfg.llm, apiKey: undefined, baseUrl: undefined, model: undefined, temperature: cfg.llm.temperature ?? null, maxMemoryBytes: 32 * 1024 * 1024 },
      });
      this.persist(this.value);
    }
  }

  persist(value) {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(temp, this.path);
  }

  update(patch) {
    const next = structuredClone(this.value);
    if (patch.qq) {
      const { appSecret, ...rest } = patch.qq;
      next.qq = { ...next.qq, ...rest, webhook: { ...next.qq.webhook, ...rest.webhook } };
      if (appSecret !== undefined && appSecret !== '') next.qq.appSecret = appSecret;
    }
    if (patch.limits) next.limits = { ...next.limits, ...patch.limits };
    if (patch.groupChat) next.groupChat = { ...next.groupChat, ...patch.groupChat };
    if (patch.plugins !== undefined) {
      if (!patch.plugins || typeof patch.plugins !== 'object' || Array.isArray(patch.plugins)) throw new Error('插件配置格式错误。');
      next.plugins = { ...next.plugins, ...patch.plugins };
    }
    if (patch.providers) {
      next.providers = patch.providers.map(provider => {
        const previous = next.providers.find(item => item.id === provider.id);
        return { ...provider, baseUrl: provider.baseUrl.replace(/\/+$/, ''), apiKey: provider.clearKey ? '' : (provider.apiKey || previous?.apiKey || '') };
      });
    }
    if (patch.prompts) next.prompts = patch.prompts;
    for (const key of ['activePromptId', 'activeProviderId']) if (patch[key] !== undefined) next[key] = patch[key];
    validateSettings(next);
    this.persist(next);
    this.value = next;
    return this.public();
  }

  public() {
    const value = structuredClone(this.value);
    value.qq.appSecretSet = Boolean(value.qq.appSecret); delete value.qq.appSecret;
    value.providers = value.providers.map(({ apiKey, ...provider }) => ({ ...provider, apiKeySet: Boolean(apiKey), searchSupported: supportsOfficialSearch(provider) }));
    return value;
  }

  runtime({ requireQQ = true } = {}) {
    const value = this.value;
    const provider = value.providers.find(item => item.id === value.activeProviderId);
    const prompt = value.prompts.find(item => item.id === value.activePromptId);
    if (requireQQ && (!value.qq.appId || !value.qq.appSecret)) throw new Error('请先在“API 与机器人”填写 QQ AppID 和 AppSecret。');
    if (!provider.apiKey) throw new Error('请先为当前 API 配置填写 API Key。');
    return {
      qq: structuredClone(value.qq),
      llm: { ...provider, temperature: value.limits.temperature ?? undefined, maxTokens: value.limits.maxTokens, timeoutMs: value.limits.timeoutMs },
      chat: { ...value.limits, systemPrompt: prompt.content, promptId: prompt.id },
      groupChat: structuredClone(value.groupChat),
    };
  }

  groupRuntime(id, kind = 'reply') {
    const policy = groupPolicy(this.value.groupChat, id);
    const providerId = kind === 'judge' ? policy.judgeProviderId : policy.replyProviderId;
    const provider = this.value.providers.find(p => p.id === (providerId || this.value.activeProviderId));
    if (!provider?.apiKey) throw new Error('这个群选择的模型尚未填写 API Key。');
    const prompt = this.value.prompts.find(p => p.id === (policy.promptId || this.value.activePromptId));
    return { qq: structuredClone(this.value.qq), groupChat: structuredClone(this.value.groupChat),
      llm: { ...provider, temperature: this.value.limits.temperature ?? undefined, maxTokens: this.value.limits.maxTokens, timeoutMs: this.value.limits.timeoutMs },
      chat: { ...this.value.limits, systemPrompt: prompt.content, promptId: prompt.id }, budgetGroup: id };
  }
}

export function readAppConfig(options) {
  return new SettingsStore().runtime(options);
}
