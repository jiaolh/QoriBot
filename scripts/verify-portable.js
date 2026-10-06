import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, renameSync, readdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectRoot } from '../src/config.js';

const cache = resolve(projectRoot, '.cache');
mkdirSync(cache, { recursive: true });
const fixture = mkdtempSync(join(cache, 'migration-'));
assert.ok(relative(cache, fixture).startsWith('migration-'));
let root = join(fixture, 'original');
function run(node, args, cwd) {
  const result = spawnSync(node, args, { cwd, encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  return result.stdout;
}
try {
  mkdirSync(root);
  for (const path of ['runtime', 'node_modules', 'src', 'ui', 'plugins', 'scripts', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']) cpSync(resolve(projectRoot, path), join(root, path), { recursive: true });
  const queue = [root];
  while (queue.length) for (const entry of readdirSync(queue.pop(), { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false, '迁移副本不得依赖外部链接');
    if (entry.isDirectory()) queue.push(join(entry.parentPath, entry.name));
  }
  run(join(root, 'runtime/node/node.exe'), ['--input-type=module', '-e', `
    import {createControlPanel} from './src/server.js';
    const panel = await createControlPanel({port:0});
    try {
      panel.settings.update({qq:{appId:'test-app',appSecret:'fake-secret'},providers:panel.settings.public().providers.map(p=>({...p,apiKey:'fake-portable-key'})),activePromptId:'coding'});
      panel.memory.commit('portable-user: coding','测试问题','测试回答',panel.settings.value.limits,{senderId:'portable-user',promptId:'coding'});
      const {LOCAL_USER}=await import('./src/profile-memory.js');
      panel.profiles.edit(panel.profiles.ensure(LOCAL_USER),{notes:'- 迁移后仍使用中文'});
      panel.runtime.plugins.targets.remember('group','portable-group','迁移测试群');
      panel.runtime.plugins.entries.get('reminders').instance.create({timeType:'relative',when:'1天',content:'迁移后保留预约'},{scope:'group',targetId:'portable-group',creatorId:'portable-user',sourceId:'portable-reminder'});
    } finally { await panel.close(); }
  `], root);
  const moved = join(fixture, '迁移后的目录 with spaces');
  renameSync(root, moved); root = moved;
  const node = join(root, 'runtime/node/node.exe');
  run(node, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {createControlPanel} from './src/server.js';
    const panel = await createControlPanel({port:0});
    try {
      const settings = await (await fetch(panel.origin+'/api/settings')).json();
      const status = await (await fetch(panel.origin+'/api/status')).json();
      const html = await (await fetch(panel.origin)).text();
      assert.equal(settings.activePromptId,'coding');
      assert.equal(status.memory.sessions,1);
      assert.ok(html.includes('提示词工作室'));
      assert.ok(html.includes('QoriBot') && html.includes('page-reminders'));
      const reminders=await (await fetch(panel.origin+'/api/plugins/reminders/tasks')).json();
      assert.equal(reminders.total,1);
      assert.equal(reminders.rows[0].content,'迁移后保留预约');
      assert.equal(reminders.rows[0].targetId,'portable-group');
      assert.equal(reminders.rows[0].state,'active');
      assert.equal((await fetch(panel.origin+'/plugins/reminders.js')).status,200);
      assert.equal(panel.memory.history('portable-user: coding')[1].content,'测试回答');
      const {LOCAL_USER}=await import('./src/profile-memory.js');
      assert.equal(panel.profiles.notes(LOCAL_USER).notes,'- 迁移后仍使用中文');
      assert.ok(panel.settings.path.startsWith(process.cwd()));
      console.log('迁移后服务、配置、记忆、插件预约和界面均正常。');
    } finally { await panel.close(); }
  `], root);
  assert.match(run(node, [join(root, 'runtime/tools/pnpm/bin/pnpm.cjs'), '--version'], root), /11\.19\.0/);
  assert.match(run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/run.ps1'), 'check'], root), /deepseek-flash/);
  console.log('便携验证通过：内置 Node 与 pnpm、无外部目录链接、中文及空格路径、移动后数据保留、启动脚本可用。');
} finally { rmSync(fixture, { recursive: true, force: true }); }
