# Changelog

All notable changes to Godot Safe Change MCP will be documented here.

## Unreleased

- Continue the community adoption work tracked in docs/GROWTH.md.
- Keep the preview, confirmation, lease, revision, verification, and rollback lifecycle stable.
- Added bounded scene signal disconnection with exact-match validation and UndoRedo rollback coverage.
- Added read-only task resource verification with bounded content assertions, revision evidence, and mismatch timelines.
- Added read-only task script verification with bounded content assertions, script revision evidence, and mismatch timelines.
- Added bounded scene group membership changes (scene.add_group and scene.remove_group) with group snapshots in editor context, dual-gate validation, and Godot UndoRedo apply/rollback.
- Added bounded project.godot autoload registration (project.autoload.add and project.autoload.remove) with settings revision guards, script existence checks, and restore-on-rollback.
- Added bounded scene.reorder_node for sibling index changes with context-derived order validation and Godot UndoRedo apply/rollback.
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
