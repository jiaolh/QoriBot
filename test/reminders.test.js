import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { SettingsStore } from '../src/settings.js';
import { MemoryDatabase } from '../src/memory-db.js';
import { PluginManager } from '../src/plugins/manager.js';
import { ChatService } from '../src/chat-service.js';
import { ReminderStore } from '../plugins/reminders/store.js';
import { parseDuration, parseAbsolute, compileSchedule, nextOccurrence, formatTime } from '../plugins/reminders/time.js';
import { createControlPanel } from '../src/server.js';
import { projectRoot } from '../src/config.js';
import { DatabaseSync } from 'node:sqlite';
import { TargetCatalog } from '../src/plugins/targets.js';
const START=Date.parse('2026-10-06T08:00:00+08:00');
const silent={info(){},warn(){},error(){}};
function fixture(t){
  mkdirSync(resolve(projectRoot,'.cache/test'),{recursive:true});const root=mkdtempSync(resolve(projectRoot,'.cache/test/reminders-'));
  const settings=new SettingsStore(root);settings.update({providers:settings.public().providers.map(p=>({...p,apiKey:'fake-key'}))});
  let clock=START,connected=true,sender=async(target,text)=>{sends.push({target,text});return {id:'sent-'+sends.length};};
  const memory=new MemoryDatabase(resolve(root,'data/memory.sqlite'),()=>settings.value.limits),sends=[];
  const manager=new PluginManager({db:memory.db,settings,now:()=>clock,sendText:(...args)=>sender(...args),isConnected:()=>connected,log(){}}),plugin=manager.entries.get('reminders').instance;
  manager.targets.remember('c2c','private-one','测试用户');manager.targets.remember('group','group-one','测试群');
  t.after(async()=>{await manager.stop();memory.close();rmSync(root,{recursive:true,force:true});});
  return {root,settings,memory,manager,plugin,sends,advance(ms){clock+=ms;},get now(){return clock;},set connected(value){connected=value;},set sender(value){sender=value;},create(extra={},scope='c2c'){return plugin.create({timeType:'relative',when:'10秒',content:'喝水',...extra},{scope,targetId:scope==='c2c'?'private-one':'group-one',creatorId:'member-one',sourceId:extra.sourceId||'source-'+Math.random()});}};
}
test('预约时间显式采用北京时间，绝对和相对类型分开，中文时长和非法日期可验证',()=>{
  assert.equal(parseDuration('十分钟后'),600000);assert.equal(parseDuration('1小时30分钟'),5400000);assert.equal(parseDuration('一个半小时'),5400000);
  assert.equal(formatTime(parseAbsolute('明天下午三点半',START)),'2026-10-07 15:30:00');assert.equal(formatTime(parseAbsolute('07:00',START)),'2026-10-07 07:00:00');
  assert.equal(formatTime(parseAbsolute('2026-10-08 09:12',START)),'2026-10-08 09:12:00');
  assert.throws(()=>parseAbsolute('2026-02-30 12:00',START),/无效/);assert.throws(()=>parseAbsolute('今天07:00',START),/过去/);
  assert.throws(()=>parseDuration('-5分钟'),/相对时间/);assert.throws(()=>compileSchedule({timeType:'relative',when:'10秒',repeat:'interval',interval:'5秒'},START),/至少/);
});
test('日、周、月和固定间隔按原锚点重复，每月31日跳过短月且遵守结束时间',()=>{
  const interval=compileSchedule({timeType:'relative',when:'10分钟',repeat:'interval',interval:'10分钟'},START);
  assert.equal(nextOccurrence(interval,START+35*60000),START+40*60000);
  const monthly=compileSchedule({timeType:'absolute',when:'2026-10-31 08:00',repeat:'monthly'},START);
  assert.equal(formatTime(nextOccurrence(monthly,monthly.firstAt)),'2026-12-31 08:00:00');
  const daily=compileSchedule({timeType:'absolute',when:'明天08:00',repeat:'daily',endAt:'2026-10-08 08:00'},START);
  assert.equal(formatTime(nextOccurrence(daily,daily.firstAt)),'2026-10-08 08:00:00');assert.equal(nextOccurrence(daily,Date.parse('2026-10-08T08:00:00+08:00')),null);
});
test('插件时间参数覆盖相对、绝对和重复计划，工作日首条自动顺延周末',t=>{
  const f=fixture(t);
  for(const input of [{timeType:'relative',when:'十分钟后'},{timeType:'absolute',when:'明天下午三点半'},{timeType:'absolute',when:'明天08:00',repeat:'daily'},{timeType:'absolute',when:'2026-10-12 08:00',repeat:'weekly'},{timeType:'absolute',when:'2026-10-31 08:00',repeat:'monthly'},{timeType:'relative',when:'30分钟',repeat:'interval',interval:'30分钟'}])assert.ok(f.plugin.compile(input).firstAt>f.now);
  const saturday=Date.parse('2026-10-10T07:00:00+08:00'),schedule=compileSchedule({timeType:'absolute',when:'08:00',repeat:'workdays'},saturday);
  assert.equal(formatTime(schedule.firstAt),'2026-10-12 08:00:00');
});
test('同一来源预约幂等且保存原场景，QQ群员只能管理自己的当前聊天预约',t=>{
  const f=fixture(t),privateRow=f.create({sourceId:'one'}),same=f.create({sourceId:'one'}),groupRow=f.create({sourceId:'one'},'group');
  assert.equal(privateRow.id,same.id);assert.notEqual(privateRow.id,groupRow.id);assert.equal(f.plugin.store.list().total,2);
  assert.throws(()=>f.plugin.manage(groupRow.id,'cancel',undefined,{scope:'group',targetId:'group-one',creatorId:'someone-else'}),/只能管理/);
  assert.throws(()=>f.plugin.manage(groupRow.id,'cancel',undefined,{scope:'c2c',targetId:'private-one',creatorId:'member-one'}),/只能管理/);
  assert.equal(f.plugin.manage(groupRow.id,'delete',groupRow.revision,{scope:'group',targetId:'group-one',creatorId:'member-one'}).deleted,true);assert.throws(()=>f.plugin.store.get(groupRow.id),/不存在/);
});
test('到时私聊发到用户、群聊发到原群，不使用过期消息ID，成功后才记送达',async t=>{
  const f=fixture(t),one=f.create(),group=f.create({},'group');f.plugin.running=true;f.advance(11000);await f.plugin.tick();
  assert.equal(f.sends.length,2);assert.ok(f.sends.some(s=>s.target.scope==='c2c'&&s.target.targetId==='private-one'));assert.ok(f.sends.some(s=>s.target.scope==='group'&&s.target.targetId==='group-one'));
  assert.ok(f.sends.every(s=>s.target.msgId===undefined));assert.equal(f.plugin.store.get(one.id).state,'completed');assert.equal(f.plugin.store.get(group.id).sendCount,1);assert.equal(f.plugin.store.history(group.id)[0].state,'sent');
  await f.plugin.tick();assert.equal(f.sends.length,2);
});

