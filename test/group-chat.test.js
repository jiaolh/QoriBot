import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { projectRoot } from '../src/config.js';
import { SettingsStore } from '../src/settings.js';
import { MemoryDatabase } from '../src/memory-db.js';
import { GroupStore } from '../src/group-store.js';
import { GroupService } from '../src/group-service.js';
import { ProfileMemory, userIdentity } from '../src/profile-memory.js';
import { MemoryLearner } from '../src/memory-learner.js';
import { isMentioned, isQuiet } from '../src/group-config.js';
import { createControlPanel } from '../src/server.js';
import { BotRuntime } from '../src/runtime.js';

async function waitFor(check) { const until=Date.now()+4000; while(!check()){if(Date.now()>until)throw new Error('群聊测试等待超时');await delay(2);} }
function fixture(t, mode='active') {
  mkdirSync(resolve(projectRoot,'.cache/test'),{recursive:true});
  const root=mkdtempSync(resolve(projectRoot,'.cache/test/group-')), settings=new SettingsStore(root);
  settings.update({providers:settings.public().providers.map(p=>({...p,apiKey:'fake-key'})),limits:{autoMemory:false},groupChat:{batchDelayMs:10,batchMaxWaitMs:30,groups:{g:{mode,cooldownMs:0,minJudgeIntervalMs:0}}}});
  let now=Date.now(), memory=new MemoryDatabase(resolve(root,'data/memory.sqlite'),()=>settings.value.limits,()=>now);
  let store=new GroupStore(memory,()=>settings.value.groupChat,()=>now),profiles=new ProfileMemory(memory,()=>settings.value.limits);
  const calls=[],sends=[], logs=[]; let failSend=false, complete;
  const learner=new MemoryLearner(profiles,{client:()=>({complete:async()=>'{"notes":null}'}),canRun:()=>true,limits:()=>settings.value.limits,log:()=>{}});
  const service=new GroupService({store,settings,profiles,learner,now:()=>now,canRun:()=>true,log:(...a)=>logs.push(a),
    client:(config,signal,scope)=>({complete:async messages=>{
      const data=JSON.parse(messages.at(-1).content),kind=data.candidates?'judge':data.targetMessageId?'reply':'summary';
      calls.push({config,messages,data,kind,signal});
      if(complete)return complete(kind,data,signal);
      scope.onUsage({inputTokens:50,outputTokens:10});
      return kind==='judge'?JSON.stringify({action:'reply',targetMessageId:data.candidates.at(-1),reason:'适合补充'}):kind==='reply'?'尾鳍晃一下，接着说捏。':'{"summary":"讨论午餐安排"}';
    }}),send:async(target,text)=>{if(failSend)throw new Error('模拟发送失败');sends.push({target,text});return{id:'bot-'+sends.length};}});
  t.after(async()=>{await service.stop();await learner.stop();memory.close();assert.ok(root.startsWith(resolve(projectRoot,'.cache/test')+'\\'));rmSync(root,{recursive:true,force:true});});
  return {root,settings,get memory(){return memory;},get store(){return store;},get profiles(){return profiles;},service,learner,calls,sends,logs,
    advance(ms){now+=ms;},get now(){return now;},set complete(fn){complete=fn;},set failSend(value){failSend=value;},
    reopen(){memory.close();memory=new MemoryDatabase(resolve(root,'data/memory.sqlite'),()=>settings.value.limits,()=>now);store=new GroupStore(memory,()=>settings.value.groupChat,()=>now);profiles=new ProfileMemory(memory,()=>settings.value.limits);service.store=store;service.profiles=profiles;learner.profiles=profiles;},
    message(id,content='能帮忙说说吗',extra={}){return{kind:'group',rawEventType:'GROUP_MESSAGE_CREATE',messageId:id,senderId:'a',senderName:'甲',content,timestamp:new Date(now).toISOString(),replyTarget:{kind:'group',targetId:'g',msgId:id},...extra};},
  };
}
async function idle(f){await waitFor(()=>!f.service.tasks.size&&!f.service.states.size);}

