# 研究与发现

## 项目文档

- `README.md` 说明当前只有只读 `project_overview`，Godot 桥接是占位适配器。
- `docs/PLAN.md` 要求 MCP Server 负责契约、编排、权限、计划和报告；Godot EditorPlugin 负责真实编辑器状态、UndoRedo、运行控制和 Godot 原生 API。
- 计划明确禁止任意 `execute_gdscript`、任意 shell 和不受限文件系统写入。
- `godot-plugin/README.md` 要求插件先支持只读项目、场景、选中节点和编辑器错误。
- `tests/README.md` 要求契约、应用、集成和 Godot 测试边界；写操作必须分别测试 preview、confirmation、apply、rollback。

## 当前仓库

- `package.json` 使用 `mcp-use@2.7.1`、Zod 4 和 TypeScript 7；当前脚本只有 `dev`、`build`、`start`、`typecheck`，没有测试脚本。
- `index.ts`、`src/domain`、`src/application`、`src/infrastructure`、`src/tools`、`src/resources` 和 `godot-plugin` 已存在，仓库仍是骨架。
- GDScript 文件已存在：`godot-plugin/plugin.gd`、`godot-plugin/bridge_client.gd`；需要先阅读其实际实现再决定保留或重写。
- 当前目录已初始化 Git，但没有提交。
- 当前环境未找到 `godot`、`godot4` 或 `Godot` CLI；真实 EditorPlugin 运行验收需要后续在安装 Godot 4.x 的环境执行。
- 现有 `PendingGodotBridge` 只返回占位 overview；`plugin.gd` 只创建 dock，`bridge_client.gd` 只有 pending 状态信号。
- 现有 `change-contracts.ts` 已包含脚本替换和场景属性设置草案，但没有 preview/apply/confirmation/operation/revision 语义，且脚本操作不符合本阶段最小安全范围。
- 现有 MCP 工具返回 `content`，没有为结构化工具结果提供 `outputSchema`/`structuredContent`。

## 外部文档

- Context7 的当前 `mcp-use` 文档显示：工具使用 Zod/Standard Schema，结构化结果需同时提供 `content` 和 `structuredContent`；服务器入口应 default export，开发/构建由 `mcp-use` CLI 管理。
- Context7 的 Godot 4.5 文档确认可使用 EditorPlugin/HTTPServer/UndoRedo/编辑器运行 API；具体方法名需要结合安装的 Godot 版本和 GDScript API 进一步核对。

## Runtime 验证

- 本机 Godot 版本为 4.7.2.stable.steam.ed1daf0bf。
- 使用临时 fixture 启动 headless Editor 后，MCP editor_context 返回 connected、res://main.tscn 和 revision。
- 通过 MCP preview、confirm、apply 后，Godot 返回 UndoRedo report，revision 从 1865036137 变为 4061296536，随后 run_current_scene 返回 stopped，并包含 fixture scene started。
- macOS 的 /tmp 是 /private/tmp 的符号链接；新增 project-root realpath 规范化后，MCP 使用 /tmp 输入也能连接 Godot。
- headless dummy renderer 在调用 play_current_scene 时输出 texture_2d_get 的环境警告，但不阻断桥接、UndoRedo、运行或诊断结果。
- EditorUndoRedoManager 只负责按 history ID 管理场景历史；实际 undo 必须从 get_history_undo_redo 返回的底层 UndoRedo 执行。

## 待核实问题

- 当前 `mcp-use@2.7.1` 安装包的实际导出和现有代码是否使用旧/新参数名。
- Godot fixture 使用的 Godot 4.x 小版本，以及本机是否安装 `godot` 或 `godot4` CLI。
- EditorPlugin HTTP 服务采用 `HTTPServer` 还是 `TCPServer`，以及 Godot 4.x 对当前运行状态/输出的可读 API。
- 诊断结果的轮询边界、超时和 operation ID 形状。

## task-level scene verification

- `ChangeCoordinator.getContext(projectRoot)` 已提供只读编辑器上下文，可由 TaskCoordinator 用于验收而无需增加 Godot RPC。
- `EditorContext.currentScene.nodes` 提供 NodePath 和有限安全属性；现有可写属性白名单为 visible、position、size、text、color。
- Task steps 已持久化 operationId、result、error 和 timeline；verify step 应复用该持久化结构并在 mismatch 时失败，而不是把断言失败记为 succeeded。
- `ChangeCoordinator.getContext` 会规范化 projectRoot 并调用只读 bridge；verification 不需要新增 Godot route 或写能力。
- `verify_scene_state` 的结果应带当前场景路径、revision、nodePath 和每个断言的 expected/actual；失败细节应进入 step.error 与 failed timeline event。
- 属性比较采用递归 JSON 比较，数值容差为 1e-5，以兼容 Godot float 序列化；验证步骤只读取 context，不调用任何写桥接路由。
- TaskState 与 timeline error schema 为旧任务保留兼容：nodePath、expectedProperties 和 error.details 均为 additive/defaulted 字段。

## task-level diagnostics verification

- `RunDiagnostics` schema 已包含 runId、scenePath、status、warnings 和 errors；TaskStepState.result 可持久化前序 run 的完整结果。
- `verify_diagnostics` 将显式引用 earlier run step，避免检查到不相关或陈旧的 run；默认错误和警告阈值均为 0。
- 通过条件要求 run 状态为 stopped，且错误/警告数量都不超过阈值；失败证据保存 runId、status、counts 与 diagnostics。

## task-level diagnostic repair preview

- `ChangeCoordinator.previewRepairFromDiagnostic` 只接受显式且受限的 `repairHint`，目前 repair action 是 allowlisted `scene.create_node`。
- 修复预览应关联前序 run step 和 diagnostic index，并保存产生的 change plan；task 在预览后暂停，不调用 confirm 或 apply。
- 应用步骤引用同一 task 的预览结果并调用现有 `applyChange`，依赖既有确认状态和 revision guard；不重新解释或执行诊断文本。
- Godot 原始诊断可能没有 repairHint；task step 可额外接收 schema 限制的 `scene.create_node` repairHint（若两者都有则使用 task 明确指定项），结果仍保存原始诊断、有效 hint 与预览 plan。

## task store concurrency

- `FileTaskStore.save` originally reused one `<taskId>.json.tmp` path; a heartbeat and a task transition can write that same file concurrently, letting one rename consume the temp file before the other rename.
- Same-instance saves for one target should run in call order; unique temp names also prevent cross-instance temporary-file collisions.
- Implemented a per-target save queue with UUID temporary paths and cleanup after failed writes; the regression confirms all concurrent saves finish and the last requested snapshot loads.

## release package boundary

- Published files are controlled by package.json files; package smoke verifies required runtime assets and rejects source/tests/agent/planning files.
- docs/RELEASE.md is the human checklist; CI repeats the package smoke plus both Godot runtime versions.

## 2026-10-03 community growth baseline

- GitHub API snapshot for LJH-snow/godot-safe-change-mcp: public repository, 0 stars, 0 forks, 0 open issues, 7 topics, no local tags, and 4 required CI jobs.
- Reference hi-godot/godot-ai snapshot: 2,747 stars, 164 forks, 8 open issues, and 5 topics; its README combines hero/demo media, Quick Start, client setup, troubleshooting, privacy, migration, and contribution links.
- The highest-leverage gap is adoption conversion, not raw commit count: release/tag trust, copy-paste starter flow, external feedback entry points, and repeatable demo evidence.
- Created docs/GROWTH.md, CONTRIBUTING.md, and issue templates; the next measurable gates are a first Release, three external install/test reports, and one external issue or PR.
