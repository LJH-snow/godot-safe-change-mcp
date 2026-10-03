# Contributor task board

这些任务适合在社区开放后转成 GitHub Issues。它们都必须保持项目的安全边界，并补齐契约、第二道插件校验、回归测试和双版本 Godot smoke。

## Good first issue

### Add client configuration examples — implemented

- Scope: document Claude Code、Codex、Cursor 和通用 Streamable HTTP 客户端的最小配置。
- Acceptance: docs/CLIENTS.md 为每个客户端指向 <code>http://127.0.0.1:3000/mcp</code>，说明 bridge 与 MCP endpoint 的边界，并给出首次只读验证流程。
- Labels: <code>good first issue</code>、<code>documentation</code>、<code>starter</code>。

### Improve the starter fixture copy guide — implemented

- Scope: 为 macOS、Linux、Windows 补充 Godot 插件复制和启用截图说明。
- Acceptance: examples/starter/README.md 已提供 macOS/Linux、Windows PowerShell、插件文件核对、启用和 editor_context 首次连接步骤。
- Labels: <code>good first issue</code>、<code>documentation</code>、<code>starter</code>。

## Intermediate

### Add scene.disconnect_signal — implemented

- Scope: 复用 scene.connect_signal 的 signal/method 快照，预览并安全断开一个已有连接。
- Guards: 源/目标 NodePath、signal、method、已有 connection、expected revision、UndoRedo history。
- Acceptance: apply 只移除指定连接，rollback 恢复连接；误删其他连接必须被拒绝；TypeScript 和真实 Godot smoke 已覆盖。
- Labels: <code>enhancement</code>、<code>godot-4.5.1</code>、<code>godot-4.7.2</code>。

### Add scene group management — implemented

- Scope: 通过 scene.add_group / scene.remove_group 管理当前场景节点的分组成员关系。
- Guards: 安全 NodePath、组名字符集与长度、重复添加和缺失成员拒绝、expected revision。
- Acceptance: editor_context 暴露只读 groups；apply/rollback 通过 Godot UndoRedo 互逆恢复；TypeScript 与真实 Godot smoke 已覆盖。
- Labels: <code>enhancement</code>、<code>godot-4.5.1</code>、<code>godot-4.7.2</code>。

### Add project autoload management — implemented

- Scope: 通过 project.autoload.add / project.autoload.remove 管理 project.godot 的自动加载单例注册。
- Guards: 单例名字符集与长度、项目内 .gd 脚本存在性、重复注册和缺失注册拒绝、project.godot revision guard。
- Acceptance: 只读 autoload 快照路由支撑 preview；apply 原子保存并在失败时恢复，rollback 恢复注册前状态；TypeScript 与真实 Godot smoke 已覆盖。
- Labels: <code>enhancement</code>、<code>godot-4.5.1</code>、<code>godot-4.7.2</code>。

### Add scene.reorder_node — implemented

- Scope: 调整当前场景节点在兄弟中的排序（绘制与输入顺序）。
- Guards: 安全 NodePath、拒绝场景根、兄弟索引范围校验、无变化拒绝、expected revision。
- Acceptance: preview 报告 fromIndex/toIndex；apply/rollback 通过 Godot UndoRedo move_child 互逆恢复；TypeScript 与真实 Godot smoke 已覆盖。
- Labels: <code>enhancement</code>、<code>godot-4.5.1</code>、<code>godot-4.7.2</code>。

### Add scene.set_unique_name — implemented

- Scope: 启用或停用节点的场景唯一名，让脚本可以通过 %Name 引用。
- Guards: 安全 NodePath、拒绝场景根、无变化拒绝、场景内同名唯一名占用拒绝、expected revision。
- Acceptance: editor_context 暴露只读 uniqueNameInOwner；apply/rollback 通过 Godot UndoRedo 属性互逆恢复；TypeScript 与真实 Godot smoke 已覆盖。
- Labels: <code>enhancement</code>、<code>godot-4.5.1</code>、<code>godot-4.7.2</code>。

### Add script.create_file — implemented

- Scope: 创建新的项目内 GDScript 文件，让 Agent 可以从零引导项目脚本。
- Guards: res:// .gd 路径、内容非空且 ≤100000 字符、已存在拒绝、原子写入、回滚在内容未变时删除文件。
- Acceptance: 只读脚本快照验证创建结果；TypeScript 与真实 Godot smoke 已覆盖。
- Labels: <code>enhancement</code>、<code>good first issue</code>、<code>godot-4.5.1</code>、<code>godot-4.7.2</code>。

### Add verify_resource_state — implemented

- Scope: 为 task 增加只读资源内容/引用断言，不提供新的写能力。
- Guards: res:// 路径、文件 revision、匹配数量和有限 contains/matchCounts 断言字段。
- Acceptance: 记录 observed/expected、operationId 和 timeline mismatch evidence；TypeScript 回归已覆盖 revision 与匹配数量冲突。
- Labels: <code>enhancement</code>、<code>good first issue</code>。

### Add verify_script_state — implemented

- Scope: 为 task 增加只读脚本内容断言，不提供新的写能力。
- Guards: 项目内脚本路径、可选脚本 revision、最多 10 条 contains 和 matchCounts 断言。
- Acceptance: 返回有限 observed/expected 证据，不回传脚本全文；TypeScript 回归与真实 Godot task smoke 已覆盖。
- Labels: <code>enhancement</code>、<code>good first issue</code>。

## Advanced

### Add a second MCP-process starter smoke — implemented

- Scope: 使用 examples/starter 验证两个 MCP 进程的 PROJECT_BUSY、TTL 接管和任务恢复。
- Acceptance: tests/starter-multiprocess-smoke.mjs 已接入两个 Godot runtime job，验证 PROJECT_BUSY、TTL 接管、starter 资源任务恢复，并在失败时清理编辑器、MCP 和临时目录进程。
- Labels: <code>enhancement</code>、<code>godot-4.5.1</code>、<code>godot-4.7.2</code>。

### Add release artifact verification — implemented

- Scope: release:check 验证 npm 元数据、GitHub Release tag、starter link、demo asset 和四项 CI 证据指向同一版本。
- Acceptance: docs/releases/v1.1.0.json 记录 commit SHA、package version、tag 和 CI run URL；不一致时脚本以非零状态退出并报告具体字段。
- Labels: <code>documentation</code>、<code>release-feedback</code>。

## Contribution rule

不要一次提交多个无关操作。每个任务都应先写一个会失败的测试，再实现最小行为，最后更新 docs/PLAN.md、tests/README.md 和 CHANGELOG.md。任何任务如果需要任意 GDScript、shell、Python、Godot RPC 或绕过确认，都不符合项目边界。
