import { MCPServer } from "mcp-use";
import { ChangeCoordinator } from "./src/application/change-coordinator.js";
import { LocalProjectService } from "./src/application/project-service.js";
import { HttpGodotBridge } from "./src/infrastructure/http-godot-bridge.js";
import { registerCapabilitiesResource } from "./src/resources/capabilities.js";
import {
  registerApplyChangeTool,
  registerConfirmChangeTool,
  registerEditorContextTool,
  registerPreviewSceneChangeTool,
  registerRollbackChangeTool,
  registerRunCurrentSceneTool,
} from "./src/tools/editor-workflow.js";
import { registerProjectOverviewTool } from "./src/tools/project-overview.js";

const server = new MCPServer({
  name: "godot-safe-change-mcp",
  title: "Godot Safe Change MCP",
  version: "0.1.0",
  description: "Project intelligence and reviewable Godot changes.",
});

const bridge = new HttpGodotBridge();
const changeCoordinator = new ChangeCoordinator(bridge);
const projectService = new LocalProjectService(bridge);

export const projectOverview = registerProjectOverviewTool(server, projectService);
export const editorContext = registerEditorContextTool(server, changeCoordinator);
export const previewSceneChange = registerPreviewSceneChangeTool(server, changeCoordinator);
export const confirmSceneChange = registerConfirmChangeTool(server, changeCoordinator);
export const applySceneChange = registerApplyChangeTool(server, changeCoordinator);
export const rollbackSceneChange = registerRollbackChangeTool(server, changeCoordinator);
export const runCurrentScene = registerRunCurrentSceneTool(server, changeCoordinator);
registerCapabilitiesResource(server);

export default server;
