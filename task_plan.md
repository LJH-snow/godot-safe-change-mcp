# Godot Safe Change MCP 垂直链路计划

## 目标

在保持 TypeScript MCP Server + GDScript Godot EditorPlugin 分层、禁止任意 GDScript/shell/Python 的前提下，打通第一条可验证链路：

> 读取编辑器上下文 → 本地桥接 → 生成并预览受限场景/节点变更 → 经 Godot UndoRedo 应用 → 运行当前场景 → 返回诊断结果

## 验收标准

- MCP Server 能通过本地桥接读取项目、当前场景、选中节点、运行状态和诊断信息。
- Agent 可以为一个明确的场景/节点操作生成稳定的、可审查的预览计划。
- 未确认或 revision 过期时不能应用变更。
- 已确认的场景/节点变更只能由 GDScript EditorPlugin 通过 Godot `UndoRedo` 应用。
- MCP Server 能请求运行当前场景，并返回结构化运行状态、输出、错误和警告。
- 桥接断开、输入越界、revision 冲突和 Godot 操作失败均返回稳定错误码。
- `npm run typecheck`、`npm run build` 和新增的自动化契约/应用测试通过。
- 至少有一个可运行的 Godot fixture 或明确的手工验收脚本，证明预览 → 确认 → UndoRedo 应用 → 运行诊断链路。

## 范围与非目标

- 本阶段只支持一个最小场景/节点变更类型，优先“在当前场景根节点下创建一个受允许类型的子节点并设置有限属性”。
- 不提供任意文件写入、任意 GDScript 执行、shell 执行、Python worker、任意 Godot RPC 或不受限的对象反射。
- 不扩展到批量变更、资源导入、脚本修改、项目设置修改或复杂任务持久化。

## 实施阶段

### Phase 1 — 契约和现状基线

状态：`in_progress`

- [ ] 检查现有 MCP 入口、领域契约、桥接适配器、工具、资源和插件代码。
- [ ] 确定 HTTP 本地桥接协议、请求/响应 envelope、错误码和 revision 语义。
- [x] 先补契约测试和 fake bridge 测试，证明关键行为当前失败。

### Phase 2 — 只读编辑器上下文

状态：`pending`

- [ ] GDScript EditorPlugin 启动受限本地 HTTP 服务并返回上下文。
- [ ] TypeScript bridge adapter 连接、超时、解析和错误映射。
- [ ] MCP 暴露上下文查询工具/资源。

### Phase 3 — 变更预览与确认

状态：`pending`

- [ ] 定义受限节点创建操作、稳定计划 ID、expected revision 和 diff。
- [ ] MCP 生成 preview，不产生副作用。
- [ ] MCP 单独确认计划，拒绝过期或不匹配的确认。

### Phase 4 — UndoRedo 应用与运行诊断

状态：`pending`

- [ ] 插件只接受受限领域操作，并通过 `UndoRedo` 提交。
- [ ] MCP 请求运行当前场景并收集状态、输出、错误和警告。
- [ ] 返回 change report、revision 和诊断证据。

### Phase 5 — 集成验证和文档

状态：`pending`

- [ ] 补齐 Godot fixture/手工验收入口。
- [ ] 运行 typecheck、build、自动化测试和最小真实服务器检查。
- [ ] 更新 README、插件说明和测试边界。

## 决策记录

- 本地桥接首版采用 `127.0.0.1` HTTP；MCP Server 不直接操作 Godot 内部对象。
- 协议保持语言无关；TypeScript 负责 MCP/编排，GDScript 负责编辑器状态、UndoRedo 和运行控制。
- 写操作采用 `preview` 与 `apply` 分离，apply 必须携带用户确认和 `expectedRevision`。

## 错误记录