test('回复窗口只保存当前目标的有效消息，忽略旧消息、自身消息和异常时间，重启保留且过期清理',t=>{
  const f=fixture(t),catalog=f.manager.targets;
  const message=(scope,targetId,messageId,at=f.now)=>({kind:scope,messageId,timestamp:new Date(at).toISOString(),replyTarget:{scope,targetId,msgId:messageId}});
  catalog.observe(message('c2c','private-one','private-latest'));
  catalog.observe(message('group','group-one','group-latest'));
  catalog.observe(message('c2c','private-two','other-user'));
  catalog.observe(message('c2c','private-one','older',f.now-1000));
  catalog.observe({...message('c2c','private-one','bot'),senderIsBot:true});
  catalog.observe(message('c2c','private-one','future',f.now+60001));
  catalog.observe({...message('c2c','private-one','no-time'),timestamp:''});
  catalog.observe({...message('c2c','private-one','wrong-target'),replyTarget:{scope:'group',targetId:'group-one',msgId:'wrong-target'}});
  assert.equal(catalog.replyTarget('c2c','private-one').msgId,'private-latest');
  assert.equal(catalog.replyTarget('c2c','private-two').msgId,'other-user');
  assert.equal(catalog.replyTarget('group','group-one').msgId,'group-latest');
  const reopened=new TargetCatalog(f.memory.db,f.settings,()=>f.now);
  assert.equal(reopened.replyTarget('c2c','private-one').msgId,'private-latest');
  f.advance(240000);
  assert.equal(reopened.replyTarget('group','group-one').msgId,undefined);
  assert.equal(reopened.replyTarget('c2c','private-one').msgId,'private-latest');
  f.advance(3300000);
  assert.equal(reopened.replyTarget('c2c','private-one').msgId,undefined);
  assert.ok(f.memory.db.prepare('SELECT reply_msg_id FROM plugin_targets').all().every(row=>!row.reply_msg_id));
});

