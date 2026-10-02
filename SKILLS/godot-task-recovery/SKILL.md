---
name: godot-task-recovery
description: Use when changing or operating multi-step Godot tasks, project leases, heartbeat renewal, restart recovery, task timelines, or concurrent task-store persistence in this repository.
---

# Godot Task Recovery

Treat task orchestration as a recoverable state machine, not as one long request. Keep the persisted task state, lease ownership, operation timeline, and actual Godot result consistent after success, failure, timeout, process restart, and concurrent windows.

## Task and lease rules

- Keep the task states active, paused, completed, failed, and cancelled distinct. Apply only valid transitions; a paused or cancelled task must not be advanced as if it were active.
- Use an explicit project lease for a multi-step task when the caller needs ownership across steps. Use a short operation lease for an isolated apply or rollback when no task lease exists. Preserve owner ID, lease ID, acquired time, expiry, and recoverable status in the task response.
- Keep lease TTL within the supported one-second to one-hour range. Heartbeat an explicit lease around TTL/3 and stop the timer on release, pause, failure, or completion.
- If renewal fails, persist the lease_renew_failed evidence and pause the task as recoverable. A later step result must not overwrite that paused state. An original owner may recover a still-valid lease; an expired, missing, or replaced lease must record the takeover reason and new owner.

## Restart and concurrency recovery

1. On startup or before retrying a task, inspect persisted state and identify steps left in running state.
2. Record a step_interrupted timeline event with the old operation ID before retrying. Give the retry a new operation ID so evidence from attempts cannot be merged.
3. If the same coordinator is already advancing the task, return the stable PROJECT_BUSY result instead of treating the live step as a crash.
4. Serialize saves targeting one task. Use a unique temporary path per save, rename atomically, and clean up a failed temporary write. Do not reuse one taskId.json.tmp path for concurrent heartbeats and transitions.
5. Keep timeline filters read-only and precise: step ID, operation ID, event type, inclusive ISO time range, and bounded limit. Preserve returned, total, and truncated counts.

Each step must still use the underlying change gates: preview, explicit confirmation, expected revision, lease, apply, verification, and guarded rollback. A lease grants ownership; it does not grant permission to skip confirmation or revision checks.

Read references/recovery-contract.md when changing state transitions, lease events, restart recovery, or task-store writes.
