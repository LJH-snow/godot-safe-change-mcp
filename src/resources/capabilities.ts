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
      "POST /v1/project-settings/read",
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
    "Bounded scene.create_node, scene.delete_node, scene.reparent_node, scene.rename_node, scene.duplicate_node, scene.reorder_node, scene.set_unique_name, scene.instantiate_scene, scene.connect_signal, scene.disconnect_signal, scene.add_group, scene.remove_group, scene.set_property, scene.attach_script, scene.detach_script, project.autoload.add, project.autoload.remove, project.setting.set, script.create_file, and script.replace_range operations are supported. project.setting.set is a project-level operation and is limited to exactly three keys: application/run/main_scene (an existing project-local res:// .tscn), display/window/size/viewport_width, and display/window/size/viewport_height (the viewport values are integers from 1 through 16384); arbitrary ProjectSettings keys and Variants are not supported. An unconfigured main-scene snapshot is typed as exists=false and value=null, and this lifecycle does not require a current scene. Preview, confirmation, full project.godot byte/revision checks, active-plan and project-lease guards, independent ConfigFile disk readback after ProjectSettings.save(), byte-preserving recovery through temporary-file atomic replacement, and revision-guarded rollback are required. Recovery failures report structured recoveryRequired and phase details; pending recovery blocks another project-setting apply, while external edits return REVISION_CONFLICT without overwriting the edited file. This is a bounded implementation and evidence description, not a complete security audit.",
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
