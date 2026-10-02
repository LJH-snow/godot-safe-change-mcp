# 进度记录

## 2026-10-02 instantiate existing scene

- 新增 `scene.instantiate_scene`，preview 校验项目内 `.tscn`、父节点、自引用和名称冲突，并绑定源场景文件 revision。
- 通过 Godot PackedScene.instantiate() 和 UndoRedo 管理实例根节点，smoke 已覆盖实例子树和 rollback；GitHub Actions run \`37005980067\` 的 check、package boundary、Godot 4.5.1 和 4.7.2 全部通过。

## 2026-10-02 detach existing script

- 新增 `scene.detach_script`，只允许移除当前场景节点已有的项目内 `.gd` 脚本；preview 返回原脚本路径和 diff。
- 通过 Godot UndoRedo 清除并恢复原 Script 资源，补充 scriptless 拒绝、重复 rollback 和真实桥接 apply/rollback smoke；GitHub Actions run \`37005980067\` 已验证双版本通过。

## 2026-09-30 safe change hardening

- `scene.set_property` 已按属性绑定严格契约：visible、position、size、text、color 分别校验类型、exact keys、finite 数值和范围；路径校验拒绝绝对路径、空段、反斜杠和 traversal。
- `scene.attach_script`、`resource.replace_reference`、`project.input_action.add_key` 和 `script.replace_range` 均完成 preview → confirm → apply → rollback，并保留 scene/file/project-settings revision guard。
- Godot 插件增加独立的第二道请求校验、active-plan guard、场景 fingerprint 属性/脚本状态和 UndoRedo history/version/action/label rollback guard；直接 loopback 非法请求由插件返回稳定错误码。
- fixture/runtime smoke 已覆盖五种属性、scriptless attach、资源引用、输入动作、脚本替换、用户修改后的 revision conflict 和重复 rollback。
- 验证基线为 `npm test` 65/65、typecheck、build、`git diff --check` 和本地 Godot 4.7.2 smoke；远程 Godot 4.5.1/4.7.2 CI 矩阵 run `36802723876` 全绿。

## 2026-09-30 Godot CI smoke

- 新增 tests/godot-runtime-smoke.mjs，临时复制 fixture/plugin 并通过 MCP 验证完整 Godot workflow。
- GitHub Actions 新增 godot-runtime job，固定下载 Godot 4.7.2 Linux editor，运行 headless smoke。
- 本地 Godot 4.7.2 smoke 已通过；远程 Actions 尚未在本轮执行。

## 2026-09-30 safe scene property

- 新增 scene.set_property，严格限制 visible、position、size、text、color 与对应节点类型。
- 真实 MCP + Godot 4.7.2 smoke 已覆盖五种属性 apply/rollback；非法类型、缺字段、越界数值和非法 NodePath 由契约层拒绝。

## 2026-09-30 attach existing script

- 新增 scene.attach_script，只允许现有 res:// .gd 脚本和当前场景节点。
- 通过 Godot UndoRedo 设置/恢复 script 属性；真实 Godot smoke 已覆盖 apply/rollback。
- Scriptless 节点的真实 attach → rollback 已验证恢复为无脚本；远程 GitHub Actions 首次运行仍待确认。

## 2026-09-30 resource preview

- 新增 resource.replace_reference preview，读取受限 tscn/tres/res 文件，校验明确 from/to 引用并返回文件 revision 与匹配数量。
- GDScript resources/read 只读路由已解析通过；资源 apply/rollback 已通过受限原子替换、file revision guard 和真实 smoke。

## 2026-09-30 resource apply verification

- resource.replace_reference 已支持 revision guard、临时文件原子替换和原始内容 rollback。
- Godot 4.7.2 smoke 已验证 resource apply 后内容变化、rollback 后恢复。

## 2026-09-30 task timeline

- TaskState 增加 task step operationId 和 timeline 事件，覆盖 running、succeeded、failed 以及 pause/resume/cancel 状态事件。
- 重启恢复测试保持通过，task_status 可同时返回 lease owner、expiresAt、recoverable 和 timeline。

## 2026-09-30 task lease heartbeat

- TaskCoordinator 为显式和多步骤任务 lease 启动 TTL/3 heartbeat，自动调用 lease store renew 并持久化新的 expiresAt。
- heartbeat 停止、续租失败和任务释放不会留下活动定时器；timeline 增加 lease_acquired、lease_renewed、lease_renew_failed、lease_released、lease_reclaimed 事件。
- 自动化回归通过：60/60 tests、typecheck、build。

## 2026-10-01 task lease recovery

- Heartbeat 续租失败自动将 active task 转为 paused，保留 recoverable=true，并记录 lease_renew_failed/paused 错误证据。
- 修复同一 coordinator 持有的过期 lease 无法接管问题；reclaim 事件现在包含 previousOwnerId、ownerId 和 lease_expired、lease_missing 或 lease_replaced 原因。
- lease 仍有效的 transient renew failure 可由原 owner resume；成功续租后记录 lease_recovered，并保留原 TTL heartbeat 周期。
- 步骤执行期间 lease 失败时，后续步骤成功/失败处理保留 paused 状态；短 TTL 不会被 advance_task 重置为默认 heartbeat TTL。
- 本地目标回归通过：63/63 tests；typecheck/build 正在进行本轮最终验证。

## 2026-10-01 interrupted task step recovery

- 进程重启接管后，遗留 running step 的旧 operationId 会产生 `step_interrupted` timeline 事件，再以新 ID 重试。
- 同一 coordinator 并发推进同一 task 时稳定返回 `PROJECT_BUSY`，避免把仍在执行的步骤误判为 crash recovery。
- `task_timeline` 可按旧 operationId 查询 running/interrupted 证据；定向回归通过。

## 2026-09-30 task timeline query

- 新增只读 `task_timeline` MCP 工具，支持 `stepId`、`operationId`、`eventTypes`、ISO `from/to` 和 `limit` 过滤。
- 返回任务状态、过滤后事件、总数、返回数和截断标记；回归测试覆盖 lease 事件和时间范围。

## 2026-10-01 task operation timeline filter

- `task_timeline` 增加精确 `operationId` 过滤，可只取某一步的一次执行尝试及其 running/succeeded/failed 证据。
- 回归测试用同一 task 的两个 step 验证 operationId 不会混合事件。

## 2026-09-30 input action persistence

- 新增只读 `/v1/input-actions/read`，返回 action 是否存在、deadzone、受限 key event 摘要和 `project.godot` revision。
- `project.input_action.add_key` preview 读取并锁定 project settings revision，拒绝重复 physical key；apply 通过 `ProjectSettings.save()` 持久化，rollback 在 revision 未变化时恢复原 action 设置。
- TypeScript 契约、HTTP bridge、Fake bridge 和真实 Godot 4.7.2 smoke 均覆盖 apply/rollback；当前 `npm test` 57/57、typecheck、build 通过。

## 2026-10-01 input action removal

- 新增受限 `project.input_action.remove_key`，只允许安全 action 名和 1..10000 的 physical keycode；缺失或重复匹配按键会拒绝。
- Preview 锁定 `project.godot` revision；apply 从现有事件数组删除唯一 InputEventKey，rollback 恢复完整原始 action 和 deadzone。
- 自动化与真实 Godot 4.7.2 smoke 覆盖 add/remove apply/rollback。

## 2026-09-30 Linux CI hardening

- 复盘远程 run `36704166909`：Linux Godot 运行场景子进程时缺少 X11 display，导致 diagnostics warning 未返回。
- smoke 显式使用 Godot `--display-driver headless` 与 `--audio-driver Dummy`；GitHub Actions 安装 `xvfb` 并通过 `xvfb-run` 启动 smoke。
- 本地 Godot 4.7.2 smoke 已通过；修复后的远程 Actions run `36741526625` 已通过。

## 2026-09-30 Linux CI verification

- GitHub Actions run `36741526625` 的 `check` 与 `godot-runtime` 均成功。
- Godot runtime smoke 覆盖 search、context、scene/property/script/resource/input apply/rollback、diagnostics 和 operation history。
- smoke 进程组清理、硬超时和 artifact 日志均已验证，远程 runner 不再被孤儿 Godot 进程长期占用。

## 2026-10-01 Godot version matrix

- CI 扩展为 Godot 4.5.1 与 4.7.2 双版本 smoke；artifact 名称包含版本和 run ID。
- 修正 job 级 `GODOT_DIR` 不支持 `runner` context 的 workflow parse failure。
- 远程 run `36802723876` 中 check、Godot 4.5.1 和 Godot 4.7.2 全部成功。

## 2026-09-30 project lease

- 新增 FileProjectLeaseStore 和 InMemoryProjectLeaseStore，使用状态目录独占文件实现跨进程租约。
- ChangeCoordinator 的 apply/rollback 自动获取 30 秒短租约；已有 leaseId 会验证 owner/过期时间。
- 并发 owner 返回 PROJECT_BUSY，过期租约可回收；任务编排和当前 57 个测试全部通过。
- 新增 acquire_task_lease、renew_task_lease、release_task_lease、task_status；显式 lease 可跨多个 task 步骤保持并续租。
- task advance 在没有显式 lease 时使用操作级短租约，避免进程崩溃后阻塞任务恢复。

## 2026-09-30 run_scene implementation

- 新增 `run_scene` MCP 工具和 `RunSceneInput` 契约，仅接受不含遍历的 `res://` `.tscn` 路径。
- HTTP bridge 新增 `/v1/run/scene` 并复用 run/status 轮询；ChangeCoordinator 为指定场景运行生成审计记录和诊断关联。
- Godot 插件使用 `EditorInterface.play_custom_scene`，拒绝不存在场景、并发运行和不安全路径。
- 多步骤任务新增 `run_scene` 步骤，持久化 scenePath/timeoutMs，并兼容旧任务 JSON。
- 自动化回归已通过：当前 57/57 tests、typecheck、build。
- 真实 MCP + Godot 4.7.2 验收通过：`run_scene` 返回 stopped、res://main.tscn、custom scene requested 与 fixture 输出；非法遍历路径被工具层拒绝；任务中的 run_scene 步骤返回 completed/succeeded。

