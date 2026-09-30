# Test boundaries

Automated coverage currently includes:

- contracts and application: preview, explicit confirmation, revision conflicts, apply reports and run diagnostics through a fake bridge;
- HTTP bridge: loopback protocol envelopes, context/apply requests and run status polling;
- plugin boundary: fixed TCPServer transport, context/apply/rollback/run route markers and forbidden-operation checks.

Run the automated suite with:

~~~bash
npm test
~~~

## Godot manual acceptance

The real EditorPlugin check uses godot-fixture and requires a local Godot 4.x editor because this environment does not provide a Godot CLI.

1. Copy godot-plugin into tests/godot-fixture as res://addons/godot-safe-change-bridge/.
2. Open a saved scene with a Node2D root and enable the plugin.
3. Start the MCP server with npm run dev and open its Inspector.
4. Call editor_context with the absolute Godot project path and verify connection, currentScene and revision.
5. Call preview_scene_change for a Node2D named SafeMarker under parentPath . Verify that only a diff is returned.
6. Call confirm_scene_change with the returned planId and expectedRevision.
7. Call apply_scene_change and verify the node appears in the scene tree and the report contains an undo label and new revision.
8. Use Godot Undo to remove the node, then run run_current_scene and verify the returned run ID, status and diagnostics.
9. Call rollback_scene_change while the applied revision is current and verify the node is undone with a rolled_back report.
10. Change the scene after apply and verify rollback_scene_change returns REVISION_CONFLICT.

The first write-operation test must keep preview, confirmation, apply and rollback as separate states.
