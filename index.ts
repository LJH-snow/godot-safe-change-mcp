import { MCPServer } from "mcp-use";
import { ChangeCoordinator } from "./src/application/change-coordinator.js";
import { LocalProjectService } from "./src/application/project-service.js";
import { LocalProjectSearchService } from "./src/application/project-search-service.js";
import { LocalReferenceService } from "./src/application/reference-service.js";
import { HttpGodotBridge } from "./src/infrastructure/http-godot-bridge.js";
import { FileOperationAuditStore } from "./src/infrastructure/operation-audit-store.js";
import { FileProjectLeaseStore } from "./src/infrastructure/project-lease-store.js";
import { registerCapabilitiesResource } from "./src/resources/capabilities.js";
import {
  registerApplyChangeTool,
  registerConfirmChangeTool,
  registerEditorContextTool,
  registerPreviewSceneChangeTool,
  registerPreviewDiagnosticRepairTool,
  registerRollbackChangeTool,
  registerRunCurrentSceneTool,
  registerRunSceneTool,
} from "./src/tools/editor-workflow.js";
import { registerProjectOverviewTool } from "./src/tools/project-overview.js";
import { registerSearchProjectTool } from "./src/tools/project-search.js";
import { registerFindReferencesTool } from "./src/tools/project-references.js";
import { registerOperationHistoryTool } from "./src/tools/operation-history.js";
import { TaskCoordinator } from "./src/application/task-coordinator.js";
import { FileTaskStore } from "./src/infrastructure/task-store.js";
import {
  registerAdvanceTaskTool,
  registerAcquireTaskLeaseTool,
  registerCancelTaskTool,
  registerCreateTaskTool,
  registerGetTaskTool,
  registerReleaseTaskLeaseTool,
  registerPauseTaskTool,
  registerRenewTaskLeaseTool,
  registerResumeTaskTool,
  registerTaskStatusTool,
} from "./src/tools/task-workflow.js";

const server = new MCPServer({
  name: "godot-safe-change-mcp",
  title: "Godot Safe Change MCP",
  version: "1.0.0",
  description: "Project intelligence and reviewable Godot changes.",
});

const bridge = new HttpGodotBridge();
const changeCoordinator = new ChangeCoordinator(
  bridge,
  new FileOperationAuditStore(),
  new FileProjectLeaseStore(),
);
const taskCoordinator = new TaskCoordinator(
  changeCoordinator,
  new FileTaskStore(),
  new FileProjectLeaseStore(),
);
const projectService = new LocalProjectService(bridge);
const projectSearchService = new LocalProjectSearchService(bridge);
const referenceService = new LocalReferenceService();

export const projectOverview = registerProjectOverviewTool(server, projectService);
export const searchProject = registerSearchProjectTool(server, projectSearchService);
export const findReferences = registerFindReferencesTool(server, referenceService);
export const operationHistory = registerOperationHistoryTool(server, changeCoordinator);
export const editorContext = registerEditorContextTool(server, changeCoordinator);
export const previewSceneChange = registerPreviewSceneChangeTool(server, changeCoordinator);
export const previewDiagnosticRepair = registerPreviewDiagnosticRepairTool(server, changeCoordinator);
export const confirmSceneChange = registerConfirmChangeTool(server, changeCoordinator);
export const applySceneChange = registerApplyChangeTool(server, changeCoordinator);
export const rollbackSceneChange = registerRollbackChangeTool(server, changeCoordinator);
export const runCurrentScene = registerRunCurrentSceneTool(server, changeCoordinator);
export const runScene = registerRunSceneTool(server, changeCoordinator);
export const createTask = registerCreateTaskTool(server, taskCoordinator);
export const getTask = registerGetTaskTool(server, taskCoordinator);
export const taskStatus = registerTaskStatusTool(server, taskCoordinator);
export const advanceTask = registerAdvanceTaskTool(server, taskCoordinator);
export const acquireTaskLease = registerAcquireTaskLeaseTool(server, taskCoordinator);
export const renewTaskLease = registerRenewTaskLeaseTool(server, taskCoordinator);
export const releaseTaskLease = registerReleaseTaskLeaseTool(server, taskCoordinator);
export const pauseTask = registerPauseTaskTool(server, taskCoordinator);
export const resumeTask = registerResumeTaskTool(server, taskCoordinator);
export const cancelTask = registerCancelTaskTool(server, taskCoordinator);
registerCapabilitiesResource(server);

export default server;
