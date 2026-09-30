# Godot Safe Change Bridge

This folder is the Godot-side EditorPlugin adapter for the TypeScript MCP server.

## Install

Copy this folder into a Godot project as:

~~~text
res://addons/godot-safe-change-bridge/
~~~

Enable Godot Safe Change Bridge in Project Settings > Plugins. The plugin starts a loopback-only HTTP server at 127.0.0.1:8765.

## Enabled routes

- POST /v1/context returns the current project, edited scene, selection, open scenes, run state and collected diagnostics.
- POST /v1/search returns read-only matches for scenes, nodes, scripts and resources from the editor filesystem and current scene tree.
- POST /v1/scripts/read returns a read-only script snapshot and content revision for safe preview generation.
- Script replace apply uses a bounded .gd path, expected file revision, temporary file and atomic rename; rollback restores the captured original content.
- POST /v1/changes/apply accepts only one scene.create_node operation and commits it through EditorUndoRedoManager.
- POST /v1/changes/rollback undoes only the latest applied plan when its plan ID and revision still match.
- POST /v1/run/current starts the current saved scene and returns a run snapshot.
- POST /v1/run/status returns the current snapshot for the requested run ID.

The server validates that projectRoot is the project currently open in the editor. It does not expose arbitrary GDScript, shell commands, file writes, method names or Godot object RPC.

## Diagnostics

The plugin tracks run lifecycle output and accepts bounded diagnostic messages through the Godot debugger channel godot_safe_change. A project scene may send severity, message, source, line, NodePath and a validated scene.create_node repair hint to make it visible to the MCP run result.

The TypeScript server polls /v1/run/status until the scene stops, fails, or the requested timeout expires.
