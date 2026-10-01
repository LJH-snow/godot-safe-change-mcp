# Release Checklist

## Local preflight

Run these commands from a clean worktree:

~~~bash
npm ci
npm test
npm run typecheck
npm run build
npm run package:check
GODOT_BIN=/path/to/Godot node tests/godot-runtime-smoke.mjs
~~~

The Godot smoke must pass with a Godot 4.x editor. It covers context/search, preview/confirm/apply/rollback, diagnostics, task leases, task verification, diagnostic repair preview/apply, and operation evidence.

## CI preflight

The push workflow must pass all four jobs: check, npm package boundary, Godot 4.5.1 runtime, and Godot 4.7.2 runtime.

The package job verifies the actual tarball boundary. Runtime jobs verify the EditorPlugin fixture under both supported Godot versions.

## Safety gates

- Do not publish with a dirty worktree or an unverified revision.
- Do not bypass preview, confirm, revision checks, leases or rollback evidence.
- Do not add arbitrary GDScript, shell, Python or Godot RPC execution.
- Review the generated package file list before publishing.
