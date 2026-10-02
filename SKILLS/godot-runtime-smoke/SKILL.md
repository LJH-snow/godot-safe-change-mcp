---
name: godot-runtime-smoke
description: Use when validating the Godot EditorPlugin bridge, fixture workflows, runtime diagnostics, or the Godot version matrix for this MCP project.
---

# Godot Runtime Smoke

Use the repository smoke harness as the source of truth for end-to-end behavior. It starts a temporary fixture, loads the copied EditorPlugin, exercises the MCP bridge, and checks real state and diagnostics. Do not replace this with a status-code-only probe.

## Local verification

- Use a Godot 4.x editor through the GODOT_BIN environment variable. Keep the fixture isolated in a temporary directory; never run a smoke mutation against the user's actual Godot project.
- When the task asks for validation, run the focused contract suite and build checks before the runtime harness: npm test, npm run typecheck, npm run build, and git diff --check as applicable.
- Run the end-to-end check with GODOT_BIN=/path/to/Godot node tests/godot-runtime-smoke.mjs (or export GODOT_BIN first). Keep the process bounded and inspect the final stopped/failed state, not only the first running response.
- Exercise the real workflow in order: context/search, preview, explicit confirm, apply, state assertion, rollback, run current or specified scene, diagnostics, task lease/recovery, and operation evidence. Include revision-conflict and unsafe-path rejection cases when the changed feature affects them.
- Preserve the smoke log, Godot version, run ID, revision changes, diagnostics, and artifact path in the verification report. Distinguish renderer/environment warnings from a failed assertion, but do not hide errors or timeouts.

## CI behavior

- The supported workflow runs Godot 4.5.1 and 4.7.2 separately after the TypeScript check job. Keep artifacts version-specific.
- Linux scene subprocesses need a virtual display. Use the repository's xvfb-run wrapper, hard timeout, TERM/KILL cleanup, and log teeing pattern. A headless editor flag alone is not enough for a launched scene that expects X11.
- Ensure the editor and scene child processes are cleaned up on success and failure. An orphan process is a smoke failure even if the MCP request returned a plausible response.

Read references/verification-matrix.md when extending fixture coverage or the CI runtime matrix.
