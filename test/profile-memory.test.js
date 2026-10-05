import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { projectRoot } from '../src/config.js';
import { SettingsStore } from '../src/settings.js';
import { MemoryDatabase } from '../src/memory-db.js';
import { ProfileMemory, LOCAL_USER, userIdentity } from '../src/profile-memory.js';
import { MemoryLearner } from '../src/memory-learner.js';
import { BotRuntime, connectionError } from '../src/runtime.js';
import { createControlPanel } from '../src/server.js';

function fixture(t) {
  mkdirSync(resolve(projectRoot,'.cache/test'),{recursive:true});
  const root=mkdtempSync(resolve(projectRoot,'.cache/test/profile-'));
  const settings=new SettingsStore(root);
  settings.update({providers:settings.public().providers.map(p=>({...p,apiKey:'fake-key'})),limits:{autoMemory:false}});
  const path=resolve(root,'data/memory.sqlite');
  let memory=new MemoryDatabase(path,()=>settings.value.limits);
  let profiles=new ProfileMemory(memory,()=>settings.value.limits);
  const stops=[];
  t.after(async()=>{for(const stop of stops)await stop();memory.close();rmSync(root,{recursive:true,force:true});});
  return {root,settings,stops,get memory(){return memory;},get profiles(){return profiles;},
    reopen(){memory.close();memory=new MemoryDatabase(path,()=>settings.value.limits);profiles=new ProfileMemory(memory,()=>settings.value.limits);}};
}
async function waitFor(condition) {
  const end=Date.now()+4000;
  while(!condition()){if(Date.now()>end)throw new Error('本地测试等待超时');await delay(2);}
}
async function idle(learner){await delay(0);await waitFor(()=>!learner.active&&!learner.queue.size);}
function learner(f,client,canRun=()=>true){
  f.settings.value.limits.autoMemory=true;
  const logs=[];
  const value=new MemoryLearner(f.profiles,{client,canRun,limits:()=>f.settings.value.limits,log:(...args)=>logs.push(args)});
  f.stops.push(()=>value.stop());return {value,logs};
}

test('长期资料可编辑 Markdown、重启保留，独立于近期对话过期并隔离聊天场景',t=>{
  const f=fixture(t),id=f.profiles.ensure(LOCAL_USER);
  f.profiles.edit(id,{notes:'- 喜欢简洁的中文回答',alias:'本人'});
  assert.equal(readFileSync(f.profiles.path(id),'utf8'),'- 喜欢简洁的中文回答');
  f.memory.commit('old','临时问题','回答');
  f.memory.db.prepare('UPDATE sessions SET updated_at=0').run();f.memory.prune(true);
  assert.deepEqual(f.memory.history('old'),[]);
  f.reopen();assert.equal(f.profiles.get(id).notes,'- 喜欢简洁的中文回答');
  writeFileSync(f.profiles.path(id),'- 我的职业是工程师');
  const now=new Date(Date.now()+1000);utimesSync(f.profiles.path(id),now,now);
  assert.equal(f.profiles.notes(LOCAL_USER).notes,'- 我的职业是工程师');
  f.reopen();assert.equal(f.profiles.get(id).alias,'本人');assert.match(f.profiles.get(id).notes,/工程师/);
  for(const identity of [userIdentity('c2c','u','u'),userIdentity('group','g1','u'),userIdentity('group','g2','u')]) {
    assert.equal(f.profiles.notes(identity).notes,'');assert.notEqual(f.profiles.ensure(identity),id);
  }
  f.profiles.edit(id,{enabled:false});assert.equal(f.profiles.notes(LOCAL_USER).notes,'');
  assert.match(f.profiles.get(id).notes,/工程师/);
});

