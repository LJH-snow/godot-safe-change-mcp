# Community launch kit

这些文案用于真实项目展示、社区讨论和用户反馈。发布时请保留实际链接，不要承诺未经验证的能力，也不要把“请点 Star”作为唯一行动号召；先邀请用户安装、运行 starter、提出问题或贡献改进。

## Canonical links

- Repository: https://github.com/LJH-snow/godot-safe-change-mcp
- Release: https://github.com/LJH-snow/godot-safe-change-mcp/releases/tag/v1.1.0
- npm: https://www.npmjs.com/package/godot-safe-change-mcp
- Starter: https://github.com/LJH-snow/godot-safe-change-mcp/tree/feature/run-scene-project-leases/examples/starter
- Demo asset: https://github.com/LJH-snow/godot-safe-change-mcp/blob/feature/run-scene-project-leases/docs/assets/mcp-safe-change-demo.gif

## English launch post

### Title

Godot Safe Change MCP: reviewable, rollback-safe Godot changes for AI agents

### Body

I built Godot Safe Change MCP to let AI agents work on Godot projects without exposing arbitrary GDScript, shell commands, or Godot RPC.

The workflow is explicit:

~~~text
inspect → preview a diff → confirm → acquire lease → apply through UndoRedo → verify → rollback
~~~

Version 1.1.0 includes:

- live editor context and project search;
- safe scene create/delete/reparent/rename/duplicate/instantiate;
- bounded properties, scripts, resources, input actions, and script ranges;
- task leases with heartbeat, TTL takeover, and timeline evidence;
- real Godot 4.5.1 and 4.7.2 CI smoke.

The starter fixture and a real Inspector workflow GIF are included in the repository. I would especially like feedback on the first-install path, MCP client compatibility, and which safe Godot operation should come next.

## 中文发布文案

### 标题

Godot Safe Change MCP：让 Agent 通过可审查、可回滚的流程修改 Godot 项目

### 正文

我做了 Godot Safe Change MCP，用 MCP 连接 AI Agent 和 Godot 编辑器，但不开放任意 GDScript、shell 或 Godot RPC。

每次写入都遵循：

~~~text
读取上下文 → Preview Diff → 用户确认 → 获取 Lease → Godot UndoRedo → 验证 → Rollback
~~~

v1.1.0 已覆盖项目搜索、场景结构和实例化、属性/脚本/资源/输入修改、任务级 Lease、TTL 接管和双版本 Godot CI。仓库提供 starter fixture 与真实 Inspector 工作流 GIF。

欢迎帮助测试首次安装、不同 MCP 客户端连接和下一个最值得开放的安全 Godot 操作；问题请附 Godot 版本、错误码和最小复现。

## Channel adaptations

| Channel | Lead with | Include | Avoid |
| --- | --- | --- | --- |
| Godot forum/Discord | Agent 如何避免破坏场景 | starter、UndoRedo、rollback、Godot 版本 | 泛泛的 AI 宣传 |
| Reddit r/godot | 一个具体场景：两个 Agent 同时改项目 | GIF、真实 Diff、PROJECT_BUSY、安装命令 | 只贴链接不解释用途 |
| MCP 社区 | MCP tool contract 和 task lease | tools、structured output、CI matrix、release | 声称兼容未验证的客户端 |
| Dev.to/博客 | 一个完整案例 | 问题、操作前后、失败恢复、日志证据 | 只列功能清单 |
| X/短帖 | 一句话结果和 GIF | Release 链接、starter、反馈问题 | 诱导互 Star |

## 反馈问题

每次发布后只问 2–3 个具体问题：

1. 你使用的 Godot 版本和 MCP 客户端是什么？
2. 从安装到第一次 context/search 成功用了多久？
3. 哪个安全操作最值得优先支持：signal、资源、输入、任务验证还是其他？

把回答转成公开 issue，并添加 starter、release-feedback、godot-4.5.1 或 godot-4.7.2 标签。不要替用户创建虚假反馈或未经同意的 issue。
