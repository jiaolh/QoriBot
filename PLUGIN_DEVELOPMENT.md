# QoriBot 插件接入规范

插件放在 `plugins/<插件ID>/`，由 `src/plugins/registry.js` 明确注册。插件运行在 QoriBot 的同一进程内，使用宿主提供的数据库、模型工具入口和 QQ 发送能力；应只加载可信的本地代码。

## 目录与注册

```text
plugins/example/
├─ index.js       manifest、createPlugin(context) 和生命周期
├─ tools.js       工具定义、参数校验与业务操作（按需）
├─ store.js       插件数据存储（按需）
└─ ui/            控制台页面与脚本（按需）
```

1. 新建插件目录，在 `index.js` 导出 `manifest` 和 `createPlugin(context)`。
2. 在 `src/plugins/registry.js` 导入它们，向 `PLUGINS` 添加注册项：
   ```js
   import { manifest as exampleManifest, createPlugin as createExample } from '../../plugins/example/index.js';

   // 在现有 PLUGINS 定义后添加，保留其他插件。
   PLUGINS.push({ manifest: exampleManifest, createPlugin: createExample,
     root: fileURLToPath(new URL('../../plugins/example/', import.meta.url)) });
   ```
3. 需要管理页面时，按下文注册页面和接口；无页面的插件可省略 `manifest.ui` 及页面字段。
4. 重启服务，在“插件管理”页检查启用状态，并验证工具调用和停止行为。

## 插件声明

```js
export const manifest = {
  id: 'example',
  name: '示例功能',
  version: '1.0.0',
  description: '简要说明功能',
  // 以下字段仅在提供管理页面时填写：
  page: 'example',
  pageTitle: '示例功能',
  navIcon: '◇',
  ui: { html: 'ui/page.html', script: 'ui/example.js' },
};

export function createPlugin(context) {
  return new ExamplePlugin(context);
}
```

插件 ID 使用小写字母开头，只包含小写字母、数字与连字符，最长 41 字符，且不能重复。页面名、DOM ID、工具名和数据库表名使用插件前缀，避免与其他插件冲突。界面文件路径相对于插件目录，不得越出目录。

## 插件实例接口

| 接口 | 约定 |
|---|---|
| `start()` | 机器人启动且插件启用时调用；重复调用不得重复建立定时器或监听器 |
| `stop()` | 机器人停止或插件关闭时调用；清理定时器和监听器，等待已发起操作结束 |
| `tools()` | 返回模型可调用的工具定义数组 |
| `callTool(name, args, owner)` | 执行业务操作，可返回 Promise；必须再次校验参数和用户权限 |
| `summarize(results)` | 可选；根据本次真实结果生成简短文字，供模型后续失败时回复 |
| `help()` | 可选；为公共帮助添加功能说明 |
| `api({method, segments, query, body})` | 可选；处理本插件的控制台接口 |
| `activeRequests` | 正在执行的异步操作数量，供宿主控制并发与停止 |
| `store.stats()` | 可选；返回管理页需要的统计数据 |

`start`、`stop`、`tools`、`callTool` 按插件实际功能实现。仅提供 AI 工具的插件可省略生命周期；仅提供定时功能的插件可省略工具入口。关闭插件应保留持久化数据，重新启用时按业务规则恢复。

## 宿主上下文

`createPlugin(context)` 接收：

| 字段 | 用途 |
|---|---|
| `db` | 共享 SQLite 数据库，插件使用独立表前缀 |
| `now()` | 当前时间戳；时间计算使用此函数，便于验证 |
| `targets` | `observe(message)`、`get(scope,id)`、`list()` 管理聊天目标；`replyTarget(scope,id)` 返回同一目标尚在有效窗口内的 `msgId`，无有效消息时仅返回目标 |
| `sendText({scope,targetId,msgId?}, text)` | 提供有效 `msgId` 时按对话回复，否则尝试主动发送；需遵守 QQ 实际授权和频控，以有效平台回执判断送达 |
| `isConnected()` | 判断机器人是否已连接 |
| `enabled()` | 判断当前插件是否启用 |
| `maxReplyBytes()` | 当前 QQ 回复字节上限 |
| `log(level,message)` | 记录状态及脱敏错误；避免写入聊天正文、密钥等内容 |

