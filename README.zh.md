# dsh-flowtext

[English](README.md)

`dsh-flowtext` 为 DeepSeek Harness 注册唯一的 `flowtext-direct` 路由。DSH 只接收用户指令，显示脱敏的精简执行轨迹并记录最终答案；分类、规划、查找、读取、写入、工具执行、追问、审批及收尾全部由 Obsidian FlowText Agent 完成。

本插件不注册 `SubagentProvider`，不提供 `subagent_flowtext`，也不安装 `tool-subagent-flowtext`。

## 环境要求

- Node.js `^22.19.0` 或 `>=24`
- DeepSeek Harness
- Obsidian 桌面端已启用 FlowText Agent Gateway

## 安装

```sh
dsh plugin --profile web add github:ytmaps/dsh-flowtext
```

安装包自带 `cordis.patch.yml`，只创建一个 Cordis 条目：

```yaml
- id: flowtext-direct
  name: dsh-flowtext
```

无需环境变量、复制 Token 或手工编辑 Profile。FlowText 会自动注册每个已打开的仓库；首次向某个仓库提交任务时，FlowText 会显示本机连接确认。允许一次后，DSH 会按仓库分别保存凭据并自动复用。

从 `dsh-subagent-flowtext` 升级时，请先删除旧包，再安装 `dsh-flowtext`。旧版按仓库保存的配对凭据会自动迁移，无需重新复制 Token。

## 运行方式

- 插件固定把 DSH Agent 请求路由到 `flowtext-direct`。
- 只打开一个 FlowText 仓库时自动选中；同时打开多个仓库时，DSH 模型列表会显示 `FlowText Agent · 仓库名`，用户在提交前选择目标仓库。
- 每次任务都会携带 Obsidian 官方维护的稳定仓库 ID；FlowText 执行前再次校验，不会因动态端口变化误投到其他仓库。
- 第一个 Gateway 优先使用 `127.0.0.1:27124`；其他同时打开的仓库自动使用空闲动态端口，无需用户配置。
- 只发送最新一条真实用户消息和 DSH `sessionId`。
- 不向 FlowText 发送 DSH 系统提示、工具目录、助手历史或插件上下文。
- 相同 DSH `sessionId` 复用同一个 FlowText 会话；不同 DSH 会话仍独立保存，但会优先复用已打开的空闲 Agent 面板。
- FlowText UI 显示完整执行过程；DSH 通过可折叠的 reasoning 区域实时显示脱敏执行摘要。
- 轨迹不会生成 DSH 工具调用，DSH 不会重复执行 FlowText 工具。
- FlowText UI 中的追问和危险操作审批会暂停 DSH，直到用户完成交互。
- 适配器禁用 DSH 模型重试，避免包含写操作的任务被重复执行。

## 配置

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `baseUrl` | 未设置 | 默认自动发现所有已打开仓库；仅在兼容旧版 FlowText 时手工指定本机 Gateway 地址。 |
| `registryDir` | `~/.flowtext/agent-gateways` | 可选的高级发现目录覆盖。 |
| `autoPair` | `true` | 无本机凭据时自动请求 FlowText 授权。 |
| `credentialPath` | DSH 凭据目录 | 可选凭据文件路径。 |
| `clientName` | `DeepSeek Harness` | FlowText 配对框显示名称。 |
| `clientId` | `deepseek-harness` | 稳定客户端标识。 |
| `modelId` | 未设置 | 可选 FlowText 模型。 |
| `activePath` | 未设置 | 可选库内活动笔记路径。 |
| `contextPaths` | `[]` | 可选库内上下文路径。 |
| `runOptions` | `{}` | `thinkingEnabled` 等 FlowText 运行参数。 |
| `requestTimeoutMs` | `30000` | 普通 HTTP 请求超时。 |
| `longPollMs` | `25000` | Gateway 事件长轮询时间。 |
| `maxResponseBytes` | `2097152` | Gateway 响应上限。 |
| `maxPromptBytes` | `1048576` | 用户指令上限。 |
| `maxAnswerBytes` | `1048576` | 最终答案上限。 |
| `progressMode` | `summary` | `summary` 实时显示脱敏执行轨迹；`off` 仅显示最终答案。 |

## 安全边界

Gateway 只接受回环地址。仓库发现记录仅包含仓库标识、显示名、路径和动态端口，使用仅当前用户可读的本地文件，不包含 Token。自动配对拒绝浏览器来源并要求用户在 Obsidian 明确允许。凭据按仓库隔离，不会写入 Profile、Obsidian 仓库、Shell 历史或模型上下文。父请求取消或 DSH 关闭 Run 时，插件会取消对应的 FlowText 任务。

目前只支持文本指令和文本最终答案；图片及结构化输出不会从 DSH 转发。
