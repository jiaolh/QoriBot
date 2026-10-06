import { readdir, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';

export function contained(root, part) {
  const target = resolve(root, part);
  const path = relative(resolve(root), target);
  if (!path || path === '..' || path.startsWith(`..${sep}`) || resolve(root) === target) throw new Error('不能操作项目目录之外的路径。');
  return target;
}

async function sizeOf(path) {
  let bytes = 0, files = 0;
  const queue = [path];
  while (queue.length) {
    const current = queue.pop();
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = resolve(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile()) { try { const info = await stat(path); bytes += info.size; files++; } catch {} }
    }
  }
  return { bytes, files };
}

export class ProjectStorage {
  constructor(root) { this.root = root; this.cached = null; this.updatedAt = 0; this.fixedStats=new Map(); }
  async stats(force = false) {
    if (!force && this.cached && Date.now() - this.updatedAt < 60000) return this.cached;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const groups = [];
      for (const [name, path, removable] of [
        ['运行环境', 'runtime', false], ['功能依赖', 'node_modules', false], ['配置与记忆', 'data', false],
        ['安装缓存', '.cache', true], ['备份', 'backups', true], ['程序与界面', 'src', false],
        ['界面文件', 'ui', false], ['插件', 'plugins', false], ['维护脚本', 'scripts', false], ['自动测试', 'test', false],
        ['记忆导出', 'exports', false],
      ]) {
        const fixed=['runtime','node_modules','src','ui','plugins','scripts','test'].includes(path);
        const stats=fixed && !force && this.fixedStats.has(path) ? this.fixedStats.get(path) : await sizeOf(resolve(this.root,path));
        if(fixed) this.fixedStats.set(path,stats);groups.push({name,path,removable,...stats});
      }
      let rootBytes = 0, rootFiles = 0;
      for (const entry of await readdir(this.root, { withFileTypes: true })) if (entry.isFile()) {
        try { rootBytes += (await stat(resolve(this.root, entry.name))).size; rootFiles++; } catch {}
      }
      groups.push({ name: '启动、说明与清单', path: '.', removable: false, bytes: rootBytes, files: rootFiles });
      this.cached = { groups, totalBytes: groups.reduce((sum, group) => sum + group.bytes, 0), measuredAt: Date.now() };
      this.updatedAt = Date.now(); return this.cached;
    })();
    try { return await this.pending; } finally { this.pending = null; }
  }
  cleanup(scope) {
    if (!['.cache', 'backups'].includes(scope)) throw new Error('只能清理安装缓存或备份。');
    const path = contained(this.root, scope);
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    mkdirSync(path, { recursive: true });
    this.updatedAt = 0; this.cached = null;
  }
}
