import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { LLMClient } from './llm.js';
import { ChatService } from './chat-service.js';

export function createChatBot(config, { logger, signal, tokenBaseUrl, sessions, getConfig, getLLM, profiles, learner, getActiveRequests, onIdle, groups, plugins, privateChats } = {}) {
  const bot = new QQBot({
    ...config.qq,
    tokenBaseUrl: tokenBaseUrl ?? config.qq.baseUrl,
    markdownSupport: false,
    // 只订阅群聊和 C2C，避免请求尚未获批的频道或交互权限。
    intents: 1 << 25,
    logger,
  });
  const llm = new LLMClient(config.llm, { signal });
  const chat = new ChatService({ llm, config, send: (target, text) => bot.sendText(target, text), logger, sessions, getConfig, getLLM, profiles, learner, getActiveRequests, onIdle, groups, plugins, privateChats });
  bot.on('ready', data => { if (groups) groups.botId = data?.user?.id || ''; });
  bot.on('message', (_ctx, message) => chat.dispatch(message));
  return { bot, chat };
}
