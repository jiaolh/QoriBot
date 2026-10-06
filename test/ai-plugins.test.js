import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {SettingsStore} from '../src/settings.js';
import {MemoryDatabase} from '../src/memory-db.js';
import {PluginManager} from '../src/plugins/manager.js';
import {ChatService} from '../src/chat-service.js';
import {LLMClient} from '../src/llm.js';
import {createControlPanel} from '../src/server.js';
const START=Date.parse('2026-10-06T08:00:00+08:00');
const config={protocol:'openai',apiKey:'fake-key',baseUrl:'https://fixture.invalid',model:'test-model',maxTokens:512,timeoutMs:1000};
const quiet={info(){},warn(){},error(){}};
const call=(name,args,id='call-one')=>({choices:[{message:{content:null,tool_calls:[{id,type:'function',function:{name,arguments:typeof args==='string'?args:JSON.stringify(args)}}]}}],usage:{prompt_tokens:30,completion_tokens:10}});
const answer=text=>({choices:[{message:{content:text}}],usage:{prompt_tokens:40,completion_tokens:15}});
function setup(t){
  const base=resolve('.cache/test');mkdirSync(base,{recursive:true});const root=mkdtempSync(resolve(base,'ai-plugins-'));
  const settings=new SettingsStore(root),memory=new MemoryDatabase(resolve(root,'data/memory.sqlite'),()=>settings.value.limits);let now=START;
  const manager=new PluginManager({db:memory.db,settings,now:()=>now,sendText:async()=>{throw new Error('test must not send QQ');},isConnected:()=>false,log(){}});
  const plugin=manager.entries.get('reminders').instance;const message=(content,scope='c2c',id='message-one',senderId='member-one')=>({kind:scope,messageId:id,senderId,content,timestamp:new Date(now).toISOString(),rawEventType:scope==='group'?'GROUP_AT_MESSAGE_CREATE':'C2C_MESSAGE_CREATE',replyTarget:{scope,targetId:scope==='group'?'group-one':'private-one',msgId:id}});
  t.after(async()=>{await manager.stop();memory.close();rmSync(root,{recursive:true,force:true});});
  return {settings,memory,manager,plugin,message,advance(ms){now+=ms;},create(senderId='member-one',scope='c2c',sourceId='original'){const m=message('',scope,sourceId,senderId);manager.targets.observe(m);return plugin.create({timeType:'relative',when:'10分钟',content:'喝水'},{scope,targetId:m.replyTarget.targetId,creatorId:senderId,sourceId});}};
}
test('自然表达由模型选择插件，工具结果回传模型；重复入站事件不重复创建',async t=>{
  const f=setup(t),requests=[],replies=[];const client=new LLMClient(config,{fetchImpl:async(_url,options)=>{
    const body=JSON.parse(options.body);requests.push(body);
    return Response.json(requests.length===1?call('reminders_create',{timeType:'relative',when:'15分钟',content:'喝水'}):answer('好嘛，十五分钟后叫你喝水捏。'));
  }});
  const chat=new ChatService({config:{chat:{...f.settings.value.limits,systemPrompt:'保持小鲸娘语气。'}},llm:client,plugins:f.manager,now:()=>START,logger:quiet,send:async(_target,text)=>replies.push(text)});
  const message=f.message('过一刻钟拍我一下，我那杯水还没喝');await chat.handle(message);await chat.handle(message);
  assert.equal(requests.length,2);assert.equal(requests[0].tool_choice,'auto');assert.equal(requests[0].tools.length,4);assert.equal(requests[1].messages.at(-1).role,'tool');
  const result=JSON.parse(requests[1].messages.at(-1).content);assert.equal(result.ok,true);assert.equal(result.reminder.nextTime,'2026-10-06 08:15:00');assert.equal(result.reminder.target,'当前私聊');
  assert.equal(f.plugin.store.list().total,1);assert.equal(f.plugin.store.list().rows[0].creatorId,'member-one');assert.match(replies[0],/捏/);assert.equal(replies.length,1);
});
test('普通聊天和时间含糊的追问不调用插件；关闭后仅提供不可执行的说明',async t=>{
  const f=setup(t);let executed=0;const session=f.manager.toolSession(f.message('今天好累呀'));
  const execute=session.execute;session.execute=(...args)=>{executed++;return execute(...args);};
  const client=new LLMClient(config,{fetchImpl:async()=>Response.json(answer('那先歇会儿嘛。'))});
  assert.match(await client.complete([{role:'user',content:'今天好累呀'}],session),/歇会/);assert.equal(executed,0);
  client.fetchImpl=async()=>Response.json(answer('主人想几点提醒呀？'));await client.complete([{role:'user',content:'以后提醒我交费'}],session);assert.equal(f.plugin.store.list().total,0);
  await f.manager.setEnabled('reminders',false);const disabled=f.manager.toolSession(f.message('提醒我喝水'));assert.equal(disabled.tools.length,0);assert.match(disabled.system,/不能.*创建/);
});
test('工具固定原群和原发言者；查询、编辑和取消不能串成员或串聊天',async t=>{
  const f=setup(t),own=f.create('member-one','group'),other=f.create('member-two','group','other'),privateRow=f.create('member-one','c2c','private');
  const session=f.manager.toolSession(f.message('把我的喝水提醒改成20分钟后','group'));
  const list=await session.execute('reminders_list',{});assert.deepEqual(list.reminders.map(r=>r.id),[own.id]);
  for(const row of [other,privateRow])assert.equal((await session.execute('reminders_change',{id:row.id,revision:row.revision,action:'cancel'})).ok,false);
  assert.equal((await session.execute('reminders_create',{scope:'c2c',targetId:'someone-else',timeType:'relative',when:'10分钟',content:'错误目标'})).ok,false);
  const edited=await session.execute('reminders_update',{id:own.id,revision:own.revision,timeType:'relative',when:'20分钟',content:'吃药'});assert.equal(edited.reminder.nextTime,'2026-10-06 08:20:00');
  assert.equal((await session.execute('reminders_change',{id:own.id,revision:0,action:'cancel'})).ok,false);
  assert.equal((await session.execute('reminders_change',{id:own.id,revision:edited.reminder.revision,action:'delete'})).reminder.deleted,true);
  assert.throws(()=>f.plugin.store.get(own.id),/不存在/);
  assert.equal(f.plugin.store.get(other.id).state,'active');assert.equal(f.plugin.store.get(privateRow.id).state,'active');
});
test('修改提醒文字保留时间和状态；未知发送结果未经确认不能恢复',async t=>{
  const f=setup(t),row=f.create();f.plugin.store.update(row.id,{state:'uncertain',nextAt:null,lastError:'结果未知'});
  const session=f.manager.toolSession(f.message('改一下内容')),current=f.plugin.store.get(row.id);
  const result=await session.execute('reminders_update',{id:row.id,revision:current.revision,content:'换一个内容'});assert.equal(result.reminder.state,'uncertain');assert.equal(result.reminder.nextTime,null);
  assert.equal((await session.execute('reminders_change',{id:row.id,revision:result.reminder.revision,action:'resume'})).ok,false);
  assert.equal((await session.execute('reminders_change',{id:row.id,revision:result.reminder.revision,action:'resume',confirmedNotReceived:true})).reminder.state,'active');
});
test('模型参数无效、未知工具和群消息过期均不产生预约',async t=>{
  const f=setup(t),session=f.manager.toolSession(f.message('随便哪天提醒','group'),{canExecute:()=>false});let i=0;
  const responses=[call('reminders_create','{broken'),call('reminders_create',{timeType:'relative',when:'10分钟',content:'喝水'}),answer('这次没有预约成功。')];
  const client=new LLMClient(config,{fetchImpl:async()=>Response.json(responses[i++])});assert.match(await client.complete([],session),/没有预约/);assert.equal(f.plugin.store.list().total,0);
  assert.equal((await session.execute('unknown_tool',{})).ok,false);
});
test('已经保存后模型网络失败，以真实结果确认；重复工具调用只执行一次',async t=>{
  const f=setup(t),session=f.manager.toolSession(f.message('十分钟后提醒我喝水'));let i=0;
  const client=new LLMClient(config,{fetchImpl:async()=>{if(i++<2)return Response.json(call('reminders_create',{timeType:'relative',when:'10分钟',content:'喝水'},'call-'+i));throw new Error('network gone');}});
  const text=await client.complete([],session),rows=f.plugin.store.list().rows;assert.equal(rows.length,1);assert.ok(text.includes(rows[0].id));assert.match(text,/已保存/);
  const replay=f.manager.toolSession(f.message('十分钟后提醒我喝水'));assert.equal((await replay.execute('reminders_create',{timeType:'relative',when:'10分钟',content:'喝水'})).reminder.id,rows[0].id);
});
test('Anthropic 工具调用原样回传tool_use和tool_result，不把搜索结果当成预约',async t=>{
  const f=setup(t),requests=[];const client=new LLMClient({...config,protocol:'anthropic'},{fetchImpl:async(_url,options)=>{
    const body=JSON.parse(options.body);requests.push(body);return Response.json({id:'msg-'+requests.length,type:'message',role:'assistant',model:'test-model',stop_reason:requests.length===1?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:20,output_tokens:10},content:requests.length===1?[{type:'tool_use',id:'call-anthropic',name:'reminders_create',input:{timeType:'absolute',when:'明天08:00',repeat:'daily',content:'起床'}}]:[{type:'text',text:'每天八点叫你起床捏。'}]});
  }});
  assert.match(await client.complete([{role:'system',content:'小鲸娘'},{role:'user',content:'每天八点叫我起床'}],f.manager.toolSession(f.message('每天八点叫我起床'))),/捏/);
  assert.equal(requests.length,2);assert.equal(requests[0].tool_choice.type,'auto');assert.equal(requests[1].messages.at(-1).content[0].type,'tool_result');assert.equal(f.plugin.store.list().rows[0].schedule.repeat,'daily');
});
test('每轮工具模型请求独立记预算，后续预算不足不会撤销已保存预约或虚报失败',async t=>{
  const base=resolve('.cache/test');mkdirSync(base,{recursive:true});const root=mkdtempSync(resolve(base,'ai-budget-')),panel=await createControlPanel({root,port:0});
  t.after(async()=>{await panel.close();rmSync(root,{recursive:true,force:true});});
  panel.settings.update({providers:panel.settings.public().providers.map(p=>({...p,apiKey:'fake-key'})),groupChat:{dailyTokenLimit:100000}});
  const message={kind:'c2c',messageId:'budget',senderId:'member-one',timestamp:new Date().toISOString(),replyTarget:{scope:'c2c',targetId:'member-one',msgId:'budget'}};
  const client=panel.runtime.client(panel.settings.runtime({requireQQ:false}));let requests=0;
  client.fetchImpl=async()=>{requests++;const data=call('reminders_create',{timeType:'relative',when:'10分钟',content:'喝水'});data.usage={prompt_tokens:100000,completion_tokens:0};return Response.json(data);};
  assert.match(await client.complete([{role:'user',content:'十分钟后提醒我喝水'}],panel.runtime.plugins.toolSession(message)),/已保存/);
  assert.equal(requests,1);assert.equal(panel.runtime.groups.usedToday(),100000);assert.equal(panel.runtime.plugins.entries.get('reminders').instance.store.list().total,1);
});
test('预约工具与官方搜索共存，搜索续传及引用仍保留；搜索失败不能执行或假称成功',async t=>{
  const f=setup(t),requests=[];
  const settings={...config,protocol:'anthropic',baseUrl:'https://api.deepseek.com/anthropic',model:'deepseek-flash',webSearch:true};
  const client=new LLMClient(settings,{fetchImpl:async(_url,options)=>{
    const body=JSON.parse(options.body);requests.push(body);
    if(requests.length===2)assert.equal(body.messages.at(-1).content[0].type,'server_tool_use');
    return Response.json({id:'search-'+requests.length,type:'message',role:'assistant',model:'deepseek-flash',stop_reason:requests.length===1?'pause_turn':'end_turn',usage:{input_tokens:20,output_tokens:10},content:requests.length===1?[{type:'server_tool_use',id:'search-one',name:'web_search',input:{query:'测试'}}]:[{type:'web_search_tool_result',tool_use_id:'search-one',content:[{title:'官方结果',url:'https://example.com/source'}]},{type:'text',text:'查询完成。'}]});
  }});
  assert.match(await client.complete([{role:'user',content:'帮我搜索'}],f.manager.toolSession(f.message('帮我搜索'))),/https:\/\/example.com\/source/);
  assert.ok(requests[0].tools.some(t=>t.name==='web_search'));assert.ok(requests[0].tools.some(t=>t.name==='reminders_create'));assert.equal(f.plugin.store.list().total,0);
  client.fetchImpl=async()=>Response.json({id:'failed',type:'message',role:'assistant',model:'deepseek-flash',stop_reason:'end_turn',usage:{input_tokens:20,output_tokens:10},content:[{type:'web_search_tool_result',tool_use_id:'search-one',content:{type:'web_search_tool_result_error',error_code:'unavailable'}},{type:'text',text:'假成功'}]});
  await assert.rejects(client.complete([],f.manager.toolSession(f.message('搜索'))),/官方联网搜索暂时失败/);
});
test('切换AI预约后旧来源重放仍幂等，不复制旧预约或向另一成员泄露',async t=>{
  const f=setup(t),old=f.create('member-one','group','message-one'),args={timeType:'relative',when:'10分钟',content:'喝水'};
  const result=await f.manager.toolSession(f.message('十分钟后提醒我喝水','group')).execute('reminders_create',args);assert.equal(result.reminder.id,old.id);assert.equal(f.plugin.store.list().total,1);
  assert.equal((await f.manager.toolSession(f.message('十分钟后提醒我喝水','group','message-one','member-two')).execute('reminders_create',args)).ok,false);
});

