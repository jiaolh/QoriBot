import { createChatBot } from './bot.js';
import { createLogger } from './logger.js';
import { LLMClient } from './llm.js';
import { checkToolSupport } from './llm/tool-check.js';
import { ProfileMemory, LOCAL_USER, withUserMemory } from './profile-memory.js';
import { MemoryLearner } from './memory-learner.js';
import { GroupStore } from './group-store.js';
import { GroupService } from './group-service.js';
import { PluginManager } from './plugins/manager.js';
import { PrivateStore } from './private-store.js';

export function connectionError(error) {
  let code;
  for (let item=error;item;item=item.cause) if (item.code) code=item.code;
  if (['EACCES','EPERM'].includes(code)) return `进程联网被运行环境拒绝（${code}）。请退出程序后在 Windows 文件夹中双击 start.cmd，或使用允许联网的启动环境。`;
  if (['ENOTFOUND','EAI_AGAIN'].includes(code)) return '无法解析 QQ 域名，请检查网络或 DNS。';
  if (['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT'].includes(code)) return '连接 QQ 官方服务超时，请检查网络或代理。';
  if (error.httpStatus===401 || /HTTP 401/.test(error.message)) return 'QQ 鉴权失败，请核对 AppID 和 AppSecret。';
  if (error.httpStatus===403 || /HTTP 403/.test(error.message)) return 'QQ 平台拒绝访问，请检查机器人权限和 IP 白名单。';
  return error.message || 'QQ 连接失败，请检查网络和平台配置。';
}

export class BotRuntime {
  constructor(settings, memory, { now=Date.now, botFactory=createChatBot } = {}) {
    this.settings = settings; this.memory = memory;
    this.state = 'stopped'; this.startedAt = null; this.logs = []; this.bot = null; this.chat = null;
    this.counters = { inputTokens: 0, outputTokens: 0, searches: 0, requests: 0, memoryRequests: 0 };
    this.now=now; this.botFactory=botFactory; this.nextStartAt=0; this.lastError='';
    this.activeTests = 0; this.testControllers = new Set();
    const output = {};
    for (const level of ['info', 'warn', 'error']) output[level] = message => {
      this.logs.push({ level, message, at: Date.now() });
      if (this.logs.length > 200) this.logs.shift();
    };
    this.output = output;
    this.groups = memory.db ? new GroupStore(memory, () => settings.value.groupChat, now) : null;
    this.profiles = memory.db ? new ProfileMemory(memory,()=>settings.value.limits) : null;
    this.privateChats = memory.db ? new PrivateStore(memory, settings, now) : null;
    this.learner = this.profiles ? new MemoryLearner(this.profiles,{
      client:(config,signal)=>{this.counters.requests++;this.counters.memoryRequests++;return this.client(config,signal);},
      canRun:()=>this.activeRequests < settings.value.limits.maxConcurrent,
      limits:()=>settings.value.limits,log:(level,message)=>this.log(level,message),
    }) : null;
    this.groupService = this.groups ? new GroupService({ store: this.groups, settings, profiles: this.profiles, learner: this.learner,
      client: (config, signal, scope) => { this.counters.requests++; return this.client(config, signal, scope); },
      send: (target, text) => { if (!this.bot || this.shutdown?.signal.aborted) throw new Error('机器人已停止'); return this.bot.sendText(target, text); },
      canRun: () => this.activeRequests < settings.value.limits.maxConcurrent, log: (level, text) => this.log(level, text), now,
      isConnected: () => this.state === 'running' && Boolean(this.bot) && !this.shutdown?.signal.aborted,
    }) : null;
    this.plugins=memory.db?new PluginManager({db:memory.db,settings,now,sendText:(target,text)=>this.sendPluginText(target,text),isConnected:()=>this.state==='running'&&Boolean(this.bot)&&!this.shutdown?.signal.aborted,log:(level,text)=>this.log(level,text)}):null;
    if(this.groupService)this.groupService.plugins=this.plugins;
    this.log('info', 'QoriBot 本地控制台已就绪。');
  }
  get activeRequests() { return (this.chat?.busy.size || 0) + this.activeTests + (this.learner?.activeRequests || 0) + (this.groupService?.activeRequests || 0) + (this.plugins?.activeRequests||0); }
  async sendPluginText(target,text) {
    if(this.state!=='running'||!this.bot||this.shutdown?.signal.aborted)throw new Error('机器人尚未连接。');
    const result=await this.bot.sendText(target,text),id=result?.id||result?.data?.id;
    if(target.scope==='group'&&id){
      this.groupService?.ownIds.set(id,this.now());
      for(const [key,at] of this.groupService.ownIds)if(this.now()-at>600000)this.groupService.ownIds.delete(key);
      while(this.groupService.ownIds.size>10000)this.groupService.ownIds.delete(this.groupService.ownIds.keys().next().value);
      if(this.groupService?.policy(target.targetId).mode!=='light'&&this.groups?.discover(target.targetId))this.groups.append(target.targetId,{messageId:id,senderId:this.groupService.botId||'bot',content:text,at:this.now()},{direction:'out'});
    }
    return result;
  }
  get retryAfterMs() { return Math.max(0,this.nextStartAt-this.now()); }
  log(level, message) {
    const secrets = [this.settings.value.qq.appSecret, ...this.settings.value.providers.map(provider => provider.apiKey)];
    createLogger(secrets, this.output)[level](message);
  }
  client(config, signal, scope = {}) {
    let usageSeen = false, total = { inputTokens: 0, outputTokens: 0 };
    const client = new LLMClient(config.llm, { signal, onUsage: usage => {
      for (const key of ['inputTokens', 'outputTokens', 'searches']) this.counters[key] += usage[key];
      if (usage.reported !== false) { usageSeen = true; total.inputTokens += usage.inputTokens; total.outputTokens += usage.outputTokens; } scope.onUsage?.(usage);
    } });
    client.onFollowup=()=>{this.counters.requests++;};
    if (this.groups && !scope.managed) {
      const privateId = scope.privateId || config.budgetPrivate;
      const reserve = (messages, kind = 'other') => {
        if (privateId) this.privateChats.checkBudget(privateId, messages, config.llm.maxTokens);
        const group = this.groups.reserve(scope.groupId || config.budgetGroup || '', kind, messages, config.llm.maxTokens);
        const personal = privateId ? this.privateChats.reserve(privateId, messages, config.llm.maxTokens) : null;
        return { group, personal };
      };
      const settle = (call, usage, state) => {
        this.groups.settle(call.group, usage, state);
        if (call.personal !== null) this.privateChats.settle(call.personal, usage, state);
      };
      const original = client.complete.bind(client);
      client.complete = async (messages,tools) => {
        if(tools?.tools?.length)return original(messages,{...tools,beforeRequest:prompt=>{
          const call=reserve(prompt, 'plugin');
          return {finish:(usage,error)=>settle(call,usage?.reported!==false?usage:null,error?'failed':'done')};
        }});
        const call = reserve(messages);
        try { const text = await original(messages,tools); settle(call, usageSeen ? total : null, 'done'); return text; }
        catch (error) { settle(call, usageSeen ? total : null, 'failed'); throw error; }
      };
    }
    return client;
  }
  async checkProvider(providerId, kind) {
    const provider = this.settings.value.providers.find(item => item.id === providerId);
    if (!provider?.apiKey) throw new Error('请先保存该配置的 API Key。');
    if (this.activeRequests >= this.settings.value.limits.maxConcurrent) throw new Error('请求较多，请稍后再试。');
    const controller = new AbortController();
    this.testControllers.add(controller);
    this.activeTests++;
    try {
      if (kind === 'models') {
        const client = new LLMClient({ ...provider, timeoutMs: 15000 }, { signal: controller.signal });
        return { models: await client.listModels() };
      }
      this.counters.requests++;
      const limits = this.settings.value.limits;
      const client = this.client({ llm: { ...provider, webSearch: false, maxTokens: Math.min(limits.maxTokens, 512), timeoutMs: limits.timeoutMs, temperature: limits.temperature ?? undefined } }, controller.signal);
      return await checkToolSupport(client);
    } finally {
      this.activeTests--;
      this.testControllers.delete(controller);
      this.learner?.pump();
    }
  }

