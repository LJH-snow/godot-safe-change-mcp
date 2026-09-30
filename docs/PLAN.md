# Godot Safe Change MCP 计划

状态：第一条垂直链路已实现，并已在本机 Godot 4.7.2 headless Editor 中完成 runtime 验收。

## 1. 产品方向

这个项目最终要让 Agent 能通过 MCP 实际参与 Godot 开发，而不只是查询项目或生成建议。
安全变更、Diff、确认、回滚和验证，是实现这个目标的控制方式，不是产品终点。

这个项目不做现有 Godot MCP 项目的工具复刻，也不追求一次暴露大量编辑器 CRUD
能力。核心价值是：

> 让 Agent 理解 Godot 项目，并通过可审查、可回滚、经过验证的操作完成开发任务。

一个完整的 Agent 开发任务应该能够形成这样的闭环：

~~~text
理解项目 → 制定步骤 → 预览变更 → 用户确认 → 操作 Godot
    ↑                                                   ↓
    └────── 收集运行结果、错误和证据 ← 验证与调试 ←─────┘
~~~

目标场景示例：

- 创建一个场景和节点，设置属性，挂载脚本并保存；
- 为玩家添加输入动作和移动逻辑，然后运行当前场景；
- 读取 Godot 输出，定位脚本错误或资源引用错误，提出修复并再次验证；
- 修改现有场景或脚本前展示具体 Diff，用户确认后应用；
- 在操作失败或用户反悔时，通过 Godot 的 UndoRedo 或变更记录恢复。

首要差异化能力：

- 项目索引：场景、节点、脚本、信号、资源、输入映射和关键设置；
- 编辑器上下文：当前场景、选中节点、打开的资源、运行状态和连接状态；
- Agent 任务编排：把自然语言开发请求拆成有前置条件和结果的操作步骤；
- Godot 操作执行：通过受限的领域操作修改场景、资源、脚本和项目设置；
- 运行与诊断：启动项目或当前场景，收集输出、错误、警告和运行结果；
- 变更计划：AI 先生成结构化计划，不直接修改文件；
- Diff 预览：展示具体节点、属性或代码行的变化；
- 版本保护：使用 expected revision 检测用户并发修改；
- 事务式应用：通过 Godot UndoRedo 执行可撤销修改；
- 验证报告：运行场景或测试，汇总错误、警告和证据。

### 操作边界

MCP 暴露的是面向 Agent 的开发意图，而不是 Godot 内部对象的任意 RPC：

- 允许 Agent 查询项目、场景、节点、资源、脚本和编辑器状态；
- 允许 Agent 生成操作计划，并预览节点属性、资源引用或代码行变化；
- 允许 Agent 在确认后执行受限操作，并返回操作 ID、变更报告和新版本号；
- 允许 Agent 运行项目、读取诊断信息和继续下一步修复；
- 不提供任意 `execute_gdscript`、任意 shell 或不受限制的文件系统写入。

这样 Agent 仍然能够完成真实开发工作，但每一步都有明确的范围、前置条件和结果。

## 2. MVP 范围

MVP 不是“只读查询服务”，而是先打通一条可验证的开发垂直链路：

> 读取项目 → 修改一个场景或脚本 → 运行 → 获取错误 → 生成修复 → 再次验证。

### 第一阶段：项目理解与编辑器上下文

- `project_overview`：返回项目路径、索引状态和编辑器连接状态；
- `search_project`：搜索场景、脚本、资源和节点；
- 读取当前场景、选中节点、打开资源和编辑器运行状态；
- 建立场景树、脚本、资源引用和输入映射的可查询索引；
- `godot://capabilities`：公开当前服务的能力和安全边界；
- Godot EditorPlugin：显示连接状态和当前编辑器上下文。

验收标准：Agent 能回答项目结构和当前编辑器状态；本阶段没有任何写入或任意代码执行。

### 第二阶段：Agent 操作计划与预览

- 定义场景、节点、资源、脚本、输入映射和项目设置的有限操作；
- 将多个有限操作组合成有依赖关系的开发任务；
- 返回结构化变更计划、风险等级和统一 diff；
- 对项目根目录、文件扩展名和节点路径做边界校验；
- 加入 revision conflict 检测。

验收标准：相同输入产生稳定计划；Agent 可以预览“创建节点、挂载脚本、设置属性、修改代码”等实际开发步骤；项目版本变化时拒绝过期计划。

### 第三阶段：Godot 操作执行与回滚

- 用户确认后才允许 apply；
- 场景修改必须经过 Godot UndoRedo；
- 文件修改先落盘到临时文件，再通过原子替换提交；
- 操作必须经过 Godot EditorPlugin，而不是让 MCP 直接伪造编辑器状态；
- 每次提交生成 change report 和 rollback 信息。

验收标准：Agent 能完成一个小型 Godot 开发任务；应用失败时不留下半成品；成功变更可以撤销或恢复。

### 第四阶段：运行、诊断与修复闭环

- 运行当前场景或项目；
- 收集 Godot 输出、脚本错误和场景运行结果；
- 将错误关联回脚本行、节点路径、资源或最近一次变更；
- 支持 Agent 根据诊断结果生成下一次修复计划；
- 输出简洁的验证报告，必要时附截图或日志资源；
- 为性能、资源引用和场景结构提供可插拔规则。

