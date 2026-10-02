# Contributing

感谢你为 Godot Safe Change MCP 提交问题、文档、测试或代码。这个项目的核心约束是：Agent 只能通过可审查、可确认、可回滚的领域操作改变 Godot 项目。

## 开始开发

环境要求：Node.js 22.22.2 或更新版本；真实 Godot smoke 另外需要 Godot 4.x 编辑器。

~~~bash
npm ci
npm test
npm run typecheck
npm run build
npm run package:check
~~~

有 Godot 编辑器时，再运行：

~~~bash
GODOT_BIN=/path/to/Godot node tests/godot-runtime-smoke.mjs
~~~

## 新增 Godot 操作

请先阅读：

- <code>SKILLS/godot-safe-change/SKILL.md</code>
- <code>SKILLS/godot-runtime-smoke/SKILL.md</code>
- <code>SKILLS/godot-safe-change/references/operation-matrix.md</code>
- <code>tests/README.md</code>

每个写操作都必须保持以下顺序：

~~~text
preview → explicit confirm → expected revision and lease → apply → verify → guarded rollback
~~~

一个完整操作通常需要同步更新：

1. TypeScript Zod contract 和 ChangeCoordinator。
2. GDScript 插件的第二道校验和 UndoRedo 操作。
3. fake bridge/contract 测试。
4. Godot fixture smoke，覆盖成功、非法输入、revision conflict 和 rollback。
5. README、docs/PLAN.md、tests/README.md 和 progress.md。

不要添加任意 GDScript、shell、Python、任意 Godot RPC、未限制的文件写入或绕过确认的快捷路径。

## Pull Request 清单

- 说明用户场景、操作边界和为什么不提供更宽的能力。
- 包含测试，并说明你先观察到的失败行为。
- 说明是否需要 Godot 4.5.1/4.7.2 runtime smoke。
- 运行 npm test、typecheck、build、package:check 和 git diff --check。
- 如果改动了写操作，提供 apply 后的状态证据和 rollback 证据。
- 不提交 .env、token、临时 fixture 状态、Godot 用户目录或构建产物。

## Issue 和讨论

提交 bug 时请包含最小复现、Godot 版本、Node.js 版本、MCP 客户端、错误码和相关 CI/run URL。功能请求请说明用户任务、所需的最小权限边界以及如何验证和回滚。

## 行为准则

保持技术讨论具体、尊重和可复现。不同意设计时，请针对约束、证据和用户影响提出意见。
