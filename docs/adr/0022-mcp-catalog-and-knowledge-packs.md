# ADR 0022: 资源目录统一化——MCP 全局配置 + Knowledge Pack(索引注入 + 召回工具)

## 状态

Accepted(2026-08-13,修订:agent 级开关 file-first)

## 上下文

ADR 0020 确立了"资源一份、桥接分发"的 Workspace Bridge 模型。三种 agent 资源的配置面现状:

| 资源 | 统一配置池 | agent 级开关 | 桥接 | 运行时消费 |
|---|---|---|---|---|
| Skill Pack | ✓(install 池) | ✓(DB 分配表) | ✓ 软链 `.<kind>/skills` | coding agent 经 progressive-skill 插件**主动加载** |
| MCP | ✗ `mcp_server` 是 per-agent 表 | ✗ | ✓ `.mcp.json` | 各后端原生挂载 |
| Knowledge | ✗(仅 seed 空目录) | ✗ | ✗ | 无 |

两个缺口都要按 skill-pack 的"统一配置池 + agent 级开关"模式补齐。**agent 级开关遵循 file-first**(ADR 0020:agent.yml 是唯一真源):开关写进 agent.yml,不建 DB 分配表(与 skill pack 的分配表不同——那是历史遗留,新资源不再走 DB 分配)。

knowledge 的**运行时消费**与 skill 有本质区别:skill 会被 coding agent **加载并执行**(progressive-skill 扫目录、skill_load 读全文);knowledge 是参考资料,**不会被自动加载**——它需要轻量索引注入 prompt + **召回工具**(agent 按需查询)。

## 决策

### 1. MCP:per-agent 表改为全局 catalog,开关走 agent.yml

- `mcp_server` 去掉 `agent_id`,成为全局 server catalog(serverId/name/transport/command/args/env/url)。**不建分配表**;agent 级开关是 agent.yml 的一部分:

```yaml
runtime_config:
  mcp_servers:
    - server_id: <catalog id>
      enabled: true
```

- 迁移 0027:**存量提升**——per-agent 行按(name, transport, url|command)去重为全局 catalog;原分配关系不回填(存量极少,用户在 UI 重新勾选或人工补 agent.yml),显式接受。
- HTTP:`/api/mcp-servers` 全局 CRUD;agent 开关经 agent update(PATCH /api/agents/:id 的 `mcpServers` 字段写 agent.yml)。
- Bridge:reconcile 读 agent.yml 的 enabled server + product-tools 合并写 `.mcp.json`。
- Web:`/team/mcp` 统一管理页(建/改/删 server);agent 侧(MCP tab)变为开关列表,勾选写 agent.yml。

### 2. Knowledge Pack:install 池 + agent.yml 开关 + 索引注入 + 召回工具

- `knowledge_pack` 表只做 install 池(builtin/git/zip,install-session 复用);**agent 级开关在 agent.yml**:

```yaml
runtime_config:
  knowledge_packs:
    - <pack id>
```

- Bridge:agent.yml 列出的 pack **软链**进 workspace `knowledge/<packId>`;并**生成机器索引** `knowledge/index.md`(每 pack 的标题、描述、文件清单,reconcile 时幂等重建——与 manifest.json 同构的桥接产物)。
- **prompt 注入**:coding agent 的 cwd meta 通道(workspace-context)在 system prompt 中追加 `knowledge/index.md` 内容(有文件才追加)。CLI 后端原生读 cwd 文件,index.md 对它们同样可见。
- **召回工具**(coding agent 原生工具,非 MCP):`knowledge_search`(对 `knowledge/` 目录做关键词 AND 匹配,返回文件+片段)+ `knowledge_read`(读 pack 内文件,路径约束在 knowledge/ 内)。CLI 后端不需要专属工具——它们的原生 grep/read 已覆盖。
- 消费语义:knowledge 是**参考**,不是指令——不参与 skill 的加载/执行链路。

### 3. 边界与降级

- index.md 是桥接产物(机器生成),reconcile 幂等重建;索引只含每 pack 摘要 + 文件清单(不内联全文),全文靠召回工具。
- 未列 knowledge 的 agent:不生成 index、不建软链,行为与现状一致。
- agent.yml 开关缺省(无 mcp_servers / knowledge_packs 键)= 全部关闭。

## 后果

- 迁移 0027(mcp 存量提升)+ 0028(knowledge_pack 表)。
- agent.yml(zod + serializeAgentYaml)扩展 `mcp_servers` / `knowledge_packs` 两节;agent update API 相应加字段。
- 新 feature:`features/mcp`(catalog 改造)、`features/knowledge`(registry/install,复用 skill-pack 的 install-session/fs-adapter)。
- Bridge 扩展:mcp 开关过滤(读 agent.yml)+ knowledge 软链 + index 生成。
- Child:workspace-context 读 index.md 注入;knowledge_search/read 工具(路径约束)。
- Web:`/team/mcp`、`/team/knowledge` 两个管理页 + agent 侧开关(写 agent.yml)。
- ADR 0020 的"Knowledge provisioning 是 future"条目随之落地。