test('没有提问的日常闲聊也可自动接话，默认间隔30秒且每小时24次',async t=>{
  const f=fixture(t);
  const defaults=new SettingsStore(f.root).value.groupChat;
  assert.equal(new SettingsStore(f.root).groupRuntime('g').chat.promptId,'general');
  f.service.handle(f.message('casual','刚吃完晚饭，好困啊'));await idle(f);
  assert.equal(f.calls[0].kind,'judge');assert.equal(f.sends.length,1);assert.equal(f.sends[0].target.msgId,'casual');
  f.settings.update({groupChat:{groups:{new:{mode:'active'}}}});
  assert.equal(f.settings.value.groupChat.groups.new.cooldownMs,30000);assert.equal(f.settings.value.groupChat.groups.new.maxRepliesHour,24);
  assert.equal(defaults.messageTtlMs,43200000);
});

test('手动加入在观察状态直接参与闲聊，跳过判断和自动限流，记录发送与预算',async t=>{
  const f=fixture(t,'observe');f.settings.value.groupChat.groups.g.cooldownMs=3600000;f.settings.value.groupChat.groups.g.maxRepliesHour=1;
  f.settings.value.groupChat.groups.g.quietStart='00:00';f.settings.value.groupChat.groups.g.quietEnd='23:59';
  f.store.discover('g');f.store.append('g',f.message('casual','刚吃完饭，今天的菜真好吃'));f.store.sent('g',true);
  f.store.discover('other');f.store.append('other',f.message('foreign','别的群消息',{senderId:'b'}));
  const profile=f.profiles.ensure(userIdentity('group','g','a'));f.profiles.edit(profile,{notes:'私人的长期资料'});
  assert.equal(f.service.participationState('g').available,true);
  const result=await f.service.requestParticipation('g');
  assert.equal(result.sent,true);assert.equal(result.transport,'reply');assert.deepEqual(f.sends[0].target,{scope:'group',targetId:'g',msgId:'casual'});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].kind,'reply');assert.equal(f.calls[0].config.llm.maxTokens,256);
  assert.ok(!JSON.stringify(f.calls[0].data).includes('别的群消息'));assert.ok(!JSON.stringify(f.calls[0].data).includes('私人的长期资料'));
  assert.equal(f.store.judgesHour('g'),0);assert.equal(f.store.lastCall('g','manual'),f.now);assert.equal(f.store.usedToday('g'),60);
  assert.equal(f.store.repliesHour('g'),2);assert.equal(f.store.detail('g').decisions[0].action,'manual_sent');
});

test('手动加入缺少上下文或QQ未连接时不调用模型，轻量也可手动使用已有群上下文',async t=>{
  const f=fixture(t,'light');f.store.discover('g');
  assert.throws(()=>f.service.requestParticipation('g'),/近期群消息/);
  f.store.append('g',f.message('one','普通闲聊'));f.service.isConnected=()=>false;
  assert.throws(()=>f.service.requestParticipation('g'),/启动机器人/);assert.equal(f.calls.length,0);
  f.service.isConnected=()=>true;const result=await f.service.requestParticipation('g');assert.equal(result.sent,true);
  f.advance(1800001);assert.equal(f.service.participationState('g').available,false);
});

test('较早的群话题手动发送走官方主动消息路径，不携带过期消息ID',async t=>{
  const f=fixture(t);f.store.discover('g');f.store.append('g',f.message('old','晚饭太香了'));f.advance(240001);
  assert.equal(f.service.participationState('g').proactive,true);
  const result=await f.service.requestParticipation('g');assert.equal(result.transport,'proactive');assert.deepEqual(f.sends[0].target,{scope:'group',targetId:'g'});
});

test('手动操作取消待判断的普通批次，阻止同时重复点击与10秒内再次发送',async t=>{
  const f=fixture(t);let release;
  f.service.handle(f.message('one','哈哈好困'));f.complete=()=>new Promise(resolve=>{release=resolve;});
  const task=f.service.requestParticipation('g');await waitFor(()=>release);
  assert.throws(()=>f.service.requestParticipation('g'),/正在处理消息/);
  release('我也想趴着捏。');await task;await delay(30);assert.equal(f.calls.length,1);assert.equal(f.sends.length,1);
  assert.throws(()=>f.service.requestParticipation('g'),/10 秒/);
  f.advance(10000);f.complete=null;await f.service.requestParticipation('g');assert.equal(f.sends.length,2);
});

