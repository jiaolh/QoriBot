export class TargetCatalog {
  constructor(db, settings, now = Date.now) {
    this.db = db;
    this.settings = settings;
    this.now = now;
    this.lastReplyPrune = 0;
    db.exec("CREATE TABLE IF NOT EXISTS plugin_targets(scope TEXT NOT NULL,target_id TEXT NOT NULL,label TEXT NOT NULL DEFAULT '',last_seen INTEGER NOT NULL,PRIMARY KEY(scope,target_id));");
    const columns = new Set(db.prepare('PRAGMA table_info(plugin_targets)').all().map(row => row.name));
    if (!columns.has('reply_msg_id')) db.exec("ALTER TABLE plugin_targets ADD COLUMN reply_msg_id TEXT NOT NULL DEFAULT ''");
    if (!columns.has('reply_at')) db.exec('ALTER TABLE plugin_targets ADD COLUMN reply_at INTEGER NOT NULL DEFAULT 0');
    // 全量群消息会频繁更新目标，复用语句，避免每条消息重复准备 SQL。
    this.known = db.prepare('SELECT 1 FROM plugin_targets WHERE scope=? AND target_id=?');
    this.count = db.prepare('SELECT count(*) AS n FROM plugin_targets');
    this.upsert = db.prepare(`INSERT INTO plugin_targets(scope,target_id,label,last_seen) VALUES(?,?,?,?) ON CONFLICT(scope,target_id) DO UPDATE SET last_seen=excluded.last_seen,label=CASE WHEN excluded.label<>'' THEN excluded.label ELSE label END`);
    this.byId = db.prepare('SELECT scope,target_id AS targetId,label,last_seen AS lastSeen FROM plugin_targets WHERE scope=? AND target_id=?');
    this.all = db.prepare('SELECT scope,target_id AS targetId,label,last_seen AS lastSeen FROM plugin_targets ORDER BY last_seen DESC LIMIT 3000');
    this.saveReply = db.prepare('UPDATE plugin_targets SET reply_msg_id=?,reply_at=? WHERE scope=? AND target_id=? AND reply_at<=?');
    this.latestReply = db.prepare('SELECT reply_msg_id AS msgId,reply_at AS at FROM plugin_targets WHERE scope=? AND target_id=?');
    this.clearReplies = db.prepare("UPDATE plugin_targets SET reply_msg_id='',reply_at=0 WHERE reply_at>0 AND ((scope='group' AND reply_at<=?) OR (scope='c2c' AND reply_at<=?))");
    this.pruneReplies(true);
    const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?");
    for (const table of ['sessions', 'profiles']) if (tableExists.get(table)) {
      for (const row of db.prepare(`SELECT kind,target_id,coalesce(max(alias),'') AS label FROM ${table} WHERE kind IN ('c2c','group') GROUP BY kind,target_id LIMIT 2000`).all()) {
        this.remember(row.kind, row.target_id, row.kind === 'c2c' ? row.label : '');
      }
    }
    if (tableExists.get('group_channels')) {
      for (const row of db.prepare('SELECT group_id FROM group_channels LIMIT 1000').all()) this.remember('group', row.group_id);
    }
  }

  remember(scope, id, label = '') {
    if (!['c2c', 'group'].includes(scope) || typeof id !== 'string' || !id || id.length > 150 || /[\s<>"'\\/]/.test(id)) return;
    if (!this.known.get(scope, id) && this.count.get().n >= 3000) return;
    this.upsert.run(scope, id, String(label || '').slice(0, 100), this.now());
  }

  observe(message) {
    if (!message?.replyTarget || message.senderIsBot || message.raw?.author?.bot || message.replyTarget.scope !== message.kind || message.replyTarget.msgId !== message.messageId) return;
    if (!['c2c', 'group'].includes(message.kind) || typeof message.replyTarget.targetId !== 'string' || !message.replyTarget.targetId || message.replyTarget.targetId.length > 150 || /[\s<>"'\\/]/.test(message.replyTarget.targetId)) return;
    this.remember(message.kind, message.replyTarget.targetId, message.kind === 'c2c' ? message.senderName : '');
    const timestamp = Date.parse(message.timestamp), now = this.now(), at = Math.min(timestamp, now);
    // 与群消息入口保持相同的时钟偏差容忍；用接收时刻截断，不延长回复窗口。
    if (typeof message.messageId !== 'string' || !message.messageId || message.messageId.length > 150 || !Number.isFinite(timestamp) || timestamp > now + 60000 || now - at >= this.replyWindow(message.kind)) return;
    this.saveReply.run(message.messageId, at, message.kind, message.replyTarget.targetId, at);
  }

  replyWindow(scope) { return scope === 'group' ? 240000 : 3300000; }

  pruneReplies(force = false) {
    if (!force && this.now() - this.lastReplyPrune < 60000) return;
    this.clearReplies.run(this.now() - this.replyWindow('group'), this.now() - this.replyWindow('c2c'));
    this.lastReplyPrune = this.now();
  }

  replyTarget(scope, targetId) {
    this.get(scope, targetId);
    this.pruneReplies();
    const row = this.latestReply.get(scope, targetId);
    return { scope, targetId, ...(row?.msgId && row.at <= this.now() && this.now() - row.at < this.replyWindow(scope) ? { msgId: row.msgId } : {}) };
  }

  get(scope, id) {
    const row = this.byId.get(scope, id);
    if (!row) throw new Error('目标尚未被机器人发现，请先私聊机器人或在目标群里 @它。');
    return this.decorate(row);
  }

  decorate(row) {
    const label = (row.scope === 'group' ? this.settings.value.groupChat.groups[row.targetId]?.alias : '') || row.label;
    const short = row.targetId.length > 18 ? row.targetId.slice(0, 8) + '…' + row.targetId.slice(-6) : row.targetId;
    return { ...row, label: label || `${row.scope === 'group' ? '群聊' : '私聊'} ${short}` };
  }

  list() { return this.all.all().map(row => this.decorate(row)); }
}
