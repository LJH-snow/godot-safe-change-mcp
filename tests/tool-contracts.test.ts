import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { MCPServer } from "mcp-use";
import { ChangeCoordinator } from "../src/application/change-coordinator.js";
import { TaskCoordinator } from "../src/application/task-coordinator.js";
import { LocalProjectSearchService } from "../src/application/project-search-service.js";
import { LocalProjectService } from "../src/application/project-service.js";
import { LocalReferenceService } from "../src/application/reference-service.js";
import type { EditorContext } from "../src/domain/contracts.js";
import type { GodotBridge } from "../src/infrastructure/godot-bridge.js";
import { HttpGodotBridge } from "../src/infrastructure/http-godot-bridge.js";
import { FileOperationAuditStore } from "../src/infrastructure/operation-audit-store.js";
import { InMemoryProjectLeaseStore } from "../src/infrastructure/project-lease-store.js";
import { FileTaskStore } from "../src/infrastructure/task-store.js";
import {
  registerApplyChangeTool,
  registerConfirmChangeTool,
  registerEditorContextTool,
  registerPreviewDiagnosticRepairTool,
  registerPreviewSceneChangeTool,
  registerRollbackChangeTool,
  registerRunCurrentSceneTool,
  registerRunSceneTool,
} from "../src/tools/editor-workflow.js";
import { registerFindReferencesTool } from "../src/tools/project-references.js";
import { registerOperationHistoryTool } from "../src/tools/operation-history.js";
import { registerProjectOverviewTool } from "../src/tools/project-overview.js";
import { registerSearchProjectTool } from "../src/tools/project-search.js";
import {
  registerAcquireTaskLeaseTool,
  registerAdvanceTaskTool,
  registerCancelTaskTool,
  registerCreateTaskTool,
  registerGetTaskTool,
  registerPauseTaskTool,
  registerReleaseTaskLeaseTool,
  registerRenewTaskLeaseTool,
  registerResumeTaskTool,
  registerTaskStatusTool,
  registerTaskTimelineTool,
} from "../src/tools/task-workflow.js";

const SCRIPT_PLAYER = [
  "# uid uid://bplayer0123456",
  "extends CharacterBody2D",
].join("\n");

const SCENE_MAIN = [
  '[gd_scene load_steps=2 format=3 uid="uid://cmain01234567"]',
  "",
  '[ext_resource type="Script" path="res://scripts/player.gd" id="1_abcde"]',
  "",
  '[node name="Main" type="Node2D"]',
].join("\n");

const ALL_TOOLS = [
  "editor_context",
  "preview_scene_change",
  "preview_diagnostic_repair",
  "confirm_scene_change",
  "apply_scene_change",
  "run_current_scene",
  "run_scene",
  "rollback_scene_change",
  "create_task",
  "get_task",
  "task_status",
  "task_timeline",
  "acquire_task_lease",
  "renew_task_lease",
  "release_task_lease",
  "advance_task",
  "pause_task",
  "resume_task",
  "cancel_task",
  "search_project",
  "project_overview",
  "operation_history",
  "find_references",
] as const;

const READ_ONLY_TOOLS = new Set<string>([
  "project_overview",
  "search_project",
  "find_references",
  "editor_context",
  "preview_scene_change",
  "preview_diagnostic_repair",
  "operation_history",
  "get_task",
  "task_status",
  "task_timeline",
]);

interface CapturedTool {
  name: string;
  title?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
  handler: (input: unknown) => Promise<unknown>;
}

const captured = new Map<string, CapturedTool>();

const stubServer = {
  tool(
    definition: Omit<CapturedTool, "handler">,
    handler: (input: unknown) => Promise<unknown>,
  ) {
    captured.set(definition.name, { ...definition, handler });
    return definition;
  },
} as unknown as MCPServer;

let fixtureRoot = "";
let stateRoot = "";

