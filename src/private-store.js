import { privatePolicy, validPrivateId } from './private-config.js';
import { isQuiet } from './group-config.js';
import { LLMError } from './llm.js';

const dayAt = now => new Date(now + 8 * 3600000).toISOString().slice(0, 10);

export class PrivateStore {
  constructor(memory, settings, now = Date.now) {
    this.memory = memory; this.db = memory.db; this.settings = settings; this.now = now; this.lastPrune = 0;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS private_channels (user_id TEXT PRIMARY KEY, last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS private_reply_counts (user_id TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS private_replies_time ON private_reply_counts(user_id,at);
      CREATE TABLE IF NOT EXISTS private_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, day TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        estimated INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'pending');
      CREATE INDEX IF NOT EXISTS private_calls_day ON private_calls(day,user_id);
      INSERT OR IGNORE INTO private_channels(user_id,last_seen)
        SELECT target_id,max(updated_at) FROM sessions WHERE kind='c2c' AND target_id<>'' GROUP BY target_id LIMIT 1000;
      INSERT OR IGNORE INTO private_channels(user_id,last_seen)
        SELECT target_id,max(updated_at) FROM profiles WHERE kind='c2c' AND target_id<>'' GROUP BY target_id LIMIT 1000;
    `);
    this.prune();
  }
  policy(id) { return privatePolicy(this.settings.value.privateChat, id); }
  discover(id) {
    this.prune();
    if (!validPrivateId(id)) return false;
    if (!this.db.prepare('SELECT 1 FROM private_channels WHERE user_id=?').get(id) && this.db.prepare('SELECT count(*) AS n FROM private_channels').get().n >= 1000) return false;
    this.db.prepare('INSERT INTO private_channels VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET last_seen=excluded.last_seen').run(id, this.now());
    return true;
  }
  repliesHour(id) { return this.db.prepare('SELECT count(*) AS n FROM private_reply_counts WHERE user_id=? AND at>?').get(id, this.now() - 3600000).n; }
  gate(id) {
    const policy = this.policy(id);
    if (!policy.enabled || isQuiet(policy, this.now())) return 'silent';
    if (policy.maxRepliesHour && this.repliesHour(id) >= policy.maxRepliesHour) return 'hour';
    const last = this.db.prepare('SELECT max(at) AS at FROM private_reply_counts WHERE user_id=?').get(id).at;
    if (last !== null && this.now() - last < (policy.cooldownMs ?? this.settings.value.limits.cooldownMs)) return 'cooldown';
    return '';
  }
  sent(id) { this.db.prepare('INSERT INTO private_reply_counts VALUES(?,?)').run(id, this.now()); }
  usedToday(id) { return this.db.prepare('SELECT coalesce(sum(input_tokens+output_tokens),0) AS n FROM private_calls WHERE day=?' + (id === undefined ? '' : ' AND user_id=?')).get(dayAt(this.now()), ...(id === undefined ? [] : [id])).n; }
  stats() {
    const ids = new Set([...this.db.prepare('SELECT user_id FROM private_channels LIMIT 1000').all().map(row => row.user_id), ...Object.keys(this.settings.value.privateChat.users)]);
    return { users: ids.size, todayTokens: this.usedToday() };
  }
  estimate(messages, maxTokens) { return messages.reduce((n, m) => n + Buffer.byteLength(m.content || '', 'utf8') + 16, 32) + maxTokens; }
  checkBudget(id, messages, maxTokens) {
    const limit = this.policy(id).dailyTokenLimit;
    if (limit && this.usedToday(id) + this.estimate(messages, maxTokens) > limit) throw new LLMError('这位用户今日私聊模型预算已达到上限，请在个人模式页调整预算。');
  }
  reserve(id, messages, maxTokens) {
    this.prune();
    const result = this.db.prepare('INSERT INTO private_calls(user_id,day,input_tokens,output_tokens) VALUES(?,?,?,?)').run(id, dayAt(this.now()), this.estimate(messages, 0), maxTokens);
    return Number(result.lastInsertRowid);
  }
  settle(id, usage, state) {
    if (usage) this.db.prepare('UPDATE private_calls SET input_tokens=?,output_tokens=?,estimated=0,state=? WHERE id=?').run(usage.inputTokens, usage.outputTokens, state, id);
    else this.db.prepare('UPDATE private_calls SET state=? WHERE id=?').run(state, id);
  }
  list(query = '') {
    this.prune(); this.memory.prune();
    const ids = new Set([...this.db.prepare('SELECT user_id FROM private_channels ORDER BY last_seen DESC LIMIT 1000').all().map(row => row.user_id), ...Object.keys(this.settings.value.privateChat.users)]);
    const rows = [...ids].filter(validPrivateId).map(id => ({ userId: id, policy: this.policy(id),
      lastSeen: this.db.prepare('SELECT last_seen AS at FROM private_channels WHERE user_id=?').get(id)?.at || 0,
      ...this.db.prepare("SELECT count(*) AS sessions,coalesce(sum(json_array_length(messages)/2),0) AS rounds,coalesce(sum(bytes),0) AS bytes FROM sessions WHERE kind='c2c' AND target_id=?").get(id),
      repliesHour: this.repliesHour(id), todayTokens: this.usedToday(id),
    }));
    const search = query.slice(0, 100).toLowerCase();
    return rows.filter(row => (row.userId + '\n' + row.policy.alias).toLowerCase().includes(search));
  }
  detail(id) {
    if (!validPrivateId(id)) throw new Error('私聊用户标识格式错误。');
    if (!Object.hasOwn(this.settings.value.privateChat.users, id) && !this.db.prepare('SELECT 1 FROM private_channels WHERE user_id=?').get(id)) throw new Error('这位用户尚未发现，请先保存私聊设置。');
    this.memory.prune();
    const sessions = this.db.prepare("SELECT id FROM sessions WHERE kind='c2c' AND target_id=? ORDER BY updated_at DESC").all(id).map(row => this.memory.detail(row.id));
    return { userId: id, policy: this.policy(id), sessions,
      profileId: this.db.prepare("SELECT id FROM profiles WHERE kind='c2c' AND target_id=? AND sender_id=?").get(id, id)?.id || '',
    };
  }
  clear(id) {
    this.detail(id);
    return Number(this.db.prepare("UPDATE sessions SET messages='[]',bytes=2 WHERE kind='c2c' AND target_id=? AND bytes>2").run(id).changes);
  }
  prune() {
    if (this.now() - this.lastPrune < 60000) return;
    this.db.prepare('DELETE FROM private_reply_counts WHERE at<=?').run(this.now() - 3600000);
    this.db.prepare('DELETE FROM private_calls WHERE day<?').run(dayAt(this.now() - 30 * 86400000));
    this.lastPrune = this.now();
  }
}
