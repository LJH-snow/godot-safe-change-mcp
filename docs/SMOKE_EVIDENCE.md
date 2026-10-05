# Verification evidence map

Use this page to reproduce the claims in the README without relying on a video or a verbal promise. The real Godot workflow is the same test harness used by the two runtime jobs in GitHub Actions.

## Local commands

Run the fast checks first:

~~~bash
npm test
npm run typecheck
npm run build
npm run package:check
npm run release:check
~~~

When a Godot 4.x editor binary is available, run the real bridge checks:

~~~bash
GODOT_BIN=/path/to/Godot node tests/godot-runtime-smoke.mjs
GODOT_BIN=/path/to/Godot node tests/starter-multiprocess-smoke.mjs
~~~

The Linux CI wraps both commands in a virtual display and runs them once per supported Godot version.

## Capability map

| Capability | Reproducible entry point | Evidence to look for |
| --- | --- | --- |
| Read-only project intelligence | tests/project-search.test.ts and the search stage in tests/godot-runtime-smoke.mjs | Scene, node, script, resource, signal, input and reference results. |
| Preview and confirmation | tests/vertical-link.test.ts | Diff-only preview, explicit confirmation, stale revision rejection and no pre-confirmation write. |
| Scene apply and rollback | tests/vertical-link.test.ts and the scene stages in tests/godot-runtime-smoke.mjs | UndoRedo report, changed revision, rollback report and restored scene state including group membership, sibling order and unique name flags. |
| Resource, script, input and project-setting changes | tests/vertical-link.test.ts and tests/godot-runtime-smoke.mjs | File/project revision guards, atomic apply, created-file rollback, user-edit conflict, autoload snapshot restore, and bounded project.setting.set coverage for the exact three-key allowlist, project-level operation without a current scene, unconfigured main-scene snapshots, full project.godot byte revisions, independent ConfigFile disk readback, byte-preserving recovery state, and external-edit conflict preservation. |
| Diagnostics and bounded repair | tests/vertical-link.test.ts and task-orchestration.test.ts | Source/line/NodePath evidence, explicit repair hint, separate confirmation and rerun verification. |
| Task verification | tests/task-orchestration.test.ts | Scene properties, resource/script revision/content assertions, diagnostics thresholds, operation IDs and mismatch timelines. |
| Multi-process recovery | tests/project-lease-process.test.ts and tests/starter-multiprocess-smoke.mjs | Stable PROJECT_BUSY, TTL takeover, lease_reclaimed, recovered step and new operation ID. |
| Publish boundary | scripts/package-smoke.mjs and scripts/release-check.mjs | Consumer tarball allowlist plus version, tag, commit, CI and onboarding asset consistency. |

## Remote CI