test('长期资料限制按字符与字节生效，旧版本整理不能覆盖手动修改',t=>{
  const f=fixture(t),id=f.profiles.ensure(LOCAL_USER);
  const revision=f.profiles.get(id).revision;
  f.profiles.edit(id,{notes:'手动保存'});
  assert.equal(f.profiles.edit(id,{notes:'旧整理结果'},{expectedRevision:revision}),false);
  assert.throws(()=>f.profiles.edit(id,{notes:'字'.repeat(4001)}),/最多/);
  f.settings.value.limits.maxProfileBytes=20;
  assert.throws(()=>f.profiles.edit(id,{notes:'字'.repeat(10)}),/容量/);
  assert.equal(f.profiles.get(id).notes,'手动保存');
  f.settings.value.limits.maxSessions=1;
  assert.throws(()=>f.profiles.ensure(userIdentity('c2c','other','other')),/上限/);
  assert.throws(()=>f.profiles.path('../../outside'),/标识/);
});

test('本机对话保存上下文、长期资料跨提示词与重启复用，记忆指令不额外调用模型',async t=>{
  const f=fixture(t);let runtime=new BotRuntime(f.settings,f.memory);const calls=[];
  const client=()=>({complete:async messages=>{calls.push(messages);return '模拟回答';}});
  runtime.client=client;f.stops.push(()=>runtime.stop());
  await runtime.testChat('/记住 我偏好中文和简洁的说明');assert.equal(calls.length,0);
  await runtime.testChat('第一条问题');await runtime.testChat('继续');
  assert.equal(calls[1].length,4);assert.match(calls[1][0].content,/偏好中文/);
  const id=f.profiles.ensure(LOCAL_USER);
  f.settings.update({activePromptId:'coding'});await runtime.testChat('编程问题');
  assert.equal(calls[2].length,2);assert.match(calls[2][0].content,/偏好中文/);
  await runtime.stop();f.reopen();runtime=new BotRuntime(f.settings,f.memory);runtime.client=client;
  await runtime.testChat('下一条');assert.equal(calls[3].length,4);assert.match(calls[3][0].content,/偏好中文/);
  await runtime.testChat('/reset');await runtime.testChat('新问题');assert.equal(calls[4].length,2);
  assert.match(calls[4][0].content,/偏好中文/);
  await runtime.testChat('/忘记');assert.equal(f.profiles.get(id).notes,'');assert.equal(calls.length,5);
  f.settings.value.limits.maxSessions=1;
  f.profiles.remove(id);f.profiles.ensure(userIdentity('group','g','another'));
  await runtime.testChat('容量满仍能聊天');assert.equal(calls.length,6);
});

test('自动整理仅接收用户陈述，关闭搜索并限制调用，坏结果保留原资料',async t=>{
  const f=fixture(t),id=f.profiles.ensure(LOCAL_USER);f.profiles.edit(id,{notes:'- 原有背景'});
  const calls=[];let answer='{"notes":"- 原有背景\\n- 喜欢中文"}';
  const {value}=learner(f,(config,signal)=>({complete:async messages=>{calls.push({config,messages,signal});return answer;}}));
  value.observe(id,'我喜欢中文',f.settings.runtime({requireQQ:false}),['我喜欢中文']);await idle(value);
  assert.match(f.profiles.get(id).notes,/喜欢中文/);assert.equal(calls[0].config.llm.webSearch,false);
  assert.equal(calls[0].config.llm.maxTokens,1024);assert.equal(calls[0].config.llm.timeoutMs,20000);
  assert.deepEqual(JSON.parse(calls[0].messages[1].content).userStatements,['我喜欢中文']);
  answer='不是 JSON';value.observe(id,'我习惯简洁',f.settings.runtime({requireQQ:false}));await idle(value);
  assert.match(f.profiles.get(id).notes,/喜欢中文/);
  answer='{"notes":null}';value.observe(id,'我习惯简洁',f.settings.runtime({requireQQ:false}));await idle(value);
  assert.match(f.profiles.get(id).notes,/喜欢中文/);
  f.profiles.edit(id,{autoLearn:false});value.observe(id,'我叫测试',f.settings.runtime({requireQQ:false}));await idle(value);
  assert.equal(calls.length,3);
});

