# Godot Safe Change Bridge

This folder is the Godot-side EditorPlugin adapter for the TypeScript MCP server.

## Install

Copy this folder into a Godot project as:

~~~text
res://addons/godot-safe-change-bridge/
~~~

Enable Godot Safe Change Bridge in Project Settings > Plugins. The plugin starts a loopback-only HTTP server at 127.0.0.1:8765.

## Enabled routes

- POST /v1/context returns the current project, edited scene, selection, open scenes, run state and collected diagnostics.
- POST /v1/search returns read-only matches for scenes, nodes, scripts and resources from the editor filesystem and current scene tree.
- POST /v1/signals/read returns current-scene signal declarations, method names, existing in-scene connections, and a scene revision for preview validation.
- POST /v1/scripts/read returns a read-only script snapshot and content revision for safe preview generation.
- Script replace apply uses a bounded .gd path, expected file revision, temporary file and atomic rename; rollback restores the captured original content.
- POST /v1/changes/apply accepts one bounded scene operation, including scene.create_node, scene.instantiate_scene, scene.set_property, scene.attach_script, scene.detach_script and scene.disconnect_signal, and commits scene changes through EditorUndoRedoManager.
- scene.connect_signal and scene.disconnect_signal validate a current-scene signal, target method and exact connection, then record inverse callbacks in UndoRedo with the normal scene revision guard.
- POST /v1/changes/rollback undoes only the latest applied plan when its plan ID and revision still match.
- scene.detach_script clears only a node's existing project-local GDScript and records the original Script resource in UndoRedo for revision-guarded rollback.
- scene.instantiate_scene loads an existing project-local PackedScene, assigns the instance root to the edited scene owner, and records add/remove callbacks in UndoRedo; the source scene revision is checked before apply.
- POST /v1/project-settings/read returns one typed snapshot from the allowlisted project.godot settings. It is a project-level route and does not require a current scene; an unconfigured application/run/main_scene is reported as exists=false and value=null.
- POST /v1/project-settings/recovery reports the pending project-setting recovery status (pending, settingKey, phase, journalPresent) and optionally re-runs the startup journal scan with {"projectRoot": ..., "action": "scan"}. It is read-only plus scan; it never mutates settings directly.
- project.setting.set accepts exactly application/run/main_scene, display/window/size/viewport_width, or display/window/size/viewport_height. Main-scene writes require an existing project-local res:// .tscn, or a uid:// reference that the editor's ResourceUID registry resolves to one; the persisted value keeps the exact form supplied (path or uid). Viewport writes require integers from 1 through 16384.
- POST /v1/run/current starts the current saved scene and returns a run snapshot.
- POST /v1/run/status returns the current snapshot for the requested run ID.

### Project-setting hardening

For project.setting.set, the bridge derives the revision from the complete project.godot byte content at preview, confirmation, apply, and rollback. It separately reads the file from disk with ConfigFile to produce the typed key snapshot and to verify the persisted value after ProjectSettings.save(); an in-memory ProjectSettings value alone is not treated as sufficient readback.

Apply and rollback capture the original and attempted project.godot bytes. If persistence or verification cannot be completed, recovery writes the captured bytes through a temporary file and atomic rename, then compares the resulting bytes and revision. Recovery failures return structured error details with recoveryRequired and phase (for example save, verify, rollback, or rollback-verify); a pending recovery blocks another project-setting apply until recovery can be completed.

Rollback never overwrites an external project.godot edit. It restores bytes only when the file still matches the applied byte snapshot (or is already the original snapshot); otherwise it returns REVISION_CONFLICT and preserves the current file, including during a pending recovery.

While a recovery is pending, the transaction (original/applied bytes and revisions, phase, plan id) is mirrored to a journal at res://.godot/godot-safe-change/project-settings-recovery.json, and /v1/context exposes a projectSettingRecovery status. On editor startup the plugin scans that journal: if the file still matches the journaled applied bytes it restores the original bytes through the same atomic path and clears the journal; if the file already matches the original bytes it only clears the journal; if the bytes differ from both (an external edit) it adopts the journal as pending recovery with phase external-edit, keeps the user's bytes untouched, and continues to block new project-setting applies until recovery completes. The journal is written inside the project's .godot cache directory, is removed whenever recovery completes cleanly, and is not a cross-editor lock: its restore path only ever writes the captured original bytes when the current bytes exactly match the captured applied snapshot.

The server validates that projectRoot is the project currently open in the editor. It does not expose arbitrary GDScript, shell commands, file writes, method names or Godot object RPC. These statements describe the bounded implementation and its evidence scope; they are not a complete security audit.

## Diagnostics

The plugin tracks run lifecycle output and accepts bounded diagnostic messages through the Godot debugger channel godot_safe_change. A project scene may send severity, message, source, line, NodePath and a validated scene.create_node repair hint to make it visible to the MCP run result.

The TypeScript server polls /v1/run/status until the scene stops, fails, or the requested timeout expires.