## 2026-09-30 multi-step task verification

- 新增受限多步骤任务编排：active/paused/completed/failed/cancelled 状态机，步骤只允许 apply_plan、rollback_plan、run_current_scene 和 run_scene。
- 任务状态以 JSON 持久化到项目内 .godot-safe-change/tasks/，重启后 get_task 可恢复；崩溃遗留的 running 步骤可重试。
- 支持 pause/resume/cancel 与失败重试（每步最多 3 次）；所有步骤复用既有 confirm、expected revision、UndoRedo 与审计守卫。
- 新增 create/get/advance/pause/resume/cancel 六个 MCP 工具；当前 npm test 57/57、typecheck、build 通过。
- 真实 MCP + Godot 4.7.2 验收通过：apply 步骤经真实 UndoRedo 应用（revision 1865036137 变化），run 步骤返回 stopped 与 fixture 输出；暂停后 advance 被拒绝 TASK_INVALID_STATUS，恢复后继续；取消后剩余步骤标记 cancelled；重启 MCP 服务器后 get_task 从磁盘恢复任务状态。

## 2026-09-30 persistent audit

- 新增 FileOperationAuditStore，按项目根哈希写入用户状态目录 JSONL，不修改 Godot 项目文件。
- 每个 operation 写入 running 和完成事件，重启后按 operationId 恢复最新状态。
- 生产入口已注入文件 store；测试默认使用内存 store，新增跨实例恢复和 interrupted running 测试。

