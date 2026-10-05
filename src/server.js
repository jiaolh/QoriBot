import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot } from './config.js';
import { SettingsStore, SEARCH_DOCS } from './settings.js';
import { MemoryDatabase } from './memory-db.js';
import { BotRuntime } from './runtime.js';
import { ProjectStorage, contained } from './storage.js';
import { LLMClient } from './llm.js';
import { LOCAL_USER } from './profile-memory.js';

async function jsonBody(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('请求需要 JSON 格式。');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length; if (size > 300000) throw new Error('请求内容过大。'); chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new Error('JSON 格式错误。'); }
}

export async function createControlPanel({ root = projectRoot, port = 17860 } = {}) {
  const settings = new SettingsStore(root);
  const memory = new MemoryDatabase(resolve(root, 'data/memory.sqlite'), () => settings.value.limits);
  const runtime = new BotRuntime(settings, memory);
  const profiles = runtime.profiles;
  const storage = new ProjectStorage(root);
  const token = randomBytes(32).toString('hex');
  const assets = new Map([
    ['/', { type: 'text/html; charset=utf-8', content: readFileSync(resolve(projectRoot, 'ui/index.html'), 'utf8').replace('__LOCAL_TOKEN__', token) }],
    ['/style.css', { type: 'text/css; charset=utf-8', content: readFileSync(resolve(projectRoot, 'ui/style.css')) }],
    ['/app.js', { type: 'text/javascript; charset=utf-8', content: readFileSync(resolve(projectRoot, 'ui/app.js')) }],
    ['/profiles.js', { type: 'text/javascript; charset=utf-8', content: readFileSync(resolve(projectRoot,'ui/profiles.js')) }],
    ['/groups.js', { type: 'text/javascript; charset=utf-8', content: readFileSync(resolve(projectRoot,'ui/groups.js')) }],
    ['/favicon.svg', { type: 'image/svg+xml', content: readFileSync(resolve(projectRoot, 'ui/favicon.svg')) }],
  ]);
  for(const path of ['/app.js','/profiles.js','/groups.js','/style.css','/favicon.svg']) assets.get('/').content=assets.get('/').content.replace(`"${path}"`,`"${path}?v=${createHash('sha256').update(assets.get(path).content).digest('hex').slice(0,12)}"`);
  const startedAt = Date.now(); let cpu = process.cpuUsage(), cpuAt = performance.now(), cpuPercent = 0;
  const assertIdle = () => { if (runtime.activeRequests) throw new Error('有回答或长期记忆正在整理，请等它完成或停止后再管理记忆。'); };
  const redact = message => {
    for (const secret of [settings.value.qq.appSecret,...settings.value.providers.map(item=>item.apiKey)].filter(Boolean)) message=message.split(secret).join('[已隐藏]');
    return message;
  };
  const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  let origin;
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') { json(res, { error: '只接受本机控制台访问。' }, 403); return; }
      const url = new URL(req.url, origin);
      const path = url.pathname;
      if (!path.startsWith('/api/')) {
        const asset = assets.get(path);
        if (!asset || req.method !== 'GET') { json(res, { error: '页面不存在。' }, 404); return; }
        res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': path === '/' ? 'no-store' : 'public,max-age=600' }); res.end(asset.content); return;
      }
      if (req.method !== 'GET' && req.headers['x-local-token'] !== token) { json(res, { error: '控制台验证已过期，请刷新页面。' }, 403); return; }
      if (path === '/api/settings' && req.method === 'GET') { json(res, settings.public()); return; }
      if (path === '/api/settings' && req.method === 'PUT') {
        const patch = await jsonBody(req);
        if (patch.qq && runtime.bot) throw new Error('修改 QQ 接入配置前请先停止机器人。');
        if (patch.limits) assertIdle();
        const old = structuredClone(settings.value);
        try {
          settings.update(patch); if (runtime.bot) settings.runtime();
          if(patch.limits && (profiles.stats().bytes>settings.value.limits.maxProfileBytes || profiles.db.prepare('SELECT coalesce(max(length(notes)),0) AS n FROM profiles').get().n>settings.value.limits.userMemoryChars)) throw new Error('已有长期资料超过新的上限，请先编辑资料再降低上限。');
        }
        catch (error) { settings.persist(old); settings.value = old; throw error; }
        if (patch.limits) memory.applyLimits();
        if (patch.groupChat || patch.prompts || patch.providers || patch.activePromptId || patch.activeProviderId) {
          runtime.groupService.cancelAll(); runtime.groups.prune(true);
          for (const row of profiles.db.prepare("SELECT id FROM profiles WHERE kind='group'").all()) runtime.learner.cancel(row.id);
        }
        runtime.log('info', '配置已保存，新的模型请求将使用当前 API 和提示词。');
        json(res, settings.public()); return;
      }
      if (path === '/api/status' && req.method === 'GET') {
        const now = performance.now();
        if (now - cpuAt > 1000) { const delta = process.cpuUsage(cpu); cpuPercent = (delta.user + delta.system) / ((now - cpuAt) * 1000) * 100; cpu = process.cpuUsage(); cpuAt = now; }
        memory.prune();
        json(res, {
          bot: { state: runtime.state, startedAt: runtime.startedAt, activeRequests: runtime.activeRequests, retryAfterMs: runtime.retryAfterMs, error: redact(runtime.lastError) },
          process: { rss: process.memoryUsage().rss, heap: process.memoryUsage().heapUsed, cpu: Math.round(cpuPercent * 10) / 10, uptimeMs: Date.now() - startedAt, node: process.versions.node },
          memory: memory.stats(), storage: await storage.stats(), usage: runtime.counters,
          profiles: profiles.stats(), memoryLearning: {active:runtime.learner.activeRequests,queued:runtime.learner.queue.size},
          groups: runtime.groups.stats(),
          logs: runtime.logs.slice(-80), searchDocs: SEARCH_DOCS,
        }); return;
      }
      if (path === '/api/bot/start' && req.method === 'POST') { runtime.start(); json(res, { state: runtime.state }); return; }
      if (path === '/api/bot/stop' && req.method === 'POST') { await runtime.stop(); json(res, { state: runtime.state }); return; }
      if (path === '/api/test-chat' && req.method === 'POST') { const body = await jsonBody(req); json(res, await runtime.testChat(body.input)); return; }
      if (path === '/api/groups' && req.method === 'GET') { json(res, { rows: runtime.groups.list(), stats: runtime.groups.stats() }); return; }
      const groupMatch = path.match(/^\/api\/groups\/([^/]+)(?:\/(clear|summary|join))?$/);
      if (groupMatch) {
        const id = decodeURIComponent(groupMatch[1]);
        if (!id || id.length > 150 || ['__proto__','constructor','prototype'].includes(id)) throw new Error('群标识格式错误');
        if (req.method === 'GET' && !groupMatch[2]) { json(res, { ...runtime.groups.detail(id), participation: runtime.groupService.participationState(id) }); return; }
        if (req.method === 'POST' && groupMatch[2] === 'clear') {
          runtime.groupService.cancel(id);
          for (const row of profiles.db.prepare("SELECT id FROM profiles WHERE kind='group' AND target_id=?").all(id)) runtime.learner.cancel(row.id);
          runtime.groups.clear(id); json(res, { ok: true }); return;
        }
        if (req.method === 'POST' && groupMatch[2] === 'summary') { await runtime.groupService.requestSummary(id); json(res, runtime.groups.detail(id)); return; }
        if (req.method === 'POST' && groupMatch[2] === 'join') { runtime.groups.channel(id); json(res, await runtime.groupService.requestParticipation(id)); return; }
      }
      if (path === '/api/models' && req.method === 'POST') {
        const body = await jsonBody(req); const provider = settings.value.providers.find(item => item.id === body.providerId);
        if (!provider?.apiKey) throw new Error('请先保存该配置的 API Key。');
        if(runtime.activeRequests>=settings.value.limits.maxConcurrent) throw new Error('请求较多，请稍后再试。');
        const controller=new AbortController(); runtime.testControllers.add(controller); runtime.activeTests++;
        try { const llm = new LLMClient({ ...provider, timeoutMs: 15000 },{signal:controller.signal}); json(res, { models: await llm.listModels() }); }
        finally {runtime.activeTests--;runtime.testControllers.delete(controller);runtime.learner.pump();} return;
      }
      if(path==='/api/profiles' && req.method==='GET') {
        const page=Number(url.searchParams.get('page')||1); if(!Number.isInteger(page)||page<1||page>100000) throw new Error('页码错误。');
        json(res,profiles.list({query:url.searchParams.get('q')||'',page}));return;
      }
      if(path==='/api/profiles/local' && req.method==='POST') { json(res,profiles.get(profiles.ensure(LOCAL_USER)));return; }
      const learnMatch = path.match(/^\/api\/profiles\/([a-f0-9]{24})\/learn$/);
      if (learnMatch && req.method === 'POST') {
        const row = profiles.get(learnMatch[1]);
        if (!row.enabled) throw new Error('请先启用这位用户的长期资料');
        let messages = row.kind === 'group' ? runtime.groups.context(row.targetId, { senderId: row.senderId, after: row.forgottenBefore, windowMs: settings.value.groupChat.messageTtlMs }).map(m => ({ text:m.content,at:m.receivedAt,messageId:m.messageId,groupId:row.targetId })) : [];
        if (!messages.length && (row.kind !== 'group' || !runtime.groups.limits.groups[row.targetId] || runtime.groups.limits.groups[row.targetId].mode === 'light')) {
          messages = profiles.db.prepare('SELECT messages,updated_at AS at FROM sessions WHERE kind=? AND target_id=? AND sender_id=? AND updated_at>? ORDER BY updated_at DESC LIMIT 10').all(row.kind,row.targetId,row.senderId,Math.max(row.forgottenBefore,Date.now()-settings.value.limits.sessionTtlMs))
            .flatMap(s=>JSON.parse(s.messages).filter(m=>m.role==='user').slice(row.forgottenBefore?-1:-10).map(m=>({text:m.content,at:s.at})));
        }
        if (!messages.length) throw new Error('没有尚未过期、且晚于清空或手动修改的用户陈述');
        runtime.learner.resume(); runtime.learner.observe(row.id,messages.at(-1).text,row.kind==='group'?settings.groupRuntime(row.targetId):settings.runtime({requireQQ:false}),messages,{force:true});
        json(res,{ok:true});return;
      }
      const profileMatch=path.match(/^\/api\/profiles\/([a-f0-9]{24})(\/export)?$/);
      if(profileMatch) {
        const id=profileMatch[1];
        if(req.method==='GET'){json(res,profiles.get(id));return;}
        if(profileMatch[2] && req.method==='POST') {
          const name=`user-memory-${id}-${Date.now()}.md`;mkdirSync(resolve(root,'exports'),{recursive:true});
          writeFileSync(contained(root,`exports/${name}`),profiles.get(id).notes,{mode:0o600});storage.cached=null;json(res,{path:`exports/${name}`});return;
        }
        assertIdle();runtime.learner.cancel(id);
        if(req.method==='PATCH'){profiles.edit(id,await jsonBody(req));json(res,{ok:true});return;}
        if(req.method==='DELETE'){profiles.remove(id);json(res,{ok:true});return;}
      }
      if (path === '/api/memory' && req.method === 'GET') {
        const page = Number(url.searchParams.get('page') || 1);
        if (!Number.isInteger(page) || page < 1 || page > 100000) throw new Error('页码错误。');
        json(res, memory.list({ query: url.searchParams.get('q') || '', page })); return;
      }
      if (path === '/api/memory/clear' && req.method === 'POST') { assertIdle(); json(res, { cleared: memory.clearAll() }); return; }
      if (path === '/api/memory/compact' && req.method === 'POST') { assertIdle(); memory.compact(); storage.cached = null; json(res, { ok: true }); return; }
      const memoryMatch = path.match(/^\/api\/memory\/([a-f0-9]{24})(\/export)?$/);
      if (memoryMatch) {
        const id = memoryMatch[1];
        if (memoryMatch[2] && req.method === 'POST') {
          const name = `memory-${id}-${Date.now()}.json`;
          const destination = contained(root, `exports/${name}`);
          mkdirSync(resolve(root, 'exports'), { recursive: true });
          writeFileSync(destination, JSON.stringify(memory.detail(id), null, 2), { mode: 0o600 });
          storage.cached = null; json(res, { path: `exports/${name}` }); return;
        }
        if (req.method === 'GET') {
          const value = memory.detail(id);
          if (memoryMatch[2]) res.setHeader('Content-Disposition', `attachment; filename="memory-${id}.json"`);
          json(res, value); return;
        }
        assertIdle();
        if (req.method === 'PATCH') { memory.edit(id, await jsonBody(req)); json(res, { ok: true }); return; }
        if (req.method === 'DELETE') { memory.delete(id); json(res, { ok: true }); return; }
      }
      if (path === '/api/storage/cleanup' && req.method === 'POST') {
        const { scope } = await jsonBody(req); storage.cleanup(scope); json(res, await storage.stats(true)); return;
      }
      if (path === '/api/storage/refresh' && req.method === 'POST') { json(res, await storage.stats(true)); return; }
      if (path === '/api/backup' && req.method === 'POST') {
        assertIdle();
        const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
        const destination = contained(root, `backups/${name}`); mkdirSync(destination, { recursive: true });
        memory.backup(resolve(destination, 'memory.sqlite')); runtime.groups.sanitizeBackup(resolve(destination,'memory.sqlite')); writeFileSync(resolve(destination, 'settings.json'), JSON.stringify(settings.value, null, 2), { mode: 0o600 });
        if(existsSync(profiles.root)) cpSync(profiles.root,resolve(destination,'users'),{recursive:true});
        writeFileSync(resolve(destination, 'README.txt'), '恢复前关闭控制台和机器人。将本目录的 settings.json、memory.sqlite 和 users 文件夹复制到项目 data 目录。先将现有 data 完整保存，再移走旧 users 与 SQLite 的 -wal/-shm 文件，避免旧内容覆盖恢复结果。此备份包含密钥，请自行保管。\n');
        storage.cached = null; json(res, { path: `backups/${name}` }); return;
      }
      if (path === '/api/shutdown' && req.method === 'POST') { json(res, { ok: true }); setTimeout(() => close(), 100).unref(); return; }
      json(res, { error: '接口不存在。' }, 404);
    } catch (error) {
      const message = redact(error.message || '操作失败。');
      json(res, { error: message }, 400);
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const pruneTimer = setInterval(() => { runtime.groups.prune(true); memory.prune(); }, 60000); pruneTimer.unref();
  let closing;
  async function close() {
    if (closing) return closing;
    closing = (async () => { clearInterval(pruneTimer); await runtime.stop(); await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }); memory.close(); })();
    return closing;
  }
  return { server, origin, token, settings, memory, profiles, runtime, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createControlPanel().then(panel => {
    console.log(`\nQQBot 本地控制台：${panel.origin}\n只接受本机访问。关闭网页后机器人可继续运行；退出程序请在界面操作或按 Ctrl+C。\n`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { panel.close().then(() => process.exit(0)); });
  }).catch(error => { console.error(error.code === 'EADDRINUSE' ? '控制台已经运行，请打开 http://127.0.0.1:17860 。' : `控制台启动失败：${error.message}`); process.exitCode = 1; });
}
