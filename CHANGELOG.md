# Changelog

All notable changes to Godot Safe Change MCP will be documented here.

## Unreleased

- Closed the diagnostics repair loop: the apply_diagnostic_repair task step accepts an optional rerunDiagnostics policy that reruns the referenced scene after the confirmed repair applies and verifies the rerun against maxErrors/maxWarnings thresholds inside the same step, recording the passed verification as step evidence. A threshold failure is retryable without re-applying the repair plan (the already-applied plan is detected instead of re-applied).
- Added cross-editor change serialization: every plugin apply and rollback runs inside an advisory per-project change lock (atomic directory create with a TTL owner record under .godot/godot-safe-change), a second live editor instance receives PROJECT_BUSY with owner details, an expired lock is taken over, and an unavailable lock falls back to the revision guards with a warning. Editors that hold no in-memory change state now also re-scan the recovery journal before mutating, so an editor that starts while another crashed with pending recovery adopts that recovery instead of overwriting it; a pending recovery now rejects other applies with PROJECT_BUSY and the pending phase instead of claiming the new plan's recovery ownership.
- Nothing yet.

## 1.3.0 - 2026-10-05

- Added uid:// support for project.setting.set main scene values: application/run/main_scene now accepts a project scene UID reference that the editor's ResourceUID registry resolves to an existing project-local .tscn; snapshots report persisted path or uid values verbatim and the supplied form is preserved on save. This also makes projects whose main scene is already stored as a uid readable through the typed snapshot contract.

## 1.2.0 - 2026-10-05

- Added a persistent project-setting recovery journal: pending project.setting.set recovery state is mirrored to res://.godot/godot-safe-change/project-settings-recovery.json, re-scanned on editor startup, exposed as a read-only projectSettingRecovery status in editor context and a /v1/project-settings/recovery bridge route, and restored only when the current bytes match the captured applied snapshot; externally edited files are adopted as pending recovery without being overwritten.
- Continue the community adoption work tracked in docs/GROWTH.md.
- Keep the preview, confirmation, lease, revision, verification, and rollback lifecycle stable.
- Added bounded scene signal disconnection with exact-match validation and UndoRedo rollback coverage.
- Added read-only task resource verification with bounded content assertions, revision evidence, and mismatch timelines.
- Added read-only task script verification with bounded content assertions, script revision evidence, and mismatch timelines.
- Added bounded scene group membership changes (scene.add_group and scene.remove_group) with group snapshots in editor context, dual-gate validation, and Godot UndoRedo apply/rollback.
- Added bounded project.godot autoload registration (project.autoload.add and project.autoload.remove) with settings revision guards, script existence checks, and restore-on-rollback.
- Added bounded scene.reorder_node for sibling index changes with context-derived order validation and Godot UndoRedo apply/rollback.
- Added bounded scene.set_unique_name to expose or hide scene-unique %Name references with collision checks, editor-context visibility, and Godot UndoRedo apply/rollback.
- Added bounded script.create_file so agents can bootstrap new GDScript files (path and content gates, atomic write, duplicate rejection, rollback deletes the created file).
- Expanded scene.create_node with nine gameplay node types (Sprite2D, Marker2D, Camera2D, Timer, AudioStreamPlayer, CharacterBody2D, StaticBody2D, Area2D, CollisionShape2D) matched on both the contract schema and the plugin allowlist.
- Added bounded project.setting.set for exactly three project.godot keys: an existing project-local main scene .tscn and integer viewport width/height values from 1 through 16384. The project-level lifecycle works without a current scene, reports an unconfigured main scene as exists=false/value=null, derives revisions from complete project.godot bytes, and independently reads typed disk state with ConfigFile after ProjectSettings.save(). Original and attempted bytes support atomic byte-preserving recovery; structured recoveryRequired/phase details block new applies while recovery is pending, and external-edit conflicts return REVISION_CONFLICT without overwriting user content. Arbitrary ProjectSettings keys remain unsupported. This entry describes the bounded implementation, not a complete security audit.
- Improved first-run diagnostics: bridge responses that are not JSON (for example another program occupying loopback port 8765) now return an actionable EDITOR_UNAVAILABLE message, and the plugin reads an optional godot_safe_change/bridge_port project setting with GODOT_BRIDGE_URL on the server side; CLIENTS.md gained a bridge troubleshooting section.
- Added complete MCP tool annotations (readOnly, destructive, idempotent, and open-world hints) across all registered tools.
- Added a tool contract test suite covering all 23 tool registrations, annotation completeness, and read-only handler smoke checks.
- Added a repository privacy policy covering local-only data handling; it ships with the npm package.
- Improved npm discovery keywords for Godot, safe changes, automation, and UndoRedo; publish only with the next authorized version release.
- Made the default README English and preserved the Chinese guide as README.zh-CN.md for clearer first-time discovery.

## 1.1.0 - 2026-10-03

- Added safe scene instantiation and signal connection apply/rollback through Godot UndoRedo.
- Added Node2D rotation and scale property changes with guarded preview and rollback.
- Added task recovery, project-local skills, contribution guidance, issue templates, and release smoke evidence.

## 1.0.0 baseline

The current development baseline includes:

- Read-only project search, editor context, reverse references, operation history, and task timeline.
- Safe scene create/delete/reparent/rename/duplicate/instantiate, property, script, resource, input-action, and script-range operations.
- Task-level leases with heartbeat renewal, TTL takeover, interrupted-step recovery, and operation evidence.
- Real Godot 4.5.1 and 4.7.2 CI smoke plus npm package boundary verification.