test('旧目标表自动兼容新增回复窗口元数据，不改目标与预约记录',t=>{
  const f=fixture(t),db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec("CREATE TABLE plugin_targets(scope TEXT NOT NULL,target_id TEXT NOT NULL,label TEXT NOT NULL DEFAULT '',last_seen INTEGER NOT NULL,PRIMARY KEY(scope,target_id)); INSERT INTO plugin_targets VALUES('c2c','legacy-user','原备注',1)");
  const catalog=new TargetCatalog(db,f.settings,()=>f.now);
  assert.equal(catalog.get('c2c','legacy-user').label,'原备注');
  assert.deepEqual(catalog.replyTarget('c2c','legacy-user'),{scope:'c2c',targetId:'legacy-user'});
});

test('主动推送被平台关闭时，短时预约用有效对话回复；过期后不携带旧消息或自动重试',async t=>{
  const f=fixture(t),one=f.create(),group=f.create({},'group');
  for(const [scope,targetId,messageId] of [['c2c','private-one','private-request'],['group','group-one','group-request']])f.manager.targets.observe({kind:scope,messageId,timestamp:new Date(f.now).toISOString(),replyTarget:{scope,targetId,msgId:messageId}});
  let attempts=0;
  f.sender=async(target,text)=>{attempts++;f.sends.push({target,text});if(!target.msgId)throw Object.assign(new Error('platform private text'),{httpStatus:400,bizCode:40011033});return {id:'confirmed-'+attempts};};
  f.plugin.running=true;f.advance(11000);await f.plugin.tick();
  assert.equal(f.plugin.store.get(one.id).state,'completed');assert.equal(f.plugin.store.get(group.id).state,'completed');
  assert.deepEqual(new Set(f.sends.map(row=>row.target.msgId)),new Set(['private-request','group-request']));
  f.advance(3300000);const expired=f.create();f.advance(11000);await f.plugin.tick();
  const failed=f.plugin.store.get(expired.id);
  assert.equal(failed.state,'failed');assert.match(failed.lastError,/主动消息.*40011033/);assert.match(failed.lastError,/有效对话回复窗口/);assert.doesNotMatch(failed.lastError,/platform private/);
  assert.equal(f.sends.at(-1).target.msgId,undefined);assert.equal(failed.sendCount,0);
  await f.plugin.tick();assert.equal(attempts,3);
});

test('HTTP 0、服务器异常和没有消息回执保留结果未知，不记成功也不自动重试',async t=>{
  const f=fixture(t);f.plugin.running=true;
  for(const outcome of [Object.assign(new Error('network'),{httpStatus:0}),Object.assign(new Error('server'),{httpStatus:500}),null]){
    const row=f.create();let attempts=0;f.sender=async()=>{attempts++;if(outcome)throw outcome;return {};};
    f.advance(11000);await f.plugin.tick();
    assert.equal(f.plugin.store.get(row.id).state,'uncertain');assert.equal(f.plugin.store.get(row.id).sendCount,0);assert.equal(f.plugin.store.history(row.id)[0].state,'uncertain');
    await f.plugin.tick();assert.equal(attempts,1);
  }
});
test('离线等待、重复预约恢复只补一次，超过24小时的旧周期跳过并等将来的周期',async t=>{
  const f=fixture(t),row=f.create({when:'1分钟',repeat:'interval',interval:'1分钟'});f.plugin.running=true;f.connected=false;f.advance(10*60000);await f.plugin.tick();assert.equal(f.sends.length,0);
  f.connected=true;await f.plugin.tick();assert.equal(f.sends.length,1);assert.equal(f.plugin.store.get(row.id).nextAt,START+11*60000);
  f.advance(2*86400000);await f.plugin.tick();assert.equal(f.sends.length,1);assert.ok(f.plugin.store.get(row.id).nextAt>f.now);
  const once=f.create();f.advance(2*86400000);await f.plugin.tick();assert.equal(f.plugin.store.get(once.id).state,'missed');
});
test('重复tick不重发，发送期间不能编辑，暂停和取消阻止到时发送',async t=>{
  const f=fixture(t),row=f.create(),paused=f.create(),cancelled=f.create();f.plugin.manage(paused.id,'pause');f.plugin.manage(cancelled.id,'cancel');f.plugin.running=true;f.advance(11000);
  let release;f.sender=async(target,text)=>{f.sends.push({target,text});return new Promise(resolve=>{release=resolve;});};
  const first=f.plugin.tick(),second=f.plugin.tick();assert.equal(first,second);assert.equal(f.plugin.activeRequests,1);assert.throws(()=>f.plugin.manage(row.id,'pause'),/正在发送/);
  assert.throws(()=>f.plugin.manage(row.id,'delete',row.revision),/正在发送/);
  release({id:'confirmed'});await first;assert.equal(f.sends.length,1);assert.equal(f.plugin.store.get(paused.id).state,'paused');
});