  start() {
    if (['starting', 'running'].includes(this.state)) return;
    if (this.state === 'stopping') throw new Error('机器人正在停止，请稍后。');
    if (this.retryAfterMs) throw new Error(`请等 ${Math.ceil(this.retryAfterMs/1000)} 秒再重试连接。`);
    const config = this.settings.runtime();
    const shutdown = new AbortController(); this.shutdown = shutdown;
    this.state = 'starting'; this.startedAt = this.now(); this.lastError=''; this.learner?.resume(); this.groupService?.resume();
    const logger = {};
    for (const level of ['info', 'warn', 'error']) logger[level] = message => this.log(level, message);
    logger.debug = () => {};
    let bot,chat;
    try { ({ bot, chat } = this.botFactory(config, {
      logger, signal: shutdown.signal, sessions: this.memory,
      getConfig: message => message?.kind === 'c2c' ? this.settings.privateRuntime(message.replyTarget.targetId) : this.settings.runtime(),
      getLLM: (current, scope) => { this.counters.requests++; return this.client(current, shutdown.signal, scope); },
      profiles:this.profiles,learner:this.learner,getActiveRequests:()=>this.activeRequests,onIdle:()=>this.learner?.pump(),
      groups: this.groupService,
      plugins: this.plugins,
      privateChats: this.privateChats,
    })); }
    catch(error) {this.state='error';this.lastError=connectionError(error);this.nextStartAt=this.now()+5000;this.shutdown=null;shutdown.abort();throw new Error(this.lastError);}
    this.bot = bot; this.chat = chat;
    this.plugins?.start().catch(()=>this.log('warn','插件启动未完成，请查看控制台。'));
    clearInterval(this.groupPruneTimer);
    if(this.groups){this.groupPruneTimer=setInterval(()=>this.groups.prune(true),60000);this.groupPruneTimer.unref();}
    const watchdog=setTimeout(()=>{if(this.state==='starting'){this.state='error';this.lastError='QQ 连接超过 30 秒仍未完成，请检查网络、代理和平台权限。';this.nextStartAt=this.now()+5000;this.log('error',this.lastError);shutdown.abort();}},30000); watchdog.unref();
    bot.on('ready', () => { if (!shutdown.signal.aborted) { clearTimeout(watchdog); this.state = 'running'; this.log('info', '机器人已连接，可以开始 QQ 对话。'); } });
    bot.on('resumed', () => { if(!shutdown.signal.aborted){this.state = 'running'; this.log('info', 'QQ 连接已恢复。');} });
    bot.on('error', error => this.log('error', `QQ 连接异常：${error.message}`));
    this.log('info', `正在启动机器人，模型：${config.llm.model}。`);
    const originalGateway = bot.messageApi.getGatewayUrl.bind(bot.messageApi);
    bot.messageApi.getGatewayUrl = async (...args) => {
      const url = await originalGateway(...args);
      shutdown.signal.throwIfAborted();
      return url;
    };
    this.running = (async () => {
      await bot.tokenManager.getAccessToken(config.qq.appId, config.qq.appSecret);
      if (shutdown.signal.aborted) return;
      const stopped = new Promise(resolve => shutdown.signal.addEventListener('abort', resolve, { once: true }));
      await Promise.race([bot.start(shutdown.signal), stopped]);
    })().catch(error => {
      if (!shutdown.signal.aborted) { this.state = 'error'; this.lastError=connectionError(error); this.nextStartAt=this.now()+5000; this.log('error', `启动失败：${this.lastError}`); }
    }).finally(async () => {
      clearTimeout(watchdog); shutdown.abort(); bot.stop(); await chat.drain();
      await this.plugins?.stop();
      clearInterval(this.groupPruneTimer);
      bot.tokenManager.clearCache();
      for (const handlers of Object.values(bot.handlers || {})) handlers.clear();
      if (this.state !== 'error') this.state = 'stopped';
      this.bot = null; this.chat = null; this.shutdown=null;
    });
  }
  async stop() {
    if(this.chat)this.chat.stopping=true;
    const groupsStopping=this.groupService?.stop();
    await this.plugins?.stop();
    clearInterval(this.groupPruneTimer);
    for (const controller of this.testControllers) controller.abort();
    await this.learner?.stop();
    await groupsStopping;
    if (!this.bot) { this.state = 'stopped'; return; }
    this.state = 'stopping'; this.chat.stopping = true;
    this.shutdown.abort();
    await this.running;
    this.state = 'stopped'; this.log('info', '机器人已停止。');
  }
  async testChat(input) {
    const config = this.settings.runtime({ requireQQ: false });
    if (typeof input !== 'string' || !input.trim() || input.length > config.chat.maxInputChars) throw new Error('请输入有效且长度合适的测试问题。');
    if (this.activeRequests >= config.chat.maxConcurrent) throw new Error('请求较多，请稍后再试。');
    const key=LOCAL_USER.key+':'+config.chat.promptId;
    if (this.localBusy) throw new Error('上一条本机问题还在处理中，请稍后。');
    if (/^\/(?:reset|重置)$/i.test(input.trim())) {this.memory.reset(key);return {text:'近期对话已重置，长期资料保留。'};}
    this.learner?.resume();
    const command=this.profiles?.command(LOCAL_USER,input.trim());
    if (command!==null && command!==undefined) {this.learner?.cancel(this.profiles.ensure(LOCAL_USER));return {text:command};}
    const controller = new AbortController(); this.testControllers.add(controller);
    this.activeTests++; this.counters.requests++; this.localBusy=true;
    try {
      let profile;
      try {profile=this.profiles?.notes(LOCAL_USER);}
      catch {this.log('warn','本机长期资料暂不可用，本次仅使用近期对话。请检查资料容量或本地文件。');}
      const context={...config.chat,maxContextChars:Math.max(0,config.chat.maxContextChars-(profile?.notes.length||0))};
      const text=await this.client(config,controller.signal).complete(withUserMemory(this.memory.messages(key,input,context),profile?.notes),{tools:[],system:'当前是控制台本机测试，不是 QQ 私聊或群聊，没有绑定 QQ 发送目标。可以聊天和说明预约功能，但不能实际保存预约，也不能声称已预约或到时会发送；需要预约时请用户在 QQ 私聊或群聊中提出，或在控制台预约提醒页选择目标后手动新建。'});
      this.memory.commit(key,input,text,config.chat,{kind:'local',targetId:'local',senderId:'local-user',promptId:config.chat.promptId});
      if(profile) {
        try {this.learner?.observe(profile.id,input,config,this.memory.history(key).filter(item=>item.role==='user').map(item=>item.content));}
        catch {this.log('warn','长期记忆暂未整理，回答和近期对话已保存。');}
      }
      return {text};
    } finally { this.activeTests--; this.localBusy=false; this.testControllers.delete(controller); this.learner?.pump(); }
  }
}