test('普通群聊每位用户累计五轮再整理，没有新事实时资料仍为空',async t=>{
  const f=fixture(t),a=f.profiles.ensure(userIdentity('group','test-group','member-a'));
  const b=f.profiles.ensure(userIdentity('group','test-group','member-b'));
  const calls=[];
  const {value}=learner(f,()=>({complete:async messages=>{calls.push(messages);return '{"notes":null}';}}));
  const config=f.settings.runtime({requireQQ:false});
  for(let i=0;i<4;i++) value.observe(a,'今天这道题怎么做？',config);
  for(let i=0;i<2;i++) value.observe(b,'你好呀',config);
  await idle(value);assert.equal(calls.length,0);
  value.observe(a,'继续说说',config);await idle(value);
  assert.equal(calls.length,1);assert.equal(f.profiles.get(a).notes,'');
  assert.equal(f.profiles.get(a).pendingTurns,0);assert.equal(f.profiles.get(b).pendingTurns,2);
  f.reopen();assert.equal(f.profiles.get(a).notes,'');assert.equal(f.profiles.get(b).pendingTurns,2);
});

test('自动整理不能覆盖期间的文件编辑或恢复已忘记的资料',async t=>{
  const f=fixture(t),id=f.profiles.ensure(LOCAL_USER);let release;
  const {value}=learner(f,()=>({complete:()=>new Promise(resolve=>{release=resolve;})}));
  const config=f.settings.runtime({requireQQ:false});
  value.observe(id,'我喜欢散步',config);await waitFor(()=>release);
  f.profiles.edit(id,{notes:'- 我喜欢写作'});release('{"notes":"- 我喜欢散步"}');await idle(value);
  assert.equal(f.profiles.get(id).notes,'- 我喜欢写作');
  release=null;value.observe(id,'我喜欢散步',config);await waitFor(()=>release);
  writeFileSync(f.profiles.path(id),'- 外部编辑');const now=new Date(Date.now()+2000);utimesSync(f.profiles.path(id),now,now);
  release('{"notes":"- 我喜欢散步"}');await idle(value);assert.equal(f.profiles.get(id).notes,'- 外部编辑');
  release=null;value.observe(id,'我喜欢散步',config);await waitFor(()=>release);
  value.cancel(id);f.profiles.command(LOCAL_USER,'/忘记');release('{"notes":"- 我喜欢散步"}');await idle(value);
  assert.equal(f.profiles.get(id).notes,'');
});

test('整理任务遵守并发、队列上限，停止时取消调用并清空队列',async t=>{
  const f=fixture(t);let allowed=false,active=0,maxActive=0;
  const {value,logs}=learner(f,(_config,signal)=>({complete:()=>new Promise((_resolve,reject)=>{
    active++;maxActive=Math.max(maxActive,active);
    signal.addEventListener('abort',()=>{active--;reject(new Error('aborted'));},{once:true});
  })}),()=>allowed);
  const config=f.settings.runtime({requireQQ:false});
  for(let i=0;i<40;i++) value.observe(f.profiles.ensure(userIdentity('c2c',String(i),String(i))),'我喜欢中文',config);
  await delay(0);assert.equal(value.queue.size,16);assert.equal(active,0);
  allowed=true;value.pump();await waitFor(()=>active===1);value.pump();await delay(0);assert.equal(maxActive,1);
  const warnings=logs.length;await value.stop();assert.equal(value.queue.size,0);assert.equal(value.activeRequests,0);assert.equal(active,0);
  assert.equal(logs.length,warnings,'主动停止不应记录失败警告');
});