test('手动生成时话题变化或清空取消操作，不发过时内容、不恢复清空的群记录',async t=>{
  const f=fixture(t,'observe');let release;
  f.store.discover('g');f.store.append('g',f.message('one','旧话题'));f.complete=()=>new Promise(resolve=>{release=resolve;});
  const changed=f.service.requestParticipation('g');await waitFor(()=>release);f.store.append('g',f.message('new','新话题'));release('旧回复');
  await assert.rejects(changed,/群里有新消息/);assert.equal(f.sends.length,0);
  f.advance(10000);release=null;const cancelled=f.service.requestParticipation('g');await waitFor(()=>release);
  f.service.cancel('g');f.store.clear('g');release('应该取消');await assert.rejects(cancelled,/已取消/);
  assert.equal(f.store.stats().messages,0);assert.equal(f.store.detail('g').decisions.length,0);assert.equal(f.sends.length,0);
});

test('手动加入遵守日预算，发送失败给出平台信息且不保存虚假发言',async t=>{
  const f=fixture(t);f.store.discover('g');f.store.append('g',f.message('one','今天真开心'));
  f.service.send=async()=>{throw Object.assign(new Error('上游敏感原文'),{httpStatus:403,bizCode:99});};
  await assert.rejects(f.service.requestParticipation('g'),error=>/QQ 发送失败/.test(error.message)&&!error.message.includes('敏感原文'));
  assert.equal(f.store.context('g').filter(m=>m.direction==='out').length,0);assert.equal(f.store.repliesHour('g'),0);
  f.advance(10000);f.settings.value.groupChat.dailyTokenLimit=1000;
  await assert.rejects(f.service.requestParticipation('g'),/预算/);assert.equal(f.calls.length,1);
});

test('旧配置迁移为轻量与12小时保留，群模型可独立选择，设置拒绝不存在的配置',t=>{
  const f=fixture(t,'light');assert.equal(f.settings.value.groupChat.messageTtlMs,43200000);
  assert.equal(f.service.handle(f.message('plain')),true);assert.equal(f.store.stats().messages,0);assert.equal(f.calls.length,0);
  const at=f.message('at','<@!123> 帮忙',{mentions:[{is_you:true}]});assert.equal(f.service.handle(at),false);assert.equal(at.rawEventType,'GROUP_AT_MESSAGE_CREATE');
  assert.ok(f.store.list()[0].lastFullAt);
  f.settings.update({providers:f.settings.public().providers.map(p=>({...p,clearKey:p.id==='default'})),groupChat:{groups:{g:{mode:'observe',judgeProviderId:'deepseek'}}}});
  assert.equal(f.settings.groupRuntime('g','judge').llm.id,'deepseek');assert.throws(()=>f.settings.groupRuntime('g'),/API Key/);
  assert.throws(()=>f.settings.update({groupChat:{groups:{g:{promptId:'missing'}}}}),/不存在/);
  assert.throws(()=>f.settings.update({groupChat:{batchDelayMs:100,batchMaxWaitMs:10}}),/最长等待/);
});

test('只识别真正提到机器人的全量消息，免打扰跨午夜按北京时间生效',()=>{
  assert.equal(isMentioned({content:'<@!other> 帮忙',mentions:[{id:'other'}]},'123'),false);
  assert.equal(isMentioned({content:'<@!123> 帮忙'},'123'),true);
  assert.equal(isMentioned({mentions:[{is_you:true}]}),true);
  const policy={quietStart:'23:00',quietEnd:'08:00'};
  assert.equal(isQuiet(policy,Date.parse('2026-10-05T23:30:00+08:00')),true);assert.equal(isQuiet(policy,Date.parse('2026-10-05T09:00:00+08:00')),false);
});

test('多人普通消息合并一次判断，用有效消息ID回复，去重与自身回声不重复调用',async t=>{
  const f=fixture(t);f.service.botId='123';
  f.service.handle(f.message('one','午餐吃什么',{msgIdx:'idx-one'}));
  f.service.handle(f.message('two','谁能推荐一下',{senderId:'b',senderName:'乙',refMsgIdx:'idx-one'}));
  f.service.handle(f.message('two','重复'));await idle(f);
  assert.deepEqual(f.calls.map(c=>c.kind),['judge','reply']);assert.equal(f.sends.length,1);assert.equal(f.sends[0].target.msgId,'two');
  assert.deepEqual(f.calls[1].data.timeline.map(m=>m.member),['a','b']);assert.equal(f.calls[1].data.currentMember,'b');assert.equal(f.calls[1].data.quotedMessage.content,'午餐吃什么');
  assert.equal(f.store.stats().messages,3);assert.equal(f.store.repliesHour('g'),1);
  f.service.handle(f.message('bot-1',f.sends[0].text,{senderId:'not-flagged'}));f.service.handle(f.message('bot-2','自己',{senderId:'123'}));await delay(20);
  assert.equal(f.calls.length,2);assert.equal(f.store.stats().messages,3);
});

