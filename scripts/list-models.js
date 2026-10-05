import { readAppConfig } from '../src/settings.js';
import { LLMClient } from '../src/llm.js';

try {
  const config = readAppConfig({ requireQQ: false });
  const models = await new LLMClient(config.llm).listModels();
  if (!models.length) console.log('当前 Key 没有返回可用模型，请在大模型平台检查授权。');
  else {
    console.log('当前 Key 可调用的模型（把名称原样填写到界面的模型名称）：');
    for (const model of models) console.log(`  ${model}`);
    if (config.llm.model && !models.includes(config.llm.model)) {
      console.log(`\n当前填写的 ${config.llm.model} 不在上述列表中，请确认名称。`);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
