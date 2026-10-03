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
| Resource, script, input and project-setting changes | tests/vertical-link.test.ts and tests/godot-runtime-smoke.mjs | File/project revision guards, atomic apply, user-edit conflict, autoload snapshot restore and rollback. |
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

## Safety interpretation

Passing smoke proves the bounded contract and the tested fixture path; it does not authorize arbitrary code execution, public bridge exposure, skipped confirmation, stale revision writes, or automatic community posting. Every new capability must add a focused test, a real fixture assertion when applicable, and a documented evidence entry here.