before(async () => {
  stateRoot = await mkdtemp(path.join(tmpdir(), "godot-tool-contracts-state-"));
  fixtureRoot = await mkdtemp(path.join(tmpdir(), "godot-tool-contracts-fixture-"));
  await mkdir(path.join(fixtureRoot, "scenes"), { recursive: true });
  await mkdir(path.join(fixtureRoot, "scripts"), { recursive: true });
  await writeFile(path.join(fixtureRoot, "project.godot"), "config_version=5\n");
  await writeFile(path.join(fixtureRoot, "scripts", "player.gd"), SCRIPT_PLAYER + "\n");
  await writeFile(path.join(fixtureRoot, "scenes", "main.tscn"), SCENE_MAIN + "\n");

  const editorContext: EditorContext = {
    schemaVersion: "0.2",
    projectRoot: fixtureRoot,
    connection: "connected",
    revision: "revision-1",
    project: { name: "Example", path: fixtureRoot },
    currentScene: {
      path: "res://main.tscn",
      rootName: "Main",
      rootType: "Node2D",
      nodes: [],
    },
    selection: [],
    openResources: ["res://main.tscn"],
    run: { status: "stopped", scenePath: "res://main.tscn", runId: null },
    diagnostics: { output: [], warnings: [], errors: [] },
  };
  const offlineBridge = {
    getContext: async () => editorContext,
  } as unknown as GodotBridge;

  const bridge = new HttpGodotBridge();
  const changeCoordinator = new ChangeCoordinator(
    bridge,
    new FileOperationAuditStore(stateRoot),
    new InMemoryProjectLeaseStore(),
  );
  const taskCoordinator = new TaskCoordinator(
    changeCoordinator,
    new FileTaskStore(),
    new InMemoryProjectLeaseStore(),
  );
  const projectService = new LocalProjectService(offlineBridge);
  const projectSearchService = new LocalProjectSearchService(bridge);
  const referenceService = new LocalReferenceService();

  registerEditorContextTool(stubServer, changeCoordinator);
  registerPreviewSceneChangeTool(stubServer, changeCoordinator);
  registerPreviewDiagnosticRepairTool(stubServer, changeCoordinator);
  registerConfirmChangeTool(stubServer, changeCoordinator);
  registerApplyChangeTool(stubServer, changeCoordinator);
  registerRunCurrentSceneTool(stubServer, changeCoordinator);
  registerRunSceneTool(stubServer, changeCoordinator);
  registerRollbackChangeTool(stubServer, changeCoordinator);
  registerOperationHistoryTool(stubServer, changeCoordinator);
  registerCreateTaskTool(stubServer, taskCoordinator);
  registerGetTaskTool(stubServer, taskCoordinator);
  registerTaskStatusTool(stubServer, taskCoordinator);
  registerTaskTimelineTool(stubServer, taskCoordinator);
  registerAcquireTaskLeaseTool(stubServer, taskCoordinator);
  registerRenewTaskLeaseTool(stubServer, taskCoordinator);
  registerReleaseTaskLeaseTool(stubServer, taskCoordinator);
  registerAdvanceTaskTool(stubServer, taskCoordinator);
  registerPauseTaskTool(stubServer, taskCoordinator);
  registerResumeTaskTool(stubServer, taskCoordinator);
  registerCancelTaskTool(stubServer, taskCoordinator);
  registerProjectOverviewTool(stubServer, projectService);
  registerSearchProjectTool(stubServer, projectSearchService);
  registerFindReferencesTool(stubServer, referenceService);
});

after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
  await rm(stateRoot, { recursive: true, force: true });
});

describe("tool registration contracts", () => {
  test("registers exactly the declared tool set", () => {
    assert.equal(captured.size, ALL_TOOLS.length);
    assert.deepEqual([...captured.keys()].sort(), [...ALL_TOOLS].sort());
  });

  test("every tool declares metadata, schemas, and complete annotations", () => {
    for (const name of ALL_TOOLS) {
      const tool = captured.get(name);
      assert.ok(tool, `missing tool: ${name}`);
      assert.equal(typeof tool.title, "string", `${name} title`);
      assert.equal((tool.title as string).length > 0, true, `${name} title`);
      assert.equal(typeof tool.description, "string", `${name} description`);
      assert.equal((tool.description as string).length > 0, true, `${name} description`);
      assert.ok(tool.inputSchema, `${name} inputSchema`);
      assert.ok(tool.outputSchema, `${name} outputSchema`);
      assert.ok(tool.annotations, `${name} annotations`);
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
        assert.equal(
          typeof tool.annotations?.[hint],
          "boolean",
          `${name} annotations.${hint}`,
        );
      }
      assert.equal(tool.annotations?.destructiveHint, false, `${name} destructiveHint`);
      assert.equal(tool.annotations?.openWorldHint, false, `${name} openWorldHint`);
    }
  });

  test("read-only tools declare readOnly and idempotent hints", () => {
    for (const name of READ_ONLY_TOOLS) {
      const tool = captured.get(name);
      assert.ok(tool, `missing tool: ${name}`);
      assert.equal(tool.annotations?.readOnlyHint, true, `${name} readOnlyHint`);
      assert.equal(tool.annotations?.idempotentHint, true, `${name} idempotentHint`);
    }
  });

  test("mutating tools declare non-read-only and non-idempotent hints", () => {
    const mutating = ALL_TOOLS.filter((name) => !READ_ONLY_TOOLS.has(name));
    for (const name of mutating) {
      const tool = captured.get(name);
      assert.ok(tool, `missing tool: ${name}`);
      assert.equal(tool.annotations?.readOnlyHint, false, `${name} readOnlyHint`);
      assert.equal(tool.annotations?.idempotentHint, false, `${name} idempotentHint`);
    }
  });
});

describe("tool handler smoke checks", () => {
  test("project_overview handler returns a locally indexed overview", async () => {
    const tool = captured.get("project_overview");
    assert.ok(tool);
    const result = (await tool.handler({ projectRoot: fixtureRoot })) as {
      structuredContent: {
        counts: { scenes: number; scripts: number };
        notes: string[];
      };
    };

    assert.equal(result.structuredContent.counts.scenes, 1);
    assert.equal(result.structuredContent.counts.scripts, 1);
    assert.equal(
      result.structuredContent.notes.some((note) => note.includes("local read-only index")),
      true,
    );
  });

  test("find_references handler returns a contract-shaped report", async () => {
    const tool = captured.get("find_references");
    assert.ok(tool);
    const result = (await tool.handler({
      projectRoot: fixtureRoot,
      target: "player.gd",
    })) as {
      structuredContent: {
        schemaVersion: string;
        target: string;
        references: { path: string }[];
      };
    };

    assert.equal(result.structuredContent.schemaVersion, "0.1");
    assert.equal(result.structuredContent.target, "player.gd");
    assert.equal(
      result.structuredContent.references.some((ref) => ref.path === "res://scenes/main.tscn"),
      true,
    );
  });
});