test('观察模式普通消息只记录决定，明确@直接回复并携带目标成员的资料',async t=>{
  const f=fixture(t,'observe');
  const a=f.profiles.ensure(userIdentity('group','g','a')),b=f.profiles.ensure(userIdentity('group','g','b'));
  f.profiles.edit(a,{notes:'- 甲喜欢米饭'});f.profiles.edit(b,{notes:'- 乙喜欢面条'});
  f.service.handle(f.message('one'));await idle(f);assert.equal(f.sends.length,0);assert.equal(f.store.detail('g').decisions[0].action,'would_reply');
  f.service.handle(f.message('two','<@!123> 午餐？',{senderId:'b',mentions:[{is_you:true}]}));await idle(f);
  assert.equal(f.sends.length,1);assert.equal(f.calls[1].kind,'reply');assert.match(f.calls[1].data.memberNotes,/乙/);assert.ok(!f.calls[1].data.memberNotes.includes('甲'));
  assert.equal(f.store.repliesHour('g'),0,'明确@不消耗自动回复小时配额');
});

test('冷却、免打扰和小时上限在模型判断前过滤，明确@仍可回答',async t=>{
  const f=fixture(t);f.settings.value.groupChat.groups.g.cooldownMs=60000;
  f.service.handle(f.message('one'));await idle(f);f.service.handle(f.message('two'));await idle(f);
  assert.equal(f.calls.length,2);assert.match(f.store.detail('g').decisions[0].reason,/冷却/);
  f.service.handle(f.message('three','明确提问',{rawEventType:'GROUP_AT_MESSAGE_CREATE'}));await idle(f);assert.equal(f.calls.length,3);
  f.advance(60001);f.settings.value.groupChat.groups.g.maxRepliesHour=1;f.service.handle(f.message('four'));await idle(f);
  assert.match(f.store.detail('g').decisions[0].reason,/回复已达上限/);
  f.settings.value.groupChat.groups.g.maxRepliesHour=100;f.settings.value.groupChat.groups.g.maxJudgesHour=1;f.service.handle(f.message('five'));await idle(f);
  assert.match(f.store.detail('g').decisions[0].reason,/判断次数/);
});

test('错误判断、跨群目标和发送失败保持安静，不保存未送达回答',async t=>{
  const f=fixture(t);f.complete=async()=>'{"action":"reply","targetMessageId":"outside"}';
  f.service.handle(f.message('one'));await idle(f);assert.equal(f.sends.length,0);assert.equal(f.store.stats().messages,1);
  f.complete=async()=> 'not-json';f.service.handle(f.message('two'));await idle(f);assert.equal(f.sends.length,0);
  f.complete=null;f.failSend=true;f.service.handle(f.message('three'));await idle(f);
  assert.equal(f.store.context('g').filter(m=>m.direction==='out').length,0);assert.equal(f.store.repliesHour('g'),0);
});

test('新消息使旧自动回复过时，切换模式和清空取消在途任务',async t=>{
  const f=fixture(t);let release;
  f.complete=async(kind,data)=>kind==='judge'?JSON.stringify({action:'reply',targetMessageId:data.candidates.at(-1)}):new Promise(resolve=>{release=resolve;});
  f.service.handle(f.message('one'));await waitFor(()=>release);
  f.service.handle(f.message('two','换个话题'));release('旧话题回答');await waitFor(()=>f.store.detail('g').decisions.some(d=>d.action==='stale'));
  f.service.cancel('g');await idle(f);assert.equal(f.sends.length,0);
  release=null;f.service.handle(f.message('three'));await waitFor(()=>release);
  f.settings.value.groupChat.groups.g.mode='light';f.service.cancel('g');release('已取消的回答');await idle(f);assert.equal(f.sends.length,0);
});

