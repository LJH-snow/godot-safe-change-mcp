import type { MCPServer } from "mcp-use";

const capabilities = {
  schemaVersion: "0.2",
  productDirection: "reviewable and verifiable Godot changes",
  transport: {
    kind: "loopback_http",
    bindAddress: "127.0.0.1",
    defaultPort: 8765,
    routes: [
      "POST /v1/context",
      "POST /v1/changes/apply",
      "POST /v1/changes/rollback",
      "POST /v1/search",
      "POST /v1/run/current",
      "POST /v1/run/scene",
      "POST /v1/run/status",
    ],
  },
  tools: [
    "project_overview",
    "search_project",
    "find_references",
    "operation_history",
    "editor_context",
    "preview_diagnostic_repair",
    "preview_scene_change",
    "confirm_scene_change",
    "apply_scene_change",
    "rollback_scene_change",
    "run_current_scene",
    "run_scene",
    "create_task",
    "get_task",
    "task_status",
    "task_timeline",
    "advance_task",
    "acquire_task_lease",
    "renew_task_lease",
    "release_task_lease",
    "pause_task",
    "resume_task",
    "cancel_task",
  ],
  lifecycle: [
    "inspect",
    "propose",
    "preview",
    "confirm",
    "apply",
    "validate",
    "rollback",
    "task_pause_resume_cancel",
  ],
  writePolicy:
    "Bounded scene.create_node, scene.delete_node, scene.reparent_node, scene.rename_node, scene.duplicate_node, scene.instantiate_scene, scene.connect_signal, scene.disconnect_signal, scene.add_group, scene.remove_group, scene.set_property, scene.attach_script, scene.detach_script, project.autoload.add, and project.autoload.remove operations are supported. Preview, confirmation, expected scene and source-resource revisions, Godot UndoRedo, and revision-guarded rollback are required for the write lifecycle.",
  forbidden: [
    "arbitrary GDScript execution",
    "shell execution",
    "Python workers",
    "unrestricted filesystem writes",
    "arbitrary Godot RPC",
  ],
};

export function registerCapabilitiesResource(server: MCPServer): void {
  server.resource(
    {
      name: "Godot MCP capabilities",
      uri: "godot://capabilities",
      description: "The initial contract and safety boundary of this server.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(capabilities, null, 2),
        },
      ],
    }),
  );
}
