# Godot Safe Change Operation Matrix

Use this matrix to keep a new operation inside the safety model documented in
docs/PLAN.md, tests/README.md, and the task records.

| Operation family | Execution boundary | Required guard | Evidence after apply |
| --- | --- | --- | --- |
| scene.create_node, scene.set_property, scene.attach_script | Godot EditorPlugin and EditorUndoRedoManager | Safe relative NodePath, allowlisted node/property/script, active plan, expected editor revision, project lease | Scene tree or property snapshot, specific UndoRedo label, new editor revision, rollback result |
| scene.connect_signal | Godot EditorPlugin and EditorUndoRedoManager | Safe source/target NodePaths, existing signal, existing target method, duplicate-connection rejection, active plan, expected editor revision, project lease | Signal snapshot, specific UndoRedo label, new scene revision, guarded rollback result |
| script.replace_range | TypeScript coordinator plus plugin file route | res:// .gd path, bounded 1-based lines, expected file revision, exact before text | Line diff, file revision, atomic replacement result, rollback or conflict evidence |
| resource.replace_reference | TypeScript coordinator and bounded file route | res:// .tscn/.tres/.res path, explicit from/to reference, expected file revision | Match count, before/after snapshot, file revision, rollback or user-edit conflict |
| project.input_action.add_key, remove_key, replace_key | Guarded ProjectSettings route | Safe action name, unique physical key match, no logical or occupied key, expected project.godot revision | Action snapshot, settings revision, persistence result, complete rollback snapshot |
| run_current_scene, run_scene | Godot EditorInterface run route | Connected editor, one run at a time, valid res:// .tscn path for custom scenes, bounded timeout | Run ID, stopped/failed/timeout state, output, errors, warnings, source association |
| verify_scene_state, verify_diagnostics | Read-only task step | Explicit previous step or run ID, safe NodePath/property assertions, bounded thresholds | Observed values or diagnostic counts, mismatch details, task step operation ID |

For every write family, preserve this order:

    preview -> explicit confirm -> expected revision and lease -> apply -> verify -> guarded rollback

The plugin is a second validation boundary. A request that passed Zod or a
MCP tool schema must still be rejected by the plugin if its path, node, value,
revision, plan identity, or history is unsafe.

Never use a diagnostic message, repair hint, or user-provided string as a
script, shell command, method name, or Godot RPC payload.