test('停止中断群请求，突发消息保持有界队列，等待并发空位而不多开模型',async t=>{
  const f=fixture(t);let allowed=false;f.service.canRun=()=>allowed;
  for(let i=0;i<100;i++)f.service.handle(f.message('burst-'+i));
  await delay(15);assert.equal(f.calls.length,0);assert.equal(f.service.state('g').normal.length,10);assert.equal(f.store.stats().messages,100);
  allowed=true;f.complete=(_kind,_data,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));
  f.service.launch('g');await waitFor(()=>f.service.activeRequests===1);await f.service.stop();
  assert.equal(f.service.activeRequests,0);assert.equal(f.sends.length,0);assert.equal(f.service.tasks.size,0);
});

test('资料命令优先处理，忘记可以取消本人成员的旧回复而不清空其他成员队列',async t=>{
  const f=fixture(t);let release;const commands=[];
  f.service.commandHandler=async message=>{commands.push(message.content);f.profiles.command(userIdentity('group','g',message.senderId),message.content);};
  f.complete=async(kind,data)=>kind==='judge'?JSON.stringify({action:'reply',targetMessageId:data.candidates.at(-1)}):new Promise(resolve=>{release=resolve;});
  f.service.handle(f.message('one','本人提问',{rawEventType:'GROUP_AT_MESSAGE_CREATE'}));await waitFor(()=>release);
  f.service.handle(f.message('forget','/忘记',{rawEventType:'GROUP_AT_MESSAGE_CREATE'}));release('旧资料回复');await idle(f);
  assert.deepEqual(commands,['/忘记']);assert.equal(f.sends.length,0);
  f.complete=null;f.service.handle(f.message('help','/帮助',{rawEventType:'GROUP_AT_MESSAGE_CREATE'}));await idle(f);assert.deepEqual(commands,['/忘记','/帮助']);
});

test('12小时查询与自动清理同时生效，字节容量淘汰最早消息，清空保留预算',t=>{
  const f=fixture(t);f.store.discover('g');f.store.append('g',f.message('old','旧消息'));
  f.store.summary('g','旧摘要',1,0);f.store.record('g','skip','旧决定');f.advance(43200000);
  assert.equal(f.store.context('g').length,0);assert.equal(f.store.message('g','old'),undefined);assert.equal(f.store.detail('g').summary,'');
  assert.equal(f.memory.db.prepare('SELECT count(*) AS n FROM group_messages').get().n,0);
  f.settings.value.groupChat.maxBytes=1048576;
  for(let i=0;i<50;i++)f.store.append('g',f.message('size-'+i,'中'.repeat(15000)));
  assert.ok(f.store.stats().bytes<=1048576);assert.equal(f.store.message('g','size-0'),undefined);assert.ok(f.store.message('g','size-49'));
  const call=f.store.reserve('g','judge',[{content:'测试'}],128);f.store.settle(call,{inputTokens:10,outputTokens:5},'done');
  f.store.sent('g',true);f.store.clear('g');assert.equal(f.store.stats().messages,0);assert.equal(f.store.usedToday('g'),15);assert.equal(f.store.repliesHour('g'),1);
});

test('日预算含在途预留并持久化，重启不能绕过全局和单群上限',t=>{
  const f=fixture(t);f.settings.value.groupChat.dailyTokenLimit=1000;
  const call=f.store.reserve('g','judge',[{content:'x'.repeat(200)}],720);
  assert.throws(()=>f.store.reserve('g','reply',[{content:'x'}],128),/预算/);
  f.reopen();assert.throws(()=>f.store.reserve('g','judge',[{content:'x'}],128),/预算/);
  f.store.settle(call,{inputTokens:20,outputTokens:10},'done');assert.equal(f.store.usedToday(),30);
  f.settings.value.groupChat.groups.g.dailyTokenLimit=100;assert.throws(()=>f.store.reserve('g','reply',[{content:'x'}],128),/预算/);
});

