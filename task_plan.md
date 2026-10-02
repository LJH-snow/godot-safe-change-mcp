# Godot Safe Change MCP 垂直链路计划

## 目标

在保持 TypeScript MCP Server + GDScript Godot EditorPlugin 分层、禁止任意 GDScript/shell/Python 的前提下，打通并加固第一条可验证链路：

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

状态：`complete`

- [x] 检查现有 MCP 入口、领域契约、桥接适配器、工具、资源和插件代码。
- [x] 确定 HTTP 本地桥接协议、请求/响应 envelope、错误码和 revision 语义。
- [x] 补契约测试和 fake bridge 测试，证明关键行为当前失败并完成回归。

### Phase 2 — 只读编辑器上下文

状态：`complete`

- [x] GDScript EditorPlugin 启动受限本地 HTTP 服务并返回上下文。
- [x] TypeScript bridge adapter 连接、超时、解析和错误映射。
- [x] MCP 暴露上下文查询工具/资源。

### Phase 3 — 变更预览与确认

状态：`complete`

- [x] 定义受限节点创建、属性、脚本、资源、输入动作和脚本范围操作，以及稳定计划 ID、expected revision 和 diff。
- [x] MCP 生成 preview，不产生副作用。
- [x] MCP 单独确认计划，拒绝过期或不匹配的确认。

### Phase 4 — UndoRedo 应用与运行诊断

状态：`complete`

- [x] 插件只接受受限领域操作，并通过 `UndoRedo` 提交场景变更。
- [x] MCP 请求运行当前场景或指定场景并收集状态、输出、错误和警告。
- [x] 返回 change report、scene/file revision 和诊断证据。

### Phase 5 — 集成验证和文档

状态：`complete`

- [x] 补齐 Godot fixture、真实 runtime smoke 和手工验收入口。
- [x] 运行 typecheck、build、57 项自动化测试、diff 检查和真实 Godot smoke。
- [x] 更新 README、插件安全边界、进度记录和测试边界。

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
| `verify_scene_state` 红灯导致 task kind、错误码和结构化 details 的 TypeScript 检查失败 | 1 | 符合预期；在实现中添加对应契约和失败证据类型。 |
| `expectedProperties.default([])` 让 Zod 推断的 task 输入类型变成必填 | 1 | task step 输入改为 optional，持久化 TaskStepState 保留空数组默认值；非法 assertion 用 schema safeParse 验证。 |
| TaskCoordinator 多段补丁因错误处理上下文不匹配而失败 | 1 | 重读文件当前状态后拆为更小补丁应用。 |
| scene verification 文档补丁把任务阶段行定位到错误文件 | 1 | 该行在 task_plan.md；按实际文档位置拆分更新。 |
| `verify_diagnostics` 测试红灯因 task union 尚未包含新 step kind | 1 | 符合预期；新增诊断验收契约并实现前序 run step 校验。 |
| 重复 run stepId 未被诊断引用校验发现 | 1 | 要求 runStepId 唯一匹配一个前序 run step，并在执行时再次检查持久化 task state。 |
| TaskCoordinator repair 方法补丁部分落盘形成重复定义 | 1 | 检查当前 diff 后移除重复实现，只保留一组唯一引用校验方法。 |
| task repair smoke 大补丁的后续上下文未匹配 | 1 | 重读当前 fixture 流程后确认补丁已有部分写入，只保留已落盘测试并补齐缺项。 |
| task repair preview 首次未接受 step 级 repairHint | 1 | 仅允许 schema 验证的 scene.create_node hint；缺少 hint 时显式失败。 |
| GitHub CI heartbeat test exposed ENOENT while renaming a shared task temp file | 1 | Reproduced with parallel FileTaskStore saves; serialized same-target writes and added unique temp paths. |
| Local npm package consumer was blocked by EALLOWSCRIPTS | 1 | Package smoke uses real npm install when permitted and tarball extraction with source dependency resolution as a safe local fallback. |
| GitHub package job failed because npm prepare logs preceded pack JSON | 1 | Parse the final JSON array from npm pack output while retaining real install in CI and local fallback behavior. |
| Package manifest parser selected a nested files array | 1 | Match the outer manifest prefix instead of the last array start. |

