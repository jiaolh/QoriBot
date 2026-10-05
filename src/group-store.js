import { groupPolicy } from './group-config.js';
import { DatabaseSync } from 'node:sqlite';

const dayAt = now => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
export class GroupStore {
  constructor(memory, config, now = Date.now) {
    this.db = memory.db; this.config = config; this.now = now; this.lastPrune = 0;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS group_channels (
        group_id TEXT PRIMARY KEY, last_seen INTEGER NOT NULL, last_full_at INTEGER NOT NULL DEFAULT 0,
        summary TEXT NOT NULL DEFAULT '', summary_at INTEGER NOT NULL DEFAULT 0, summary_cursor INTEGER NOT NULL DEFAULT 0,
        generation INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS group_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, message_id TEXT NOT NULL,
        sender_id TEXT NOT NULL, sender_name TEXT NOT NULL, direction TEXT NOT NULL, content TEXT NOT NULL,
        at INTEGER NOT NULL, received_at INTEGER NOT NULL, mentioned INTEGER NOT NULL DEFAULT 0,
        quote_id TEXT NOT NULL DEFAULT '', index_id TEXT NOT NULL DEFAULT '', bytes INTEGER NOT NULL,
        UNIQUE(group_id,message_id));
      CREATE INDEX IF NOT EXISTS group_messages_time ON group_messages(received_at);
      CREATE INDEX IF NOT EXISTS group_messages_group ON group_messages(group_id,seq);
      CREATE TABLE IF NOT EXISTS group_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, at INTEGER NOT NULL,
        action TEXT NOT NULL, reason TEXT NOT NULL, target_id TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS group_decisions_time ON group_decisions(group_id,at);
      CREATE TABLE IF NOT EXISTS group_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL,
        day TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        estimated INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'pending');
      CREATE INDEX IF NOT EXISTS group_calls_day ON group_calls(day,group_id);
      CREATE TABLE IF NOT EXISTS group_reply_counts (
        group_id TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS group_reply_counts_time ON group_reply_counts(group_id,at);
    `);
    this.db.exec("INSERT OR IGNORE INTO group_channels(group_id,last_seen) SELECT target_id,max(updated_at) FROM sessions WHERE kind='group' AND target_id<>'' GROUP BY target_id LIMIT 1000;");
    this.prune(true);
  }
  get limits() { return this.config(); }
  discover(id, full = false) {
    if (!this.db.prepare('SELECT 1 FROM group_channels WHERE group_id=?').get(id) && this.db.prepare('SELECT count(*) AS n FROM group_channels').get().n >= 1000) return false;
    this.db.prepare(`INSERT INTO group_channels(group_id,last_seen,last_full_at) VALUES(?,?,?)
      ON CONFLICT(group_id) DO UPDATE SET last_seen=excluded.last_seen,
      last_full_at=CASE WHEN excluded.last_full_at>0 THEN excluded.last_full_at ELSE last_full_at END`).run(id, this.now(), full ? this.now() : 0);
    return true;
  }
  channel(id) {
    this.prune();
    const row = this.db.prepare('SELECT group_id AS groupId,last_seen AS lastSeen,last_full_at AS lastFullAt,summary,summary_at AS summaryAt,summary_cursor AS summaryCursor,generation FROM group_channels WHERE group_id=?').get(id);
    if (!row) throw new Error('尚未收到这个群的消息。');
    return row;
  }
  append(id, message, { direction = 'in', mentioned = false } = {}) {
    this.prune();
    const at = Number(message.at || Date.parse(message.timestamp)) || this.now();
    const content = String(message.content || '').slice(0, 20000);
    const sender = String(message.senderId || 'bot').slice(0, 150), name = String(message.senderName || '').slice(0, 100);
    const bytes = Buffer.byteLength(content + sender + name) + 250;
    const result = this.db.prepare(`INSERT OR IGNORE INTO group_messages(group_id,message_id,sender_id,sender_name,direction,content,at,received_at,mentioned,quote_id,index_id,bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, message.messageId, sender, name, direction, content, at, this.now(), Number(mentioned), String(message.refMsgIdx || message.quoteId || ''), String(message.msgIdx || ''), bytes);
    this.enforceBytes();
    return Boolean(result.changes);
  }
  message(id, messageId) {
    return this.db.prepare(`SELECT seq,message_id AS messageId,sender_id AS senderId,sender_name AS senderName,direction,content,at,received_at AS receivedAt,mentioned,quote_id AS quoteId,index_id AS indexId
      FROM group_messages WHERE group_id=? AND message_id=? AND received_at>?`).get(id, messageId, this.now() - this.limits.messageTtlMs);
  }
  context(id, { limit = this.limits.contextMessages, windowMs = this.limits.contextWindowMs, senderId, after = 0 } = {}) {
    const cutoff = this.now() - Math.min(windowMs, this.limits.messageTtlMs);
    const rows = this.db.prepare(`SELECT seq,message_id AS messageId,sender_id AS senderId,sender_name AS senderName,direction,content,at,received_at AS receivedAt,mentioned,quote_id AS quoteId,index_id AS indexId
      FROM group_messages WHERE group_id=? AND received_at>? AND received_at>? ${senderId ? 'AND sender_id=? AND direction=\'in\'' : ''} ORDER BY seq DESC LIMIT ?`)
      .all(id, cutoff, after, ...(senderId ? [senderId] : []), limit);
    return rows.reverse();
  }
  quote(id, index) {
    if (!index) return null;
    return this.db.prepare('SELECT message_id AS messageId,sender_id AS senderId,direction,content FROM group_messages WHERE group_id=? AND (index_id=? OR message_id=?) AND received_at>? LIMIT 1').get(id, index, index, this.now() - this.limits.messageTtlMs);
  }
  record(id, action, reason, targetId = '', mode = '') {
    this.db.prepare('INSERT INTO group_decisions(group_id,at,action,reason,target_id,mode) VALUES(?,?,?,?,?,?)').run(id, this.now(), action, String(reason).slice(0, 180), targetId, mode);
    this.db.prepare('DELETE FROM group_decisions WHERE id NOT IN (SELECT id FROM group_decisions ORDER BY id DESC LIMIT 2000)').run();
  }
  lastReply(id) { return this.db.prepare('SELECT coalesce(max(at),0) AS at FROM group_reply_counts WHERE group_id=?').get(id).at; }
  repliesHour(id) { return this.db.prepare('SELECT count(*) AS n FROM group_reply_counts WHERE group_id=? AND at>?').get(id, this.now() - 3600000).n; }
  sent(id, automatic) { if (automatic) this.db.prepare('INSERT INTO group_reply_counts(group_id,at) VALUES(?,?)').run(id, this.now()); }
  judgesHour(id) { return this.db.prepare("SELECT count(*) AS n FROM group_calls WHERE group_id=? AND kind='judge' AND at>?").get(id, this.now() - 3600000).n; }
  lastJudge(id) { return this.db.prepare("SELECT coalesce(max(at),0) AS at FROM group_calls WHERE group_id=? AND kind='judge'").get(id).at; }
  lastCall(id, kind) { return this.db.prepare('SELECT coalesce(max(at),0) AS at FROM group_calls WHERE group_id=? AND kind=?').get(id,kind).at; }
  usedToday(id) {
    const sql = 'SELECT coalesce(sum(input_tokens+output_tokens),0) AS n FROM group_calls WHERE day=?' + (id === undefined ? '' : ' AND group_id=?');
    return this.db.prepare(sql).get(dayAt(this.now()), ...(id === undefined ? [] : [id])).n;
  }
  reserve(id, kind, messages, maxTokens) {
    const input = messages.reduce((n, m) => n + Buffer.byteLength(m.content, 'utf8') + 16, 32);
    const estimate = input + maxTokens, policy = groupPolicy(this.limits, id);
    if (this.usedToday() + estimate > this.limits.dailyTokenLimit || (policy.dailyTokenLimit && this.usedToday(id) + estimate > policy.dailyTokenLimit)) throw new Error('今日模型预算已达到上限，请在群聊模式页调整预算。');
    const result = this.db.prepare('INSERT INTO group_calls(group_id,kind,at,day,input_tokens,output_tokens) VALUES(?,?,?,?,?,?)').run(id, kind, this.now(), dayAt(this.now()), input, maxTokens);
    return Number(result.lastInsertRowid);
  }
  settle(id, usage, state) {
    if (usage) this.db.prepare('UPDATE group_calls SET input_tokens=?,output_tokens=?,estimated=0,state=? WHERE id=?').run(usage.inputTokens, usage.outputTokens, state, id);
    else this.db.prepare('UPDATE group_calls SET state=? WHERE id=?').run(state, id);
  }
  summary(id, content, cursor, expectedGeneration) {
    return Boolean(this.db.prepare('UPDATE group_channels SET summary=?,summary_at=?,summary_cursor=? WHERE group_id=? AND generation=?').run(content.slice(0, 2000), this.now(), cursor, id, expectedGeneration).changes);
  }
  clear(id) {
    this.db.prepare('DELETE FROM group_messages WHERE group_id=?').run(id);
    this.db.prepare('DELETE FROM group_decisions WHERE group_id=?').run(id);
    this.db.prepare("UPDATE group_channels SET summary='',summary_at=0,summary_cursor=0,generation=generation+1 WHERE group_id=?").run(id);
  }
  sanitizeBackup(path) {
    const backup = new DatabaseSync(path);
    try { backup.exec("DELETE FROM group_messages; DELETE FROM group_decisions; UPDATE group_channels SET summary='',summary_at=0,summary_cursor=0; VACUUM;"); }
    finally { backup.close(); }
  }
  prune(force = false) {
    if (!force && this.now() - this.lastPrune < 60000) return;
    const cutoff = this.now() - this.limits.messageTtlMs;
    this.db.prepare('DELETE FROM group_messages WHERE received_at<=?').run(cutoff);
    this.db.prepare('DELETE FROM group_decisions WHERE at<=?').run(cutoff);
    this.db.prepare("UPDATE group_channels SET summary='',summary_at=0,summary_cursor=0 WHERE summary_at>0 AND summary_at<=?").run(cutoff);
    this.db.prepare('DELETE FROM group_reply_counts WHERE at<=?').run(this.now() - 3600000);
    this.db.prepare('DELETE FROM group_calls WHERE day<?').run(dayAt(this.now() - 30 * 86400000));
    this.enforceBytes(); this.lastPrune = this.now();
  }
  enforceBytes() {
    let size = this.db.prepare('SELECT coalesce(sum(bytes),0) AS n FROM group_messages').get().n;
    if (size <= this.limits.maxBytes) return;
    const remove = this.db.prepare('DELETE FROM group_messages WHERE seq=?');
    for (const row of this.db.prepare('SELECT seq,bytes FROM group_messages ORDER BY seq').all()) {
      remove.run(row.seq); size -= row.bytes; if (size <= this.limits.maxBytes) break;
    }
  }
  stats() { return { ...this.db.prepare('SELECT count(*) AS messages,coalesce(sum(bytes),0) AS bytes FROM group_messages WHERE received_at>?').get(this.now() - this.limits.messageTtlMs), todayTokens: this.usedToday(), retentionHours: this.limits.messageTtlMs / 3600000 }; }
  list() {
    this.prune();
    const ids = new Set([...this.db.prepare('SELECT group_id FROM group_channels ORDER BY last_seen DESC LIMIT 1000').all().map(r => r.group_id), ...Object.keys(this.limits.groups)]);
    return [...ids].map(id => ({ groupId: id, policy: groupPolicy(this.limits, id),
      ...this.db.prepare('SELECT last_seen AS lastSeen,last_full_at AS lastFullAt,summary_at AS summaryAt FROM group_channels WHERE group_id=?').get(id),
      messages: this.db.prepare('SELECT count(*) AS n FROM group_messages WHERE group_id=? AND received_at>?').get(id, this.now() - this.limits.messageTtlMs).n,
      repliesHour: this.repliesHour(id), judgesHour: this.judgesHour(id), todayTokens: this.usedToday(id),
    }));
  }
  detail(id) {
    if (!this.db.prepare('SELECT 1 FROM group_channels WHERE group_id=?').get(id)) {
      if (!Object.hasOwn(this.limits.groups,id)) throw new Error('这个群尚未发现，请先保存群设置');
      this.db.prepare('INSERT INTO group_channels(group_id,last_seen) VALUES(?,0)').run(id);
    }
    return { ...this.channel(id), policy: groupPolicy(this.limits, id), messages: this.context(id, { limit: 100, windowMs: this.limits.messageTtlMs }),
      decisions: this.db.prepare('SELECT at,action,reason,target_id AS targetId,mode FROM group_decisions WHERE group_id=? AND at>? ORDER BY id DESC LIMIT 50').all(id, this.now() - this.limits.messageTtlMs) };
  }
}