test('宿主可接入其他工具插件，模型失败后由该插件汇总真实结果', async t => {
  const f = setup(t);
  const manager = new PluginManager({ db: f.memory.db, settings: f.settings, log() {} }, [{
    manifest: { id: 'local-demo', name: '示例功能' },
    createPlugin: () => ({
      tools: () => [{ name: 'demo_read', parameters: { type: 'object', properties: {} } }],
      callTool: (_name, _args, owner) => ({ ok: true, text: '示例结果', owner }),
      summarize: results => results.map(result => result.text).join('\n'),
    }),
  }]);
  const session = manager.toolSession(f.message('示例查询'));
  const result = await session.execute('demo_read', {});
  assert.equal(result.owner.creatorId, 'member-one');
  assert.equal(session.summary(), '示例结果');
});

test('查询成功后模型失败时仍显示实际预约，而不误报处理未完成', async t => {
  const f = setup(t), row = f.create();
  let requests = 0;
  const client = new LLMClient(config, { fetchImpl: async () => {
    if (++requests === 1) return Response.json(call('reminders_list', {}));
    throw new Error('network gone');
  } });
  const text = await client.complete([], f.manager.toolSession(f.message('我有哪些提醒')));
  assert.ok(text.includes(row.id)); assert.match(text, /喝水/);
});

