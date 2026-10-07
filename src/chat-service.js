import { LLMError } from './llm.js';
import { SessionStore } from './sessions.js';
import { userIdentity, withUserMemory } from './profile-memory.js';
import { validPrivateId } from './private-config.js';

const HELP = '直接发送文字即可聊天；群里请先 @我。\n/重置 或 /reset：清空短期对话\n/记住 内容：保存长期资料\n/记忆：查看长期资料\n/忘记：清空长期资料\n/帮助 或 /help：查看帮助\n/模型 或 /model：查看当前模型\n同一群内每个人的会话独立，私聊与群聊也相互独立。';

export function cleanInput(content = '') {
  return content.replace(/^\s*(?:<@!?[^>\s]+>\s*)+/, '').trim();
}

export function sessionKey(message) {
  const target = message.replyTarget;
  return JSON.stringify([message.kind, target.targetId, message.senderId]);
}

export function limitReply(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const suffix = '\n（回答较长，已截断；可以让我继续。）';
  const budget = maxBytes - Buffer.byteLength(suffix, 'utf8');
  let output = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > budget) break;
    output += char;
    bytes += size;
  }
  return output.trimEnd() + suffix;
}

export class ChatService {
  constructor({ llm, config, send, logger, now = Date.now, sessions, getConfig, getLLM, profiles, learner, getActiveRequests, onIdle, groups, plugins, privateChats }) {
    this.llm = llm;
    this.config = config;
    this.send = send;
    this.logger = logger;
    this.now = now;
    this.sessions = sessions || new SessionStore(config.chat, now);
    this.getConfig = getConfig;
    this.getLLM = getLLM;
    this.profiles = profiles; this.learner = learner; this.getActiveRequests = getActiveRequests; this.onIdle = onIdle;
    this.groups = groups;
    this.plugins = plugins;
    this.privateChats = privateChats;
    if (groups) groups.commandHandler = message => this.handle(message, true);
    this.seen = new Map();
    this.busy = new Set();
    this.cooldowns = new Map();
    this.pending = new Set();
    this.stopping = false;
  }

  // 不阻塞 SDK 的消息分发；每个会话只允许一条正在处理的问题。
  dispatch(message) {
    if (this.stopping) return;
    const task = this.handle(message).catch(() => this.logger.error('处理消息时发生内部错误。'));
    this.pending.add(task);
    task.finally(() => this.pending.delete(task));
  }

  async drain() {
    this.stopping = true;
    await this.groups?.stop();
    await Promise.allSettled([...this.pending]);
    this.seen.clear(); this.cooldowns.clear(); this.busy.clear(); this.pending.clear();
  }

  pruneCaches() {
    const now = this.now();
    for (const [key, expiresAt] of this.seen) if (expiresAt <= now) this.seen.delete(key);
    for (const [key, startedAt] of this.cooldowns) if (startedAt + 3600000 <= now) this.cooldowns.delete(key);
  }

  async reply(message, text, maxBytes = this.config.chat.maxReplyBytes) {
    try {
      await this.send(message.replyTarget, limitReply(text, maxBytes));
      return true;
    } catch (error) {
      const status = Number.isInteger(error.httpStatus) ? error.httpStatus : 0;
      const code = Number.isInteger(error.bizCode) ? error.bizCode : 0;
      this.logger.error(`QQ 回复失败（HTTP ${status}，错误码 ${code}）。请检查平台权限、IP 白名单和被动回复时限。`);
      return false;
    }
  }

