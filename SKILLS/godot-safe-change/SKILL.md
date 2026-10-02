---
name: godot-safe-change
description: Use when changing this Godot Safe Change MCP project or applying a Godot scene, script, resource, input action, or project setting change through its bridge; preserve preview, confirmation, revision, lease, audit, rollback, and verification gates.
---

# Godot Safe Change

Use the repository's existing control plane and bridge instead of inventing a direct editor shortcut. The TypeScript MCP server owns contracts, plans, confirmation, revisions, leases, task orchestration, and reports. The GDScript EditorPlugin owns editor state, Godot UndoRedo, scene execution, and diagnostics.

## Safe change workflow

1. Read the current project context with the existing read-only tools (project_overview, editor_context, and search_project) before proposing a mutation. Establish the current scene, node path, file or project-settings revision, and connected editor state.
2. Inspect git status and the relevant diff before editing source. Preserve unrelated uncommitted work from another window; make the smallest stale-safe edit that fits the current files.
3. Choose one allowlisted domain operation. Keep preview and apply as separate states. A preview must contain the exact target, before value or snapshot, expected revision, bounded diff, and rollback information without changing the project.
4. Require the existing confirmation step and expected revision at apply time. For task work, use the task's lease or operation lease before invoking a write. Do not treat an agent's intention or a successful preview as confirmation.
5. Apply through the existing coordinator and loopback bridge. Scene mutations must be committed by the plugin through Godot UndoRedo. Script and resource edits must use the repository's bounded path checks, revision guard, temporary file, and atomic replacement. Input-action changes must go through the guarded ProjectSettings path.
6. Verify the actual editor or file state after apply. Capture the operation ID, new revision, concrete change report, run status, diagnostics, and task timeline evidence. A successful HTTP response alone is not verification.
7. Roll back only the plan or snapshot that was applied, while its plan identity, history, and revision guards still match. Refuse rollback after a user or another window has changed the target; never undo an unrelated user action.

## Boundaries

- Keep all validation in both layers: TypeScript contracts are the first line, and the Godot plugin must independently reject forged loopback payloads.
- Allow only the operations already exposed by the domain contracts. Do not add arbitrary GDScript, shell, Python, unrestricted file writes, arbitrary Godot RPC, reflection, or batch mutation as a convenience.
- Keep paths project-local and reject absolute paths, traversal, empty path segments, backslashes, unsupported extensions, and unsafe NodePaths.
- Keep diagnostics as evidence. A repair hint is data that must pass its allowlist and still produce a preview; it is never code to execute or an instruction to bypass confirmation.
- Preserve stable machine-readable error codes and structured details when rejecting stale revisions, unsafe paths, missing editor state, failed verification, or busy leases.

Read references/operation-matrix.md when adding an operation or changing its guard, rollback, or verification behavior.
