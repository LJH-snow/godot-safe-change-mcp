# 项目增长与社区采用计划

这份计划的目标不是购买或交换 Star，而是让真实用户更容易发现、安装、验证、使用并贡献 Godot Safe Change MCP。Star 是信任和传播的结果，不是唯一目标。

## 2026-10-03 基线

| 指标 | 当前值 | 说明 |
| --- | ---: | --- |
| GitHub Stars | 0 | GitHub 仓库 API 快照 |
| Forks | 0 | GitHub 仓库 API 快照 |
| Open issues | 0 | 还没有形成公开反馈入口 |
| Topics | 7 | 已包含 godot、mcp、mcp-server、ai-agents 等关键词 |
| Release tags | 0 | 需要发布第一个可复现版本 |
| CI | 4 个 job | Node、package boundary、Godot 4.5.1/4.7.2 |

参考项目 hi-godot/godot-ai 的 GitHub 快照为 2,747 Stars、164 Forks、8 个开放 issue。它的 README 还提供 hero 图、实际演示 GIF、Quick Start、客户端列表、故障排查、隐私说明和完整文档入口。本项目的差异化不应是复制工具数量，而应突出“可审查、可回滚、带 Lease 和证据的 Godot 变更”。

## 目标用户

1. 使用 Claude Code、Codex、Cursor 或其他 MCP 客户端的 Godot 开发者。
2. 不希望 Agent 直接改文件、执行任意脚本或破坏场景的个人开发者。
3. 需要多个窗口/Agent 协作，并且关心 revision、rollback 和操作审计的团队。
4. 想把 Godot 自动化接入 CI、fixture 和回归验证的插件作者。

## 长期路线

### Phase A：信任和转化（0–2 周）

- [x] 双语 README、Inspector 截图、Quick Start 和安全模型。
- [x] 项目本地技能、发布边界、Godot 双版本 CI 和真实 smoke。
- [x] 贡献指南和可复现的 issue 入口。
- [x] Code of Conduct 和 Security policy，明确社区行为和漏洞反馈路径。
- [x] 准备 docs/CONTRIBUTOR_TASKS.md，给未来贡献者提供带验收标准的 good first issue 候选。
- [x] 创建第一个 GitHub Release/tag，并在 Release 页面固定安装方式、兼容版本和 CI 证据。
- [x] 提供真实 GIF 演示：搜索 → preview → confirm → apply → rollback；后续可扩展为带 verify/run 的 60 秒视频。
- [x] 准备中英文社区发布文案、渠道适配和反馈问题模板。

### Phase B：让第一次成功变得简单（2–4 周）

- [x] 提供 examples/starter fixture，用户无需理解内部实现即可运行第一条安全变更。
- [x] GitHub Actions 在 Godot 4.5.1/4.7.2 中打开 starter fixture，防止示例随版本漂移。
- [ ] 增加 5 个可复制的 Agent 示例请求：搜索、创建节点、实例化场景、脚本/资源安全修改、任务恢复。
- [x] 增加 docs/EXAMPLES.md，覆盖搜索、场景变更、实例化/信号、任务 Lease 和冲突恢复。
- [x] 增加 docs/DEMO.md，固定 60 秒录制分镜、旁白和验收标准。
- [ ] 为 Claude Code、Codex、Cursor 和通用 Streamable HTTP 客户端各写一份最小连接示例。
- [x] 发布 docs/FAQ.md，覆盖 EDITOR_UNAVAILABLE、PROJECT_BUSY、REVISION_CONFLICT、Inspector、确认门控和 npm 安装。
- [ ] 为每个主要能力增加一条可链接的 smoke 输出或短演示。

### Phase C：形成外部反馈回路（1–2 个月）

- [x] 设置 good first issue、help wanted、documentation、Godot 版本、starter 和 release-feedback 标签。
- [ ] 每个小版本至少保留一个适合新贡献者的任务：fixture、文档、测试或一个受限操作。
- [ ] 每月发布一次 changelog，记录新增工具、兼容 Godot 版本、迁移影响和 CI 结果。
- [ ] 收集 3 个真实使用案例，优先展示“避免了什么风险”和“如何回滚”，而不是只展示工具数量。
- [ ] 把用户反馈转成公开 issue，并在 README 或 FAQ 中回链解决方案。

### Phase D：有节奏地分发（持续）

- [ ] GitHub Release 后，在 Godot 社区、MCP 社区、个人博客/Dev.to、Reddit 或 Discord 发布真实使用文章。
- [ ] 每次发布只突出一个具体场景：例如“两个 Agent 同时改场景时如何避免覆盖”。
- [ ] 使用同一份演示 fixture、截图和结果，避免不同渠道出现互相矛盾的安装说明。
- [ ] 参与相关项目的 issue/discussion 时先提供解决方案，不把链接当作无关广告。
- [ ] 不购买 Star、不刷评论、不批量发送无关推广、不用虚假 benchmark。

## 每周指标

每周记录一次 GitHub Insights 或 API 数据：

- Stars、Forks、Watchers、Issues、Discussions 和外部贡献者数量。
- Repository views、unique visitors、clones 和 releases 下载量。
- README 到达后的安装尝试、CI smoke 成功率和首次 issue 类型。
- 从发现到第一次成功 smoke 的时间；目标是新用户 15 分钟内完成。

第一阶段的可验证目标是：完成第一个 Release、出现 3 个外部安装/测试反馈、至少 1 个外部 issue 或 PR；不要把绝对 Star 数写成保证，因为它取决于真实用户和传播质量。

## 发布前清单

~~~text
README 能在 30 秒内说明项目解决什么问题
Quick Start 能复制粘贴运行
Godot 插件路径和 MCP endpoint 明确
至少一张真实工具界面截图和一条完整 workflow
安全边界、禁止事项和 rollback 行为明确
CONTRIBUTING、issue template、CHANGELOG 和 Release notes 已更新
check、package boundary、Godot 4.5.1、Godot 4.7.2 全部通过
~~~

## 社区发布文案模板

~~~text
Godot Safe Change MCP：让 Agent 通过 preview → confirm → apply → verify → rollback 参与 Godot 开发。

它不是任意 Godot RPC：场景写入经过 UndoRedo、revision guard、project/task lease 和审计时间线；两个 Agent 同时改同一项目时返回 PROJECT_BUSY，进程崩溃后可按 TTL 接管。

本次演示：<一个具体 fixture 场景>
验证环境：Godot 4.5.1 / 4.7.2，CI smoke 全绿。
反馈入口：GitHub Issues / Discussions。
~~~

## 维护原则

增长工作必须服务于可用性：任何宣传材料都应能由仓库中的命令、fixture、CI 或文档复现。优先修复安装摩擦、错误提示和首次成功路径，再扩展高级 Godot 操作。