| 错误 | 尝试 | 处理 |
|---|---:|---|
| 测试补丁首次 JavaScript 字符串未转义 | 1 | 改用原始补丁字符串；本次失败没有写入文件。 |
| npm test 首次运行缺少待实现契约 | 1 | 红灯符合预期；补充领域类型、协调器和 HTTP 桥接实现。 |
| godot-bridge 重写补丁同时删除和新增同一路径 | 1 | 拆成独立的删除与新增补丁。 |
| 计划更新补丁上下文不匹配 | 1 | 拆成多个最小补丁，按当前文件内容更新。 |
| npm test 当前唯一失败是插件仍为占位实现 | 1 | 保留该红灯作为 GDScript 插件实现的验收驱动。 |
| 插件边界测试正则转义导致 TypeScript 解析失败 | 1 | 修正正则为普通路径匹配；测试随后全绿。 |
| mcp-use 资源检索正则未闭合 | 1 | 改用直接读取声明文件；不影响实现。 |
| 运行测试首次只返回 running 状态 | 1 | 先补红灯，再加入 run/status 轮询直到终态或超时。 |
| npx mcp-use client 安装可选客户端被 EALLOWSCRIPTS 拦截 | 1 | 不放宽脚本权限；改用公开 MCP HTTP 端点发送标准 JSON-RPC 验证。 |
| 直接 JSON-RPC 探测命令两次因 shell/JavaScript 字符串截断未发送 | 2 | 改用分开的 heredoc 单请求；随后 initialize、tools/list、resources/list 和 resources/read 均成功。 |
| GDScript 字节缓冲补丁重复声明同一路径 | 1 | 合并为单个文件更新后成功应用。 |
| Godot headless 首次使用 quit-after 30 导致编辑器在 30 帧后退出 | 1 | 改用 quit-after 0 保持编辑器运行；真实链路随后通过。 |
| 内联 MCP SSE 测试解析器把换行转义成字面量 | 1 | 改用按 data 行匹配的解析；端到端工具调用通过。 |
| fixture 场景首次运行没有退出条件 | 1 | 增加 0.5 秒后退出，确保能验证 stopped 和诊断结果。 |
| 技能路径误拼为 `.../skills/r0/...` | 1 | 根据技能根路径修正为 `.../skills/xdt-agents/...`；不重复使用错误路径。 |
| `mcp-apps-builder` 的 Cindy 根路径不存在 | 1 | 使用项目内 `.agents/skills/mcp-apps-builder/SKILL.md`；该项目技能提供本仓库专用约束。 |
| `apply_patch` 首次补丁缺少空行前缀 | 1 | 修正补丁格式后重新提交；本次失败没有写入文件。 |
| `rg` 依赖声明检索正则未闭合 | 1 | 改用不含括号的简单模式；基线 typecheck 仍已通过。 |

## 本轮状态

- Phase 1：契约、错误码、fake bridge 和红灯测试已完成。
- Phase 2：TypeScript HTTP bridge、MCP 上下文工具和 GDScript context 路由已实现并通过 Godot 4.7.2 runtime 验证。
- Phase 3：单节点预览、确认、expected revision 和 apply 状态机已实现并通过真实 revision 变化验证。
- Phase 4：UndoRedo 应用、当前场景运行和诊断轮询已实现并返回 stopped 与 fixture 诊断。
- Phase 5：自动化、MCP HTTP 端点、文档和 Godot fixture 已完成；本轮真实端到端验收通过。

## Phase 6 — 受限回滚

状态：complete

- [x] 为已应用计划生成可验证的 rollback 输入和报告。
- [x] 只有 planId 已应用且当前 revision 未变化时，才允许插件调用 Godot UndoRedo.undo。
- [x] 增加 MCP rollback 工具、fake bridge/HTTP/fixture 测试和文档。

## Phase 7 — 搜索与场景上下文

状态：complete

- [x] 增加只读 project index，搜索场景、节点、脚本、资源、signal 和 input。
- [x] 增加 MCP search_project 工具和 editor bridge 搜索路由。
- [x] 返回完整当前场景树、选中节点和有限安全属性。
- [x] 通过 Godot 4.7.2 runtime 验证 node、script、scene、resource 搜索。

## Phase 8 — 诊断关联与操作审计

状态：complete

- [x] 将诊断关联到节点路径、脚本行和最近变更。
- [x] 为 preview、confirm、apply、rollback、run 生成 operation ID 和审计记录。
- [x] 支持查询最近操作及其验证证据。

## Phase 9 — 安全脚本修改

状态：complete

- [x] 增加只读 script.replace_range preview、文件 revision 和行级 diff。
- [x] 通过临时文件和原子替换 apply 脚本修改。
- [x] 为脚本修改增加 revision 守卫、回滚报告和真实 Godot fixture 验收。

## Phase 10 — 持久化任务审计

状态：complete

- [x] 使用用户状态目录的 JSONL 事件文件持久化 operation audit，不写入 Godot 项目。
- [x] 跨 coordinator/store 实例恢复最新操作状态。
- [x] 保留重启前未完成的 running 操作，供后续任务恢复与异常提示使用。

## Phase 11 — 多步骤开发任务

状态：complete

- [x] 增加受限任务状态机：active/paused/completed/failed/cancelled，步骤只允许 apply_plan、rollback_plan 和 run_current_scene 三种受限操作。
- [x] 任务状态以 JSON 文件持久化到 `<projectRoot>/.godot-safe-change/tasks/`，重启后可查询与继续；崩溃遗留的 running 步骤可重试。
- [x] 支持 pause/resume/cancel 和失败重试（每步最多 3 次），所有步骤复用既有 preview/confirm/apply/rollback/run 守卫与审计。
- [x] 新增 create/get/advance/pause/resume/cancel 六个 MCP 工具与契约测试。
- [x] 真实 MCP + Godot 4.7.2 验收通过：UndoRedo apply、fixture 运行诊断、pause/resume/cancel 状态机与重启后磁盘恢复。

## 完成定义

只有在验收标准全部满足、自动化检查通过，并且真实或 fixture Godot 链路有可复现证据后，才将所有阶段标记为 `complete`。
