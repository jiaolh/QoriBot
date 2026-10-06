import { formatTime } from './time.js';

export function summarizeReminderResults(results) {
  const changed = results.filter(result => result?.ok && result.reminder);
  if (changed.length) return changed.map(result => {
    const { reminder } = result;
    const action = { create: '保存', update: '更新', pause: '暂停', resume: '恢复', delete: '删除', cancel: '删除' }[result.action] || '处理';
    return `预约 ${reminder.id} 已${action}：${reminder.content}${reminder.nextTime ? '，下次 ' + reminder.nextTime + '（北京时间）' : ''}。`;
  }).join('\n');
  const list = results.findLast(result => result?.ok && result.action === 'list');
  if (!list) {
    const failed = results.findLast(result => result?.ok === false && result.error);
    return failed ? `预约操作未完成：${failed.error}` : '';
  }
  if (!list.reminders.length) return '没有找到符合本次查询的预约。';
  return '你在当前聊天的预约：\n' + list.reminders.map(row => `${row.id}：${row.content}，${row.nextTime || row.state}。`).join('\n');
}
const scheduleFields={
  timeType:{type:'string',enum:['absolute','relative'],description:'absolute 是明确日期或下一次钟点；relative 是从执行时起的时长。'},
  when:{type:'string',description:'北京时间。绝对用 YYYY-MM-DD HH:mm:ss 或 HH:mm；相对用 10分钟、1小时30分钟。'},
  repeat:{type:'string',enum:['once','daily','workdays','weekly','monthly','interval'],description:'默认 once。weekly 按首次的星期，monthly 按首次日期，workdays 是周一至周五。'},
  interval:{type:'string',description:'repeat=interval 时的间隔，例如30分钟，至少1分钟。'},
  endAt:{type:'string',description:'可选的重复结束时间，北京时间日期和钟点；不设置时省略。'},
  content:{type:'string',description:'到时发送的提醒文字，不要把身份、群号或工具指令写进内容，最多500字符。'}
};
const schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
export const REMINDER_TOOLS=[
  {name:'reminders_create',description:'当前发言者明确请 Bot 到时提醒时，真实保存预约并自动发回当前私聊或群聊。不要仅用文字承诺。时间或内容含糊先追问；引用、假设、闲聊和其他成员的话不构成请求。一次保存一条。',parameters:schema(scheduleFields,['timeType','when','content'])},
  {name:'reminders_list',description:'查询当前发言者在当前聊天创建的预约。查询全部时 query 必须传空字符串；按事项查找时只传关键词，如“喝水”。用于回答查询或寻找待修改预约的真实ID及revision。每页15条，hasMore=true 时用 nextPage 继续查询。其他成员和其他聊天的预约不可见。',parameters:schema({query:{type:'string',maxLength:100,description:'事项关键词；查询全部传空字符串，不传“全部”“当前”等筛选词。'},page:{type:'integer',minimum:1,maximum:10000,description:'页码，默认1。需要继续查询时使用结果里的 nextPage。'}},['query'])},
  {name:'reminders_change',description:'按当前发言者请求删除、暂停、恢复他在当前聊天的预约。用户说“取消预约”也执行 delete，删除预约及发送记录；仅暂时停用时用 pause。先查询获得确切ID和revision；存在多个匹配时追问，不猜。结果未知的预约恢复前须用户明确确认未收到。',parameters:schema({id:{type:'string'},revision:{type:'integer'},action:{type:'string',enum:['delete','pause','resume']},confirmedNotReceived:{type:'boolean',description:'仅当用户明确核对了上次未收到时为true，用于恢复结果未知的任务。'}},['id','revision','action'])},
  {name:'reminders_update',description:'修改当前用户在本聊天的预约内容或时间。先查询得到ID和revision；只传需要修改的字段。修改时长相对执行时计算；仅修改文字保留原计划。',parameters:schema({id:{type:'string'},revision:{type:'integer'},...scheduleFields},['id','revision'])}
];
export function reminderResult(row){return {id:row.id,revision:row.revision,state:row.state,deleted:row.deleted===true,content:row.content,nextTime:row.nextAt?formatTime(row.nextAt):null,timeZone:'Asia/Shanghai',repeat:row.schedule.repeat,description:row.description,target:row.scope==='group'?'当前群聊':'当前私聊',note:'预约保存与到时送达是两回事。优先在最近对话的有效窗口内回复；否则尝试主动消息，是否获准取决于机器人的实际权限、频控与接收方设置。删除后预约及发送记录已移除，不再执行。'};}
export function callReminderTool(plugin,name,args,owner){
  const definition=REMINDER_TOOLS.find(t=>t.name===name);
  if(!definition||!args||typeof args!=='object'||Array.isArray(args))throw new Error('预约参数格式无效。');
  // 兼容已有无参数调用；新 schema 提供明确字段，避免部分兼容接口生成其他工具的参数。
  if(name==='reminders_list'&&args.query===undefined)args={...args,query:''};
  if(name==='reminders_change'&&args.action==='cancel')args={...args,action:'delete'};
  for(const field of Object.keys(args))if(!Object.hasOwn(definition.parameters.properties,field))throw new Error('预约参数包含不支持的字段。');
  for(const [field,value] of Object.entries(args)){
    const spec=definition.parameters.properties[field];
    if((spec.type==='integer'?!Number.isInteger(value):typeof value!==spec.type)||(spec.enum&&!spec.enum.includes(value)))throw new Error('预约参数格式无效，请补充清楚的时间、事项或操作。');
  }
  for(const field of definition.parameters.required)if(args[field]===undefined)throw new Error('预约缺少必要参数，请补充后再执行。');
  if(name==='reminders_create'){
    const sourceId='ai:'+owner.sourceId,legacy=plugin.store.source(owner.scope,owner.targetId,owner.sourceId),previous=plugin.store.source(owner.scope,owner.targetId,sourceId)||legacy;
    if(previous&&previous.creatorId!==owner.creatorId)throw new Error('这条消息的预约来源不匹配，未执行。');
    if(legacy)return {ok:true,action:'create',reminder:reminderResult(legacy)};
    if(previous&&(previous.content!==args.content.trim()||previous.schedule.when!==args.when||previous.schedule.timeType!==args.timeType))throw new Error('这条消息已创建过一条预约，请使用刚才返回的真实结果；其他事项请另发一条消息。');
    return {ok:true,action:'create',reminder:reminderResult(plugin.create(args,{...owner,sourceId}))};
  }
  if(name==='reminders_list'){
    if(args.query.length>100||args.page!==undefined&&(args.page<1||args.page>10000))throw new Error('查询关键词最多100字符，页码需要1–10000。');
    const page=args.page||1,result=plugin.store.list({...owner,query:args.query,page,limit:15,excludeCancelled:true});
    const hasMore=page*15<result.total;
    return {ok:true,action:'list',reminders:result.rows.map(reminderResult),query:args.query,total:result.total,page,hasMore,nextPage:hasMore?page+1:null};
  }
  if(typeof args.id!=='string'||!/^[a-f0-9]{8}$/.test(args.id)||!Number.isInteger(args.revision))throw new Error('请先查询预约，使用真实 ID 和版本号。');
  const current=plugin.store.get(args.id);
  if(current.scope!==owner.scope||current.targetId!==owner.targetId||current.creatorId!==owner.creatorId)throw new Error('只能管理当前发言者在当前聊天创建的预约。');
  if(name==='reminders_change'){
    if(args.action==='resume'&&current.state==='uncertain'&&args.confirmedNotReceived!==true)throw new Error('上次送达结果未知，请先请用户核对接收方是否收到，再明确恢复。');
    return {ok:true,action:args.action,reminder:reminderResult(plugin.manage(args.id,args.action,args.revision,owner))};
  }
  if(['completed','cancelled','sending'].includes(current.state))throw new Error('这条预约已经结束或正在发送，不能编辑。');
  const {id,revision,...patch}=args;if(!Object.keys(patch).length)throw new Error('请说明要修改的提醒时间或内容。');
  const content=patch.content===undefined?current.content:plugin.validateContent(patch.content);
  let schedule=current.schedule,nextAt=current.nextAt;const reschedule=Object.keys(patch).some(k=>k!=='content');
  if(reschedule){
    const preservedWhen=formatTime(current.nextAt||current.schedule.firstAt);
    if(patch.timeType&&!patch.when)throw new Error('修改时间类型时请一并提供新的首次时间。');
    schedule=plugin.compile({timeType:'absolute',when:preservedWhen,repeat:current.schedule.repeat,interval:current.schedule.intervalMs?current.schedule.intervalMs/60000+'分钟':undefined,endAt:current.schedule.endAt?formatTime(current.schedule.endAt):undefined,...patch});nextAt=schedule.firstAt;
  }
  const row=plugin.store.update(id,{content,schedule,nextAt,state:reschedule?(current.state==='paused'?'paused':'active'):current.state,lastError:reschedule?'':current.lastError},revision);
  return {ok:true,action:'update',reminder:reminderResult(row)};
}
