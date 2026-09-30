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

## 待核实问题

- 当前 `mcp-use@2.7.1` 安装包的实际导出和现有代码是否使用旧/新参数名。
- Godot fixture 使用的 Godot 4.x 小版本，以及本机是否安装 `godot` 或 `godot4` CLI。
- EditorPlugin HTTP 服务采用 `HTTPServer` 还是 `TCPServer`，以及 Godot 4.x 对当前运行状态/输出的可读 API。
- 诊断结果的轮询边界、超时和 operation ID 形状。
