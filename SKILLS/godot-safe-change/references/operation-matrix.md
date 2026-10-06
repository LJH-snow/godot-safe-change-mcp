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
| project.setting.set | Guarded ProjectSettings route; project-level and independent of the current scene | Exact three-key allowlist: application/run/main_scene must be an existing project-local res:// .tscn or a uid:// reference that ResourceUID resolves to one (the uid form persists as supplied); viewport_width/viewport_height must be integers from 1 through 16384; operation object is exact kind/settingKey/value; full project.godot byte revision, active plan, project lease, and the per-project plugin change lock | Typed before/after diff; unconfigured main scene is exists=false/value=null; snapshots report path or uid values verbatim; independent ConfigFile disk readback after ProjectSettings.save(); original and attempted bytes retained for temporary-file atomic recovery; structured recoveryRequired/phase on incomplete recovery; pending recovery makes other applies return PROJECT_BUSY with the phase; a second live editor receives PROJECT_BUSY from the change lock and a pre-mutation journal scan adopts crashed recoveries; guarded rollback preserves external edits with REVISION_CONFLICT; arbitrary keys and Variants are rejected |
| run_current_scene, run_scene | Godot EditorInterface run route | Connected editor, one run at a time, valid res:// .tscn path for custom scenes, bounded timeout | Run ID, stopped/failed/timeout state, output, errors, warnings, source association |
| verify_scene_state, verify_diagnostics | Read-only task step | Explicit previous step or run ID, safe NodePath/property assertions, bounded thresholds | Observed values or diagnostic counts, mismatch details, task step operation ID |

For every write family, preserve this order:

    preview -> explicit confirm -> expected revision and lease -> apply -> verify -> guarded rollback

The plugin is a second validation boundary. A request that passed Zod or a
MCP tool schema must still be rejected by the plugin if its path, node, value,
revision, plan identity, or history is unsafe. The matrix documents bounded
implementation behavior and evidence scope; it is not a complete security audit.

Never use a diagnostic message, repair hint, or user-provided string as a
script, shell command, method name, or Godot RPC payload.
