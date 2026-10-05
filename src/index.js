import { resolve } from 'node:path';
import { projectRoot } from './config.js';
import { SettingsStore } from './settings.js';
import { MemoryDatabase } from './memory-db.js';
import { BotRuntime } from './runtime.js';

// 无界面运行也使用相同的配置和持久化记忆，请勿与控制台同时启动。
let memory, runtime;
try {
  const settings = new SettingsStore();
  memory = new MemoryDatabase(resolve(projectRoot, 'data/memory.sqlite'), () => settings.value.limits);
  runtime = new BotRuntime(settings, memory);
  runtime.output = console;
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => runtime.stop());
  runtime.start();
  await runtime.running;
  if (runtime.state === 'error') process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { await runtime?.stop(); memory?.close(); }
