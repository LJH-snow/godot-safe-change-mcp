# Test boundaries

Automated coverage currently includes:

- contracts and application: preview, explicit confirmation, revision conflicts, property-specific diffs, active-plan identity, apply reports and run diagnostics through a fake bridge;
- change contracts: strict visible/position/size/text/color value shapes, finite numeric ranges, safe relative NodePaths, scene subtree deletion and reparent preview/apply/rollback checks, and project-local script/resource identifiers;
- search index: read-only scene/script/resource/node matching, signal declarations, input actions, truncation and symlink safety;
- operation audit: lifecycle operation IDs, inputs, outputs, revisions, failure evidence and JSONL restart recovery;
- task contract boundaries: unique step IDs, slug-safe task IDs, lease TTL limits, inclusive timeline time ranges and bounded timeline limits;
- project lease: atomic owner acquisition, concurrent-owner rejection and expired-lease recovery;
- multi-process lease recovery: independent worker processes, stable `PROJECT_BUSY`, single expired-lease takeover, crashed running-step recovery and operation ID continuity;
- task lease/recovery: acquire, renew, release, heartbeat failure pause, same-window and cross-window TTL takeover, interrupted-step operationId recovery, filtered task timeline and conflict handling;
- diagnostics: source/line/NodePath association and preview generation from explicit repair hints;
- script and resource changes: bounded .gd/resource replacement, temporary-file atomic apply, file revision guard, user-edit conflict and rollback;
- scene changes: UndoRedo-backed create, property and script-attachment operations with rollback history/version/action guards;
- input actions: bounded ProjectSettings key addition/removal/replacement for physical keys, direct-plugin rejection of equal, logical, duplicate and occupied keys, settings revision guard and rollback after external edits;
- multi-step tasks: bounded task state machine with apply/rollback/run/verify/diagnostic-repair preview+apply steps, pause/resume/cancel transitions, explicit lease acquire/renew/release, retry budget, project-directory persistence and restart recovery; repair apply is gated by a separate confirmation;
- HTTP bridge: loopback protocol envelopes, context/search/apply requests, current-scene and specified-scene run status polling;
- plugin boundary: fixed TCPServer transport, independent validation of forged apply/rollback requests, unchanged project state after rejected payloads, context/apply/rollback/run/run-scene routes, safe paths and forbidden-operation checks.
- real Godot integration: two MCP processes sharing one EditorPlugin bridge, lease contention, write apply rejection, forced owner termination, TTL takeover, and task execution plus rollback through the real bridge.

Run the automated suite with:

~~~bash
npm test
~~~

验证发布包边界：

~~~bash
npm run package:check
~~~

该检查会构建并打包，然后在临时消费者中验证 bin/mcp-server.mjs、MCP bundle 和 Godot 插件文件，并拒绝 tests、src、.agents 和计划/进度文件进入 tarball；本机受 npm 脚本白名单限制时会使用 tarball 解包 fallback。

## Godot manual acceptance

The real EditorPlugin check uses godot-fixture and requires a local Godot 4.x editor. The repository smoke harness runs the same flow with Godot 4.7.2 when `GODOT_BIN` is available; the Linux workflow wraps it in `xvfb-run` because a launched scene may require a display.

1. Copy godot-plugin into tests/godot-fixture as res://addons/godot-safe-change-bridge/.
2. Open a saved scene with a Node2D root and enable the plugin.
3. Start the MCP server with npm run dev and open its Inspector.
4. Call editor_context with the absolute Godot project path and verify connection, currentScene and revision.
5. Call search_project for Main, diagnostic, main and theme; verify node, script, scene and resource results include paths and NodePath where applicable.
6. Verify currentScene.nodes includes the full scene tree and safe properties such as position, visible, text or color.
7. Call preview_scene_change for a Node2D named SafeMarker under parentPath . Verify that only a diff is returned.
8. Send a direct loopback `/v1/changes/apply` request with `nodePath: "../Canvas"` and verify the plugin itself returns HTTP 400 with `VALIDATION_FAILED`, without relying on MCP/Zod validation.
9. Call confirm_scene_change with the returned planId and expectedRevision.
10. Call apply_scene_change and verify the node appears in the scene tree and the report contains an undo label and new revision.
11. Call rollback_scene_change while the applied revision is current and verify the node is undone with a rolled_back report.
12. For `scene.set_property`, round-trip visible, position, size, text and color on compatible fixture nodes; verify each revision changes on apply, the property value changes, the UndoRedo label is specific, and rollback restores the prior value.
13. Attach `res://diagnostic_scene.gd` to the fixture's scriptless node, verify the script path appears after apply and returns to null after rollback; a second rollback must be rejected.
14. Run run_current_scene and verify the returned run ID, status and diagnostics.
15. Call run_scene with `res://main.tscn` and verify the custom-scene output, run ID and stopped diagnostics; also verify a `.gd` or traversal path is rejected before the bridge.
16. Change the scene after apply and verify rollback_scene_change returns REVISION_CONFLICT; change a resource after apply and verify its user edit remains after the rejected rollback.
17. Call create_task with a run step, preview_diagnostic_repair carrying a bounded repairHint, apply_diagnostic_repair, rerun and verify_diagnostics; verify timeline links the run/diagnostic/plan, preview pauses, and apply succeeds only after confirm_scene_change.
18. Create a second task, pause it and verify advance_task returns TASK_INVALID_STATUS; resume, advance once, then cancel and verify the remaining steps become "cancelled".
19. Restart the MCP server and call get_task; verify the task state is restored from `.godot-safe-change/tasks/` inside the project.

The first write-operation test must keep preview, confirmation, apply and rollback as separate states.