test('群摘要有版本保护和过期；备份排除群原文、决定与摘要，资料和预算保留',async t=>{
  const f=fixture(t);f.store.discover('g');f.store.append('g',f.message('one','讨论午餐'));await f.service.requestSummary('g');assert.match(f.store.channel('g').summary,/午餐/);
  let release;f.complete=()=>new Promise(resolve=>{release=resolve;});
  const task=f.service.requestSummary('g');await waitFor(()=>release);f.store.clear('g');release('{"summary":"过时摘要"}');await task;assert.equal(f.store.channel('g').summary,'');
  f.store.append('g',f.message('new','不应带入备份的原文'));f.store.record('g','skip','原因');f.store.summary('g','不应备份的摘要',3,1);
  const id=f.profiles.ensure(userIdentity('group','g','a'));f.profiles.edit(id,{notes:'- 喜欢米饭'});
  const path=resolve(f.root,'snapshot.sqlite');f.memory.backup(path);f.store.sanitizeBackup(path);
  const backup=new DatabaseSync(path);try{assert.equal(backup.prepare('SELECT count(*) AS n FROM group_messages').get().n,0);assert.equal(backup.prepare('SELECT count(*) AS n FROM group_decisions').get().n,0);assert.equal(backup.prepare('SELECT summary FROM group_channels').get().summary,'');assert.match(backup.prepare('SELECT notes FROM profiles').get().notes,/米饭/);assert.ok(backup.prepare('SELECT count(*) AS n FROM group_calls').get().n>0);}finally{backup.close();}
});

test('旁听个人陈述可触发资料整理，输入只含该成员，来源和忘记排除重启保留',async t=>{
  const f=fixture(t,'observe');f.settings.value.limits.autoMemory=true;const learned=[];
  f.learner.client=()=>({complete:async messages=>{learned.push(JSON.parse(messages[1].content));return '{"notes":"- 喜欢米饭"}';}});
  f.service.handle(f.message('a1','我喜欢米饭'));f.service.handle(f.message('b1','我喜欢面条',{senderId:'b'}));await idle(f);await waitFor(()=>!f.learner.active&&!f.learner.queue.size);
  assert.deepEqual(learned[0].userStatements,['我喜欢米饭']);assert.deepEqual(learned[1].userStatements,['我喜欢面条']);
  const identity=userIdentity('group','g','a'),id=f.profiles.ensure(identity);
  assert.equal(f.profiles.get(id).sources[0].messageId,'a1');f.profiles.command(identity,'/忘记');const barrier=f.profiles.get(id).forgottenBefore;
  f.learner.observe(id,'新的闲聊',f.settings.groupRuntime('g'),[{text:'我喜欢米饭',at:barrier-1,messageId:'a1',groupId:'g'}],{force:true});await waitFor(()=>!f.learner.active&&!f.learner.queue.size);
  assert.equal(f.profiles.get(id).notes,'');assert.equal(learned.length,2);
  f.reopen();assert.equal(f.profiles.get(id).forgottenBefore,barrier);
  f.profiles.remove(id);f.reopen();assert.ok(f.profiles.get(f.profiles.ensure(identity)).forgottenBefore>=barrier);
});

test('群上下文字符上限包含摘要、资料和引用，旧消息不参与新回复',t=>{
  const f=fixture(t);f.settings.value.groupChat.maxContextChars=12000;f.store.discover('g');
  for(let i=0;i<50;i++)f.store.append('g',f.message('m-'+i,'中'.repeat(5000),{senderId:'member-'+i}));
  const payload=f.service.payload('g',{targetText:'中'.repeat(6000),memberNotes:'记'.repeat(4000),quotedMessage:{content:'引'.repeat(5000)}});
  assert.ok(payload.length<=12000);assert.ok(JSON.parse(payload).timeline.length<50);
  f.advance(1800001);assert.equal(f.service.timeline('g').length,0);
  f.settings.value.groupChat.maxContextChars=1000;
  assert.ok(f.service.payload('g',{targetText:'"\\\n'.repeat(3000),memberNotes:'旧'.repeat(4000)}).length<=1000);
  assert.ok(f.service.payload('g',{candidates:Array.from({length:30},(_,i)=>String(i)+'x'.repeat(148))}).length<=1000);
});

