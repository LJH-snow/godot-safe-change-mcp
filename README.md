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
- project lease：apply/rollback 自动获取短租约，多个窗口同时写入同一项目时返回 PROJECT_BUSY；租约状态存放在用户状态目录，不写入 Godot 项目。
- search_project：统一的只读项目搜索，覆盖场景、节点、脚本、资源、信号连接和输入映射。场景/节点/脚本/资源优先由连接的 Godot 编辑器返回（编辑中场景的实时状态），编辑器离线时自动回退到本地只读索引；信号与输入结果始终来自本地索引。每条结果带 `source` 标记来源。
- find_references：反向引用查找，回答“哪些场景、资源或脚本引用了这个脚本、贴图或资源”。支持场景/资源 ext_resource、GDScript `preload()` / `load()`，可按 res:// 路径或 uid:// 标识匹配，能解析 Godot 4.4+ 中省略路径、只写 uid 的引用（纯本地只读）。
- preview_scene_change：生成受限 scene.create_node、scene.delete_node、scene.reparent_node、scene.rename_node、scene.duplicate_node、scene.set_property、scene.attach_script、scene.detach_script、resource.replace_reference、project.input_action.add_key/remove_key/replace_key 或 script.replace_range 计划和 diff。
- scene.duplicate_node：只允许复制当前场景拥有的非根节点子树到当前场景其他父节点；拒绝循环、重名和外部实例节点，preview 返回源/目标路径映射，apply/rollback 通过 Godot UndoRedo 保持 owner 和全局变换策略。
- scene.rename_node：只允许重命名当前场景拥有的非根节点；拒绝同名 no-op、非法名称和同级重名，preview 显示该子树所有受影响 NodePath；apply/rollback 通过 Godot UndoRedo 恢复名称及路径。
- scene.reparent_node：只允许当前场景拥有的非根节点移动到当前场景内其他父节点；拒绝循环、同父级无效移动和重名节点。preview 展示 NodePath、父节点、child index 和全局变换策略，默认保留全局变换，apply/rollback 通过 Godot UndoRedo 恢复原层级和顺序。
- scene.delete_node：只允许删除当前场景内由当前场景拥有的非根节点；preview 返回完整待删除子树快照，apply/rollback 通过 Godot UndoRedo 保持原父级和节点顺序。
- scene.set_property：仅允许 visible、position、size、text、color，并绑定节点类型、严格对象字段、finite 数值范围和当前属性快照。
- scene.attach_script：仅允许给当前场景节点挂载项目内现有 `.gd` 脚本，不执行或修改脚本内容。
- scene.detach_script：仅允许移除当前场景节点已有的项目内 `.gd` 脚本；apply/rollback 通过 Godot UndoRedo 恢复原脚本资源，预览会返回原脚本路径。
- resource.replace_reference / project.input_action.add_key/remove_key/replace_key：分别通过文件 revision 或 project.godot revision guard 执行受限替换/设置保存，并支持安全 rollback；按键删除和替换只接受唯一匹配的 InputEventKey，替换会保留原修饰键。
- confirm_scene_change：检查 expected revision 并确认计划。
- apply_scene_change：只把已确认且 revision 未过期的计划交给 Godot UndoRedo 或对应的受限文件/设置写入路径；同一项目同时只允许一个已应用计划。
- rollback_scene_change：只回滚仍处于最新 revision、文件 revision 或 UndoRedo history 的已应用计划。
- run_current_scene：运行当前场景，并轮询插件返回 stopped 或 failed 诊断。
- run_scene：运行一个经过 `res://` 和 `.tscn` 路径校验的指定场景，并通过 run ID 轮询长时运行状态。
- create_task / get_task / advance_task / pause_task / resume_task / cancel_task：把受限的 apply、rollback、run、scene-state/diagnostics 验收和诊断修复预览/应用步骤组成一个可审查的多步骤任务；每个任务的 `stepId` 必须唯一，修复预览后暂停等用户确认，apply 仍走既有 revision/confirmation 守卫。

- acquire_task_lease / renew_task_lease / release_task_lease：管理跨多个 task 步骤的项目 lease，返回 owner、过期时间和 recoverable 状态；多个 MCP 进程并发接管时通过原子文件 lease 保证单一 owner。
- task_status：只读返回任务状态、lease owner、expiresAt 和可恢复状态。
- task_timeline：只读查询完整任务时间线，可按 stepId、operationId、事件类型和 ISO 时间范围过滤。

当前只支持在当前场景内创建一个 allowlist 中的节点类型：Node、Node2D、Control、Label、ColorRect；场景属性修改、脚本挂载/卸载、节点删除、重挂和重命名只针对当前场景内的相对 NodePath 和 allowlisted 属性。

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
npm run package:check
~~~

## 发布前检查

发布前必须在干净工作区执行完整检查，并确认当前提交已推送：

~~~bash
npm ci
npm test
npm run typecheck
npm run build
npm run package:check
GODOT_BIN=/path/to/Godot node tests/godot-runtime-smoke.mjs
~~~

GitHub Actions 还必须通过 `check`、`npm package boundary`、Godot `4.5.1 runtime` 和 Godot `4.7.2 runtime` 四个 job。Godot smoke 会在同一真实 EditorPlugin 桥接上启动两个 MCP 进程，验证 lease 冲突和 TTL 接管。`npm run package:check` 会用实际 tarball 的显式发布清单检查包边界，拒绝源码、测试、文档、CI、脚本和锁文件进入包。

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

在 Godot 编辑器中启用 Godot Safe Change Bridge 插件。插件只绑定 127.0.0.1:8765，并只提供固定的 context、changes/apply、changes/rollback、search、受限 snapshot/read 和 run 路由。

没有 Godot 编辑器连接时，MCP 工具返回稳定的 EDITOR_UNAVAILABLE，而不会伪造成功。

## 安全边界

- 写操作必须经过 preview、confirmation 和 expected revision 检查。
- 场景创建、属性修改和脚本挂载只能由 GDScript 插件通过 Godot EditorUndoRedoManager 执行；scene rollback 会校验 history、version、action 和 label。
- 文件和项目设置修改只走受限 `.gd` 原子替换、资源引用替换或 ProjectSettings 路径，并保留 file revision guard。
- 不执行 Agent 生成的任意 GDScript、shell、Python 或任意 Godot RPC。
- 插件只接受固定路由、allowlist 节点类型、safe relative NodePath 和项目内路径，并校验当前项目根目录。
- 运行诊断只返回插件采集的输出、warning、error 和运行状态。

完整产品计划见 docs/PLAN.md；测试边界和 Godot 手工验收见 tests/README.md；发布前清单见 docs/RELEASE.md。
