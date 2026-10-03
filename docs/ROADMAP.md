# Long-term adoption roadmap

这份路线图把“提高知名度”拆成用户能够验证的结果，而不是承诺某个 Star 数。Star 应来自真实安装、成功使用和持续贡献。

## North star

让一个没有读过源码的 Godot 开发者在 15 分钟内完成：安装 → 连接 → 只读理解 → preview → confirm → apply → verify → rollback，并能在遇到问题时提交脱敏、可复现的反馈。

## 0–30 days: make the public baseline trustworthy

- 合并 PR #15 到默认分支，并确认默认分支的 README、starter、Release、CI badge 和反馈入口一致。
- 保持 npm 包、GitHub Release、双语 README 和版本化 release evidence 同步。
- 使用同一套 starter fixture 维护 Inspector GIF、客户端配置和 smoke evidence map。
- 在用户授权社区发布前，只完善内部文档、Issue 模板和回归测试，不自动发帖或创建反馈。

## 30–90 days: close the first-user feedback loop

- 获得至少 3 份真实安装或 starter 测试反馈，并将每份反馈脱敏后关联到一个 issue、FAQ 或 changelog 修复。
- 记录首次成功时间、EDITOR_UNAVAILABLE、PROJECT_BUSY、REVISION_CONFLICT 和 rollback 失败的比例。
- 每周检查 README 访问、npm 下载、Release 下载、Issue 类型和 CI 失败原因；不把单一 Star 数当作唯一指标。
- 为每个新增能力保留契约测试、真实 Godot smoke 和一段可复制的请求示例。

## 3–6 months: turn usage into contributions

- 每个小版本保留一个 good first issue：starter、文档、测试或一个受限 Godot 操作。
- 建立兼容性记录：Godot 4.x 小版本、Node.js、Claude Code、Codex、Cursor 和通用 MCP 客户端。
- 只在用户授权后选择一个最相关的社区渠道发布一篇真实案例；内容优先讲风险、证据和 rollback，不诱导互 Star。
- 把已验证的外部反馈整理为小型案例，明确环境、命令、结果和限制。

## 6–12 months: build durable trust

- 形成月度 release cadence：变更摘要、迁移影响、CI 证据、npm 包边界和安全说明一起发布。
- 维护贡献者路径：good first issue → reproducible test → Godot smoke → review → changelog。
- 评估只读索引缓存、可选 worktree 隔离和更多 Godot 4.x 兼容性；任何新写能力仍必须经过 preview、confirm、lease、revision、verify 和 rollback。
- 需要更高并发或团队采用时，再设计可审计的组织级策略；不以绕过用户确认换取自动化速度。

## Success gates

- **Discoverability:** README、starter、客户端配置和演示链接在默认分支可用。
- **First success:** 新用户能在 15 分钟内完成一次安全闭环。
- **Trust:** 每个发布版本有双版本 Godot CI、package boundary 和可追溯 commit。
- **Feedback:** 至少 3 份真实测试反馈和 1 个经授权的外部 issue/PR。
- **Contribution:** 至少一个新贡献者能按文档完成一个受限任务。

Absolute Star targets are intentionally not a release gate. If adoption grows, Stars should follow from useful software and honest evidence rather than promotion shortcuts.
