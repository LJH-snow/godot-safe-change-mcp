# Release Checklist

## Local preflight

Run these commands from a clean worktree:

~~~bash
npm ci
npm test
npm run typecheck
npm run build
npm run package:check
npm run release:check
GODOT_BIN=/path/to/Godot node tests/godot-runtime-smoke.mjs
git diff --check
~~~

The Godot smoke must pass with a Godot 4.x editor. It covers context/search, preview/confirm/apply/rollback, diagnostics, task leases, task verification, diagnostic repair preview/apply, operation evidence, and two MCP processes sharing one real EditorPlugin bridge.

## CI preflight

The push workflow must pass all four jobs: check, npm package boundary, Godot 4.5.1 runtime, and Godot 4.7.2 runtime.

The package job verifies the actual tarball boundary. Runtime jobs verify the EditorPlugin fixture under both supported Godot versions. A release is not ready until all four jobs are completed successfully for the exact pushed commit.

The release check validates the versioned record under docs/releases: package and lockfile versions, the v<version> tag, the exact release commit, the repository-owned Actions run URL, all four required job names, the starter and demo assets, and both public README links. Pass --head <sha> when checking out the exact commit being released; without it, the check validates the recorded published release independently of the current branch.

## Package boundary

The published tarball is intentionally limited to the CLI entry point, built MCP bundle, Godot plugin, public README files, license, `.env.example`, and package metadata. `npm run package:check` fails if source, tests, plans, docs, CI configuration, build scripts, or `package-lock.json` enter the tarball. Update the explicit allowlist together with any intentional release artifact.

## Contract boundary

The automated suite also checks that task `stepId` values are unique, task IDs remain safe for the task directory, lease TTL stays within the supported one-second to one-hour range, and timeline filters reject reversed ranges or out-of-bounds limits while accepting inclusive endpoints.
It also starts independent worker processes to verify stable `PROJECT_BUSY`, atomic expired-lease takeover, and recovery of a running task step after the owner process is killed.

## Evidence to retain

- Record the pushed commit SHA and the GitHub Actions run URL.
- Confirm the four required job names and their `success` conclusions.
- Keep the local test count, package smoke result, and Godot smoke result in the release handoff.
- Do not run `npm publish` until the worktree is clean and the exact revision has passed both local and remote checks.

## Safety gates

- Do not publish with a dirty worktree or an unverified revision.
- Do not bypass preview, confirm, revision checks, leases or rollback evidence.
- Do not add arbitrary GDScript, shell, Python or Godot RPC execution.
- Review the generated package file list before publishing.