## 2026-09-30 script apply verification

- script.replace_range 已支持受限 .gd 路径、1-based 行范围、expectedFileRevision 和 before/after diff。
- Godot 插件使用临时文件和 DirAccess.rename_absolute 原子替换；rollback 恢复原始内容并返回 fileRevision。
- 真实 MCP + Godot 4.7.2 验证通过：文件 apply 后内容变化，rollback 后恢复原文；无任意 GDScript、shell 或不受限文件写入。

## 2026-09-30 script preview

- 增加受限 script.replace_range 操作，只允许 res:// 下的 .gd 文件和 1-based 行范围。
- Godot EditorPlugin 新增只读 /v1/scripts/read，返回内容和文件 revision；MCP preview 返回 before/after 行级 diff。
- 真实 Godot 4.7.2 + MCP 验证通过：diagnostic_scene.gd preview 返回 expectedFileRevision 356683845，未产生文件写入。
- 原子 apply、revision-guarded rollback 留在下一轮，避免在未完成写入验证前扩大风险。

## 2026-09-30 diagnostic repair verification

- 诊断条目支持 source、line、NodePath、最近 mutation operationId 和受限 repairHint。
- 新增 preview_diagnostic_repair，只接受明确的 scene.create_node hint，不猜测、不直接执行修复。
- 真实 MCP + Godot 4.7.2 验证通过：warning 关联到 res://diagnostic_scene.gd:7 和 NodePath .，并生成 RepairMarker preview；operation_history 同时返回完整生命周期。

