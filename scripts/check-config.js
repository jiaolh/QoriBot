import { readAppConfig } from '../src/settings.js';
import { LLMClient } from '../src/llm.js';

try {
  const config = readAppConfig();
  console.log('配置检查通过（未显示密钥）。');
  console.log(`QQ 接入方式：${config.qq.transport}`);
  console.log(`大模型地址：${config.llm.baseUrl}`);
  console.log(`模型：${config.llm.model}`);
  if (process.argv.includes('--remote')) {
    const models = await new LLMClient(config.llm).listModels();
    if (models.includes(config.llm.model)) console.log('模型列表查询成功，当前模型在可用列表中。');
    else {
      console.error(`当前模型 ${config.llm.model} 不在 /models 返回的列表中，请通过 models 工具查询准确名称。`);
      process.exitCode = 1;
    }
  } else console.log('此检查只核对配置格式，尚未连接 QQ 或大模型。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
