import { fileURLToPath } from 'node:url';
import { manifest, createPlugin } from '../../plugins/reminders/index.js';
// 明确注册可信的本地插件；不从聊天消息或远程地址加载可执行代码。
export const PLUGINS = [{manifest,createPlugin,root:fileURLToPath(new URL('../../plugins/reminders/',import.meta.url))}];