## 2026-09-30 operation audit

- 为 preview、confirm、apply、rollback、run 增加内存审计记录和 UUID operation ID。
- 审计记录保存输入、输出、项目根、planId、状态、时间戳和稳定错误信息。
- 新增只读 operation_history MCP 工具，支持按项目查询最近操作和验证证据。
- 自动化回归通过：20/20 tests、typecheck、build；诊断到节点/脚本行的关联仍是下一阶段。

## 2026-09-30 search/context verification

- 中断前已存在并保留 project-index 实现，覆盖场景、节点、脚本、资源、signal、input、截断和符号链接安全。
- 完成 GDScript EditorPlugin 场景树索引、选中节点安全属性和 /v1/search 路由。
- 真实 MCP + Godot 4.7.2 验证通过：node Main、script diagnostic、scene main、resource theme 均返回结果。
- editor_context 返回 connected、完整节点数量和属性结构；未增加任意脚本执行或写文件能力。

## 2026-09-30 rollback verification

- 新增 rollback_scene_change、回滚契约、revision 守卫和结构化 rollback report。
- Godot 4.7.2 runtime 首次暴露 EditorUndoRedoManager 没有 undo 方法；随后改为 get_object_history_id + get_history_undo_redo 后通过真实回滚。
- 真实 MCP 验收通过：apply revision 3568054998，rollback revision 恢复到 1865036137，返回 rolled_back。
- rollback 仍保持 planId 和 applied revision 守卫，不允许撤销用户后续修改。

## 2026-09-29 runtime verification

- 找到本机 Steam 安装的 Godot 4.7.2.stable.steam.ed1daf0bf，并用 headless Editor 加载插件。
- 真实 Godot context 路由返回 connected；scene.create_node 经 EditorUndoRedoManager 应用成功，revision 从 1865036137 变为 4061296536。
- 真实 MCP 端到端调用顺序通过：editor_context → preview_scene_change → confirm_scene_change → apply_scene_change → run_current_scene。
- run_current_scene 返回 stopped，输出包含 fixture scene started，errors 为空。
- 修复 MCP 项目根路径的 realpath 规范化；/tmp 输入现在可连接 macOS 上的 /private/tmp Godot 项目。
- headless dummy renderer 的 texture_2d_get 警告不影响链路结果，已记录为环境限制。

## 2026-09-29

- 已阅读 `README.md` 和 `docs/PLAN.md`，确认目标是第一条安全、可验证的 Godot 开发垂直链路。
- 已加载 cook、planning-with-files、TDD、TypeScript、API/interface、mcp-use 和 Context7 相关规范。
- 已用 Context7 查询当前 `mcp-use` 与 Godot 4.5 文档。
- 已完成项目结构和依赖基线盘点。
- 已确认当前环境没有可执行的 Godot CLI；真实插件链路需在具备 Godot 4.x 的环境验收。
- 已确认现有桥接、插件和变更契约仍是占位/草案，尚未形成安全写操作闭环。
- 基线 `npm run typecheck` 通过；一次依赖检索正则失败，已改用简单模式继续。
- 已新增 Node 原生测试配置和第一组垂直链路测试；npm test 红灯，失败点集中在预期的缺失契约与实现。
- 已实现领域契约、ChangeCoordinator 和 HttpGodotBridge；应用层与 HTTP 桥接测试已转绿。
- 当前唯一失败是插件安全边界测试，因为 plugin.gd 仍然是占位实现。
- 已实现 GDScript TCPServer 路由、EditorInterface 上下文、EditorUndoRedoManager 应用和当前场景运行诊断入口；插件边界测试已转绿。
- 已接入 MCP 工具、结构化输出和运行状态轮询；mcp-use 类型检查通过。
- 已先写运行轮询红灯，再实现启动后查询 run/status；npm test 当前通过：7 个测试全部通过。
- 已运行 build 并启动 127.0.0.1:3100 的开发服务器；npx mcp-use client 因 EALLOWSCRIPTS 无法自动安装可选客户端。
- 已改用公开 MCP HTTP 端点验证 initialize、tools/list、resources/list、resources/read 和 editor_context 的 EDITOR_UNAVAILABLE 错误路径。
- 已补齐能力资源、README、插件说明、测试边界、Godot fixture 和 UTF-8 安全的字节缓冲解析。
- 最终回归通过：npm test 7/7、npm run typecheck、npm run build；真实 MCP HTTP 端点也验证了工具/资源清单和 EDITOR_UNAVAILABLE 错误路径。
- 当前完成边界：本机没有 Godot 4.x CLI，尚未实际加载 EditorPlugin、执行 UndoRedo 或运行 fixture；这些步骤已写入 tests/README.md，需在安装 Godot 的环境验收。

