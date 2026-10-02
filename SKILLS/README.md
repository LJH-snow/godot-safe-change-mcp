# Project-local skills

These skills were distilled from the project’s recorded agent work rather than
from a generic Godot checklist. The source set reviewed for this folder was:

- task_plan.md, findings.md, progress.md
- docs/PLAN.md, docs/RELEASE.md, tests/README.md, and godot-plugin/README.md
- .zcode/plans/
- .mimosa/history/, .mimosa/reports/, and hook status records
- Git history through the current branch, including the repeated LJH-snow and
  Cindy agent commits

| Skill | Repeated project concern captured |
| --- | --- |
| godot-safe-change | Preview/confirm/apply, revision guards, two-layer validation, UndoRedo, atomic file changes, diagnostics, and guarded rollback |
| godot-task-recovery | Multi-step task states, project leases, TTL/3 heartbeat, interrupted-step recovery, timeline evidence, and concurrent task saves |
| godot-runtime-smoke | Temporary fixture validation, real editor state, diagnostics, process cleanup, xvfb-run, and the Godot 4.5.1/4.7.2 matrix |
| mcp-package-boundary | npm tarball allowlist, temporary consumer smoke, lifecycle-script fallback, package metadata parsing, and release gates |

The repository had no raw in-tree conversation transcript format. The skills
therefore use the durable planning, finding, review, progress, and commit
records that preserve the agents’ decisions and recurring failure fixes.
