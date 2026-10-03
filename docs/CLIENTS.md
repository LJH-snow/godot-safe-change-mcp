# MCP client configuration

This page connects a local MCP client to Godot Safe Change MCP. It does not expose the Godot bridge to the client or to the network.

## Shared setup

Start the local server from the repository root:

~~~bash
npm ci
npm run build
npm run dev -- --no-open
~~~

Use this MCP endpoint in every client:

~~~text
http://127.0.0.1:3000/mcp
~~~

The Godot EditorPlugin bridge remains a separate loopback service at http://127.0.0.1:8765. Do not paste that bridge URL into an MCP client, do not bind either service to a public interface, and do not add credentials to these local examples.

## Claude Code

For a project-scoped setup, create .mcp.json at the project root:

~~~json
{
  "mcpServers": {
    "godot-safe-change": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
~~~

The current Claude Code command-line equivalent is:

~~~bash
claude mcp add --transport http godot-safe-change http://127.0.0.1:3000/mcp
~~~

Claude Code also accepts streamable-http as the transport name in JSON configuration. Approve the project-scoped server when prompted, then start with editor_context.

## Codex CLI

Add a server entry to the Codex TOML configuration, usually ~/.codex/config.toml:

~~~toml
[mcp_servers.godot-safe-change]
url = "http://127.0.0.1:3000/mcp"
~~~

Restart Codex after changing the configuration. The server should appear in the MCP tool list; call editor_context before any write workflow.

## Cursor

For a repository-scoped setup, create .cursor/mcp.json:

~~~json
{
  "mcpServers": {
    "godot-safe-change": {
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
~~~

Reload the workspace or restart Cursor, then verify that the server is connected before using tools.

## Other Streamable HTTP clients

Use the client's remote or Streamable HTTP MCP server form with:

~~~text
Name: godot-safe-change
URL:  http://127.0.0.1:3000/mcp
~~~

Do not add an Authorization header for the default local server. If the client asks for an SSE URL instead of Streamable HTTP, use a client version that supports the endpoint described above rather than exposing the Godot bridge directly.

## First connection check

Run this sequence in the client:

1. editor_context — confirm connection: connected, a current scene, and a revision.
2. search_project — confirm read-only project results.
3. preview_scene_change — inspect the diff without writing.
4. confirm_scene_change → apply_scene_change — write only after explicit confirmation.
5. verify_scene_state or verify_resource_state — collect bounded evidence.
6. rollback_scene_change — undo only while the applied revision is still current.

If the first call returns EDITOR_UNAVAILABLE, check that Godot is open with the plugin enabled and that the MCP server is using the same project. If a write returns PROJECT_BUSY, inspect task_status and task_timeline instead of retrying in a tight loop.

## Troubleshooting the bridge connection

The Godot EditorPlugin listens on loopback port 8765 by default. Two failure shapes exist:

- **Connection refused** (`could not be reached` with a `cause` mentioning fetch or ECONNREFUSED): Godot is not running, the plugin is not enabled in the project, or the MCP server points at a different project. Enable the plugin per the starter guide and retry.
- **A non-Godot service answered** (`Something other than the Godot Safe Change EditorPlugin answered on the bridge endpoint`): another program on your machine already owns port 8765, so the bridge request reached it instead of the plugin. Free the port, or move both sides:
  1. Add `godot_safe_change/bridge_port = 8899` to the `[application]`-adjacent custom settings in the target project's `project.godot` and reload the editor plugin.
  2. Set `GODOT_BRIDGE_URL=http://127.0.0.1:8899` in the MCP server environment (see `.env.example`) before `npm run dev`.

Both services stay on loopback in every configuration; never expose either port beyond 127.0.0.1.

## Official client references

- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Cursor MCP](https://cursor.com/docs/mcp)

Client configuration syntax can change independently of this project. Keep the endpoint and safety sequence above, and consult the linked client documentation when a client changes its settings UI.