## 本轮状态

- Phase 1：契约、错误码、fake bridge 和回归测试已完成。
- Phase 2：TypeScript HTTP bridge、MCP 上下文工具和 GDScript context 路由已实现并通过 Godot 4.7.2 runtime 验证。
- Phase 3：受限节点、属性、脚本、资源、输入动作和脚本范围操作的 preview、confirm、expected revision 和 apply 状态机已完成。
- Phase 4：UndoRedo 应用、文件/项目设置 revision guard、场景运行和诊断轮询已完成。
- Phase 5：自动化、MCP HTTP 端点、文档和 Godot fixture 已完成；当前 57/57 测试通过，本地真实端到端验收通过。
- 远程 GitHub Actions 的 Xvfb 修复后首次运行仍待确认；本轮不自动 commit/push。

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

## Phase 11 — 多窗口项目租约

状态：complete

- [x] 通过独占文件创建实现跨进程项目 lease。
- [x] apply/rollback 自动获取短租约，支持显式 leaseId 校验和过期回收。
- [x] 并发 owner、过期 lease 和任务恢复测试通过。
- [x] 支持 acquire_task_lease、renew_task_lease、release_task_lease 和 task_status。
- [x] 任务步骤可复用显式 leaseId，lease owner、expiresAt 和 recoverable 状态持久化可见。
- [x] 显式任务 lease 在持有期间按 TTL/3 自动 heartbeat 续租，并记录 acquire、renew、release、reclaim timeline 事件。
- [x] heartbeat 续租失败自动暂停任务并保留可恢复状态；接管事件记录 previousOwnerId、ownerId 和到期/丢失/替换原因。
- [x] 原 owner 在 lease 仍有效时可恢复同一 lease 并记录 lease_recovered；本地缓存 lease 到期时也会正确回收。

## Phase 11 — 多步骤开发任务

状态：complete

- [x] 增加受限任务状态机：active/paused/completed/failed/cancelled，步骤支持 apply_plan、rollback_plan、run_current_scene、run_scene、verify_scene_state、verify_diagnostics 和确认门控的 diagnostic-repair preview/apply。
- [x] 任务状态以 JSON 文件持久化到 `<projectRoot>/.godot-safe-change/tasks/`，重启后可查询与继续；崩溃遗留的 running 步骤可重试。
- [x] 支持 pause/resume/cancel 和失败重试（每步最多 3 次），所有步骤复用既有 preview/confirm/apply/rollback/run 守卫与审计。
- [x] 新增 create/get/advance/pause/resume/cancel 六个 MCP 工具与契约测试。
- [x] 每个 task step 生成 operationId，并持久化 running/succeeded/failed timeline 事件。
- [x] 只读 `task_timeline` 支持按 stepId、operationId、事件类型和时间范围筛选执行证据。
- [x] 重启接管时把遗留 running operation 标为 step_interrupted，再以新 operationId 重试；同一 coordinator 并发 advance 返回 PROJECT_BUSY。
- [x] 真实 MCP + Godot 4.7.2 验收通过：UndoRedo apply、fixture 运行诊断、pause/resume/cancel 状态机与重启后磁盘恢复。

## Phase 12 — 运行指定场景

状态：complete

- [x] 新增 `run_scene` 契约、MCP 工具、ChangeCoordinator 用例和 `/v1/run/scene` HTTP bridge 路由。
- [x] 通过 `EditorInterface.play_custom_scene` 运行经过 `res://`、`.tscn` 和路径遍历校验的指定场景。
- [x] 任务步骤支持 `run_scene`，并保存 scenePath 与 timeoutMs；旧任务状态可由 schema 默认字段恢复。
- [x] 自动化测试 57/57、typecheck、build 已通过。
- [x] 真实 MCP + Godot 4.7.2 验收通过：`run_scene` 返回 stopped、指定 scenePath 和 fixture 输出；非法路径在工具层拒绝；任务中的 run_scene 步骤完成。

## Phase 13 — Godot headless CI

状态：complete