  async handle(message, skipGroup = false) {
    if(!skipGroup&&this.plugins&&!this.stopping&&['c2c','group'].includes(message.kind)&&!message.senderIsBot&&!message.raw?.author?.bot&&message.replyTarget?.scope===message.kind&&message.replyTarget.targetId&&message.replyTarget.msgId===message.messageId&&message.senderId&&message.messageId){
      this.plugins.targets.observe(message);
    }
    if (!skipGroup && this.groups?.handle(message)) return;
    if (this.stopping || !['c2c', 'group'].includes(message.kind) || message.senderIsBot || message.raw?.author?.bot) return;
    if (message.kind === 'group' && message.rawEventType !== 'GROUP_AT_MESSAGE_CREATE') return;
    const target = message.replyTarget;
    if (!target?.targetId || !target.msgId || !message.senderId || !message.messageId) return;
    if (message.kind === 'c2c' && this.privateChats) {
      if (!validPrivateId(target.targetId)) return;
      this.privateChats.discover(target.targetId);
      if (this.privateChats.gate(target.targetId) === 'silent') return;
    }
    let config;
    try { config = skipGroup && this.groups ? this.groups.settings.groupRuntime(target.targetId) : this.getConfig ? this.getConfig(message) : this.config; }
    catch (error) { this.logger.warn(error.message); await this.reply(message, error.message); return; }

    this.pruneCaches();
    const eventKey = JSON.stringify([message.kind, target.targetId, message.messageId]);
    if (this.seen.has(eventKey)) return;
    this.seen.set(eventKey, this.now() + 600_000);
    while (this.seen.size > 10000) this.seen.delete(this.seen.keys().next().value);

    const input = cleanInput(message.content);
    const key = sessionKey(message) + (config.chat.promptId ? `:${config.chat.promptId}` : '');
    const requestKey = message.kind === 'c2c' ? sessionKey(message) : key;
    const identity = userIdentity(message.kind,target.targetId,message.senderId);
    const command = input.toLowerCase();
    if (['/help', '/帮助', '帮助'].includes(command)) { const help=HELP+(this.plugins?.help()?'\n'+this.plugins.help():'');await this.reply(message, skipGroup ? help + '\n当前群已开启多人上下文。非 @消息由接话判断决定；/重置清空你在轻量模式下的个人近期对话，全群上下文请在本机群聊模式页清空。' : help); return; }
    if (['/model', '/模型'].includes(command)) { await this.reply(message, `当前模型：${config.llm.model}`); return; }
    if (this.busy.has(requestKey)) { await this.reply(message, '上一条问题还在处理中，请等我回答后再发送。'); return; }
    if (this.profiles) {
      let memoryCommand;
      try { memoryCommand = this.profiles.command(identity,input); }
      catch(error) {await this.reply(message,error.message,config.chat.maxReplyBytes);return;}
      if (memoryCommand !== null) {
        this.learner?.cancel(this.profiles.ensure(identity));
        await this.reply(message,memoryCommand,config.chat.maxReplyBytes); return;
      }
    }
    if (['/reset', '/重置', '重置会话', '清空会话'].includes(command)) {
      this.sessions.reset(key);
      await this.reply(message, '当前会话已重置，可以开始新的话题。');
      return;
    }
    if (!input) { await this.reply(message, '请发送文字问题。我目前支持文字聊天，发送 /帮助 可以查看指令。'); return; }
    if (input.length > config.chat.maxInputChars) {
      await this.reply(message, `问题太长了，请控制在 ${config.chat.maxInputChars} 字符以内。`);
      return;
    }
    const gate = message.kind === 'c2c' ? this.privateChats?.gate(target.targetId) : '';
    if (gate === 'hour') { await this.reply(message, '本小时私聊回复次数已达到上限，请稍后再试。'); return; }
    const startedAt = this.cooldowns.get(requestKey);
    if (gate === 'cooldown' || (startedAt !== undefined && this.now() - startedAt < config.chat.cooldownMs)) { await this.reply(message, '发送得有点快，请稍等片刻再试。'); return; }
    if ((this.getActiveRequests ? this.getActiveRequests() : this.busy.size) >= config.chat.maxConcurrent) { await this.reply(message, '我现在正在处理较多问题，请稍后再试。'); return; }

    this.busy.add(requestKey);
    this.cooldowns.set(requestKey, this.now());
    while (this.cooldowns.size > 10000) this.cooldowns.delete(this.cooldowns.keys().next().value);
    this.logger.info(`收到${message.kind === 'group' ? '群聊' : '私聊'}问题，正在生成回答。`);
    try {
      let answer;
      let profile;
      try {
        try {profile = this.profiles?.notes(identity);}
        catch {this.logger.warn('用户长期资料暂不可用，本次仅使用近期对话。请检查资料容量或本地文件。');}
        const context = { ...config.chat, maxContextChars: Math.max(0,config.chat.maxContextChars-(profile?.notes.length||0)) };
        const llm = this.getLLM ? this.getLLM(config, { groupId: message.kind === 'group' ? target.targetId : '', privateId: message.kind === 'c2c' ? target.targetId : '' }) : this.llm;
        const tools=this.plugins?.toolSession(message,{canExecute:()=>!this.stopping&&this.now()-(Date.parse(message.timestamp)||this.now())<=(message.kind==='group'?240000:3300000)});
        answer = await llm.complete(withUserMemory(this.sessions.messages(key,input,context),profile?.notes),tools);
      } catch (error) {
        const detail = error instanceof LLMError ? error.message : '大模型处理失败，请稍后再试。';
        this.logger.warn(detail);
        await this.reply(message, detail);
        return;
      }
      const delivered = limitReply(answer, config.chat.maxReplyBytes);
      if (await this.reply(message, delivered, config.chat.maxReplyBytes)) {
        if (message.kind === 'c2c') this.privateChats?.sent(target.targetId);
        this.sessions.commit(key, input, delivered, config.chat, { kind: message.kind, targetId: target.targetId, senderId: message.senderId, promptId: config.chat.promptId });
        if (profile) {
          try {this.learner?.observe(profile.id,input,config,this.sessions.history(key).filter(item=>item.role==='user').map(item=>item.content));}
          catch {this.logger.warn('长期记忆暂未整理，回答和近期对话已保存。');}
        }
        this.logger.info('回答已发送。');
      }
    } finally {
      this.busy.delete(requestKey);
      this.onIdle?.();
    }
  }
}
