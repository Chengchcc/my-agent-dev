# 飞书卡片流式渲染：前期调研

> **状态：已废弃（superseded）。** 本文描述的 `run-delta-watcher` / `card-sender` / `card-renderer` 路径从未进入生产代码。实际出站路径走 `sse-watcher.ts`，消费 conversation ledger SSE，经 `render.ts` 转为纯文本发送。卡片流式渲染方案保留为未来参考，但当前架构不沿此方向。
>
> 2026-06-14 · 基于 lark-cli v1.0.53 + 飞书卡片 JSON 2.0 文档

## 目标

M15 当前只发纯文本最终回复。下一步（M16+）要做到：agent 生成回复的过程中，Lark 端以**流式卡片**逐步展示内容——类似 ChatGPT 的打字效果，但以飞书卡片为载体。

## 关键 API

> **来源**：lark-cli v1.0.53 实测 + [飞书服务端 API 文档](https://open.feishu.cn/document/server-docs/im-v1/message/create)

### 发送卡片消息

```
lark-cli im +messages-send \
  --chat-id oc_xxx \
  --msg-type interactive \
  --content '<card JSON>' \
  --as bot
```

`--content` 接受完整卡片 JSON 字符串。卡片的 `msg_type` 必须为 `interactive`。

✅ **已验证**（2026-06-13，lark-cli v1.0.53，profile fixture-test，bot 身份）

### 更新卡片（流式追加内容）

飞书 OpenAPI 支持 PATCH 更新已发送的卡片：

```
PATCH /open-apis/im/v1/messages/{message_id}
```

> **来源**：[更新应用发送的消息](https://open.feishu.cn/document/server-docs/im-v1/message/patch)

通过 lark-cli（TODO verify）：

```bash
lark-cli api PATCH "/open-apis/im/v1/messages/{message_id}" \
  --data '{"content":"<updated card JSON>"}' \
  --as bot
```

**关键约束**：
- 只能更新 `msg_type=interactive` 的消息
- 更新时需要传**完整卡片 JSON**（非增量 patch）——客户端用新的完整 JSON 替换渲染
- 需要在卡片 JSON 中设置 `config.update_multi=true`（共享卡片）

### 流式模式配置

在卡片 JSON 的 `config` 中启用流式模式：

```json
{
  "schema": "2.0",
  "config": {
    "streaming_mode": true,
    "streaming_config": {
      "print_frequency_ms": { "default": 30 },
      "print_step": { "default": 2 },
      "print_strategy": "fast"
    },
    "summary": { "content": "生成中..." },
    "update_multi": true
  },
  "body": {
    "elements": [
      { "tag": "markdown", "content": "" }
    ]
  }
}
```

- `streaming_mode: true` — 告诉客户端这张卡片会持续更新
- `streaming_config.print_step` — 每次渲染的字符步长
- `streaming_config.print_frequency_ms` — 渲染频率（ms）
- `summary.content` — 聊天列表中的预览文案，流式模式下默认 "生成中..."

## 与当前架构的集成点

### 当前数据流

```
agent run → AgentEvent(delta) → event_log → (目前只读最终)
                                           → (未来: SSE watcher 读 delta)
```

### 流式方案

```
agent run → text_delta → SSE watcher 捕获
                       → lark-cli PATCH /messages/{msg_id}
                       → 飞书客户端逐字渲染
```

**方案 A：SSE watcher 扩展**

当前 lark-bot 的 `sse-watcher.ts` 只订阅 `/conversations/:id/events`（ledger），不订阅 `/runs/:id/events`（event_log delta）。流式需要额外订阅 run 级 delta stream：

```ts
// 新增：run-level delta watcher
function watchRunDelta(runId: string, messageId: string, larkChatId: string) {
  // 1. 先发送占位卡片
  const msgId = await sendCard(larkChatId, placeholderCard);

  // 2. 订阅 run delta events
  const stream = fetch(`/api/runs/${runId}/events`);

  // 3. 每次 text_delta 追加到卡片内容
  for await (const delta of stream) {
    accumulated += delta.text;
    await updateCard(msgId, buildCard(accumulated));
  }

  // 4. run 结束后发送最终版本（或让最终消息覆盖）
}
```

**方案 B：D19 后批量发送**

agent 跑完后一次性发卡片，不走流式，但可以利用卡片的 markdown 组件展示富文本。这是 MVP 之后的第一步升级，先拿到卡片展示能力，再叠流式。

### 需要新增的能力

| 能力 | 优先级 | 说明 |
|------|--------|------|
| `sendCard(chatId, cardJson)` | P0 | 发送卡片消息，替代 `sendText` |
| `updateCard(messageId, cardJson)` | P0 | 更新已有卡片 |
| `runDeltaWatcher` | P1 | 订阅 run 级 delta event |
| `textToCardRenderer` | P1 | 将流式文本增量转换为卡片元素 |
| `templateCardBuilder` | P2 | 预设卡片模板（思考中/生成中/完成/错误） |

## 卡片组件速查

### Markdown 组件（推荐用于 agent 输出）

```json
{
  "tag": "markdown",
  "content": "## 分析结果\n\n- 项目：**my-agent**\n- 状态：✅ 通过",
  "element_id": "agent_output"
}
```

支持飞书 markdown 语法：标题、加粗、列表、代码块、链接、图片。

### 文本组件

```json
{
  "tag": "plain_text",
  "content": "简单文本",
  "element_id": "status_text"
}
```

### 按钮组件（交互回调）

```json
{
  "tag": "button",
  "text": { "tag": "plain_text", "content": "确认" },
  "type": "primary",
  "element_id": "btn_confirm",
  "value": { "action": "confirm" }
}
```

按钮点击会产生 `card.action.trigger` 事件，需要 lark-bot 订阅该事件类型才能响应。这是未来交互式审批/确认的基础。

### 布局容器

```json
{
  "tag": "column_set",
  "flex_mode": "bisect",
  "columns": [
    { "tag": "column", "elements": [...] },
    { "tag": "column", "elements": [...] }
  ]
}
```

## 流式性能参数

> **来源**：[流式更新卡片](https://open.larkoffice.com/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/streaming-updates-openapi-overview)

飞书客户端对流式卡片有内置的去抖/聚合机制（`streaming_config`）。服务端不需要做逐 token 推送，可以用更大的 chunk（如每 100ms 或每 5 个 token 推一次）：

| 参数 | 推荐值 | 说明 |
|------|--------|------|
| `print_frequency_ms.default` | 50 | 50ms 刷新间隔 |
| `print_step.default` | 3 | 每次刷 3 字符 |
| `print_strategy` | `fast` | 快速策略（优先速度） |

实际推送频率建议：**每 100-200ms 更新一次卡片**，每次包含当前完整文本。这比逐 token 推送更稳定，也降低了 API 调用量。

## 与当前 `sender.ts` 的对比

| | 当前 `sendMessage` | 流式 `sendCard` |
|---|---|---|
| 传输 | `lark-cli im +messages-send --text` | `lark-cli im +messages-send --msg-type interactive --content` |
| 更新 | 不支持 | `lark-cli api PATCH /im/v1/messages/{id}` |
| 去重 | `--idempotency-key` | 同上 |
| 内容 | 纯文本 | 卡片 JSON（支持 markdown/布局/交互） |

## 风险与限制

### 已实测（lark-cli v1.0.53 + fixture-test profile）

1. **发送卡片**：`lark-cli im +messages-send --msg-type interactive --content '<card JSON>' --as bot` — ✅ 可用，P2P 和群聊均测试通过。
2. **幂等发送**：`--idempotency-key` 返回相同 message_id — ✅ 确认有效。
3. **接收卡片事件**：`event consume im.message.receive_v1` 收到 `message_type=interactive` 时 content 为 JSON string — ✅ fixture 已有。

### 官方文档确认（可作为实现依据）

1. **客户端兼容**：卡片 JSON 2.0 需要飞书客户端 ≥7.20。[来源](https://open.larkoffice.com/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-breaking-changes-release-notes)
2. **共享卡片约束**：`update_multi` 必须为 `true`。[来源](https://open.larkoffice.com/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-structure)
3. **PATCH 全量替换**：需要传完整卡片 JSON。[来源](https://open.feishu.cn/document/server-docs/im-v1/message/patch)
4. **流式配置参数**：`streaming_mode/streaming_config/print_step/print_frequency_ms`。[来源](https://open.larkoffice.com/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/streaming-updates-openapi-overview)

### M15.1 spike 验证结果（2026-06-14，lark-cli v1.0.53）

以下项目已在 M15.1 spike 中 dry-run 验证：

1. **PATCH 更新卡片的 lark-cli 命令形态** — ✅ dry-run 通过：
   ```bash
   lark-cli api PATCH /open-apis/im/v1/messages/om_xxx \
     --as bot \
     --params '{"message_id_type":"open_message_id"}' \
     --data '{"content":"<full card JSON>"}'
   ```
   dry-run 输出显示 `"as": "bot"`，bot 身份 PATCH 已验证请求形态。`im.messages.patch` / `.update` / `.create` schema shortcut 在 1.0.53 仍不可用（只暴露 `delete/forward/merge_forward/read_users/urgent_*`），因此 `updateCard` 必须封装通用 `api PATCH`，不依赖 typed schema。

2. **sendCard 命令形态** — ✅ dry-run 通过：
   ```bash
   lark-cli im +messages-send --chat-id oc_xxx --msg-type interactive \
     --content '<card JSON>' --as bot --idempotency-key '<key>' --format json
   ```
   需在真实 fixture-test profile 上验证 `--format json` stdout 中 `message_id` 字段路径，作为单测 fixture。

3. **Typing reaction API** — ✅ dry-run 通过：
   ```bash
   # add
   lark-cli api POST /open-apis/im/v1/messages/<id>/reactions \
     --data '{"reaction_type":{"emoji_type":"Typing"}}'
   # remove (需真实 reaction_id)
   lark-cli api DELETE /open-apis/im/v1/messages/<id>/reactions/<reaction_id>
   ```

### 仍需真实验证（M15.1 implementation gate）

1. **body size 上限**：未在官方文档找到明确数字，需通过 API 返回错误码或压测确认。当前保守设为 12000 chars markdown。
2. **更新频率/限流**：推测约 100 次/分钟/应用，需通过压测或[官方限流文档](https://open.feishu.cn/document/server-docs/api-call-guide/rate-limit)确认实际值。M15.1 保守节流 150ms/次。
3. **update_multi 群聊可见性**：需验证群聊场景下所有成员是否实时看到卡片更新。
4. **streaming_config 实际渲染效果**：需在真实设备验证 `print_step`/`print_frequency_ms` 参数的效果差异。
5. **sendCard stdout JSON 中 message_id 字段路径**：需 fixture-test profile 真实发送一次，确认是 `message_id` 还是 `data.message_id`。

### 能力探测（capability probe）

不同 Mira / 本地 runtime 可能安装不同 `lark-cli` 版本。实现应在启动时 probe 以下能力，失败时降级：

| 能力 | probe 方式 | 降级 |
|------|-----------|------|
| `im +messages-send --msg-type interactive` | `--help` grep `interactive` | 卡片功能整体关闭，fallback 纯文本 |
| `api PATCH /im/v1/messages` | dry-run 后 grep `PATCH` | `updateCard` 不可用，只发最终卡片 |
| `config init --new` | 执行后 grep URL pattern | 切到 `legacy_secret_stdin` provisioner |

## 推进路径

1. ~~**M15.x**（当前）— 保持文本发送，验证 E2E 稳定性~~ ✅ 已完成
2. ~~**M15.1 卡片 + 流式** — `sendCard` + `runDeltaWatcher` + `updateCard` + `Typing` reaction lifecycle，降级纯文本 fallback~~（方向已废弃，未实施）
3. ~~**M15.2 交互卡片** — 按钮/表单回调，订阅 `card.action.trigger` 事件，实现审批/确认交互~~（方向已废弃，未实施）
