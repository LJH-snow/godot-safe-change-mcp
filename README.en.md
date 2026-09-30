# Godot Safe Change MCP

English | [简体中文](README.md)

An MCP server that lets AI Agents participate in Godot development through MCP. The TypeScript MCP server owns tool contracts, planning, confirmation and reporting; the GDScript Godot EditorPlugin owns editor context, UndoRedo, run control and diagnostics collection.

The first safe vertical workflow is now fully connected:

> Read editor context → local loopback HTTP bridge → preview a scene node change → user confirmation → apply via Godot UndoRedo → run the current scene and return diagnostics

## Implemented capabilities

- project_overview: read the project overview and editor connection status.
- editor_context: read the current project, scene, selected nodes, open resources, run state and diagnostics.
- search_project: search file paths, node names and node types across scenes, scripts and resources, plus signal connections, GDScript signal declarations and input map actions (purely local and read-only, no editor connection required).
- preview_scene_change: produce a stable plan and diff for a restricted scene.create_node change.
- confirm_scene_change: check the expected revision and confirm the plan.
- apply_scene_change: hand only a confirmed, non-expired plan to Godot UndoRedo.
- rollback_scene_change: roll back only an applied plan whose revision is still current.
- run_current_scene: run the current scene and poll the plugin until it returns stopped or failed diagnostics.

Currently only one node type from the allowlist can be created inside the current scene: Node, Node2D, Control, Label, ColorRect.

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
~~~

## Godot plugin

Copy the godot-plugin directory into the target Godot project:

~~~text
res://addons/godot-safe-change-bridge/
~~~

Enable the Godot Safe Change Bridge plugin in the Godot editor. The plugin only binds 127.0.0.1:8765 and only serves the fixed context, changes/apply, run/current and run/status routes.

When no Godot editor is connected, MCP tools return a stable EDITOR_UNAVAILABLE instead of faking success.

## Safety boundaries

- Write operations must pass preview, confirmation and expected-revision checks.
- Scene node creation is executed only by the GDScript plugin through Godot's EditorUndoRedoManager.
- No agent-generated GDScript, shell, Python or arbitrary Godot RPC is ever executed.
- The plugin accepts only fixed routes and allowlisted node types, and validates the current project root.
- Run diagnostics return only plugin-collected output, warnings, errors and run state.

See docs/PLAN.md for the full product plan, and tests/README.md for test boundaries and manual Godot acceptance steps.
