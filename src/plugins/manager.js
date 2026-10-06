import { readFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { PLUGINS } from './registry.js';
import { TargetCatalog } from './targets.js';
import { createToolSession } from './tool-session.js';

export class PluginManager {
  constructor({ db, settings, now = Date.now, sendText, isConnected, log }, entries = PLUGINS) {
    Object.assign(this, { db, settings, now, sendText, isConnected, log });
    this.entries = new Map();
    this.running = false;
    this.targets = new TargetCatalog(db, settings, now);
    for (const entry of entries) {
      const { manifest } = entry;
      if (!/^[a-z][a-z0-9-]{0,40}$/.test(manifest.id) || this.entries.has(manifest.id)) throw new Error('插件标识无效或重复。');
      const context = {
        db, now, targets: this.targets, sendText, isConnected, log,
        enabled: () => this.enabled(manifest.id), maxReplyBytes: () => settings.value.limits.maxReplyBytes,
      };
      this.entries.set(manifest.id, { ...entry, instance: entry.createPlugin(context) });
    }
  }

  enabled(id) { return this.settings.value.plugins?.[id]?.enabled !== false; }

  get activeRequests() {
    return [...this.entries.values()].reduce((count, { instance }) => count + (instance.activeRequests || 0), 0);
  }

  list() {
    return [...this.entries.values()].map(({ manifest, instance }) => ({
      ...manifest, ui: undefined, enabled: this.enabled(manifest.id),
      running: this.running && this.enabled(manifest.id), stats: instance.store?.stats?.() || {},
    }));
  }

  async start() { this.running = true; await this.sync(); }

  async stop() {
    this.running = false;
    await Promise.allSettled([...this.entries.values()].map(({ instance }) => instance.stop?.()));
  }

  async sync() {
    for (const [id, { instance }] of this.entries) {
      if (this.running && this.enabled(id)) await instance.start?.();
      else await instance.stop?.();
    }
  }

  async setEnabled(id, enabled) {
    if (!this.entries.has(id) || typeof enabled !== 'boolean') throw new Error('插件或开关格式错误。');
    this.settings.update({ plugins: { ...this.settings.value.plugins, [id]: { enabled } } });
    await this.sync();
    return this.list();
  }

  help() {
    return [...this.entries].filter(([id]) => this.enabled(id)).map(([, { instance }]) => instance.help?.()).filter(Boolean).join('\n');
  }

  toolSession(message, options) { return createToolSession(this, message, options); }

  assets() {
    let navigation = '', pages = '', scripts = '';
    const assets = [];
    for (const [id, entry] of this.entries) {
      const read = name => {
        const path = resolve(entry.root, name), part = relative(entry.root, path);
        if (!part || part === '..' || part.startsWith('..' + sep)) throw new Error('插件界面路径超出目录。');
        return readFileSync(path, 'utf8');
      };
      const { manifest } = entry;
      if (!manifest.ui) continue;
      // 插件管理页面由插件卡片进入，侧栏只保留统一的插件管理入口。
      pages += read(manifest.ui.html);
      const url = `/plugins/${id}.js`;
      assets.push([url, { type: 'text/javascript; charset=utf-8', content: read(manifest.ui.script) }]);
      scripts += `<script src="${url}" defer></script>`;
    }
    return { navigation, pages, scripts, assets };
  }

  async api({ method, segments, query, body }) {
    if (!segments.length && method === 'GET') return { rows: this.list() };
    const [id, ...rest] = segments, entry = this.entries.get(id);
    if (!entry) throw new Error('插件不存在。');
    if (rest.length === 1 && rest[0] === 'enabled' && method === 'POST') return { rows: await this.setEnabled(id, body?.enabled) };
    if (typeof entry.instance.api !== 'function') throw new Error('插件没有控制台接口。');
    return entry.instance.api({ method, segments: rest, query, body });
  }
}