test('查询提供明确参数，模型根据取消请求查询真实ID后删除，后续查询不再返回记录', async t => {
  const f = setup(t), row = f.create(), requests = [];
  const client = new LLMClient(config, { fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    if (requests.length === 1) {
      const definition = body.tools.find(tool => tool.function.name === 'reminders_list').function;
      assert.deepEqual(definition.parameters.required, ['query']);
      assert.equal(definition.parameters.properties.query.type, 'string');
      return Response.json(call('reminders_list', { query: '喝水' }));
    }
    const result = JSON.parse(body.messages.at(-1).content);
    if (requests.length === 2) {
      assert.equal(result.reminders.length, 1);
      const selected = result.reminders[0];
      const definition=body.tools.find(tool=>tool.function.name==='reminders_change').function;
      assert.deepEqual(definition.parameters.properties.action.enum,['delete','pause','resume']);
      return Response.json(call('reminders_change', { id: selected.id, revision: selected.revision, action: 'delete' }, 'delete-real-id'));
    }
    assert.equal(result.reminder.state, 'deleted');assert.equal(result.reminder.deleted,true);
    return Response.json(answer('这条提醒已经删除。'));
  } });
  assert.match(await client.complete([{ role: 'user', content: '取消喝水的预约' }], f.manager.toolSession(f.message('取消喝水的预约'))), /已经删除/);
  assert.throws(()=>f.plugin.store.get(row.id),/不存在/);
  const remaining = await f.manager.toolSession(f.message('现在有哪些预约')).execute('reminders_list', { query: '' });
  assert.equal(remaining.reminders.length, 0); assert.equal(remaining.total, 0);
});