The required workflow is [CI](https://github.com/LJH-snow/godot-safe-change-mcp/actions/workflows/ci.yml). For a release or pull request, verify the exact commit has all four successful jobs:

- check
- npm package boundary
- Godot 4.5.1 runtime
- Godot 4.7.2 runtime

Runtime jobs upload per-version smoke logs. Prefer the exact run linked from a release manifest or pull request over a badge from another branch.

### Phase 37 project.setting.set evidence

The setting lifecycle in `tests/godot-runtime-smoke.mjs` proves the bounded contract through the real loopback bridge:

- `/v1/project-settings/read` returns a typed snapshot for each of exactly three allowlisted keys and a shared revision derived from the complete `project.godot` bytes. It reads the disk file independently with `ConfigFile`; an unconfigured `application/run/main_scene` is returned as `exists: false` and `value: null`.
- This is a project-level lifecycle. Preview, confirm, apply, and rollback do not require a current scene. Preview captures the full-file revision and returns a key-specific before/after diff without changing the file; apply requires explicit confirmation and persists through `ProjectSettings.save()`.
- Apply readback independently verifies the typed persisted value and changed full-file revision; an equal effective value is rejected as a no-op.
- Direct forged requests reject unknown keys, out-of-range values, extra fields, traversal, non-integers, and non-finite values without changing `project.godot`.
- Apply and rollback retain original and attempted bytes. If save/readback or restoration cannot be verified, the bridge reports structured `recoveryRequired` and `phase` details (including `save`, `verify`, `rollback`, and `rollback-verify` paths), restores through a temporary file and atomic rename when safe, and blocks a new project-setting apply while recovery remains pending.
- An external edit after apply makes rollback return `REVISION_CONFLICT` while preserving the edited bytes; recovery likewise refuses to overwrite bytes that differ from the captured applied snapshot. When the file is unchanged or restored to the expected applied/original bytes, rollback verifies the original bytes, revision, and typed value before completing.
- `application/run/main_scene` rejects missing scenes, applies only an existing project-local `.tscn`, reads back the new path, and restores the original setting, including the originally unconfigured state.
- Latest local verification for this hardening pass: `npm test` (145 passed), `npm run typecheck`, `npm run build`, `npm run package:check`, `npm run release:check`, `node --check tests/godot-runtime-smoke.mjs`, and `git diff --check` all passed; the full smoke also passed with local Godot 4.7.2.
- The coordinator recovery seam also preserves applied-plan ownership when a bridge reports `recoveryRequired` without `currentRevision`; a rollback retry refreshes the setting snapshot revision before sending the guarded request, covered by the vertical-link regression suite.
- Feature branch PR #34 CI run `37274338265` passed all required jobs: `check`, `npm package boundary`, `Godot 4.5.1 runtime`, and `Godot 4.7.2 runtime`. PR #34 merged into protected `main` with merge commit `076be0e3a12f8510bd6a8c82b8ad5e993e5c1eac`.
- Evidence closeout PR #35 passed CI run `37276309244` and merged with commit `826befbaeaf97a878c21ec89577b9e647f95a22e`.
- Recovery-state fix PR #36 passed CI run `37283430277` across all four required jobs and merged into protected `main` with commit `0efb95d476489eff94b9a48345443a2995877c1d`. The fix preserves applied-plan ownership when `recoveryRequired` omits `currentRevision`, refreshes the setting revision before a rollback retry, and propagates external-edit `REVISION_CONFLICT` without wrapping it as recoverable persistence failure.
- Persistent recovery journal (2026-10-05): pending project-setting recovery is now mirrored to `res://.godot/godot-safe-change/project-settings-recovery.json` and re-scanned on editor startup. The runtime smoke covers three journal paths through the real bridge: a startup scan that restores the original bytes when the file still matches the journaled applied snapshot (journal cleared, snapshot back to 640), an external-edit scan that adopts the journal as pending recovery with `phase=external-edit` while preserving the edited bytes byte-for-byte, and a blocked new apply through the MCP tool while that recovery stays pending. `/v1/context` exposes the read-only `projectSettingRecovery` status and `/v1/project-settings/recovery` reports or re-scans it. Local verification for this pass: `npm test` (145 passed), typecheck, build, package:check, release:check, smoke syntax, `git diff --check`, and the full smoke with local Godot 4.7.2.
- A Mimosa deep security scan completed on 2026-10-05 (scan id `scan-2026-10-05T11-42-28.713Z-2ac030a7df9a`, seal `sha256:1780c3cf932d5b45820d72b993268e8fead51d1cc8145c043c56ef54c4e91ce1`) reporting 0 findings and 0 dependency advisories across 116 packages. Its evidence boundary is static-only with no runtime execution, so it complements but does not replace the runtime smoke and is not a complete security audit.
- The Phase 37/38 implementation evidence is limited to the focused tests, fixture assertions, and CI jobs named above; it is not a complete security audit. Do not infer additional audit coverage from the CI badge or from this page. Remaining limitations include filesystem check-then-rename TOCTOU, cross-platform rename durability, and the absence of production save-failure injection; the recovery journal is process-crash recovery within one project, not a cross-editor lock.

## Safety interpretation

Passing smoke proves the bounded contract and the tested fixture path; it does not authorize arbitrary code execution, public bridge exposure, skipped confirmation, stale revision writes, or automatic community posting. Every new capability must add a focused test, a real fixture assertion when applicable, and a documented evidence entry here.
