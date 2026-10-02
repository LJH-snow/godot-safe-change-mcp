# Changelog

All notable changes to Godot Safe Change MCP will be documented here.

## Unreleased

- Continue the community adoption work tracked in docs/GROWTH.md.
- Keep the preview, confirmation, lease, revision, verification, and rollback lifecycle stable.

## 1.0.0 baseline

The current development baseline includes:

- Read-only project search, editor context, reverse references, operation history, and task timeline.
- Safe scene create/delete/reparent/rename/duplicate/instantiate, property, script, resource, input-action, and script-range operations.
- Task-level leases with heartbeat renewal, TTL takeover, interrupted-step recovery, and operation evidence.
- Real Godot 4.5.1 and 4.7.2 CI smoke plus npm package boundary verification.
