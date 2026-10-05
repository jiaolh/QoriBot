import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export class MemoryDatabase {
  constructor(path, config, now = Date.now) {
    mkdirSync(dirname(path), { recursive: true });
    this.path = path; this.config = config; this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-2048;
      CREATE TABLE IF NOT EXISTS sessions (
        key TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, target_id TEXT NOT NULL,
        sender_id TEXT NOT NULL, prompt_id TEXT NOT NULL, alias TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL,
        messages TEXT NOT NULL DEFAULT '[]', bytes INTEGER NOT NULL DEFAULT 2
      ); CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at);`);
    this.lastPrune = 0;
  }
  get limits() { return typeof this.config === 'function' ? this.config() : this.config; }

  prune(force = false) {
    if (!force && this.now() - this.lastPrune < 60000) return 0;
    const result = this.db.prepare("UPDATE sessions SET messages='[]', bytes=2 WHERE updated_at <= ? AND bytes > 2").run(this.now() - this.limits.sessionTtlMs);
    this.lastPrune = this.now();
    this.enforceLimits();
    return Number(result.changes);
  }

  history(key) {
    const row = this.db.prepare('SELECT messages, enabled, updated_at FROM sessions WHERE key=?').get(key);
    if (!row || !row.enabled || row.updated_at <= this.now() - this.limits.sessionTtlMs) return [];
    return JSON.parse(row.messages);
  }
  messages(key, input, cfg = this.limits) {
    const history = this.history(key);
    let size = history.reduce((total, item) => total + item.content.length, 0) + input.length;
    while (history.length && size > cfg.maxContextChars) {
      size -= history[0].content.length + history[1].content.length; history.splice(0, 2);
    }
    return [{ role: 'system', content: cfg.systemPrompt }, ...history, { role: 'user', content: input }];
  }
  commit(key, input, answer, cfg = this.limits, meta = {}) {
    const existing = this.db.prepare('SELECT enabled FROM sessions WHERE key=?').get(key);
    if (existing && !existing.enabled) return;
    const messages = [...this.history(key), { role: 'user', content: input }, { role: 'assistant', content: answer }];
    while (messages.length > cfg.historyRounds * 2 || (messages.length > 2 && messages.reduce((n, item) => n + item.content.length, 0) > cfg.maxContextChars)) messages.splice(0, 2);
    const serialized = JSON.stringify(messages);
    const id = createHash('sha256').update(key).digest('hex').slice(0, 24);
    this.db.prepare(`INSERT INTO sessions(key,id,kind,target_id,sender_id,prompt_id,updated_at,messages,bytes)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET updated_at=excluded.updated_at,messages=excluded.messages,bytes=excluded.bytes`).run(
      key, id, meta.kind || 'c2c', meta.targetId || '', meta.senderId || '', meta.promptId || 'general', this.now(), serialized, Buffer.byteLength(serialized));
    this.prune(); this.enforceLimits();
  }
  enforceLimits() {
    let stats = this.stats();
    const remove = this.db.prepare('DELETE FROM sessions WHERE key=?');
    if (stats.sessions > this.limits.maxSessions || stats.logicalBytes > this.limits.maxMemoryBytes) {
      for (const row of this.db.prepare('SELECT key,bytes FROM sessions ORDER BY updated_at ASC').iterate()) {
        remove.run(row.key); stats.sessions--; stats.logicalBytes -= row.bytes;
        if (stats.sessions <= this.limits.maxSessions && stats.logicalBytes <= this.limits.maxMemoryBytes) break;
      }
    }
  }
  applyLimits() {
    const cfg = this.limits;
    const update = this.db.prepare('UPDATE sessions SET messages=?,bytes=? WHERE key=?');
    for (const row of this.db.prepare('SELECT key,messages FROM sessions').all()) {
      const messages = JSON.parse(row.messages);
      while (messages.length > cfg.historyRounds * 2 || (messages.length > 2 && messages.reduce((n, item) => n + item.content.length, 0) > cfg.maxContextChars)) messages.splice(0, 2);
      const text = JSON.stringify(messages);
      if (text !== row.messages) update.run(text, Buffer.byteLength(text), row.key);
    }
    this.prune(true); this.enforceLimits();
  }
  reset(key) { this.db.prepare("UPDATE sessions SET messages='[]',bytes=2 WHERE key=?").run(key); }
  stats() {
    const row = this.db.prepare('SELECT count(*) AS sessions,coalesce(sum(bytes),0) AS logicalBytes,coalesce(sum(enabled=0),0) AS disabled FROM sessions').get();
    let diskBytes = 0;
    for (const path of [this.path, `${this.path}-wal`, `${this.path}-shm`]) { try { diskBytes += statSync(path).size; } catch {} }
    return { ...row, diskBytes };
  }
  list({ query = '', page = 1, limit = 30 } = {}) {
    this.prune();
    const pattern = `%${query.slice(0, 100)}%`;
    const where = 'WHERE alias LIKE ? OR sender_id LIKE ? OR target_id LIKE ?';
    const total = this.db.prepare(`SELECT count(*) AS n FROM sessions ${where}`).get(pattern, pattern, pattern).n;
    const rows = this.db.prepare(`SELECT id,kind,target_id AS targetId,sender_id AS senderId,prompt_id AS promptId,alias,enabled,updated_at AS updatedAt,bytes,json_array_length(messages)/2 AS rounds FROM sessions ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(pattern, pattern, pattern, limit, (page - 1) * limit);
    return { total, rows };
  }
  detail(id) {
    const row = this.db.prepare('SELECT id,alias,kind,sender_id AS senderId,target_id AS targetId,prompt_id AS promptId,enabled,messages,updated_at AS updatedAt,bytes FROM sessions WHERE id=?').get(id);
    if (!row) throw new Error('找不到这条记忆。');
    row.messages = row.updatedAt <= this.now() - this.limits.sessionTtlMs ? [] : JSON.parse(row.messages);
    return row;
  }
  edit(id, { alias, enabled, clear = false }) {
    if (!this.db.prepare('SELECT id FROM sessions WHERE id=?').get(id)) throw new Error('找不到这条记忆。');
    if (alias !== undefined && (typeof alias !== 'string' || alias.length > 80)) throw new Error('备注最多 80 字符。');
    if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('开关格式错误。');
    if (alias !== undefined) this.db.prepare('UPDATE sessions SET alias=? WHERE id=?').run(alias, id);
    if (enabled !== undefined) this.db.prepare('UPDATE sessions SET enabled=? WHERE id=?').run(Number(enabled), id);
    if (clear) this.db.prepare("UPDATE sessions SET messages='[]',bytes=2 WHERE id=?").run(id);
  }
  clearAll() { return Number(this.db.prepare("UPDATE sessions SET messages='[]',bytes=2 WHERE bytes>2").run().changes); }
  delete(id) { this.db.prepare('DELETE FROM sessions WHERE id=?').run(id); }
  compact() { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);'); }
  backup(path) { this.db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`); }
  close() { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.db.close(); }
}