test('本机实际对话触发自动长期资料，机器人回答内容不参与整理',async t=>{
  const f=fixture(t);f.settings.value.limits.autoMemory=true;const runtime=new BotRuntime(f.settings,f.memory);
  f.stops.push(()=>runtime.stop());const calls=[];
  runtime.client=(config)=>({complete:async messages=>{
    calls.push({config,messages});return config.llm.temperature===0?' {"notes":"- 希望使用中文"} ':'机器人推测的个人资料';
  }});
  await runtime.testChat('我喜欢用中文交流');await idle(runtime.learner);
  assert.equal(calls.length,2);assert.match(runtime.profiles.notes(LOCAL_USER).notes,/使用中文/);
  const source=JSON.parse(calls[1].messages[1].content);
  assert.deepEqual(source.userStatements,['我喜欢用中文交流']);assert.ok(!JSON.stringify(source).includes('推测'));
});

test('长期资料管理接口、导出和备份完整，静态资源随修改更新版本',async t=>{
  mkdirSync(resolve(projectRoot,'.cache/test'),{recursive:true});const root=mkdtempSync(resolve(projectRoot,'.cache/test/profile-api-'));
  const panel=await createControlPanel({root,port:0});
  t.after(async()=>{await panel.close();rmSync(root,{recursive:true,force:true});});
  const call=async(path,method='GET',body)=>{
    const res=await fetch(panel.origin+path,{method,headers:{'x-local-token':panel.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:res.status,data:await res.json()};
  };
  const local=(await call('/api/profiles/local','POST')).data;
  assert.equal((await call('/api/profiles/'+local.id,'PATCH',{notes:'- 喜欢简洁',alias:'本机用户'})).status,200);
  const row=(await call('/api/profiles?q=本机')).data.rows[0];assert.match(row.preview,/简洁/);
  const exported=(await call('/api/profiles/'+local.id+'/export','POST')).data;
  assert.equal(readFileSync(resolve(root,exported.path),'utf8'),'- 喜欢简洁');
  const backup=(await call('/api/backup','POST')).data;
  assert.ok(existsSync(resolve(root,backup.path,'memory.sqlite')));
  assert.equal(readFileSync(resolve(root,backup.path,'users',local.id,'memory.md'),'utf8'),'- 喜欢简洁');
  panel.runtime.activeTests=1;assert.equal((await call('/api/profiles/'+local.id,'PATCH',{notes:''})).status,400);panel.runtime.activeTests=0;
  assert.equal((await call('/api/profiles/'+local.id,'DELETE')).status,200);assert.equal(panel.profiles.stats().users,0);
  const html=await(await fetch(panel.origin)).text();assert.match(html,/profiles\.js\?v=[a-f0-9]{12}/);
  assert.equal((await fetch(panel.origin+'/profiles.js')).status,200);
});

test('失败连接保留可读错误，五秒内不重复创建实例，初始化异常不留下启动状态',async t=>{
  const f=fixture(t);f.settings.value.qq.appId='fake-id';f.settings.value.qq.appSecret='fake-secret';
  const originalFetch=global.fetch;let fetches=0,now=Date.now();
  global.fetch=async()=>{fetches++;throw new TypeError('fetch failed',{cause:Object.assign(new Error('blocked'),{code:'EACCES'})});};
  const runtime=new BotRuntime(f.settings,f.memory,{now:()=>now});
  try {
    runtime.start();await runtime.running;assert.equal(runtime.state,'error');assert.match(runtime.lastError,/EACCES/);
    assert.equal(runtime.bot,null);assert.throws(()=>runtime.start(),/秒再重试/);assert.equal(fetches,1);
    now+=5001;runtime.start();await runtime.running;assert.equal(fetches,2);
    await runtime.stop();assert.equal(runtime.state,'stopped');
    assert.match(connectionError({message:'failed',cause:{code:'ENOTFOUND'}}),/DNS/);
    assert.match(connectionError({message:'HTTP 403'}),/权限/);
  } finally {global.fetch=originalFetch;await runtime.stop();}
  const broken=new BotRuntime(f.settings,f.memory,{botFactory(){throw new Error('初始化失败');}});
  assert.throws(()=>broken.start(),/初始化失败/);assert.equal(broken.state,'error');assert.equal(broken.shutdown,null);
  await broken.stop();
});
