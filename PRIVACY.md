# Privacy Policy

Godot Safe Change MCP is a local-first developer tool. This page describes exactly what data it touches and where that data goes.

## What data is processed

- **Read:** the files of the Godot project you point the server at — scenes, scripts, resources, and project settings — to build editor context, change previews, diffs, and verification evidence.
- **Written:** task timelines under `<projectRoot>/.godot-safe-change/tasks/`, plus operation audit and project lease records under a local state directory on your machine (default `~/.godot-safe-change-mcp`, override with the `GODOT_SAFE_CHANGE_STATE_DIR` environment variable).

## Where data goes

- **Nowhere else.** There is no telemetry, no analytics, no crash reporting, no account creation, and no license check that phones home.
- The only network endpoint the server uses is a localhost-only HTTP bridge (`127.0.0.1`) between this MCP server and the Godot EditorPlugin in your own editor. Because the server exposes no remote surface, it ships no authentication or rate-limiting layer by design.
- Project data is returned as tool results to the MCP client (the AI assistant) that you explicitly configured to connect to this server. How that client handles data is governed by its own provider and policy.

## Third parties

The server does not send data to any third-party service.

## Changes

Material changes to this policy will be documented in the repository changelog.

## Contact

Open an issue at [github.com/LJH-snow/godot-safe-change-mcp/issues](https://github.com/LJH-snow/godot-safe-change-mcp/issues).
