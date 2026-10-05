import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readAppConfig } from '../src/settings.js';
import { LLMClient } from '../src/llm.js';
import { SessionStore } from '../src/sessions.js';

try {
  const config = readAppConfig({ requireQQ: false });
  const shutdown = new AbortController();
  const llm = new LLMClient(config.llm, { signal: shutdown.signal });
  const sessions = new SessionStore(config.chat);
  const rl = createInterface({ input: stdin, output: stdout });
  rl.on('SIGINT', () => { shutdown.abort(); rl.close(); });
  console.log(`本地大模型测试，当前模型：${config.llm.model}`);
  console.log('发送文字测试对话；/reset 清空记忆；/exit 退出。此工具不连接 QQ。');
  try {
    while (!shutdown.signal.aborted) {
      let input;
      try { input = (await rl.question('\n你：')).trim(); } catch { break; }
      if (!input) continue;
      if (input === '/exit') break;
      if (['/reset', '/重置'].includes(input)) { sessions.reset('local'); console.log('会话已重置。'); continue; }
      if (input.length > config.chat.maxInputChars) { console.log(`请控制在 ${config.chat.maxInputChars} 字符以内。`); continue; }
      try {
        const answer = await llm.complete(sessions.messages('local', input));
        console.log(`\n机器人：${answer}`);
        sessions.commit('local', input, answer);
      } catch (error) { console.error(error.message); }
    }
  } finally { shutdown.abort(); rl.close(); }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
