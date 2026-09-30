# Godot Safe Change MCP

[English](README.en.md) | 简体中文

一个让 Agent 通过 MCP 参与 Godot 开发的 MCP Server。TypeScript MCP Server 负责工具契约、计划、确认和报告；GDScript Godot EditorPlugin 负责编辑器上下文、UndoRedo、运行控制和诊断采集。

当前已经打通第一条安全垂直链路：

> 读取编辑器上下文 → 本地 loopback HTTP 桥接 → 预览场景节点变更 → 用户确认 → Godot UndoRedo 应用 → 运行当前场景并返回诊断

## 已实现能力

- project_overview：读取项目 overview 和编辑器连接状态。
- editor_context：读取当前项目、场景、选中节点、打开资源、运行状态和诊断。
- preview_scene_change：生成一个受限 scene.create_node 变更的稳定计划和 diff。
- confirm_scene_change：检查 expected revision 并确认计划。
- apply_scene_change：只把已确认且 revision 未过期的计划交给 Godot UndoRedo。
- rollback_scene_change：只回滚仍处于最新 revision 的已应用计划。
- run_current_scene：运行当前场景，并轮询插件返回 stopped 或 failed 诊断。

当前只支持在当前场景内创建一个 allowlist 中的节点类型：Node、Node2D、Control、Label、ColorRect。

## 本地运行

安装依赖并启动 MCP 开发服务器：

~~~bash
npm install
npm run dev
~~~

然后打开 http://localhost:3000/mcp/inspector，在 Inspector 中查看工具、资源和错误结果。

默认情况下 MCP Server 连接 http://127.0.0.1:8765 的 Godot EditorPlugin 桥接；可通过 GODOT_BRIDGE_URL 覆盖地址。

常用检查：

~~~bash
npm run typecheck
npm test
npm run build
~~~

## Godot 插件

将 godot-plugin 目录复制到目标 Godot 项目：

~~~text
res://addons/godot-safe-change-bridge/
~~~

在 Godot 编辑器中启用 Godot Safe Change Bridge 插件。插件只绑定 127.0.0.1:8765，并只提供固定的 context、changes/apply、run/current 和 run/status 路由。

没有 Godot 编辑器连接时，MCP 工具返回稳定的 EDITOR_UNAVAILABLE，而不会伪造成功。

## 安全边界

- 写操作必须经过 preview、confirmation 和 expected revision 检查。
- 场景节点创建只能由 GDScript 插件通过 Godot EditorUndoRedoManager 执行。
- 不执行 Agent 生成的任意 GDScript、shell、Python 或任意 Godot RPC。
- 插件只接受固定路由和 allowlist 节点类型，并校验当前项目根目录。
- 运行诊断只返回插件采集的输出、warning、error 和运行状态。

完整产品计划见 docs/PLAN.md；测试边界和 Godot 手工验收见 tests/README.md。