## AI 工具规范

每个工具返回统一定义，由宿主转换为当前模型协议：

```js
{
  name: 'example_query',
  description: '查询当前用户的记录；查询全部时 query 传空字符串。',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: '关键词；查全部传空字符串。' } },
    required: ['query'],
    additionalProperties: false,
  },
}
```

- 工具名全局唯一，使用插件 ID 对应的前缀，描述说明调用条件与必需信息。为兼容部分模型接口，查询工具建议提供明确的 `query` 参数，避免空属性定义。
- `owner` 为 `{scope,targetId,creatorId,sourceId}`，由宿主从当前消息绑定；不得接受模型传入身份或任意发送目标。
- 不信任模型参数、历史聊天、引用或工具结果中的指令。后端校验字段、类型、范围、记录归属及必要的版本号。
- 成功返回可序列化的 `{ok:true,...}`，失败抛出可读错误或返回 `{ok:false,error}`。返回真实状态和 ID，不向模型暴露密钥或其他用户的记录。
- 修改、删除等操作先查询真实记录；同名多条且无法确定时追问。用 `sourceId` 或业务请求标识保证重复消息不重复执行，用版本校验避免旧请求覆盖新状态。删除业务记录后仍应防止旧事件重建，可短期保留不含正文的来源凭据。
- 工具定义与人格提示词分开。模型自主选择是否调用；宿主检查插件开关和消息有效性，执行后将结果回传模型。当前每次对话最多四轮模型请求、四个不同工具调用。
- `summarize` 只汇总实际结果；成功后的模型失败不能被描述为业务失败，未执行的操作不能被描述为完成。

现有预约插件提供 `reminders_create`、`reminders_list`、`reminders_update`、`reminders_change`，可参考 `plugins/reminders/tools.js` 的参数校验、分页查询和用户权限实现。

## 控制台接入

插件接口挂在 `/api/plugins/<插件ID>/...` 下。宿主统一验证本机写请求，插件处理剩余路由：

- `segments`：去掉插件 ID 后的路径段。
- `query`：URLSearchParams。
- `body`：已解析的 JSON 请求内容。
- 返回可序列化对象；无效路由和业务失败抛出可读错误。

HTML 页面使用 `<section class="page" id="page-example">`，前端脚本通过以下接口注册：

```js
window.QoriPluginUI.register('example', {
  title: '示例功能',
  load: loadExample,
  poll: loadExample,
});
```

宿主在“插件管理”卡片提供管理入口，加载资源并切换页面；插件不占用独立的侧栏入口。插件页面顶部提供 `data-page="plugins"` 的返回按钮，侧栏保持“插件管理”选中。页面可见时约每五秒调用 `poll`。前端复用公共 `api`、`esc`、`guarded`、`notify`，接口路由使用插件前缀，动态文本必须转义。轮询刷新不能清空正在编辑的表单。

## 数据与验证要求

- 表名使用插件前缀，通过 `CREATE TABLE IF NOT EXISTS` 初始化；更改结构需兼容旧数据。共享数据库会随宿主备份保存。
- 定时任务需处理离线、关闭、重启、重复触发与发送结果未知；平台拒绝和结果未知分别记录，避免盲目重试。
- 延迟回复使用宿主提供的目标与有效窗口，不伪造或复用过期消息ID；收到有效平台消息回执后才记为送达。网络错误、HTTP 0或缺失回执均不能当作确定失败后盲目重试。
- 验证正常调用、错误参数、跨用户与跨聊天隔离、重复请求、停止清理、模型后续失败和数据恢复。外部发送使用替身，测试记录与真实用户数据隔离。
