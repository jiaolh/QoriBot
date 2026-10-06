import { randomUUID } from 'node:crypto';
import { ReminderStore } from './store.js';
import { compileSchedule, nextOccurrence } from './time.js';
import { REMINDER_TOOLS, callReminderTool, summarizeReminderResults } from './tools.js';
export const manifest = {id:'reminders',name:'预约提醒',version:'1.2.0',description:'AI 理解自然对话并调用预约工具，在原聊天按时提醒，支持查询、删除、重复与手动管理。',page:'reminders',pageTitle:'预约提醒',navIcon:'◷',ui:{html:'ui/page.html',script:'ui/reminders.js'}};
export function createPlugin(context) { return new ReminderPlugin(context); }
export class ReminderPlugin {
  constructor(context) { this.context=context;this.store=new ReminderStore(context.db,context.now);this.timer=null;this.running=false;this.task=null;this.activeRequests=0; }
  start() { if(this.running)return;this.running=true;this.schedule(); }
  schedule() { if(!this.running)return;this.timer=setTimeout(()=>{this.timer=null;this.tick().catch(()=>this.context.log('warn','预约检查未完成，请查看插件状态。')).finally(()=>this.schedule());},1000);this.timer.unref(); }
  async stop() { this.running=false;clearTimeout(this.timer);this.timer=null;await this.task; }
  tools() { return REMINDER_TOOLS; }
  callTool(name,args,owner) { return callReminderTool(this,name,args,owner); }
  summarize(results) { return summarizeReminderResults(results); }
  help() { return '预约提醒：直接说“十分钟后提醒我喝水”，AI会按需调用插件；也可查询、修改或删除自己的提醒。删除会移除预约及发送记录；暂时停用请说暂停。到时优先用有效对话回复，否则尝试主动发送，实际送达受 QQ 权限与频控限制。'; }
  validateContent(content) {
    if(typeof content!=='string'||!content.trim()||content.trim().length>500)throw new Error('提醒内容需要 1–500 个字符。');
    if(Buffer.byteLength('⏰ 预约提醒 [12345678]\n'+content.trim())>this.context.maxReplyBytes())throw new Error('提醒内容超过当前 QQ 回复长度限制，请缩短内容。');
    return content.trim();
  }
  compile(input) {
    return compileSchedule(input,this.context.now());
  }
  create(input, origin) {
    const previous=this.store.source(origin.scope,origin.targetId,origin.sourceId);if(previous)return previous;
    const content=this.validateContent(input.content),schedule=this.compile(input);
    this.context.targets.get(origin.scope,origin.targetId);
    return this.store.create({...origin,content,schedule,nextAt:schedule.firstAt});
  }
  manage(id, action, revision, owner) {
    const row=this.store.get(id);
    if(row.state==='sending')throw new Error('这条预约正在发送，请等发送结束后再修改。');
    if(owner&&(row.scope!==owner.scope||row.targetId!==owner.targetId||row.creatorId!==owner.creatorId))throw new Error('只能管理你在当前聊天里创建的预约。');
    if(action==='delete'||action==='cancel')return this.store.delete(id,revision);
    if(action==='pause'){if(!['active','failed','uncertain','missed'].includes(row.state))throw new Error('当前预约不能暂停。');return this.store.update(id,{state:'paused'},revision);}
    if(action==='resume'){
      if(!['paused','failed','uncertain','missed'].includes(row.state))throw new Error('当前预约不能恢复。');
      const nextAt=row.schedule.repeat==='once'?Math.max(this.context.now()+1000,row.nextAt||row.schedule.firstAt):nextOccurrence(row.schedule,this.context.now());
      if(!nextAt)throw new Error('重复预约已经结束，请编辑预约的时间。');
      return this.store.update(id,{state:'active',nextAt,lastError:''},revision);
    }
    throw new Error('预约操作无效。');
  }
  tick() {
    if(this.task)return this.task;
    if(!this.running||!this.context.isConnected())return Promise.resolve();
    this.task=this.processDue().finally(()=>{this.task=null;});return this.task;
  }
  async processDue() {
    this.store.prune();
    this.context.targets.pruneReplies();
    for(const row of this.store.due()){
      if(!this.running||!this.context.isConnected())break;
      const lease=this.store.claim(row);if(!lease)continue;
      const now=this.context.now();
      // 恢复连接只补最近的一条，不补发全部重复周期。
      if(now-row.nextAt>86400000){const nextAt=nextOccurrence(row.schedule,now);this.store.finish(row,lease,{state:nextAt?'active':'missed',nextAt,error:'超过 24 小时未送出，本次已跳过'});continue;}
      this.activeRequests++;
      let sending=false,replyTarget;
      try{
        this.validateContent(row.content);
        replyTarget=this.context.targets.replyTarget(row.scope,row.targetId);
        sending=true;
        const response=await this.context.sendText(replyTarget,`⏰ 预约提醒 [${row.id}]\n${row.content}`);
        const messageId=response?.id||response?.data?.id;
        if(typeof messageId!=='string'||!messageId)throw new Error('QQ 未返回有效的消息回执。');
        this.store.finish(row,lease,{state:'sent',sent:true,messageId,nextAt:nextOccurrence(row.schedule,this.context.now())});
        this.context.log('info',`预约 ${row.id} 已发送。`);
      }catch(error){
        const known=!sending||(Number.isInteger(error.httpStatus)&&error.httpStatus>=400&&error.httpStatus<500)||(Number.isInteger(error.bizCode)&&error.bizCode>0);
        const reason=!sending?error.message:known?`QQ 拒绝${replyTarget?.msgId?'对话回复':'主动消息'}（HTTP ${error.httpStatus||0}，错误码 ${error.bizCode||0}）。${replyTarget?.msgId?`请检查回复时限与次数；每条${row.scope==='c2c'?'私聊消息最多回复4次':'群消息最多回复5次'}。`:'请核对机器人的实际主动发送权限、频控与接收方设置；当前没有有效对话回复窗口，不能据此错误码认定主动能力已取消。'}`:'发送结果未知或连接中断，请核对后手动恢复，避免重复提醒';
        this.store.finish(row,lease,{state:known?'failed':'uncertain',error:reason});this.context.log('warn',`预约 ${row.id} 未确认送达：${reason}`);
      }finally{this.activeRequests--;}
    }
  }
  async api({method,segments,query,body}) {
    if(!segments.length&&method==='GET')return {manifest,stats:this.store.stats(),connected:this.context.isConnected(),enabled:this.context.enabled()};
    if(segments[0]==='targets'&&segments.length===1&&method==='GET')return {rows:this.context.targets.list()};
    if(segments[0]!=='tasks')throw new Error('插件接口不存在。');
    if(segments.length===1&&method==='GET'){
      const page=Number(query.get('page')||1),state=query.get('state')||'',search=query.get('q')||'';
      if(!Number.isInteger(page)||page<1||page>10000||search.length>100||!['','active','paused','completed','failed','uncertain','cancelled','missed','sending'].includes(state))throw new Error('筛选条件无效。');
      const result=this.store.list({state,query:search,page});return {...result,targets:this.context.targets.list(),stats:this.store.stats()};
    }
    if(segments.length===1&&method==='POST'){
      if(!this.context.enabled())throw new Error('请先启用预约插件。');
      if(!body||!['c2c','group'].includes(body.scope)||typeof body.targetId!=='string')throw new Error('请选择已发现的私聊或群聊目标。');
      if(body.requestId!==undefined&&!/^[a-zA-Z0-9-]{1,80}$/.test(body.requestId))throw new Error('请求标识格式错误。');
      return this.create(body,{scope:body.scope,targetId:body.targetId,creatorId:'console',sourceId:'console:'+(body.requestId||randomUUID())});
    }
    const id=segments[1];if(!/^[a-f0-9]{8}$/.test(id||''))throw new Error('预约 ID 格式错误。');
    if(segments.length===2&&method==='GET')return {...this.store.get(id),deliveries:this.store.history(id)};
    if(segments.length===2&&method==='DELETE'){
      if(!Number.isInteger(body?.revision))throw new Error('请刷新后再删除预约。');
      return this.manage(id,'delete',body.revision);
    }
    if(segments.length===2&&method==='PATCH'){
      const current=this.store.get(id),content=this.validateContent(body?.content),schedule=this.compile(body);
      if(['cancelled','completed'].includes(current.state))throw new Error('已结束的预约请重新创建。');
      if(!Number.isInteger(body.revision))throw new Error('请刷新后再编辑预约。');
      return this.store.update(id,{content,schedule,nextAt:schedule.firstAt,lastError:'',state:current.state==='paused'?'paused':'active'},body.revision);
    }
    if(segments.length===3&&method==='POST')return this.manage(id,segments[2],body?.revision);
    throw new Error('插件接口不存在。');
  }
}
