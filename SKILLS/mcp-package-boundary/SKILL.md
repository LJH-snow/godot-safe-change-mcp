---
name: mcp-package-boundary
description: Use when preparing, reviewing, or troubleshooting the npm package boundary and release checks for this Godot Safe Change MCP project.
---

# Mcp Package Boundary

Treat the published tarball as a security and support boundary. The package must contain the runnable MCP entry, built bundle, Godot plugin, public README files, license, environment example, and package metadata; source, tests, planning material, CI configuration, and development-only skills stay outside it.

## Release workflow

1. Inspect package.json files and the generated tarball allowlist before changing release files. Update the allowlist deliberately when a new runtime artifact is intentional.
2. Run the requested checks in a clean worktree: npm ci, npm test, npm run typecheck, npm run build, npm run package:check, and git diff --check as applicable. Do not claim release readiness from a build alone.
3. Let package:check build and pack the project, inspect npm metadata, and install or unpack the tarball in a temporary consumer. Verify the bin entry, MCP bundle, Godot plugin, and required public files actually work from the package boundary.
4. Keep the local EALLOWSCRIPTS fallback safe: when npm refuses lifecycle scripts, validate the extracted tarball with its existing source-dependency-resolution fallback instead of disabling the restriction globally. In npm pack output, parse the final JSON manifest because prepare logs may precede it.
5. Reject source, tests, .agents, .claude, .cursor, plans, progress files, docs, CI configuration, build scripts, and package-lock.json when they are not in the explicit runtime allowlist. Review the file list rather than trusting a successful npm pack command.
6. Before publishing, require a clean worktree, the exact checked revision, local package smoke, and the CI check, package, Godot 4.5.1, and Godot 4.7.2 jobs. Publishing itself remains a separate, explicit user action.

Read references/release-gates.md when changing package.json, scripts/package-smoke.mjs, CI, or the release checklist.
