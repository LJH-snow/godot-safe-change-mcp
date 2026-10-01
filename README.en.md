# Godot Safe Change MCP

English | [简体中文](README.md)

An MCP server that lets AI Agents participate in Godot development through MCP. The TypeScript MCP server owns tool contracts, planning, confirmation and reporting; the GDScript Godot EditorPlugin owns editor context, UndoRedo, run control and diagnostics collection.

The first safe vertical workflow is now fully connected:

> Read editor context → local loopback HTTP bridge → preview a scene node change → user confirmation → apply via Godot UndoRedo → run the current scene and return diagnostics

## Implemented capabilities

- project_overview: read the project overview and editor connection status, with real scene, script, resource and settings file counts from the local read-only index (also available while the editor is offline).
- editor_context: read the current project, scene, selected nodes, open resources, run state and diagnostics.
- search_project: unified read-only project search covering scenes, nodes, scripts, resources, signal connections and input actions. Scene, node, script and resource results come from the connected Godot editor when available (live state of the edited scene) and fall back to a local read-only index otherwise; signal and input results always come from the local index. Every result is tagged with its `source`.
- find_references: reverse reference lookup answering "which scenes, resources or scripts reference this script, texture or resource". It scans scene/resource ext_resource entries and GDScript `preload()` / `load()` calls, matches by res:// path or uid:// identifier, and resolves uid-only references where Godot 4.4+ omits the path (purely local and read-only).
- preview_scene_change: produce a plan and diff for restricted scene.create_node, scene.delete_node, scene.set_property, scene.attach_script, resource.replace_reference, project.input_action.add_key/remove_key/replace_key or script.replace_range operations.
- scene.delete_node: delete only a non-root node owned by the current scene; preview returns the complete subtree snapshot and apply/rollback use Godot UndoRedo while restoring the original parent and child order.
- scene.set_property: allow only visible, position, size, text and color with node-type checks, exact object keys, finite numeric ranges and a current property snapshot.
- scene.attach_script: attach only an existing project-local `.gd` script to a node in the current scene; it never executes or edits the script.
- resource.replace_reference / project.input_action.add_key/remove_key/replace_key: use file or project.godot revision guards, bounded writes and safe rollback; key removal/replacement requires exactly one matching physical InputEventKey and replacement preserves modifiers.
- preview_diagnostic_repair: create the next restricted preview only from an explicit scene.create_node repair hint; task repair previews pause for review and never auto-confirm.
- confirm_scene_change: check the expected revision and confirm the plan.
- apply_scene_change: hand only a confirmed, non-expired plan to Godot UndoRedo or its bounded file/settings path; only one applied plan is allowed per project.
- rollback_scene_change: roll back only an applied plan whose scene, file or UndoRedo history revision is still current.
- run_current_scene: run the current scene and poll the plugin until it returns stopped or failed diagnostics.
- run_scene: run one validated `res://` `.tscn` scene through the editor and poll its run ID until it returns terminal diagnostics.
- create_task / get_task / advance_task / pause_task / resume_task / cancel_task: compose bounded apply, rollback, run, scene/diagnostic verification and diagnostic-repair preview/apply steps into an auditable task with leases, pause/resume/cancel, retry and restart recovery. Every task must use unique `stepId` values. Repair apply requires a separate confirm_scene_change call.
- acquire_task_lease / renew_task_lease / release_task_lease / task_status / task_timeline: coordinate multi-window ownership, heartbeat recovery and filtered evidence timelines; atomic file acquisition keeps a single owner across concurrent MCP processes.

The current scene can create only allowlisted node types—Node, Node2D, Control, Label and ColorRect—and property/script/delete operations accept only safe relative NodePaths and allowlisted properties.

## Running locally

Install dependencies and start the MCP dev server:

~~~bash
npm install
npm run dev
~~~

Then open http://localhost:3000/mcp/inspector to inspect tools, resources and error results in the Inspector.

By default the MCP server connects to the Godot EditorPlugin bridge at http://127.0.0.1:8765; override the address with GODOT_BRIDGE_URL.

Common checks:

~~~bash
npm run typecheck
npm test
npm run build
npm run package:check
~~~

## Running with npx

Start without cloning the repository (requires Node >= 22.22.2; the first run builds automatically):

~~~bash
npx github:LJH-snow/godot-safe-change-mcp
~~~

Once published to npm, this will also work:

~~~bash
npx godot-safe-change-mcp
~~~

The server exposes an MCP Streamable HTTP endpoint at `http://127.0.0.1:3000/mcp`; override the defaults with the `PORT`, `HOST` and `GODOT_BRIDGE_URL` environment variables.

## Godot plugin

Copy the godot-plugin directory into the target Godot project:

~~~text
res://addons/godot-safe-change-bridge/
~~~

Enable the Godot Safe Change Bridge plugin in the Godot editor. The plugin binds only to 127.0.0.1:8765 and serves only fixed context, changes/apply, changes/rollback, search, bounded snapshot/read and run routes.

When no Godot editor is connected, MCP tools return a stable EDITOR_UNAVAILABLE instead of faking success.

## Release preflight

Run `npm run package:check` before publishing. It builds the server, creates a real npm tarball, installs it in a temporary consumer when permitted, and verifies the packaged MCP entry point and Godot plugin files. GitHub Actions repeats this package boundary check alongside Node tests and Godot 4.5.1/4.7.2 runtime smoke.
For a local editor-backed release check, also run `GODOT_BIN=/path/to/Godot node tests/godot-runtime-smoke.mjs`. The Godot smoke starts two MCP processes against the same real EditorPlugin bridge to verify lease contention and TTL takeover. The workflow must finish the `check`, `npm package boundary`, `Godot 4.5.1 runtime`, and `Godot 4.7.2 runtime` jobs successfully. The package smoke uses an explicit release allowlist and rejects source, test, documentation, CI, script, and lock files.

## Safety boundaries

- Write operations must pass preview, confirmation and expected-revision checks.
- Scene creation, property changes and script attachment are executed only by the GDScript plugin through Godot's EditorUndoRedoManager; scene rollback checks history, version, action and label.
- File and project-setting changes use only bounded `.gd` atomic replacement, resource replacement or ProjectSettings paths with file revision guards.
- No agent-generated GDScript, shell, Python or arbitrary Godot RPC is ever executed.
- The plugin accepts only fixed routes, allowlisted node types, safe relative NodePaths and project-local paths, and validates the current project root.
- Run diagnostics return only plugin-collected output, warnings, errors and run state.
- Task repair previews never execute diagnostic text; they use only schema-validated allowlisted hints and require explicit confirmation before applying.

See docs/PLAN.md for the full product plan, tests/README.md for test boundaries and manual Godot acceptance steps, and docs/RELEASE.md for the release checklist.
