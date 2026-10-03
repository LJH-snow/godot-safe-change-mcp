# Release feedback guide

This guide makes a real installation or starter test easy to report. It is a collection aid, not a request to publish feedback without the user's consent.

## Before opening an issue

1. Run the starter fixture from examples/starter or record the smallest project that reproduces the behavior.
2. Record the Godot version, operating system, MCP client, Node.js version, package version, and whether the Inspector was used.
3. Copy the first stable error code and the relevant operation or task step; do not include tokens, private scenes, project files, or full logs containing secrets.
4. If the behavior involves a write, say whether it stopped at preview, confirmation, lease, revision, apply, verification, or rollback.
5. Confirm whether the issue is reproducible on a clean starter copy.

## Useful evidence

- The exact command used to start the MCP server.
- The MCP endpoint, with private hostnames or tokens removed.
- Godot and MCP client versions.
- The operation kind or task step kind, NodePath/resource path if safe to share, and stable error code.
- Expected behavior, observed behavior, and whether the project remained unchanged.
- A short redacted log excerpt or a link to the relevant CI run.

## Privacy and safety

Never paste credentials, private project content, personal paths, or unredacted diagnostic output into a public issue. Use SECURITY.md for suspected vulnerabilities. Do not ask for Stars in exchange for testing; a reproducible report or a small contribution is more valuable than a number.

## What maintainers do next

Maintainers label the report with release-feedback, starter, and the verified Godot version when applicable. A confirmed issue is reproduced on the starter fixture or a minimized test, then linked from the FAQ or changelog when fixed.
