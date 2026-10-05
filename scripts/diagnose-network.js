import { TokenManager, MessageApi, ApiClient } from '@tencent-connect/qqbot-nodejs/protocol';
import { SettingsStore } from '../src/settings.js';

const settings = new SettingsStore();
function code(error) {
  for (let item = error; item; item = item.cause) if (item.code) return item.code;
  return 'UNKNOWN';
}
try {
  const response = await fetch(settings.value.qq.baseUrl, { signal: AbortSignal.timeout(8000), redirect: 'error' });
  await response.body?.cancel();
  console.log(`QQ 官方域名可访问（HTTP ${response.status}；根路径 404 属于正常连通结果）。`);
} catch (error) {
  console.error(`QQ 网络检查失败：${code(error)}。`);
  process.exitCode = 1;
}
if (!process.exitCode && process.argv.includes('--qq-auth')) {
  const qq = settings.value.qq;
  if (!qq.appId || !qq.appSecret) throw new Error('请先保存 QQ 凭证。');
  const tokenManager = new TokenManager({ baseUrl: qq.baseUrl });
  try {
    const token = await tokenManager.getAccessToken(qq.appId, qq.appSecret);
    console.log('QQ 应用鉴权通过（不显示 Token 或密钥）。');
    const api = new MessageApi(new ApiClient({ baseUrl: qq.baseUrl }), tokenManager, { markdownSupport: false });
    const gateway = new URL(await api.getGatewayUrl({ appId: qq.appId, clientSecret: qq.appSecret }));
    console.log(`QQ 网关查询通过：${gateway.hostname}。`);
  } catch (error) {
    const status = error.httpStatus || error.message?.match(/HTTP\s+(\d+)/)?.[1];
    console.error(`QQ 鉴权或网关检查失败：${status ? 'HTTP ' + status : code(error)}。`);
    process.exitCode = 1;
  } finally { tokenManager.stopBackgroundRefresh(); tokenManager.clearCache(); }
}
