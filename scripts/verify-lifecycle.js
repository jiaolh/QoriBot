import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../src/config.js';
import { SessionStore } from '../src/sessions.js';
import { BotRuntime } from '../src/runtime.js';

if (!global.gc) throw new Error('请使用内置 Node 加 --expose-gc 运行本工具。');
const config = readConfig({QQ_APP_ID:'fake-id',QQ_APP_SECRET:'fake-secret',LLM_API_KEY:'fake-key',LLM_MODEL:'deepseek-flash'});
const settings = {value:{qq:config.qq,providers:[config.llm]},runtime:()=>structuredClone(config)};
const originalFetch = global.fetch;
global.fetch = async () => { throw new TypeError('fetch failed', {cause:Object.assign(new Error('blocked'),{code:'EACCES'})}); };
let now=Date.now();
const runtime = new BotRuntime(settings, new SessionStore(config.chat),{now:()=>now});
const references = []; const samples = [];
try {
  for (let batch=0; batch<6; batch++) {
    for (let i=0; i<500; i++) {
      now+=6000;
      runtime.start(); references.push(new WeakRef(runtime.bot));
      await runtime.running;
      assert.equal(runtime.bot,null); assert.equal(runtime.chat,null);
    }
    await delay(0); global.gc(); await delay(0); global.gc();
    const memory=process.memoryUsage();
    samples.push({attempts:(batch+1)*500,heapMB:+(memory.heapUsed/1048576).toFixed(2),rssMB:+(memory.rss/1048576).toFixed(2),resources:process.getActiveResourcesInfo()});
  }
  const retained = references.filter(ref=>ref.deref()).length;
  console.log(JSON.stringify({samples,retainedBotInstances:retained,logEntries:runtime.logs.length},null,2));
  assert.ok(retained<=1,'失败连接后不应保留历史机器人实例');
  assert.ok(samples.at(-1).heapMB-samples[2].heapMB<3,'预热后堆内存不应随连接次数持续增长');
} finally { global.fetch=originalFetch; await runtime.stop(); }