## 2026-10-01 task-level scene verification

- 已确认真实 Godot task smoke 已覆盖显式 lease、apply_plan、run_current_scene 和 operationId timeline。
- 新增目标：提供只读 verify_scene_state task step，核对节点存在和受限属性值，为任务“完成”增加实际结果断言。
- 已先写 success、missing-node、property-mismatch、unsafe NodePath 和不支持属性测试；红灯定位到缺失的 step kind、error code 和 error details。
- 已实现只读 context 验收、1e-5 浮点容差和结构化 expected/actual mismatch 证据；72 项自动化测试和 Godot 4.7.2 task smoke 已通过。
- Godot task smoke 现覆盖 lease-held `apply_plan → run_current_scene → verify_scene_state`，确认通过后完成并写入 operationId-filtered timeline。
- 最终本地检查通过：`npm test` 72/72、`npm run typecheck`、`npm run build` 和 `git diff --check`。

## 2026-10-01 task-level diagnostics verification

- 新增测试覆盖 warning threshold pass、failed run/diagnostics mismatch 和前序 runStepId 约束。
- 首轮 `npm test` 红灯定位为任务 union 缺少 `verify_diagnostics`，符合预期。
- 已完成 diagnostics schema、唯一前序 runStepId 验证、阈值比较和结构化失败证据；75 项单测、typecheck、build、diff-check 与真实 Godot 4.7.2 四步 task smoke 全部通过。

## 2026-10-01 task-level diagnostic repair preview

- 已实现 task-level repair preview：从前序 run 的诊断和诊断内/step-level 有限 `scene.create_node` repairHint 生成 plan，记录 runId 与 diagnostic，预览后暂停。
- 用户必须显式确认 plan；`apply_diagnostic_repair` 只应用任务内预览，随后可重跑并验证 diagnostics。未执行任意 GDScript 或 shell。
- 本地 79 项测试、typecheck、build、diff-check 和 Godot 4.7.2 repair workflow smoke 均通过；推送后等待双版本 CI。

## 2026-10-01 task-store concurrency regression

- GitHub Actions run `36821699283` failed `heartbeats an explicit task lease and records lease timeline events` with `ENOENT` renaming the shared task temp file.
- Added a deterministic 32-writer `FileTaskStore.save` regression; it reproduced the same `ENOENT` locally.
- Replaced the shared temp path with per-save UUID paths and serialized same-target saves; 80 tests, typecheck/build, diff-check and Godot 4.7.2 runtime smoke all pass.

## 2026-10-01 release package boundary

- Added `npm run package:check` and a CI package job. It builds, packs and validates the tarball metadata, bundled MCP entry and Godot plugin files in a temporary consumer.
- Local npm `EALLOWSCRIPTS` is handled by a tarball extraction fallback; GitHub Actions uses the real consumer install path.
- CI run `36835756490` exposed npm pack JSON polluted by the package prepare log; package smoke now parses the trailing JSON manifest.
- Package smoke now also rejects source, test, agent and planning files from the publish tarball; docs/RELEASE.md records the release gates.