test('控制台群管理、手动整理、清空和静态页面入口可用，写接口仍需本机验证',async t=>{
  mkdirSync(resolve(projectRoot,'.cache/test'),{recursive:true});const root=mkdtempSync(resolve(projectRoot,'.cache/test/group-api-'));
  const panel=await createControlPanel({root,port:0});t.after(async()=>{await panel.close();rmSync(root,{recursive:true,force:true});});
  const call=async(path,method='GET',body)=>{const response=await fetch(panel.origin+path,{method,headers:{'x-local-token':panel.token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:response.status,data:await response.json()};};
  panel.settings.update({providers:panel.settings.public().providers.map(p=>({...p,apiKey:'fake-key'}))});
  assert.equal((await call('/api/groups')).data.stats.retentionHours,12);
  assert.equal((await call('/api/settings','PUT',{groupChat:{groups:{g:{mode:'observe'}}}})).status,200);
  panel.runtime.groups.discover('g',true);panel.runtime.groups.append('g',{messageId:'src',senderId:'a',content:'我喜欢米饭'});
  const id=panel.profiles.ensure(userIdentity('group','g','a'));panel.runtime.client=()=>({complete:async()=>'{"notes":"- 喜欢米饭"}'});
  assert.equal((await call('/api/profiles/'+id+'/learn','POST')).status,200);await waitFor(()=>panel.profiles.get(id).learnStatus==='saved');
  assert.equal((await call('/api/groups/g')).data.messages.length,1);
  assert.equal((await fetch(panel.origin+'/api/groups/g/clear',{method:'POST'})).status,403);
  assert.equal((await call('/api/groups/g/clear','POST')).status,200);assert.equal((await call('/api/groups/g')).data.messages.length,0);
  const html=await(await fetch(panel.origin)).text();assert.match(html,/groups\.js\?v=[a-f0-9]{12}/);assert.match(html,/id="page-groups"/);
  assert.equal((await fetch(panel.origin+'/groups.js')).status,200);
  const snapshot=(await call('/api/backup','POST')).data;assert.ok(readFileSync(resolve(root,snapshot.path,'settings.json'),'utf8').includes('43200000'));
});

test('上游未报告tokens时保持预留估算，报告真实用量后按实际数入账',async t=>{
  const f=fixture(t);const runtime=new BotRuntime(f.settings,f.memory);t.after(()=>runtime.stop());
  const original=global.fetch;let report=false;
  global.fetch=async()=>new Response(JSON.stringify({choices:[{message:{content:'答复'}}],...(report?{usage:{prompt_tokens:10,completion_tokens:5}}:{})}),{status:200,headers:{'content-type':'application/json'}});
  try{await runtime.client(f.settings.groupRuntime('g'),new AbortController().signal).complete([{role:'user',content:'问题'}]);const estimate=runtime.groups.usedToday();assert.ok(estimate>15);report=true;await runtime.client(f.settings.groupRuntime('g'),new AbortController().signal).complete([{role:'user',content:'问题'}]);assert.equal(runtime.groups.usedToday(),estimate+15);}finally{global.fetch=original;}
});

test('手动接话API需本机验证，返回真实发送结果，群详情解释不可用状态',async t=>{
  mkdirSync(resolve(projectRoot,'.cache/test'),{recursive:true});const root=mkdtempSync(resolve(projectRoot,'.cache/test/join-api-'));
  const panel=await createControlPanel({root,port:0}),sends=[];
  t.after(async()=>{panel.runtime.bot=null;panel.runtime.state='stopped';await panel.close();rmSync(root,{recursive:true,force:true});});
  panel.settings.update({providers:panel.settings.public().providers.map(p=>({...p,apiKey:'fake-key'})),limits:{autoMemory:false},groupChat:{groups:{g:{mode:'observe'}}}});
  panel.runtime.groups.discover('g');panel.runtime.groups.append('g',{messageId:'one',senderId:'a',content:'今天米饭真好吃'});
  const call=async(path,method='GET')=>{const response=await fetch(panel.origin+path,{method,headers:{'x-local-token':panel.token}});return{status:response.status,data:await response.json()};};
  assert.equal((await call('/api/groups/g')).data.participation.available,false);assert.equal((await call('/api/groups/g/join','POST')).status,400);
  panel.runtime.state='running';panel.runtime.bot={sendText:async(target,text)=>{sends.push({target,text});return{id:'manual-one'};}};
  panel.runtime.client=()=>({complete:async()=>'给鲸鲸留一碗嘛。'});
  assert.equal((await fetch(panel.origin+'/api/groups/g/join',{method:'POST'})).status,403);
  const result=await call('/api/groups/g/join','POST');assert.equal(result.status,200);assert.equal(result.data.sent,true);assert.equal(sends.length,1);
  assert.equal((await call('/api/groups/g/join','POST')).status,400);
  const detail=(await call('/api/groups/g')).data;assert.equal(detail.decisions[0].action,'manual_sent');assert.equal(detail.messages.at(-1).content,'给鲸鲸留一碗嘛。');
  const html=await(await fetch(panel.origin)).text();assert.match(html,/id="group-join"/);
});