test('查询在权限过滤后分页和检索，已取消记录不占页，支持兼容无参调用', async t => {
  const f = setup(t);
  for (let index = 0; index < 19; index++) {
    const row = f.create('member-one', 'c2c', 'page-' + index);
    if (index < 2) f.plugin.manage(row.id, 'cancel');
  }
  f.create('member-two', 'c2c', 'other-owner');
  f.create('member-one', 'group', 'other-chat');
  const session = f.manager.toolSession(f.message('查看我的预约'));
  const first = await session.execute('reminders_list', {});
  assert.equal(first.total, 17); assert.equal(first.reminders.length, 15); assert.equal(first.nextPage, 2);
  const second = await session.execute('reminders_list', { query: '', page: 2 });
  assert.equal(second.reminders.length, 2); assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.reminders, ...second.reminders].map(row => row.id)).size, 17);
  assert.equal((await session.execute('reminders_list', { query: '不存在的事项' })).total, 0);
  for (const args of [{ query: 'x'.repeat(101) }, { query: '', page: 0 }, { query: '', page: 1.5 }, { query: '', targetId: 'other-chat' }]) {
    assert.equal((await session.execute('reminders_list', args)).ok, false);
  }
});

test('模型仍传错查询参数时保留具体错误，查询失败不能产生取消效果', async t => {
  const f = setup(t), row = f.create();
  const client = new LLMClient(config, { fetchImpl: async () => Response.json(call('reminders_list', { content: '查询当前预约' })) });
  const text = await client.complete([], f.manager.toolSession(f.message('取消预约')));
  assert.match(text, /不支持的字段/);
  assert.equal(f.plugin.store.get(row.id).state, 'active');
});
