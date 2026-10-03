# Contributor task board

这些任务适合在社区开放后转成 GitHub Issues。它们都必须保持项目的安全边界，并补齐契约、第二道插件校验、回归测试和双版本 Godot smoke。

## Good first issue

### Add client configuration examples

- Scope: document Claude Code、Codex、Cursor 和通用 Streamable HTTP 客户端的最小配置。
- Acceptance: 每个示例能连接 <code>http://127.0.0.1:3000/mcp</code>，不要求用户暴露 Godot bridge。
- Labels: <code>good first issue</code>、<code>documentation</code>、<code>starter</code>。

### Improve the starter fixture copy guide

- Scope: 为 macOS、Linux、Windows 补充 Godot 插件复制和启用截图说明。
- Acceptance: 新用户可以从 examples/starter 启动到 editor_context 成功。
- Labels: <code>good first issue</code>、<code>documentation</code>、<code>starter</code>。

## Intermediate

### Add scene.disconnect_signal — implemented

- Scope: 复用 scene.connect_signal 的 signal/method 快照，预览并安全断开一个已有连接。
- Guards: 源/目标 NodePath、signal、method、已有 connection、expected revision、UndoRedo history。
- Acceptance: apply 只移除指定连接，rollback 恢复连接；误删其他连接必须被拒绝；TypeScript 和真实 Godot smoke 已覆盖。
- Labels: <code>enhancement</code>、<code>godot-4.5.1</code>、<code>godot-4.7.2</code>。

### Add verify_resource_state — implemented

- Scope: 为 task 增加只读资源内容/引用断言，不提供新的写能力。
- Guards: res:// 路径、文件 revision、匹配数量和有限 contains/matchCounts 断言字段。
- Acceptance: 记录 observed/expected、operationId 和 timeline mismatch evidence；TypeScript 回归已覆盖 revision 与匹配数量冲突。
- Labels: <code>enhancement</code>、<code>good first issue</code>。

## Advanced

### Add a second MCP-process starter smoke

- Scope: 使用 examples/starter 验证两个 MCP 进程的 PROJECT_BUSY、TTL 接管和任务恢复。
- Acceptance: 两个 Godot 版本都运行；失败时清理编辑器、MCP 和临时目录进程。
- Labels: <code>enhancement</code>、<code>godot-4.5.1</code>、<code>godot-4.7.2</code>。

### Add release artifact verification — implemented

- Scope: release:check 验证 npm 元数据、GitHub Release tag、starter link、demo asset 和四项 CI 证据指向同一版本。
- Acceptance: docs/releases/v1.1.0.json 记录 commit SHA、package version、tag 和 CI run URL；不一致时脚本以非零状态退出并报告具体字段。
- Labels: <code>documentation</code>、<code>release-feedback</code>。

## Contribution rule

不要一次提交多个无关操作。每个任务都应先写一个会失败的测试，再实现最小行为，最后更新 docs/PLAN.md、tests/README.md 和 CHANGELOG.md。任何任务如果需要任意 GDScript、shell、Python、Godot RPC 或绕过确认，都不符合项目边界。