test('删除移除预约及全部发送记录，保护版本和其他预约，并阻止重放原创建事件',async t=>{
  const f=fixture(t),row=f.create({sourceId:'delete-source',content:'应被删除的测试事项'}),other=f.create({sourceId:'keep-source'});
  f.plugin.running=true;f.advance(11000);await f.plugin.tick();
  const completed=f.plugin.store.get(row.id);assert.equal(f.plugin.store.history(row.id).length,1);
  assert.throws(()=>f.plugin.manage(row.id,'delete',completed.revision-1),/刷新/);
  const deleted=f.plugin.manage(row.id,'delete',completed.revision);
  assert.equal(deleted.deleted,true);assert.equal(deleted.nextAt,null);
  assert.throws(()=>f.plugin.store.get(row.id),/不存在/);
  assert.equal(f.memory.db.prepare('SELECT count(*) AS n FROM plugin_reminder_deliveries WHERE task_id=?').get(row.id).n,0);
  assert.equal(f.plugin.store.get(other.id).state,'completed');assert.equal(f.plugin.store.history(other.id).length,1);
  assert.throws(()=>f.create({sourceId:'delete-source'}),/已被删除/);
  const reopened=new ReminderStore(f.memory.db,()=>f.now);
  assert.throws(()=>reopened.source('c2c','private-one','delete-source'),/已被删除/);
  assert.ok(f.create({sourceId:'new-request'}).id);
  assert.equal(f.plugin.store.list().total,2);
});
test('平台拒绝和结果未知分别落盘，停止重试；编辑使用版本防止旧表单覆盖新数据',async t=>{
  const f=fixture(t),row=f.create();f.plugin.running=true;f.advance(11000);f.sender=async()=>{throw Object.assign(new Error('private upstream'),{httpStatus:403,bizCode:22009});};
  await f.plugin.tick();assert.equal(f.plugin.store.get(row.id).state,'failed');assert.equal(f.plugin.store.get(row.id).sendCount,0);assert.match(f.plugin.store.get(row.id).lastError,/22009/);assert.doesNotMatch(f.plugin.store.get(row.id).lastError,/private/);
  f.plugin.manage(row.id,'resume');f.advance(1001);f.sender=async()=>{throw new Error('connection lost');};await f.plugin.tick();assert.equal(f.plugin.store.get(row.id).state,'uncertain');
  const current=f.plugin.store.get(row.id);f.plugin.store.update(row.id,{state:'paused'},current.revision);assert.throws(()=>f.plugin.store.update(row.id,{content:'旧编辑'},current.revision),/刷新/);
});
test('重启发送中的预约被标成未知；关闭插件后模型不可获得执行工具，普通聊天保持可用',async t=>{
  const f=fixture(t),row=f.create();f.plugin.store.claim(row);
  const reopened=new ReminderStore(f.memory.db,()=>f.now);assert.equal(reopened.get(row.id).state,'uncertain');assert.equal(reopened.history(row.id)[0].state,'uncertain');
  await f.manager.setEnabled('reminders',false);let modelCalls=0;const replies=[];
  const chat=new ChatService({config:f.settings.runtime({requireQQ:false}),llm:{complete:async()=>{modelCalls++;return '未预约';}},logger:silent,now:()=>f.now,send:async(target,text)=>{replies.push(text);},plugins:f.manager});
  const message={kind:'c2c',messageId:'request',senderId:'private-one',content:'十分钟后提醒我喝水',replyTarget:{scope:'c2c',targetId:'private-one',msgId:'request'},timestamp:new Date(f.now).toISOString()};
  assert.equal(f.manager.toolSession(message).tools.length,0);await chat.handle(message);assert.equal(modelCalls,1);assert.match(replies[0],/未预约/);
  await f.manager.setEnabled('reminders',true);f.advance(f.settings.value.limits.cooldownMs+1);message.messageId='request-two';message.replyTarget.msgId='request-two';assert.equal(f.manager.toolSession(message).tools.length,4);await chat.handle(message);await chat.handle(message);assert.equal(modelCalls,2);assert.equal(replies.length,2);assert.equal(f.plugin.store.list().total,1,'没有真实工具调用就不能创建预约');
});
test('控制台支持插件开关、管理预约、发送记录和本机验证；原文保留时间确实可保存',async t=>{
  mkdirSync(resolve(projectRoot,'.cache/test'),{recursive:true});const root=mkdtempSync(resolve(projectRoot,'.cache/test/reminder-api-'));
  const panel=await createControlPanel({root,port:0});t.after(async()=>{await panel.close();rmSync(root,{recursive:true,force:true});});
  panel.runtime.plugins.targets.remember('c2c','test-private');panel.runtime.plugins.targets.remember('group','test-group');
  const call=async(path,method='GET',body)=>{const response=await fetch(panel.origin+path,{method,headers:{'Content-Type':'application/json','X-Local-Token':panel.token},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};};
  const payload={scope:'group',targetId:'test-group',timeType:'relative',when:'10分钟',content:'开会',requestId:'ui-first'};
  assert.equal((await fetch(panel.origin+'/api/plugins/reminders/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})).status,403);
  const created=await call('/api/plugins/reminders/tasks','POST',payload);assert.equal(created.status,200);assert.equal((await call('/api/plugins/reminders/tasks','POST',payload)).data.id,created.data.id);
  assert.equal((await call('/api/plugins/reminders/tasks/'+created.data.id+'/pause','POST',{revision:created.data.revision})).data.state,'paused');
  const edited=await call('/api/plugins/reminders/tasks/'+created.data.id,'PATCH',{...payload,when:'20分钟',content:'新提醒',revision:1});assert.equal(edited.data.state,'paused');
  assert.equal((await call('/api/plugins/reminders/tasks/'+created.data.id+'/resume','POST',{revision:edited.data.revision})).data.state,'active');
  assert.deepEqual((await call('/api/plugins/reminders/tasks/'+created.data.id)).data.deliveries,[]);
  await call('/api/plugins/reminders/enabled','POST',{enabled:false});assert.equal((await call('/api/plugins/reminders/tasks','POST',{...payload,requestId:'two'})).status,400);
  assert.equal((await call('/api/plugins/reminders/tasks/'+created.data.id,'DELETE')).status,400,'删除必须带当前版本');
  assert.equal((await call('/api/plugins/reminders/tasks/'+created.data.id,'DELETE',{revision:0})).status,400,'旧版本不能删除');
  assert.equal((await call('/api/plugins/reminders/tasks/'+created.data.id,'DELETE',{revision:edited.data.revision+1})).data.deleted,true);
  assert.equal((await call('/api/plugins/reminders/tasks/'+created.data.id)).status,400);
  assert.equal((await call('/api/plugins/reminders/tasks')).data.total,0);
  const changed=await call('/api/settings','PUT',{groupChat:{messageTtlMs:24*3600000}});assert.equal(changed.data.groupChat.messageTtlMs,24*3600000);assert.equal((await call('/api/groups')).data.stats.retentionHours,24);
  assert.equal((await call('/api/settings','PUT',{groupChat:{messageTtlMs:169*3600000}})).status,400);
  const html=await(await fetch(panel.origin)).text();assert.match(html,/QoriBot/);assert.match(html,/group-retention-hours/);assert.match(html,/page-reminders/);assert.doesNotMatch(html,/__PLUGIN_/);
  assert.match(html,/插件管理/);assert.doesNotMatch(html,/class="nav-item" data-page="reminders"/);
  assert.equal((await fetch(panel.origin+'/plugins/reminders.js')).status,200);
});