- [x] 增加固定 Godot 4.7.2 的 GitHub Actions runtime job 和临时 fixture smoke harness。
- [x] smoke 覆盖 search、context、scene apply/rollback、script apply/rollback、diagnostics 和 operation history。
- [x] smoke 额外覆盖输入动作的 ProjectSettings 持久化 apply/rollback；Linux runtime 使用 `xvfb-run` 为运行中的场景子进程提供显示服务。
- [x] 在远程 GitHub Actions run `36741526625` 确认 Linux headless fixture、Godot smoke 和日志 artifact 均通过。
- [x] Godot 4.5.1/4.7.2 Linux smoke 与独立日志 artifact 均通过；远程 Actions run `36802723876` 的 check 和两个 Godot runtime jobs 全绿。

## Phase 14 — 更多安全 Godot 操作

状态：complete

- [x] 增加受限 scene.set_property，覆盖 visible、position、rotation_degrees、scale、size、text、color，并通过 UndoRedo apply/rollback smoke。
- [x] 增加输入动作按键添加/移除的 preview/apply/rollback，使用 project.godot revision guard、重复/歧义键校验和回滚验证。
- [x] 增加资源引用 snapshot/preview diff、revision guard、原子 apply 和 rollback。
- [x] 增加挂载已有脚本的 preview/apply/rollback。
- [x] 增加 scene.instantiate_scene：校验项目内 `.tscn`、父节点和名称冲突，绑定源场景 revision，并通过 UndoRedo apply/rollback。
- [x] 增加 scene.connect_signal preview/apply/rollback：读取当前场景 signal/method/connection 快照，拒绝无信号、无方法、重复连接和不安全 NodePath，并通过 Godot UndoRedo 连接/断开。

## Phase 15 — task-level scene verification

状态：`complete`

- [x] 新增只读 `verify_scene_state` task step，验证一个安全 NodePath 是否存在，并可断言有限白名单属性。
- [x] 成功结果保存 revision、实际节点属性和 task step operationId 作为证据。
- [x] 验证失败时 task step 标记 failed，返回稳定错误码与结构化 mismatch 证据。
- [x] 增加契约/TaskCoordinator 单元测试和真实 Godot smoke；确认不执行脚本、不写项目。

## Phase 16 — task-level diagnostics verification

状态：`complete`

- [x] 新增 `verify_diagnostics` step，显式引用前序 run_current_scene/run_scene 结果。
- [x] 按 maxErrors/maxWarnings 和 stopped 状态验证运行结果，返回 counts、runId 和诊断证据。
- [x] 无前序 run、失败状态或阈值超限时让 task step 失败并记录 TASK_VERIFICATION_FAILED。
- [x] 增加单元测试、真实 Godot MCP smoke 和文档，并确认不执行脚本、不写项目。

## Phase 17 — task-level diagnostic repair preview

状态：`complete`

- [x] 从前序 run 的诊断和诊断内或 task step 提供的 allowlisted repairHint 生成受限预览计划，并在 task timeline 关联 run ID、diagnostic 和 plan。
- [x] 预览后暂停任务等待审查；apply step 只能引用本任务的修复预览且不能代替用户确认。
- [x] 用户通过既有 confirm 工具确认后，任务可应用修复、重跑并重新验证 diagnostics。
- [x] 增加单测和真实 Godot task smoke，确认没有任意代码执行或未确认写入。

## Phase 18 — concurrent task-store persistence

状态：`complete`

- [x] Reproduce concurrent heartbeat/state saves for one task and preserve last-write ordering.
- [x] Serialize same-target atomic saves and use unique temporary paths with cleanup.
- [x] Verify the full test suite, typecheck/build and Godot runtime smoke before pushing.

## Phase 19 — release package boundary

状态：`complete`

- [x] 增加 `npm run package:check`，验证 tarball 元数据、发布入口、MCP bundle 和 Godot 插件文件。
- [x] package smoke 拒绝 tests、src、.agents 和计划/进度文件进入发布 tarball。
- [x] 将 package boundary check 接入 GitHub Actions 和 `prepublishOnly`。
- [x] 本地 package smoke、完整测试、typecheck、build 和 Godot runtime smoke 通过。

## 完成定义

只有在验收标准全部满足、自动化检查通过，并且真实或 fixture Godot 链路有可复现证据后，才将所有阶段标记为 `complete`。