验收标准：Agent 能根据一次运行错误继续执行修复流程；每个写操作都有验证结果，而不是只返回“已完成”。

### 第五阶段：多步骤开发任务

- 支持保存和恢复 Agent 当前任务状态；
- 支持长时间运行的导入、构建、运行和测试操作；
- 支持任务级别的暂停、继续、取消和失败恢复；
- 提供可审计的操作时间线，显示每一步的输入、变更、输出和证据。

验收标准：Agent 可以在一个任务中连续完成“理解、修改、运行、诊断、修复、验证”，并且中途失败后能够从最后一个确定状态继续。

## 3. 边界与接口

MCP Server 是 Agent 的控制层，负责工具契约、任务编排、权限策略、变更计划和报告；
Godot EditorPlugin 是执行层，负责编辑器真实状态、UndoRedo、运行控制和 Godot
原生 API。两边通过独立的本地桥接协议通信，不让 MCP 回调直接依赖 Godot 内部对象。

协议需要保持语言无关，使未来可以增加 Python、Rust 或其他分析 worker，而不用改变
Agent 面向的 MCP 工具契约。

当前目录边界：

~~~text
index.ts                         MCP Server 入口
src/domain/                      契约、操作类型、错误码
src/application/                 用例和服务编排
src/infrastructure/              Godot 桥接适配器
src/tools/                       MCP 工具注册
src/resources/                   MCP 资源注册
godot-plugin/                    Godot EditorPlugin 适配器
tests/                           契约、应用、集成和 Godot 测试边界
docs/                            产品与技术文档
~~~

## 4. 安全约束

- 默认只读；写操作必须显式区分 preview 和 apply；
- 不执行 AI 生成的任意 GDScript、shell 或系统命令；
- 所有路径解析后必须位于允许的 Godot 项目根目录；
- 删除、覆盖、修改项目设置和批量变更属于高风险操作；
- 每个操作都要声明前置条件、影响范围、超时策略和可恢复方式；
- 长时间操作必须返回可查询的 operation ID，不能因为请求超时就假装操作没有发生；
- 使用 expected revision 防止覆盖用户刚刚保存的修改；
- 错误使用稳定的机器可读 code，并附带可操作的说明；
- Godot 不在线时，服务应返回明确的 EDITOR_UNAVAILABLE，而不是假装成功。

## 5. 独立实现与许可证策略

- 只使用 MCP 标准、Godot 官方 API 和独立设计的领域契约；
- 不复制其他项目的源码、测试、README 文案、工具名称、参数结构或图标；
- 不使用容易造成混淆的项目名和品牌元素；
- 为第三方依赖保留许可证和版权信息；
- 在每个重要模块记录设计来源和独立决策；
- 兼容 MCP 协议，但不兼容任何第三方项目的私有工具 API。

## 6. 开发命令

~~~bash
npm install
npm run dev
npm run typecheck
npm run build
~~~

开发服务器启动后，使用 mcp-use Inspector 检查工具、资源和提示词。

当前已实现的垂直链路：MCP 读取编辑器上下文，经 127.0.0.1 loopback HTTP 连接 GDScript EditorPlugin，生成并预览一个受限 scene.create_node 操作，经过确认和 expected revision 检查后由 Godot EditorUndoRedoManager 应用，再运行当前场景并轮询诊断结果。

2026-09-29 runtime 验收已覆盖：editor_context、preview_scene_change、confirm_scene_change、apply_scene_change 和 run_current_scene；fixture 返回 stopped，并采集到 fixture scene started。

2026-09-30 已增加并验证 rollback_scene_change：只允许回滚最新已应用计划，使用当前场景 history 的底层 UndoRedo，并拒绝 revision 已变化的回滚请求。

2026-09-30 已增加并验证 search_project 和增强 editor_context：可搜索场景、节点、脚本、资源、signal/input，并返回当前场景树和安全属性。

2026-09-30 已增加 operation_history：为 preview、confirm、apply、rollback、run 记录 operation ID、输入、输出、revision 和错误证据，并提供只读查询工具。

2026-09-30 已完成诊断关联：Godot warning/error 可携带 source、line、NodePath 和受限 repair hint；MCP 会关联最近 mutation operation，并生成下一份 preview plan。

当前刻意未开放任意 GDScript、shell、Python、文件写入、批量操作、脚本修改和项目设置修改。

2026-09-30 已完成受限 script.replace_range：读取 .gd 快照、校验行范围和文件 revision，返回 before/after diff，并通过临时文件原子替换与原始内容 rollback。

## 7. 待决定问题

- 本地桥接使用 HTTP、WebSocket，还是两个都提供；
- Agent 操作协议采用单步操作、任务图，还是两层组合；
- 场景、脚本、资源和项目设置分别开放哪些最小安全操作；
- Godot 运行结果如何关联到节点、资源和脚本行；
- 用户确认放在每个写操作前，还是放在整个任务计划前；
- 项目索引存储在内存、SQLite，还是项目内的可审计缓存；
- 验证阶段优先支持单场景运行，还是先支持项目测试命令；
- 是否加入 Git worktree 沙箱，实现 AI 变更隔离；
- 需要支持哪些 Godot 4.x 小版本。
