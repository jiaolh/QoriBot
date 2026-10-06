import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { ed25519Sign } from '@tencent-connect/qqbot-nodejs/protocol';
import { createChatBot } from '../src/bot.js';
import { readConfig } from '../src/config.js';
import { BotRuntime } from '../src/runtime.js';
import { SessionStore } from '../src/sessions.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectRoot } from '../src/config.js';
import { SettingsStore } from '../src/settings.js';
import { MemoryDatabase } from '../src/memory-db.js';

// 使用 SDK 自身依赖的 WebSocket 实现来模拟 QQ 网关，不访问外部服务。
const { WebSocketServer } = createRequire(import.meta.resolve('@tencent-connect/qqbot-nodejs'))('ws');
const silent = { info() {}, warn() {}, error() {}, debug() {} };

async function waitFor(condition) {
  const end = Date.now() + 4000;
  while (!condition()) {
    if (Date.now() >= end) throw new Error('本地模拟服务等待超时');
    await delay(10);
  }
}

async function platform(t, { rejectProactive = false } = {}) {
  const replies = [], requests = [], tokens = [], identifies = [];
  let baseUrl;
  let heldLLM;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      let data;
      if (req.url === '/app/getAppAccessToken') {
        tokens.push(body);
        data = { access_token: 'fake-qq-token', expires_in: '7200' };
      } else if (req.url === '/gateway') data = { url: baseUrl.replace('http:', 'ws:') + '/gateway-socket' };
      else if (req.url === '/v1/chat/completions') {
        requests.push({ body, auth: req.headers.authorization });
        if (heldLLM) await heldLLM;
        const system = body.messages?.[0]?.content || '';
        const payload = system.includes('判断群聊是否需要机器人接话') ? JSON.parse(body.messages.at(-1).content) : null;
        const latest=body.messages?.at(-1),text=latest?.role==='user'?latest.content:'';
        if(body.tools&&text.includes('10秒后提醒')){
          const args={timeType:'relative',when:'10秒',content:text.includes('集合')?'集合':'喝水'};
          res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:null,tool_calls:[{id:'call-reminder',type:'function',function:{name:'reminders_create',arguments:JSON.stringify(args)}}]}}],usage:{prompt_tokens:15,completion_tokens:5}}));return;
        }
        const content = payload ? JSON.stringify({ action:'reply',targetMessageId:payload.candidates.at(-1),reason:'群成员求助' }) : `模拟回答${requests.length}`;
        data = { choices: [{ message: { content } }], usage:{prompt_tokens:20,completion_tokens:10} };
      } else if (/^\/v2\/(users|groups)\/[^/]+\/messages$/.test(req.url)) {
        replies.push({ url: req.url, body, auth: req.headers.authorization });
        if(rejectProactive&&!body.msg_id){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({code:40011033,message:'proactive push unavailable'}));return;}
        data = { id: `reply-${replies.length}`, timestamp: new Date().toISOString() };
      } else {
        res.writeHead(404); res.end('{}'); return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch { res.writeHead(500); res.end('{}'); }
  });
  const sockets = new WebSocketServer({ server });
  let connected;
  sockets.on('connection', socket => {
    connected = socket;
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
    socket.on('message', raw => {
      const data = JSON.parse(raw);
      if (data.op === 2) {
        identifies.push(data.d);
        socket.send(JSON.stringify({ op: 0, s: 1, t: 'READY', d: { session_id: 'fake-session', user: { id: '123', bot: true } } }));
      } else if (data.op === 1) socket.send(JSON.stringify({ op: 11 }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return {
    baseUrl, requests, replies, tokens, identifies, sockets,
    push: payload => connected.send(JSON.stringify(payload)),
    holdLLM: () => {
      let release;
      heldLLM = new Promise(resolve => { release = resolve; });
      return release;
    },
  };
}

function settings(baseUrl, extra = {}) {
  return readConfig({
    QQ_APP_ID: '123', QQ_APP_SECRET: 'test-secret', LLM_API_KEY: 'fake-llm-key', LLM_MODEL: 'deepseek-flash',
    QQ_API_BASE_URL: baseUrl, LLM_BASE_URL: `${baseUrl}/v1`, USER_COOLDOWN_SECONDS: '0', ...extra,
  });
}
function event(id, kind = 'c2c') {
  return {
    op: 0, s: 2, t: kind === 'group' ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE',
    d: {
      id, content: kind === 'group' ? '<@!123> 你好' : '你好', timestamp: new Date().toISOString(),
      author: kind === 'group' ? { member_openid: 'group-user' } : { user_openid: 'private-user' },
      ...(kind === 'group' ? { group_openid: 'group-1' } : {}),
    },
  };
}

for (const transport of ['websocket','webhook']) test(`${transport} 全能模式：官方普通事件合并多人上下文，判断与回复使用原消息ID，全量事件@直接回答`,{timeout:10000},async t=>{
  const mock=await platform(t,{rejectProactive:true});mkdirSync(resolve(projectRoot,'.cache/test'),{recursive:true});const root=mkdtempSync(resolve(projectRoot,'.cache/test/full-'));
  const saved=new SettingsStore(root);
  saved.update({providers:saved.public().providers.map(p=>p.id==='default'?{...p,baseUrl:mock.baseUrl+'/v1',apiKey:'fake-key'}:p),
    qq:{appId:'123',appSecret:'test-secret',baseUrl:mock.baseUrl,transport},limits:{autoMemory:false,cooldownMs:0},groupChat:{batchDelayMs:20,batchMaxWaitMs:100,groups:{'group-1':{mode:'active',cooldownMs:0,minJudgeIntervalMs:0}}}});
  let adapter;
  if(transport==='webhook'){
    const {NodeHttpWebhookServer}=await import('@tencent-connect/qqbot-nodejs/protocol');adapter=new NodeHttpWebhookServer();saved.value.qq.webhook.port=0;saved.value.qq.webhook.server=adapter;
  }
  // Webhook server 是运行时对象，单独注入 SDK，避免配置克隆它。
  if(adapter)delete saved.value.qq.webhook.server;
  const memory=new MemoryDatabase(resolve(root,'data/memory.sqlite'),()=>saved.value.limits);
  let clock=Date.now();
  const runtime=new BotRuntime(saved,memory,{now:()=>clock,botFactory:(config,options)=>{if(adapter){config.qq.webhook.port=0;config.qq.webhook.server=adapter;}return createChatBot(config,options);}});
  t.after(async()=>{await runtime.stop();memory.close();rmSync(root,{recursive:true,force:true});});
  runtime.start();await waitFor(()=>runtime.state==='running');if(transport==='websocket')assert.equal(runtime.groupService.botId,'123');
  const push=async payload=>{
    if(transport==='websocket'){mock.push(payload);return;}
    const body=JSON.stringify(payload),timestamp=String(Math.floor(Date.now()/1000));
    const res=await fetch(`http://127.0.0.1:${adapter.server.address().port}${saved.value.qq.webhook.path}`,{method:'POST',headers:{'content-type':'application/json','X-Signature-Timestamp':timestamp,'X-Signature-Ed25519':ed25519Sign('test-secret',Buffer.from(timestamp+body))},body});
    assert.deepEqual(await res.json(),{op:12,d:0});
  };
  const one=event('full-one','group');one.t='GROUP_MESSAGE_CREATE';one.d.content='午餐吃什么';one.d.author.username='甲';
  const two=event('full-two','group');two.t='GROUP_MESSAGE_CREATE';two.d.content='谁能帮忙推荐';two.d.author.member_openid='member-b';two.d.author.username='乙';
  await push(one);await push(two);await waitFor(()=>mock.replies.length===1);await waitFor(()=>!runtime.groupService.tasks.size);
  assert.equal(mock.requests.length,2);assert.equal(mock.replies[0].body.msg_id,'full-two');
  const context=JSON.parse(mock.requests[1].body.messages.at(-1).content);assert.deepEqual(context.timeline.map(r=>r.member),['group-user','member-b']);
  assert.equal(runtime.groups.list()[0].policy.mode,'active');assert.ok(runtime.groups.list()[0].lastFullAt);
  const mentioned=event('full-at','group');mentioned.t='GROUP_MESSAGE_CREATE';mentioned.d.mentions=[{is_you:true,id:'123'}];
  await push(mentioned);await waitFor(()=>mock.replies.length===2);assert.equal(mock.requests.length,3);assert.equal(mock.replies[1].body.msg_id,'full-at');
  assert.equal(runtime.groups.usedToday('group-1'),90);
  await waitFor(()=>!runtime.groupService.tasks.size);
  const joined=await runtime.groupService.requestParticipation('group-1');assert.equal(joined.sent,true);
  assert.equal(mock.replies.length,3);assert.equal(mock.replies[2].body.msg_id,'full-at');assert.equal(mock.requests.length,4);
  assert.equal(runtime.groups.usedToday('group-1'),120);
  const groupReminder=event('reminder-group','group');groupReminder.d.content='<@!123> 10秒后提醒我集合';
  const privateReminder=event('reminder-private');privateReminder.d.content='10秒后提醒我喝水';
  await push(groupReminder);await push(privateReminder);await waitFor(()=>mock.replies.length===5);
  assert.equal(mock.requests.length,8,'模型自主选择预约工具，并根据结果生成确认回复');
  await waitFor(()=>!runtime.chat.pending.size);
  clock+=11000;await runtime.plugins.entries.get('reminders').instance.tick();
  assert.equal(mock.replies.length,7);
  const reminders=mock.replies.slice(5);assert.ok(reminders.some(r=>r.url==='/v2/groups/group-1/messages'));assert.ok(reminders.some(r=>r.url==='/v2/users/private-user/messages'));
  assert.ok(reminders.every(r=>r.body.msg_id&&r.body.content.includes('预约提醒')),'主动推送关闭时，到时通过 SDK 在有效窗口回复原目标');
  assert.equal(reminders.find(r=>r.url.includes('/groups/')).body.msg_id,'reminder-group');
  assert.equal(reminders.find(r=>r.url.includes('/users/')).body.msg_id,'reminder-private');
  assert.equal(runtime.plugins.entries.get('reminders').instance.store.list({state:'completed'}).total,2);
});

test('WebSocket 端到端：鉴权、私聊、群 @、模型调用、被动回复和重复消息过滤', { timeout: 10000 }, async t => {
  const mock = await platform(t);
  const signal = new AbortController();
  const { bot, chat } = createChatBot(settings(mock.baseUrl), { signal: signal.signal, logger: silent });
  const ready = new Promise(resolve => bot.on('ready', resolve));
  const running = bot.start(signal.signal);
  t.after(async () => { signal.abort(); bot.stop(); await running; await chat.drain(); });
  await ready;
  mock.push(event('ws-c2c'));
  await waitFor(() => mock.replies.length === 1);
  await waitFor(() => chat.busy.size === 0);
  mock.push(event('ws-c2c'));
  mock.push(event('ws-group', 'group'));
  await waitFor(() => mock.replies.length === 2);

  assert.deepEqual(mock.tokens[0], { appId: '123', clientSecret: 'test-secret' });
  assert.equal(mock.identifies[0].token, 'QQBot fake-qq-token');
  assert.equal(mock.identifies[0].intents, 1 << 25);
  assert.equal(mock.requests.length, 2);
  assert.equal(mock.requests[0].auth, 'Bearer fake-llm-key');
  assert.equal(mock.requests[0].body.model, 'deepseek-flash');
  assert.equal(mock.requests[1].body.messages.at(-1).content, '你好');
  assert.equal(mock.replies[0].url, '/v2/users/private-user/messages');
  assert.equal(mock.replies[1].url, '/v2/groups/group-1/messages');
  assert.equal(mock.replies[0].auth, 'QQBot fake-qq-token');
  assert.equal(mock.replies[0].body.msg_id, 'ws-c2c');
  assert.ok(Number.isInteger(mock.replies[0].body.msg_seq));
  assert.ok(mock.replies[0].body.msg_seq >= 0 && mock.replies[0].body.msg_seq <= 65535);
  assert.equal(mock.replies[0].body.msg_type, 0);
  assert.equal(mock.replies[0].body.content, '模拟回答1');
});

test('Webhook 端到端：回调地址验证、拒绝无签名请求、立即确认和 AI 回复', { timeout: 10000 }, async t => {
  const mock = await platform(t);
  const signal = new AbortController();
  const cfg = settings(mock.baseUrl, { QQ_TRANSPORT: 'webhook' });
  // 测试时交给操作系统分配空闲端口，正式配置仍要求明确端口。
  cfg.qq.webhook.port = 0;
  const { NodeHttpWebhookServer } = await import('@tencent-connect/qqbot-nodejs/protocol');
  const adapter = new NodeHttpWebhookServer();
  cfg.qq.webhook.server = adapter;
  const { bot, chat } = createChatBot(cfg, { signal: signal.signal, logger: silent });
  const ready = new Promise(resolve => bot.on('ready', resolve));
  const running = bot.start(signal.signal);
  t.after(async () => { signal.abort(); bot.stop(); await running; await chat.drain(); });
  await ready;
  const url = `http://127.0.0.1:${adapter.server.address().port}${cfg.qq.webhook.path}`;
  const post = (body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  const validation = { op: 13, d: { plain_token: 'verify-me', event_ts: '1725442341' } };
  const validated = await post(JSON.stringify(validation));
  const response = await validated.json();
  assert.equal(response.plain_token, 'verify-me');
  assert.equal(response.signature, ed25519Sign(cfg.qq.appSecret, Buffer.from('1725442341verify-me')));
  const body = JSON.stringify(event('webhook-c2c'));
  assert.equal((await post(body)).status, 401);
  assert.equal(mock.requests.length, 0);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = ed25519Sign(cfg.qq.appSecret, Buffer.from(timestamp + body));
  const releaseLLM = mock.holdLLM();
  const ack = await post(body, { 'X-Signature-Timestamp': timestamp, 'X-Signature-Ed25519': signature });
  assert.deepEqual(await ack.json(), { op: 12, d: 0 });
  await waitFor(() => mock.requests.length === 1);
  assert.equal(mock.replies.length, 0);
  releaseLLM();
  await waitFor(() => mock.replies.length === 1);
  assert.equal(mock.replies[0].body.msg_id, 'webhook-c2c');
  assert.equal(mock.replies[0].body.content, '模拟回答1');
});

test('连续正常连接与停止 50 次，关闭网关、心跳、监听器和会话缓存', {timeout:15000}, async t=>{
  const mock=await platform(t),config=settings(mock.baseUrl);
  const store={value:{qq:config.qq,providers:[config.llm]},runtime:()=>structuredClone(config)};
  const runtime=new BotRuntime(store,new SessionStore(config.chat));
  t.after(()=>runtime.stop());
  for(let i=0;i<50;i++) {
    runtime.start();const bot=runtime.bot,chat=runtime.chat;
    runtime.start();assert.equal(runtime.bot,bot);
    await waitFor(()=>runtime.state==='running');
    const gateway=bot.gateway;
    chat.seen.set('example',Date.now()+600000);chat.cooldowns.set('example',Date.now()+1000);
    await runtime.stop();await waitFor(()=>mock.sockets.clients.size===0);
    assert.equal(runtime.bot,null);assert.equal(runtime.chat,null);
    assert.equal(chat.seen.size,0);assert.equal(chat.cooldowns.size,0);
    for(const handlers of Object.values(bot.handlers)) assert.equal(handlers.size,0);
    assert.equal(bot.gateway,null);
    assert.equal(gateway.heartbeatInterval,null);
    assert.equal(gateway.reconnectTimer,null);
    assert.equal(gateway.currentWs,null);
    assert.equal(runtime.state,'stopped');
  }
});
