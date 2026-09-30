# 进度记录

## 2026-09-30 rollback verification

- 新增 rollback_scene_change、回滚契约、revision 守卫和结构化 rollback report。
- Godot 4.7.2 runtime 首次暴露 EditorUndoRedoManager 没有 undo 方法；随后改为 get_object_history_id + get_history_undo_redo 后通过真实回滚。
- 真实 MCP 验收通过：apply revision 3568054998，rollback revision 恢复到 1865036137，返回 rolled_back。
- rollback 仍保持 planId 和 applied revision 守卫，不允许撤销用户后续修改。

## 2026-09-29 runtime verification

- 找到本机 Steam 安装的 Godot 4.7.2.stable.steam.ed1daf0bf，并用 headless Editor 加载插件。
- 真实 Godot context 路由返回 connected；scene.create_node 经 EditorUndoRedoManager 应用成功，revision 从 1865036137 变为 4061296536。
- 真实 MCP 端到端调用顺序通过：editor_context → preview_scene_change → confirm_scene_change → apply_scene_change → run_current_scene。
- run_current_scene 返回 stopped，输出包含 fixture scene started，errors 为空。
- 修复 MCP 项目根路径的 realpath 规范化；/tmp 输入现在可连接 macOS 上的 /private/tmp Godot 项目。
- headless dummy renderer 的 texture_2d_get 警告不影响链路结果，已记录为环境限制。

## 2026-09-29

- 已阅读 `README.md` 和 `docs/PLAN.md`，确认目标是第一条安全、可验证的 Godot 开发垂直链路。
- 已加载 cook、planning-with-files、TDD、TypeScript、API/interface、mcp-use 和 Context7 相关规范。
- 已用 Context7 查询当前 `mcp-use` 与 Godot 4.5 文档。
- 已完成项目结构和依赖基线盘点。
- 已确认当前环境没有可执行的 Godot CLI；真实插件链路需在具备 Godot 4.x 的环境验收。
- 已确认现有桥接、插件和变更契约仍是占位/草案，尚未形成安全写操作闭环。
- 基线 `npm run typecheck` 通过；一次依赖检索正则失败，已改用简单模式继续。
- 已新增 Node 原生测试配置和第一组垂直链路测试；npm test 红灯，失败点集中在预期的缺失契约与实现。
- 已实现领域契约、ChangeCoordinator 和 HttpGodotBridge；应用层与 HTTP 桥接测试已转绿。
- 当前唯一失败是插件安全边界测试，因为 plugin.gd 仍然是占位实现。
- 已实现 GDScript TCPServer 路由、EditorInterface 上下文、EditorUndoRedoManager 应用和当前场景运行诊断入口；插件边界测试已转绿。
- 已接入 MCP 工具、结构化输出和运行状态轮询；mcp-use 类型检查通过。
- 已先写运行轮询红灯，再实现启动后查询 run/status；npm test 当前通过：7 个测试全部通过。
- 已运行 build 并启动 127.0.0.1:3100 的开发服务器；npx mcp-use client 因 EALLOWSCRIPTS 无法自动安装可选客户端。
- 已改用公开 MCP HTTP 端点验证 initialize、tools/list、resources/list、resources/read 和 editor_context 的 EDITOR_UNAVAILABLE 错误路径。
- 已补齐能力资源、README、插件说明、测试边界、Godot fixture 和 UTF-8 安全的字节缓冲解析。
- 最终回归通过：npm test 7/7、npm run typecheck、npm run build；真实 MCP HTTP 端点也验证了工具/资源清单和 EDITOR_UNAVAILABLE 错误路径。
- 当前完成边界：本机没有 Godot 4.x CLI，尚未实际加载 EditorPlugin、执行 UndoRedo 或运行 fixture；这些步骤已写入 tests/README.md，需在安装 Godot 的环境验收。
