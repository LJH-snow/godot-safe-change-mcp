import type { MCPServer } from "mcp-use";
import {
  changePlanSchema,
  confirmChangeInputSchema,
  confirmedChangeSchema,
  applyChangeInputSchema,
  previewSceneChangeInputSchema,
  type ApplyChangeInput,
  type ConfirmChangeInput,
  type PreviewSceneChangeInput,
} from "../domain/change-contracts.js";
import {
  changeReportSchema,
  editorContextSchema,
  previewRepairFromDiagnosticInputSchema,
  rollbackReportSchema,
  runCurrentSceneInputSchema,
  runDiagnosticsSchema,
  runSceneInputSchema,
  type RunCurrentSceneInput,
  type RunSceneInput,
} from "../domain/contracts.js";
import { ChangeCoordinator } from "../application/change-coordinator.js";
import { toolError } from "./tool-errors.js";

export function registerEditorContextTool(
  server: MCPServer,
  coordinator: ChangeCoordinator,
) {
  return server.tool(
    {
      name: "editor_context",
      title: "Godot editor context",
      description: "Read the connected Godot editor context without changing the project.",
      inputSchema: runCurrentSceneInputSchema.pick({ projectRoot: true }),
      outputSchema: editorContextSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ projectRoot }) => {
      try {
        const context = await coordinator.getContext(projectRoot);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(context, null, 2) }],
          structuredContent: context,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

export function registerPreviewSceneChangeTool(
  server: MCPServer,
  coordinator: ChangeCoordinator,
) {
  return server.tool(
    {
      name: "preview_scene_change",
      title: "Preview a Godot scene change",
      description: "Create a reviewable preview for one allowlisted scene node operation.",
      inputSchema: previewSceneChangeInputSchema,
      outputSchema: changePlanSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input: PreviewSceneChangeInput) => {
      try {
        const plan = await coordinator.previewSceneChange(input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(plan, null, 2) }],
          structuredContent: plan,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

export function registerPreviewDiagnosticRepairTool(
  server: MCPServer,
  coordinator: ChangeCoordinator,
) {
  return server.tool(
    {
      name: "preview_diagnostic_repair",
      title: "Preview a diagnostic repair",
      description: "Turn an explicit bounded diagnostic repair hint into a reviewable scene plan.",
      inputSchema: previewRepairFromDiagnosticInputSchema,
      outputSchema: changePlanSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        const plan = await coordinator.previewRepairFromDiagnostic(input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(plan, null, 2) }],
          structuredContent: plan,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

export function registerConfirmChangeTool(
  server: MCPServer,
  coordinator: ChangeCoordinator,
) {
  return server.tool(
    {
      name: "confirm_scene_change",
      title: "Confirm a Godot scene change",
      description: "Confirm one preview after checking its diff and expected editor revision.",
      inputSchema: confirmChangeInputSchema,
      outputSchema: confirmedChangeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input: ConfirmChangeInput) => {
      try {
        const confirmation = await coordinator.confirmChange(input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(confirmation, null, 2) }],
          structuredContent: confirmation,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

export function registerApplyChangeTool(
  server: MCPServer,
  coordinator: ChangeCoordinator,
) {
  return server.tool(
    {
      name: "apply_scene_change",
      title: "Apply a confirmed Godot scene change",
      description: "Apply one confirmed scene node operation through Godot UndoRedo.",
      inputSchema: applyChangeInputSchema,
      outputSchema: changeReportSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input: ApplyChangeInput) => {
      try {
        const report = await coordinator.applyChange(input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
          structuredContent: report,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

export function registerRunCurrentSceneTool(
  server: MCPServer,
  coordinator: ChangeCoordinator,
) {
  return server.tool(
    {
      name: "run_current_scene",
      title: "Run the current Godot scene",
      description: "Run the current scene through the editor and return collected diagnostics.",
      inputSchema: runCurrentSceneInputSchema,
      outputSchema: runDiagnosticsSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input: RunCurrentSceneInput) => {
      try {
        const diagnostics = await coordinator.runCurrentScene(input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(diagnostics, null, 2) }],
          structuredContent: diagnostics,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

export function registerRunSceneTool(
  server: MCPServer,
  coordinator: ChangeCoordinator,
) {
  return server.tool(
    {
      name: "run_scene",
      title: "Run a specific Godot scene",
      description:
        "Run one res:// .tscn scene through the editor and return collected diagnostics.",
      inputSchema: runSceneInputSchema,
      outputSchema: runDiagnosticsSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input: RunSceneInput) => {
      try {
        const diagnostics = await coordinator.runScene(input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(diagnostics, null, 2) }],
          structuredContent: diagnostics,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

export function registerRollbackChangeTool(
  server: MCPServer,
  coordinator: ChangeCoordinator,
) {
  return server.tool(
    {
      name: "rollback_scene_change",
      title: "Rollback a Godot scene change",
      description: "Undo the latest applied plan only when its revision is still current.",
      inputSchema: applyChangeInputSchema,
      outputSchema: rollbackReportSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input: ApplyChangeInput) => {
      try {
        const report = await coordinator.rollbackChange(input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
          structuredContent: report,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
