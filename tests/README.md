# Test boundaries

Automated coverage currently includes:

- contracts and application: preview, explicit confirmation, revision conflicts, property-specific diffs, active-plan identity, apply reports and run diagnostics through a fake bridge;
- change contracts: strict visible/position/size/text/color value shapes, finite numeric ranges, safe relative NodePaths and project-local script/resource identifiers;
- search index: read-only scene/script/resource/node matching, signal declarations, input actions, truncation and symlink safety;
- operation audit: lifecycle operation IDs, inputs, outputs, revisions, failure evidence and JSONL restart recovery;
- project lease: atomic owner acquisition, concurrent-owner rejection and expired-lease recovery;
- task lease: acquire, renew, release, task status visibility and cross-window conflict handling;
- diagnostics: source/line/NodePath association and preview generation from explicit repair hints;
- script and resource changes: bounded .gd/resource replacement, temporary-file atomic apply, file revision guard, user-edit conflict and rollback;
- scene changes: UndoRedo-backed create, property and script-attachment operations with rollback history/version/action guards;
- input actions: bounded ProjectSettings persistence, duplicate-key rejection, settings revision guard and rollback;
- multi-step tasks: bounded task state machine with apply/rollback/run steps, pause/resume/cancel transitions, explicit lease acquire/renew/release, retry budget, project-directory persistence and restart recovery;
- HTTP bridge: loopback protocol envelopes, context/search/apply requests, current-scene and specified-scene run status polling;
- plugin boundary: fixed TCPServer transport, independent request validation, context/apply/rollback/run/run-scene route markers, safe paths and forbidden-operation checks.

Run the automated suite with:

~~~bash
npm test
~~~

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
17. Call create_task with an apply_plan step (planId and expectedRevision from step 7) followed by a run_current_scene step; advance twice and verify the apply step returns "applied", the run step returns "stopped", and the task ends "completed".
18. Create a second task, pause it and verify advance_task returns TASK_INVALID_STATUS; resume, advance once, then cancel and verify the remaining steps become "cancelled".
19. Restart the MCP server and call get_task; verify the task state is restored from `.godot-safe-change/tasks/` inside the project.

The first write-operation test must keep preview, confirmation, apply and rollback as separate states.
