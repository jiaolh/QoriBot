import { randomBytes } from 'node:crypto';
import { describeSchedule } from './time.js';
export class ReminderStore {
  constructor(db, now=Date.now) {
    this.db=db;this.now=now;this.lastPrune=0;
    db.exec(`CREATE TABLE IF NOT EXISTS plugin_reminders (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, target_id TEXT NOT NULL, creator_id TEXT NOT NULL,
      source_id TEXT NOT NULL, content TEXT NOT NULL, schedule TEXT NOT NULL, next_at INTEGER,
      state TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, send_count INTEGER NOT NULL DEFAULT 0, last_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '', UNIQUE(scope,target_id,source_id));
      CREATE INDEX IF NOT EXISTS plugin_reminders_due ON plugin_reminders(state,next_at);
      CREATE TABLE IF NOT EXISTS plugin_reminder_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, scheduled_at INTEGER NOT NULL,
        started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL,
        message_id TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS plugin_reminder_deleted_sources (
        scope TEXT NOT NULL,target_id TEXT NOT NULL,source_id TEXT NOT NULL,deleted_at INTEGER NOT NULL,
        PRIMARY KEY(scope,target_id,source_id));`);
    // 发送时崩溃不能确定平台是否已收到，交给管理员决定是否再发。
    db.prepare("UPDATE plugin_reminders SET state='uncertain',last_error='上次发送中程序退出，送达结果未知；请确认后手动恢复',updated_at=? WHERE state='sending'").run(now());
    db.prepare("UPDATE plugin_reminder_deliveries SET state='uncertain',finished_at=?,error='发送时程序退出，结果未知' WHERE state='sending'").run(now());
  }
  row(row) {
    if(!row)return null;
    const schedule=JSON.parse(row.schedule);
    return {id:row.id,scope:row.scope,targetId:row.target_id,creatorId:row.creator_id,content:row.content,schedule,
      nextAt:row.next_at,state:row.state,createdAt:row.created_at,updatedAt:row.updated_at,revision:row.revision,
      sendCount:row.send_count,lastAt:row.last_at,lastError:row.last_error,description:describeSchedule(schedule)};
  }
  get(id) { const row=this.row(this.db.prepare('SELECT * FROM plugin_reminders WHERE id=?').get(id));if(!row)throw new Error('预约不存在。');return row; }
  source(scope,targetId,sourceId) {
    if(this.db.prepare('SELECT 1 FROM plugin_reminder_deleted_sources WHERE scope=? AND target_id=? AND source_id=?').get(scope,targetId,sourceId))throw new Error('这条消息创建的预约已被删除；如需重新预约，请另发一条消息。');
    return this.row(this.db.prepare('SELECT * FROM plugin_reminders WHERE scope=? AND target_id=? AND source_id=?').get(scope,targetId,sourceId));
  }
  create({scope,targetId,creatorId,sourceId,content,schedule,nextAt}) {
    const previous=this.source(scope,targetId,sourceId);
    if(previous)return previous;
    if(this.db.prepare("SELECT count(*) AS n FROM plugin_reminders WHERE state IN ('active','paused','sending','failed','uncertain')").get().n>=1000)throw new Error('预约总数已达 1000，请先删除不需要的预约。');
    if(this.db.prepare("SELECT count(*) AS n FROM plugin_reminders WHERE scope=? AND target_id=? AND creator_id=? AND state IN ('active','paused','sending')").get(scope,targetId,creatorId).n>=50)throw new Error('当前聊天中你的有效预约已达 50 条。');
    let id;do{id=randomBytes(4).toString('hex');}while(this.db.prepare('SELECT 1 FROM plugin_reminders WHERE id=?').get(id));
    this.db.prepare('INSERT INTO plugin_reminders(id,scope,target_id,creator_id,source_id,content,schedule,next_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id,scope,targetId,creatorId,sourceId,content,JSON.stringify(schedule),nextAt,this.now(),this.now());
    return this.get(id);
  }
  list({scope,targetId,creatorId,state='',query='',page=1,limit=50,excludeCancelled=false}={}) {
    const filters=[],params=[];
    for(const [key,value] of [['scope',scope],['target_id',targetId],['creator_id',creatorId],['state',state]])if(value){filters.push(`${key}=?`);params.push(value);}
    if(excludeCancelled)filters.push("state<>'cancelled'");
    if(query){filters.push('(instr(content,?)>0 OR instr(id,?)>0 OR instr(target_id,?)>0)');params.push(query,query,query);}
    const where=filters.length?' WHERE '+filters.join(' AND '):'',total=this.db.prepare('SELECT count(*) AS n FROM plugin_reminders'+where).get(...params).n;
    const rows=this.db.prepare('SELECT * FROM plugin_reminders'+where+' ORDER BY created_at DESC,id LIMIT ? OFFSET ?').all(...params,limit,(page-1)*limit).map(row=>this.row(row));
    return {rows,total,page};
  }
  due() { return this.db.prepare("SELECT * FROM plugin_reminders WHERE state='active' AND next_at<=? ORDER BY next_at LIMIT 20").all(this.now()).map(row=>this.row(row)); }
  update(id, patch, revision) {
    const current=this.get(id);if(current.state==='sending')throw new Error('这条预约正在发送，请等发送结束后再修改。');
    if(revision!==undefined&&revision!==current.revision)throw new Error('预约已被其他操作更新，请刷新后再编辑。');
    this.db.prepare('UPDATE plugin_reminders SET content=?,schedule=?,next_at=?,state=?,last_error=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?')
      .run(patch.content??current.content,JSON.stringify(patch.schedule??current.schedule),patch.nextAt===undefined?current.nextAt:patch.nextAt,patch.state??current.state,patch.lastError??current.lastError,this.now(),id,current.revision);
    return this.get(id);
  }
  claim(row) {
    const result=this.db.prepare("UPDATE plugin_reminders SET state='sending',updated_at=? WHERE id=? AND state='active' AND revision=? AND next_at=?").run(this.now(),row.id,row.revision,row.nextAt);
    if(!result.changes)return null;
    return Number(this.db.prepare("INSERT INTO plugin_reminder_deliveries(task_id,scheduled_at,started_at,state) VALUES(?,?,?,'sending')").run(row.id,row.nextAt,this.now()).lastInsertRowid);
  }
  delete(id, revision) {
    const current=this.get(id);
    if(current.state==='sending')throw new Error('这条预约正在发送，请等发送结束后再删除。');
    if(revision!==undefined&&revision!==current.revision)throw new Error('预约已被其他操作更新，请刷新后再删除。');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const source=this.db.prepare('SELECT source_id FROM plugin_reminders WHERE id=?').get(id);
      // 仅保留短期来源凭据，不保留预约内容或发送记录，阻止旧入站事件重建已删除预约。
      this.db.prepare('INSERT OR REPLACE INTO plugin_reminder_deleted_sources(scope,target_id,source_id,deleted_at) VALUES(?,?,?,?)').run(current.scope,current.targetId,source.source_id,this.now());
      this.db.prepare('DELETE FROM plugin_reminder_deliveries WHERE task_id=?').run(id);
      const removed=this.db.prepare("DELETE FROM plugin_reminders WHERE id=? AND revision=? AND state<>'sending'").run(id,current.revision);
      if(!removed.changes)throw new Error('预约已被其他操作更新，请刷新后再删除。');
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    return {...current,state:'deleted',nextAt:null,deleted:true};
  }
  finish(row, deliveryId, {state,error='',messageId='',nextAt=null,sent=false}) {
    this.db.prepare('UPDATE plugin_reminder_deliveries SET state=?,finished_at=?,error=?,message_id=? WHERE id=?').run(state,this.now(),error,messageId,deliveryId);
    this.db.prepare('UPDATE plugin_reminders SET state=?,next_at=?,last_at=?,last_error=?,send_count=send_count+?,updated_at=?,revision=revision+1 WHERE id=?')
      .run(sent?(nextAt?'active':'completed'):state,nextAt,sent?this.now():row.lastAt,error,Number(sent),this.now(),row.id);
    this.prune(true);
  }
  history(id) { this.get(id);return this.db.prepare('SELECT scheduled_at AS scheduledAt,started_at AS startedAt,finished_at AS finishedAt,state,message_id AS messageId,error FROM plugin_reminder_deliveries WHERE task_id=? ORDER BY id DESC LIMIT 30').all(id); }
  stats() { return {active:this.db.prepare("SELECT count(*) AS n FROM plugin_reminders WHERE state='active'").get().n,attention:this.db.prepare("SELECT count(*) AS n FROM plugin_reminders WHERE state IN ('failed','uncertain','missed')").get().n}; }
  prune(force=false) {
    if(!force&&this.now()-this.lastPrune<3600000)return;this.lastPrune=this.now();
    this.db.prepare('DELETE FROM plugin_reminder_deliveries WHERE id NOT IN (SELECT id FROM plugin_reminder_deliveries ORDER BY id DESC LIMIT 2000) OR started_at<?').run(this.now()-30*86400000);
    this.db.prepare("DELETE FROM plugin_reminders WHERE state IN ('completed','cancelled','missed') AND updated_at<?").run(this.now()-30*86400000);
    this.db.prepare('DELETE FROM plugin_reminder_deleted_sources WHERE deleted_at<?').run(this.now()-30*86400000);
  }
}
