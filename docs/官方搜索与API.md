# API 与官方搜索配置

## 预设和兼容接口

| 配置 | 协议 | Base URL | 搜索 |
|---|---|---|---|
| 通用对话 API | Chat Completions | `https://api.deepseek.com` | 默认关闭 |
| DeepSeek 官方搜索 | Anthropic Messages | `https://api.deepseek.com/anthropic` | 服务端按需搜索 |

两组预设均使用 `deepseek-flash`，API Key 由使用者自行填写。其他服务可点击“新配置”，设置其名称、基础地址、模型和协议。当前实现支持 OpenAI 兼容 Chat Completions 和 Anthropic Messages；兼容程度与可用模型由所选服务决定。

默认地址与模型参考 [DeepSeek 官方 API 文档](https://api-docs.deepseek.com/)。查询模型列表可检查当前 Key 获准使用的模型。Key 无需添加 Bearer，不同平台的 Key 不通用。

Base URL 填基础地址，不追加 `/chat/completions` 或 `/v1/messages`。程序会附加请求路径。配置保存后还需点击“使用这个 API”；在途请求保留开始时的配置，之后的请求使用新配置。切换 API 不删除提示词或用户记忆。

## 启用搜索

1. 在“API 与机器人”选择“DeepSeek 官方搜索”。
2. 填入 DeepSeek 官方平台 Key，确认 Anthropic Messages 协议和 `https://api.deepseek.com/anthropic`。
3. 保持“官方联网搜索”开启，点击“保存 API”，再点击“使用这个 API”。
4. 回到本机对话，提出需要当前信息的问题，检查回答是否带来源。

搜索开关表示允许模型调用工具，普通闲聊可能直接回答。搜索可能增加模型用量；实际可用性取决于账户与模型。只有上述官方 Anthropic 地址可以启用本项目当前实现的搜索；其他兼容接口不会因模型名相同而自动支持搜索。

## 实现与验证范围

本项目使用 Anthropic SDK 的 Messages API 声明服务端 `web_search` 工具。本机不抓取网页、不安装搜索代理，也不使用额外的第三方搜索 Key。遇到 `pause_turn` 时原样续传工具块，最多三个续传阶段，共用一个超时。

返回来源时优先采用回答引用，否则使用搜索结果携带的 URL；QQ 回复字节限制可能截断较长的来源列表。模型列表通过 DeepSeek 官方 `/v1/models` 查询。

测试覆盖模拟请求、引用、暂停续传和搜索失败；未使用真实账户验证全部搜索能力。工具错误会显示失败，不会伪装成搜索成功。

参考：[DeepSeek 官方搜索说明](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/#using-web-search-in-claude-code)、[Anthropic 兼容说明](https://api-docs.deepseek.com/guides/anthropic_api/)。

