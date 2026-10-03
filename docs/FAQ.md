# FAQ

## What is the Inspector?

The mcp-use Inspector is a local web UI for listing and calling MCP tools. It is installed with the locked mcp-use dependencies during npm ci or npm install, then started by npm run dev at:

~~~text
http://127.0.0.1:3000/mcp/inspector
~~~

It is for local development, manual acceptance, and demos. CI and the production CLI do not require the Inspector.

## How do I connect Godot?

Copy godot-plugin into:

~~~text
res://addons/godot-safe-change-bridge/
~~~

Enable the plugin in Project Settings → Plugins, then start the MCP server. The default bridge is <code>http://127.0.0.1:8765</code>; override it with <code>GODOT_BRIDGE_URL</code> when the port is different.

Start with <code>editor_context</code>. It should report <code>connection: connected</code>, a current scene, and a non-null revision.

## Why do I get EDITOR_UNAVAILABLE?

Check these in order:

1. The Godot project is open and the plugin is enabled.
2. The MCP server uses the correct <code>GODOT_BRIDGE_URL</code>.
3. The requested projectRoot is the absolute path of the open project.
4. Port 8765 is not occupied by another local service.
5. The Godot EditorPlugin output does not contain a startup error.

The MCP server must return this error instead of pretending that a disconnected editor is connected.

## What does PROJECT_BUSY mean?

Another MCP process owns the project lease. Do not retry a write in a tight loop. Read <code>task_status</code> and <code>task_timeline</code>, wait for release or TTL expiry, then let the replacement window acquire the task lease.

## What does REVISION_CONFLICT mean?

The editor, file, or project settings changed after the plan was previewed or applied. Re-read <code>editor_context</code> or the relevant snapshot, discard the stale plan, and create a new preview. Never force a stale plan over a user edit.

## Why can apply require confirmation?

Preview and apply are intentionally separate. A successful preview only describes a possible change; <code>confirm_scene_change</code> records explicit approval, and apply still checks the editor revision and project lease.

## Why can rollback be refused?

Rollback refuses to undo when the plan identity, editor revision, file revision, or Godot UndoRedo history no longer matches. This protects a later user edit or another window's operation.

## How do I run the real Godot smoke locally?

Provide a Godot 4.x editor binary:

~~~bash
GODOT_BIN=/path/to/Godot node tests/godot-runtime-smoke.mjs
~~~

The GitHub workflow runs the same fixture on Godot 4.5.1 and 4.7.2 with a virtual display. A local machine without a Godot binary can still run the Node tests, typecheck, build, and package boundary checks.

## How do I install the published package?

The npm package is available at version 1.1.0:

~~~bash
npm install -g godot-safe-change-mcp@1.1.0
godot-safe-change-mcp
~~~

The npm package contains the MCP entry, built bundle, public README files, and Godot plugin. Development sources, tests, docs, and project-local skills remain outside the tarball by design.

## Where should I report a problem?

Use the repository issue templates for reproducible bugs and bounded feature requests. Do not put tokens, private project files, or vulnerability details in a public issue; read SECURITY.md first for sensitive reports.
