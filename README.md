# Godot Safe Change MCP

[English](README.en.md) | 简体中文

一个让 Agent 通过 MCP 参与 Godot 开发的 MCP Server。TypeScript MCP Server 负责工具契约、计划、确认和报告；GDScript Godot EditorPlugin 负责编辑器上下文、UndoRedo、运行控制和诊断采集。

当前已经打通第一条安全垂直链路：

> 读取编辑器上下文 → 本地 loopback HTTP 桥接 → 预览场景节点变更 → 用户确认 → Godot UndoRedo 应用 → 运行当前场景并返回诊断

## 已实现能力

- project_overview：读取项目 overview 和编辑器连接状态，并基于本地只读索引统计真实的场景、脚本、资源和设置文件数量（编辑器离线时同样可用）。
- editor_context：读取当前项目、场景、选中节点、打开资源、运行状态和诊断。
- preview_diagnostic_repair：仅根据诊断中明确的受限 repair hint 生成下一份 preview plan。
- operation_history：查询最近的 preview、confirm、apply、rollback、run 操作及其输入、输出、revision 和错误证据；审计事件持久化在用户状态目录，支持重启后恢复。
- search_project：统一的只读项目搜索，覆盖场景、节点、脚本、资源、信号连接和输入映射。场景/节点/脚本/资源优先由连接的 Godot 编辑器返回（编辑中场景的实时状态），编辑器离线时自动回退到本地只读索引；信号与输入结果始终来自本地索引。每条结果带 `source` 标记来源。
- find_references：反向引用查找，回答“哪些场景/资源引用了这个脚本、贴图或资源”。支持按 res:// 路径或 uid:// 标识匹配，能解析 Godot 4.4+ 中省略路径、只写 uid 的引用（纯本地只读）。
- preview_scene_change：生成一个受限 scene.create_node 变更的稳定计划和 diff。
- preview_scene_change：也支持受限 script.replace_range preview，返回文件 revision 和行级 before/after diff；apply 使用临时文件原子替换，rollback 恢复原始内容。
- confirm_scene_change：检查 expected revision 并确认计划。
- apply_scene_change：只把已确认且 revision 未过期的计划交给 Godot UndoRedo。
- rollback_scene_change：只回滚仍处于最新 revision 的已应用计划。
- run_current_scene：运行当前场景，并轮询插件返回 stopped 或 failed 诊断。
- create_task / get_task / advance_task / pause_task / resume_task / cancel_task：把受限的 apply、rollback 和 run 步骤组成一个可审查的多步骤任务；任务状态持久化在项目内 `.godot-safe-change/tasks/`，支持暂停、继续、取消、失败重试和重启后恢复。步骤只复用既有的确认、revision 守卫和 UndoRedo 语义，不引入新的写入能力。

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

## 通过 npx 运行

无需克隆仓库即可启动（需要 Node >= 22.22.2，首次运行会自动构建）：

~~~bash
npx github:LJH-snow/godot-safe-change-mcp
~~~

发布到 npm 后也可以：

~~~bash
npx godot-safe-change-mcp
~~~

服务器在 `http://127.0.0.1:3000/mcp` 提供 MCP Streamable HTTP 端点；可用 `PORT`、`HOST` 和 `GODOT_BRIDGE_URL` 环境变量覆盖默认值。

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
