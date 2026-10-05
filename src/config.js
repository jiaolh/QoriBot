import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export function loadLocalEnv() {
  const path = resolve(projectRoot, '.env');
  if (existsSync(path)) process.loadEnvFile(path);
}

function number(env, name, fallback, min, max, integer = true) {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的${integer ? '整数' : '数字'}。`);
  }
  return value;
}

function url(env, name, fallback) {
  const value = (env[name]?.trim() || fallback).replace(/\/+$/, '');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${name} 不是有效的 URL。`); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if ((parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) ||
      parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} 需要 HTTPS 地址（本机测试允许 HTTP），不能包含账号、查询参数或锚点。`);
  }
  return value;
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value || /^(your[_-]|请填写|你的|sk-你的|<)/i.test(value)) {
    throw new Error(`请在 .env 文件中填写 ${name}。`);
  }
  return value;
}

export function readConfig(env = process.env, { requireQQ = true, requireModel = true, requireLLM = true } = {}) {
  const transport = env.QQ_TRANSPORT?.trim().toLowerCase() || 'websocket';
  if (!['websocket', 'webhook'].includes(transport)) throw new Error('QQ_TRANSPORT 只能填写 websocket 或 webhook。');
  const webhookPath = env.WEBHOOK_PATH?.trim() || '/qqbot/webhook';
  if (!/^\/[\w/.-]*$/.test(webhookPath)) throw new Error('WEBHOOK_PATH 应是以 / 开头的路径。');
  const temperature = env.LLM_TEMPERATURE?.trim();
  return {
    qq: {
      appId: requireQQ ? required(env, 'QQ_APP_ID') : (env.QQ_APP_ID?.trim() || ''),
      appSecret: requireQQ ? required(env, 'QQ_APP_SECRET') : (env.QQ_APP_SECRET?.trim() || ''),
      transport,
      baseUrl: url(env, 'QQ_API_BASE_URL', 'https://api.bot.qq.com'),
      webhook: { port: number(env, 'WEBHOOK_PORT', 8080, 1, 65535), path: webhookPath },
    },
    llm: {
      apiKey: requireLLM ? required(env, 'LLM_API_KEY') : (env.LLM_API_KEY?.trim() || ''),
      baseUrl: url(env, 'LLM_BASE_URL', 'https://api.deepseek.com'),
      model: requireModel ? required(env, 'LLM_MODEL') : (env.LLM_MODEL?.trim() || ''),
      temperature: temperature ? number(env, 'LLM_TEMPERATURE', 0.7, 0, 2, false) : undefined,
      maxTokens: number(env, 'LLM_MAX_TOKENS', 1024, 64, 8192),
      timeoutMs: number(env, 'LLM_TIMEOUT_SECONDS', 60, 1, 180) * 1000,
    },
    chat: {
      systemPrompt: env.SYSTEM_PROMPT?.trim() || '你是一个友好、可靠的中文聊天助手。默认简洁，不确定时如实说明。',
      historyRounds: number(env, 'HISTORY_ROUNDS', 10, 1, 50),
      sessionTtlMs: number(env, 'SESSION_TTL_MINUTES', 30, 1, 43200) * 60_000,
      maxSessions: number(env, 'MAX_SESSIONS', 1000, 1, 10000),
      maxContextChars: number(env, 'MAX_CONTEXT_CHARS', 24000, 1000, 200000),
      maxInputChars: number(env, 'MAX_INPUT_CHARS', 4000, 1, 20000),
      maxReplyBytes: number(env, 'MAX_REPLY_BYTES', 3600, 512, 4000),
      maxConcurrent: number(env, 'MAX_CONCURRENT_REQUESTS', 4, 1, 32),
      cooldownMs: number(env, 'USER_COOLDOWN_SECONDS', 1, 0, 60, false) * 1000,
    },
  };
}
