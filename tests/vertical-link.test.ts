import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import type { AddressInfo } from "node:net";
import { ChangeCoordinator } from "../src/application/change-coordinator.js";
import { LocalProjectSearchService } from "../src/application/project-search-service.js";
import { DomainError, ERROR_CODES } from "../src/domain/errors.js";
import { changeOperationSchema } from "../src/domain/change-contracts.js";
import type {
  ApplyChangeRequest,
  AutoloadSnapshot,
  ChangeReport,
  EditorContext,
  InputActionSnapshot,
  RollbackReport,
  RollbackRequest,
  RunDiagnostics,
  ResourceSnapshot,
  SearchProjectReport,
  SearchProjectRequest,
  ScriptSnapshot,
} from "../src/domain/contracts.js";
import type { GodotBridge } from "../src/infrastructure/godot-bridge.js";
import { HttpGodotBridge } from "../src/infrastructure/http-godot-bridge.js";
import { normalizeProjectRoot } from "../src/infrastructure/project-root.js";

const projectRoot = "/tmp/example-godot-project";

function createContext(revision = "revision-1"): EditorContext {
  return {
    schemaVersion: "0.2",
    projectRoot,
    connection: "connected",
    revision,
    project: { name: "Example", path: projectRoot },
    currentScene: {
      path: "res://main.tscn",
      rootName: "Main",
      rootType: "Node2D",
      nodes: [
        {
          path: ".",
          name: "Main",
          type: "Node2D",
          properties: { visible: true, position: { x: 0, y: 0 } },
        },
      ],
    },
    selection: [],
    openResources: ["res://main.tscn"],
    run: { status: "stopped", scenePath: "res://main.tscn", runId: null },
    diagnostics: { output: [], warnings: [], errors: [] },
  };
}

class FakeGodotBridge implements GodotBridge {
  context = createContext();
  applied: ApplyChangeRequest[] = [];
  rolledBack: RollbackRequest[] = [];
  searchCalls: SearchProjectRequest[] = [];
  scriptSnapshot: ScriptSnapshot = {
    path: "res://diagnostic_scene.gd",
    revision: "script-revision-1",
    content: "extends Node2D\n\nfunc _ready() -> void:\n    pass\n",
  };
  resourceSnapshot: ResourceSnapshot = {
    path: "res://resources/theme.tres",
    revision: "resource-revision-1",
    content: "[ext_resource path=\"res://old_theme.tres\"]\n",
  };
  inputActionSnapshot: InputActionSnapshot = {
    actionName: "jump",
    revision: "input-revision-1",
    exists: false,
    deadzone: null,
    events: [],
  };
  sceneSignalsSnapshot: {
    path: string;
    revision: string;
    nodes: Array<{
      nodePath: string;
      signals: string[];
      methods: string[];
      connections: Array<{ signalName: string; targetPath: string; methodName: string }>;
    }>;
  } = { path: "res://main.tscn", revision: "revision-1", nodes: [] };
  inputActionBeforeApplySnapshot: InputActionSnapshot | null = null;
  runCalls = 0;
  runDiagnosticsResult: RunDiagnostics = {
    schemaVersion: "0.2",
    runId: "run-1",
    status: "stopped",
    scenePath: "res://main.tscn",
    output: ["scene started", "scene stopped"],
    warnings: [],
    errors: [],
  };

  async getContext(): Promise<EditorContext> {
    return this.context;
  }

  async applyChange(_projectRoot: string, request: ApplyChangeRequest): Promise<ChangeReport> {
    this.applied.push(request);
    this.context = createContext("revision-2");
    const inputOperation = request.operations[0];
    const isInputAction =
      inputOperation?.kind === "project.input_action.add_key" ||
      inputOperation?.kind === "project.input_action.remove_key" ||
      inputOperation?.kind === "project.input_action.replace_key";
    if (isInputAction && inputOperation !== undefined) {
      this.inputActionBeforeApplySnapshot = structuredClone(this.inputActionSnapshot);
      let events = [...this.inputActionSnapshot.events];
      if (inputOperation.kind === "project.input_action.add_key") {
        events.push({ type: "InputEventKey", physicalKeycode: inputOperation.physicalKeycode, keycode: 0 });
      } else if (inputOperation.kind === "project.input_action.remove_key") {
        events = events.filter((event) => event.physicalKeycode !== inputOperation.physicalKeycode);
      } else {
        events = events.map((event) =>
          event.physicalKeycode === inputOperation.fromPhysicalKeycode
            ? { ...event, physicalKeycode: inputOperation.toPhysicalKeycode }
            : event,
        );
      }
      this.inputActionSnapshot = {
        ...this.inputActionSnapshot,
        revision: "input-revision-2",
        events,
        ...(inputOperation.kind === "project.input_action.add_key"
          ? { exists: true, deadzone: inputOperation.deadzone ?? this.inputActionSnapshot.deadzone ?? 0.2 }
          : {}),
      };
    }
    return {
      schemaVersion: "0.2",
      planId: request.planId,
      status: "applied",
      revision: "revision-2",
      operationCount: request.operations.length,
      undoLabel: "Godot Safe Change: Add node",
      ...(isInputAction ? { fileRevision: "input-revision-2" } : {}),
    };
  }

  async runCurrentScene(): Promise<RunDiagnostics> {
    this.runCalls += 1;
    return this.runDiagnosticsResult;
  }

  sceneRunPaths: string[] = [];

  async runScene(_projectRoot: string, scenePath: string): Promise<RunDiagnostics> {
    this.sceneRunPaths.push(scenePath);
    return {
      ...this.runDiagnosticsResult,
      scenePath,
      output: ["custom scene requested: " + scenePath, ...this.runDiagnosticsResult.output],
    };
  }

  async rollbackChange(_projectRoot: string, request: RollbackRequest): Promise<RollbackReport> {
    this.rolledBack.push(request);
    this.context = createContext("revision-3");
    const isInputAction = request.expectedFileRevision === "input-revision-2";
    if (isInputAction && this.inputActionBeforeApplySnapshot !== null) {
      this.inputActionSnapshot = {
        ...this.inputActionBeforeApplySnapshot,
        revision: "input-revision-3",
      };
    }
    return {
      schemaVersion: "0.2",
      planId: request.planId,
      status: "rolled_back",
      revision: "revision-3",
      undoLabel: "Godot Safe Change: Add node",
      ...(isInputAction ? { fileRevision: "input-revision-3" } : {}),
    };
  }

  async searchProject(_projectRoot: string, request: SearchProjectRequest): Promise<SearchProjectReport> {
    this.searchCalls.push(request);
    return {
      schemaVersion: "0.3",
      projectRoot,
      query: request.query,
      revision: this.context.revision,
      results: [
        {
          kind: "node",
          path: "res://main.tscn",
          name: "SafeMarker",
          nodePath: ".",
          nodeType: "Node2D",
          matches: ["name"],
        },
      ],
    };
  }

  async readScript(_projectRoot: string, scriptPath: string): Promise<ScriptSnapshot> {
    return { ...this.scriptSnapshot, path: scriptPath };
  }

  async readResource(_projectRoot: string, resourcePath: string): Promise<ResourceSnapshot> {
    return { ...this.resourceSnapshot, path: resourcePath };
  }

  async readInputAction(_projectRoot: string, actionName: string): Promise<InputActionSnapshot> {
    return { ...this.inputActionSnapshot, actionName };
  }

  autoloadSnapshot: AutoloadSnapshot = {
    name: "Game",
    revision: "settings-revision-1",
    exists: false,
    scriptPath: null,
  };

  async readAutoload(_projectRoot: string, name: string): Promise<AutoloadSnapshot> {
    return { ...this.autoloadSnapshot, name };
  }

  async readSceneSignals() {
    return this.sceneSignalsSnapshot;
  }
}

describe("ChangeCoordinator", () => {
  test("previews duplicating a scene subtree with target path mapping", async () => {
    const bridge = new FakeGodotBridge();
    bridge.context = {
      ...bridge.context,
      currentScene: {
        ...bridge.context.currentScene,
        nodes: [
          ...bridge.context.currentScene.nodes,
          { path: "Source", name: "Source", type: "Node2D", properties: { position: { x: 4, y: 8 } } },
          { path: "Source/Title", name: "Title", type: "Label", properties: { text: "Copy me" } },
          { path: "Source/Title/Badge", name: "Badge", type: "Label", properties: { text: "Nested" } },
          { path: "Target", name: "Target", type: "Node2D", properties: { position: { x: 20, y: 10 } } },
        ],
      },
    };
    const coordinator = new ChangeCoordinator(bridge);
    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Duplicate the source subtree for a second panel.",
      operation: {
        kind: "scene.duplicate_node",
        nodePath: "Source",
        newParentPath: "Target",
        newName: "SourceCopy",
      },
    });

    assert.equal(plan.operations[0]?.kind, "scene.duplicate_node");
    assert.deepEqual(plan.diff[0], {
      kind: "scene.duplicate_node",
      target: "res://main.tscn:Target/SourceCopy",
      summary: "Duplicate Source under Target as SourceCopy in res://main.tscn",
      sourcePath: "Source",
      newParentPath: "Target",
      targetPath: "Target/SourceCopy",
      newName: "SourceCopy",
      keepGlobalTransform: true,
      duplicatedNodes: [
        { from: "Source", to: "Target/SourceCopy", name: "Source", type: "Node2D", properties: { position: { x: 4, y: 8 } } },
        { from: "Source/Title", to: "Target/SourceCopy/Title", name: "Title", type: "Label", properties: { text: "Copy me" } },
        { from: "Source/Title/Badge", to: "Target/SourceCopy/Title/Badge", name: "Badge", type: "Label", properties: { text: "Nested" } },
      ],
    });
    assert.equal(bridge.applied.length, 0);
  });

  test("rejects unsafe and colliding duplicate targets", async () => {
    const bridge = new FakeGodotBridge();
    bridge.context = {
      ...bridge.context,
      currentScene: {
        ...bridge.context.currentScene,
        nodes: [
          ...bridge.context.currentScene.nodes,
          { path: "Source", name: "Source", type: "Node2D", properties: {} },
          { path: "Source/Child", name: "Child", type: "Node2D", properties: {} },
          { path: "Target", name: "Target", type: "Node2D", properties: {} },
          { path: "Target/Existing", name: "Existing", type: "Node2D", properties: {} },
        ],
      },
    };
    const coordinator = new ChangeCoordinator(bridge);
    const preview = (nodePath: string, newParentPath: string, newName: string) =>
      coordinator.previewSceneChange({
        projectRoot,
        reason: "Exercise duplicate safety validation.",
        operation: { kind: "scene.duplicate_node", nodePath, newParentPath, newName },
      });

    await assert.rejects(
      () => preview(".", "Target", "RootCopy"),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.UNSAFE_OPERATION,
    );
    await assert.rejects(
      () => preview("Missing", "Target", "Copy"),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.VALIDATION_FAILED,
    );
    await assert.rejects(
      () => preview("Source", "Source/Child", "Copy"),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.UNSAFE_OPERATION,
    );
    await assert.rejects(
      () => preview("Source", "Target", "Existing"),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.VALIDATION_FAILED,
    );
    await assert.rejects(() => preview("Source", "Target", "bad/name"));
    assert.equal(bridge.applied.length, 0);
  });

  test("previews a scene node rename with descendant NodePath changes", async () => {
    const bridge = new FakeGodotBridge();
    bridge.context = {
      ...bridge.context,
      currentScene: {
        ...bridge.context.currentScene,
        nodes: [
          ...bridge.context.currentScene.nodes,
          { path: "Canvas", name: "Canvas", type: "Control", properties: { visible: true } },
          { path: "Canvas/Title", name: "Title", type: "Label", properties: { text: "Fixture" } },
          { path: "Canvas/Title/Badge", name: "Badge", type: "Label", properties: { text: "New" } },
          { path: "Scriptless", name: "Scriptless", type: "Node2D", properties: {} },
        ],
      },
    };
    const coordinator = new ChangeCoordinator(bridge);
    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Give the canvas a stable descriptive name.",
      operation: { kind: "scene.rename_node", nodePath: "Canvas", newName: "HUD" } as never,
    });

    assert.equal(plan.operations[0]?.kind, "scene.rename_node");
    assert.deepEqual(plan.diff[0], {
      kind: "scene.rename_node",
      target: "res://main.tscn:Canvas",
      summary: "Rename Canvas to HUD in res://main.tscn",
      nodePath: "Canvas",
      newNodePath: "HUD",
      previousName: "Canvas",
      newName: "HUD",
      affectedPaths: [
        { from: "Canvas", to: "HUD" },
        { from: "Canvas/Title", to: "HUD/Title" },
        { from: "Canvas/Title/Badge", to: "HUD/Title/Badge" },
      ],
    });
    assert.equal(bridge.applied.length, 0);
  });

  test("rejects root, missing, unchanged and colliding scene rename targets", async () => {
    const bridge = new FakeGodotBridge();
    bridge.context = {
      ...bridge.context,
      currentScene: {
        ...bridge.context.currentScene,
        nodes: [
          ...bridge.context.currentScene.nodes,
          { path: "Canvas", name: "Canvas", type: "Control", properties: {} },
          { path: "Scriptless", name: "Scriptless", type: "Node2D", properties: {} },
        ],
      },
    };
    const coordinator = new ChangeCoordinator(bridge);
    const preview = (nodePath: string, newName: string) =>
      coordinator.previewSceneChange({
        projectRoot,
        reason: "Exercise rename safety validation.",
        operation: { kind: "scene.rename_node", nodePath, newName } as never,
      });

    await assert.rejects(
      () => preview(".", "RenamedRoot"),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.UNSAFE_OPERATION,
    );
    await assert.rejects(
      () => preview("Missing", "Renamed"),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.VALIDATION_FAILED,
    );
    await assert.rejects(
      () => preview("Canvas", "Canvas"),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.OPERATION_REJECTED,
    );
    await assert.rejects(
      () => preview("Canvas", "Scriptless"),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.VALIDATION_FAILED,
    );
    await assert.rejects(() => preview("Canvas", "bad/name"));
    assert.equal(bridge.applied.length, 0);
  });

  test("accepts the bounded scene.reparent_node contract and defaults transform preservation on", () => {
    const parsed = changeOperationSchema.parse({
      kind: "scene.reparent_node",
      nodePath: "Source/Movable",
      newParentPath: "Target",
    });

    assert.deepEqual(parsed, {
      kind: "scene.reparent_node",
      nodePath: "Source/Movable",
      newParentPath: "Target",
      keepGlobalTransform: true,
    });
    assert.deepEqual(
      changeOperationSchema.parse({
        kind: "scene.reparent_node",
        nodePath: "Source/Movable",
        newParentPath: "Target",
        keepGlobalTransform: false,
      }),
      {
        kind: "scene.reparent_node",
        nodePath: "Source/Movable",
        newParentPath: "Target",
        keepGlobalTransform: false,
      },
    );
  });

  test("previews reparent paths, child indexes and transform policy without applying", async () => {
    const bridge = new FakeGodotBridge();
    bridge.context = {
      ...bridge.context,
      currentScene: {
        ...bridge.context.currentScene,
        nodes: [
          ...bridge.context.currentScene.nodes,
          { path: "Source", name: "Source", type: "Node2D", properties: { position: { x: 0, y: 0 } } },
          { path: "Source/Spacer", name: "Spacer", type: "Node2D", properties: { position: { x: 1, y: 1 } } },
          { path: "Source/Movable", name: "Movable", type: "Node2D", properties: { position: { x: 12, y: 8 } } },
          { path: "Source/Movable/Grandchild", name: "Grandchild", type: "Label", properties: { text: "Keep me" } },
          { path: "Target", name: "Target", type: "Node2D", properties: { position: { x: 4, y: 5 } } },
          { path: "Target/Existing", name: "Existing", type: "Node2D", properties: { position: { x: 0, y: 0 } } },
        ],
      },
    };
    const coordinator = new ChangeCoordinator(bridge);
    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Move the node into the target branch.",
      operation: {
        kind: "scene.reparent_node",
        nodePath: "Source/Movable",
        newParentPath: "Target",
      },
    });

    assert.equal(plan.operations[0]?.kind, "scene.reparent_node");
    assert.deepEqual(plan.operations[0], {
      kind: "scene.reparent_node",
      nodePath: "Source/Movable",
      newParentPath: "Target",
      keepGlobalTransform: true,
    });
    assert.deepEqual(plan.diff[0], {
      kind: "scene.reparent_node",
      target: "res://main.tscn:Source/Movable",
      summary: "Move Source/Movable under Target in res://main.tscn",
      fromNodePath: "Source/Movable",
      toNodePath: "Target/Movable",
      fromParentPath: "Source",
      fromIndex: 1,
      toParentPath: "Target",
      toIndex: 1,
      keepGlobalTransform: true,
    });
    assert.equal(bridge.applied.length, 0);
  });

  test("rejects root, missing, cyclic, same-parent and colliding reparent targets", async () => {
    const bridge = new FakeGodotBridge();
    bridge.context = {
      ...bridge.context,
      currentScene: {
        ...bridge.context.currentScene,
        nodes: [
          ...bridge.context.currentScene.nodes,
          { path: "Source", name: "Source", type: "Node2D", properties: {} },
          { path: "Source/Movable", name: "Movable", type: "Node2D", properties: {} },
          { path: "Source/Movable/Child", name: "Child", type: "Node2D", properties: {} },
          { path: "Target", name: "Target", type: "Node2D", properties: {} },
          { path: "Target/Movable", name: "Movable", type: "Node2D", properties: {} },
        ],
      },
    };
    const coordinator = new ChangeCoordinator(bridge);
    const preview = (nodePath: string, newParentPath: string) =>
      coordinator.previewSceneChange({
        projectRoot,
        reason: "Exercise reparent path validation.",
        operation: { kind: "scene.reparent_node", nodePath, newParentPath },
      });

    await assert.rejects(
      () => preview(".", "Target"),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.UNSAFE_OPERATION,
    );
    await assert.rejects(
      () => preview("Source/Missing", "Target"),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.VALIDATION_FAILED,
    );
    await assert.rejects(
      () => preview("Source/Movable", "Source/Movable/Child"),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.UNSAFE_OPERATION,
    );
    await assert.rejects(
      () => preview("Source/Movable", "Source"),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.OPERATION_REJECTED,
    );
    await assert.rejects(
      () => preview("Source/Movable", "Target"),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.VALIDATION_FAILED,
    );
    assert.equal(bridge.applied.length, 0);
  });

  test("previews a node creation without applying it", async () => {
    const bridge = new FakeGodotBridge();
    const coordinator = new ChangeCoordinator(bridge);

    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Add a marker node for the first vertical-link check.",
      operation: {
        kind: "scene.create_node",
        parentPath: ".",
        nodeName: "SafeMarker",
        nodeType: "Node2D",
      },
    });

    assert.equal(plan.mode, "preview");
    assert.equal(plan.expectedRevision, "revision-1");
    assert.equal(plan.operations[0]?.kind, "scene.create_node");
    assert.match(plan.diff[0]?.summary ?? "", /SafeMarker/);
    assert.equal(bridge.applied.length, 0);
  });

  test("previews deleting a bounded scene subtree and rejects unsafe targets", async () => {
    const bridge = new FakeGodotBridge();
    bridge.context = {
      ...bridge.context,
      currentScene: {
        ...bridge.context.currentScene,
        nodes: [
          ...bridge.context.currentScene.nodes,
          {
            path: "Canvas",
            name: "Canvas",
            type: "Control",
            properties: { visible: true, size: { x: 320, y: 180 } },
          },
          {
            path: "Canvas/Title",
            name: "Title",
            type: "Label",
            properties: { visible: true, text: "Fixture label" },
          },
          {
            path: "CanvasOther",
            name: "CanvasOther",
            type: "Node2D",
            properties: { visible: true, position: { x: 0, y: 0 } },
          },
        ],
      },
    };
    const coordinator = new ChangeCoordinator(bridge);

    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Remove the obsolete canvas subtree.",
      operation: { kind: "scene.delete_node", nodePath: "Canvas" },
    });

    assert.equal(plan.operations[0]?.kind, "scene.delete_node");
    const diff = plan.diff[0] as {
      kind: string;
      nodePath: string;
      deletedNodes: Array<{ path: string; name: string; type: string }>;
    };
    assert.equal(diff.kind, "scene.delete_node");
    assert.equal(diff.nodePath, "Canvas");
    assert.deepEqual(diff.deletedNodes.map((node) => node.path), ["Canvas", "Canvas/Title"]);
    assert.match(plan.diff[0]?.summary ?? "", /Canvas/);
    assert.equal(bridge.applied.length, 0);
    await coordinator.confirmChange({ projectRoot, planId: plan.planId, expectedRevision: plan.expectedRevision });
    const applied = await coordinator.applyChange({ projectRoot, planId: plan.planId });
    assert.equal(applied.status, "applied");
    assert.equal(bridge.applied[0]?.operations[0]?.kind, "scene.delete_node");
    const rolledBack = await coordinator.rollbackChange({ projectRoot, planId: plan.planId });
    assert.equal(rolledBack.status, "rolled_back");

    await assert.rejects(
      () =>
        coordinator.previewSceneChange({
          projectRoot,
          reason: "Do not remove the scene root.",
          operation: { kind: "scene.delete_node", nodePath: "." },
        }),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.UNSAFE_OPERATION,
    );
    await assert.rejects(
      () =>
        coordinator.previewSceneChange({
          projectRoot,
          reason: "Reject a missing node.",
          operation: { kind: "scene.delete_node", nodePath: "Canvas/Missing" },
        }),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.VALIDATION_FAILED,
    );
    await assert.rejects(() =>
      coordinator.previewSceneChange({
        projectRoot,
        reason: "Reject traversal.",
        operation: { kind: "scene.delete_node", nodePath: "../Canvas" },
      }),
    );
  });

  test("previews a bounded scene property change", async () => {
    const bridge = new FakeGodotBridge();
    const coordinator = new ChangeCoordinator(bridge);

    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Move the current scene root.",
      operation: {
        kind: "scene.set_property",
        nodePath: ".",
        property: "position",
        value: { x: 32, y: 16 },
      },
    });

    assert.equal(plan.operations[0]?.kind, "scene.set_property");
    assert.equal(plan.diff[0]?.kind, "scene.set_property");
    assert.match(plan.diff[0]?.summary ?? "", /position/);
    assert.equal(bridge.applied.length, 0);
  });

  test("previews a bounded Node2D rotation change", async () => {
    const bridge = new FakeGodotBridge();
    bridge.context = {
      ...bridge.context,
      currentScene: {
        ...bridge.context.currentScene,
        nodes: [
          {
            path: ".",
            name: "Main",
            type: "Node2D",
            properties: { visible: true, position: { x: 0, y: 0 }, rotation_degrees: 10 },
          },
        ],
      },
    };
    const coordinator = new ChangeCoordinator(bridge);

    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Rotate the scene root.",
      operation: {
        kind: "scene.set_property",
        nodePath: ".",
        property: "rotation_degrees",
        value: 45,
      } as never,
    });

    assert.deepEqual(plan.diff[0], {
      kind: "scene.set_property",
      target: "res://main.tscn:.:rotation_degrees",
      summary: "Set rotation_degrees on . in res://main.tscn",
      property: "rotation_degrees",
      before: 10,
      after: 45,
    });
    assert.equal(bridge.applied.length, 0);
  });

  test("previews a bounded Node2D scale change", async () => {
    const bridge = new FakeGodotBridge();
    bridge.context = {
      ...bridge.context,
      currentScene: {
        ...bridge.context.currentScene,
        nodes: [
          {
            path: ".",
            name: "Main",
            type: "Node2D",
            properties: { visible: true, position: { x: 0, y: 0 }, scale: { x: 1, y: 1 } },
          },
        ],
      },
    };
    const coordinator = new ChangeCoordinator(bridge);

    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Resize the scene root uniformly.",
      operation: {
        kind: "scene.set_property",
        nodePath: ".",
        property: "scale",
        value: { x: 1.25, y: 0.8 },
      } as never,
    });

    const diff = plan.diff[0];
    assert.equal(diff?.kind, "scene.set_property");
    const scaleDiff = diff as unknown as { property: string; before: unknown; after: unknown };
    assert.equal(scaleDiff.property, "scale");
    assert.deepEqual(scaleDiff.before, { x: 1, y: 1 });
    assert.deepEqual(scaleDiff.after, { x: 1.25, y: 0.8 });
    assert.equal(bridge.applied.length, 0);
  });

  test("previews a validated scene signal connection without applying it", async () => {
    const bridge = new FakeGodotBridge();
    bridge.context = {
      ...bridge.context,
      currentScene: {
        ...bridge.context.currentScene,
        nodes: [
          { path: ".", name: "Main", type: "Node2D", properties: {} },
          { path: "Canvas/Title", name: "Title", type: "Label", properties: {} },
        ],
      },
    };
    bridge.sceneSignalsSnapshot = {
      path: "res://main.tscn",
      revision: "revision-1",
      nodes: [
        {
          nodePath: "Canvas/Title",
          signals: ["visibility_changed"],
          methods: ["show", "hide"],
          connections: [{ signalName: "visibility_changed", targetPath: "Canvas/Other", methodName: "@generated" }],
        },
        {
          nodePath: ".",
          signals: ["tree_entered"],
          methods: ["_ready", "on_title_visibility_changed"],
          connections: [],
        },
      ],
    };
    const coordinator = new ChangeCoordinator(bridge);

    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Connect the title visibility signal to the scene handler.",
      operation: {
        kind: "scene.connect_signal",
        sourcePath: "Canvas/Title",
        signalName: "visibility_changed",
        targetPath: ".",
        methodName: "on_title_visibility_changed",
      } as never,
    });

    assert.equal(plan.operations[0]?.kind, "scene.connect_signal");
    assert.deepEqual(plan.diff[0], {
      kind: "scene.connect_signal",
      target: "res://main.tscn:Canvas/Title.visibility_changed -> .on_title_visibility_changed",
      summary: "Connect Canvas/Title.visibility_changed to .on_title_visibility_changed in res://main.tscn",
      sourcePath: "Canvas/Title",
      signalName: "visibility_changed",
      targetPath: ".",
      methodName: "on_title_visibility_changed",
    });
    assert.equal(bridge.applied.length, 0);
    const confirmation = await coordinator.confirmChange({
      projectRoot,
      planId: plan.planId,
      expectedRevision: plan.expectedRevision,
    });
    assert.equal(confirmation.status, "confirmed");
    const applied = await coordinator.applyChange({ projectRoot, planId: plan.planId });
    assert.equal(applied.status, "applied");
    assert.equal(bridge.applied[0]?.operations[0]?.kind, "scene.connect_signal");
    const rolledBack = await coordinator.rollbackChange({ projectRoot, planId: plan.planId });
    assert.equal(rolledBack.status, "rolled_back");
    bridge.context = {
      ...bridge.context,
      currentScene: {
        ...bridge.context.currentScene,
        nodes: [
          { path: ".", name: "Main", type: "Node2D", properties: {} },
          { path: "Canvas/Title", name: "Title", type: "Label", properties: {} },
        ],
      },
    };
    bridge.sceneSignalsSnapshot.nodes[0].connections = [{
      signalName: "visibility_changed",
      targetPath: ".",
      methodName: "on_title_visibility_changed",
    }];
    bridge.sceneSignalsSnapshot.revision = "revision-3";
    await assert.rejects(
      () => coordinator.previewSceneChange({
        projectRoot,
        reason: "Reject a duplicate signal connection.",
        operation: {
          kind: "scene.connect_signal",
          sourcePath: "Canvas/Title",
          signalName: "visibility_changed",
          targetPath: ".",
          methodName: "on_title_visibility_changed",
        } as never,
      }),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.OPERATION_REJECTED,
    );

    const preview = (sourcePath: string, signalName: string, targetPath: string, methodName: string) =>
      coordinator.previewSceneChange({
        projectRoot,
        reason: "Exercise signal connection validation.",
        operation: { kind: "scene.connect_signal", sourcePath, signalName, targetPath, methodName } as never,
      });
    await assert.rejects(
      () => preview("Canvas/Missing", "visibility_changed", ".", "on_title_visibility_changed"),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.VALIDATION_FAILED,
    );
    await assert.rejects(
      () => preview("Canvas/Title", "missing_signal", ".", "on_title_visibility_changed"),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.VALIDATION_FAILED,
    );
    await assert.rejects(
      () => preview("Canvas/Title", "visibility_changed", ".", "missing_method"),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.VALIDATION_FAILED,
    );
  });

  test("previews, applies and rolls back one exact scene signal disconnect", async () => {
    const bridge = new FakeGodotBridge();
    bridge.context = {
      ...bridge.context,
      currentScene: {
        ...bridge.context.currentScene,
        nodes: [
          { path: ".", name: "Main", type: "Node2D", properties: {} },
          { path: "Canvas/Title", name: "Title", type: "Label", properties: {} },
          { path: "Canvas/Other", name: "Other", type: "Node", properties: {} },
        ],
      },
    };
    bridge.sceneSignalsSnapshot = {
      path: "res://main.tscn",
      revision: "revision-1",
      nodes: [
        {
          nodePath: "Canvas/Title",
          signals: ["visibility_changed"],
          methods: ["show", "hide"],
          connections: [
            { signalName: "visibility_changed", targetPath: ".", methodName: "on_title_visibility_changed" },
            { signalName: "visibility_changed", targetPath: "Canvas/Other", methodName: "on_other_visibility_changed" },
          ],
        },
        {
          nodePath: ".",
          signals: ["tree_entered"],
          methods: ["_ready", "on_title_visibility_changed"],
          connections: [],
        },
        {
          nodePath: "Canvas/Other",
          signals: [],
          methods: ["on_other_visibility_changed"],
          connections: [],
        },
      ],
    };
    const coordinator = new ChangeCoordinator(bridge);

    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Disconnect only the title visibility handler.",
      operation: {
        kind: "scene.disconnect_signal",
        sourcePath: "Canvas/Title",
        signalName: "visibility_changed",
        targetPath: ".",
        methodName: "on_title_visibility_changed",
      } as never,
    });

    assert.equal(plan.operations[0]?.kind, "scene.disconnect_signal");
    assert.deepEqual(plan.diff[0], {
      kind: "scene.disconnect_signal",
      target: "res://main.tscn:Canvas/Title.visibility_changed -> .on_title_visibility_changed",
      summary: "Disconnect Canvas/Title.visibility_changed from .on_title_visibility_changed in res://main.tscn",
      sourcePath: "Canvas/Title",
      signalName: "visibility_changed",
      targetPath: ".",
      methodName: "on_title_visibility_changed",
    });
    const confirmation = await coordinator.confirmChange({
      projectRoot,
      planId: plan.planId,
      expectedRevision: plan.expectedRevision,
    });
    assert.equal(confirmation.status, "confirmed");
    const applied = await coordinator.applyChange({ projectRoot, planId: plan.planId });
    assert.equal(applied.status, "applied");
    assert.equal(bridge.applied[0]?.operations[0]?.kind, "scene.disconnect_signal");
    const rolledBack = await coordinator.rollbackChange({ projectRoot, planId: plan.planId });
    assert.equal(rolledBack.status, "rolled_back");
  });

  test("rejects disconnecting a signal connection that is not an exact match", async () => {
    const bridge = new FakeGodotBridge();
    bridge.context = {
      ...bridge.context,
      currentScene: {
        ...bridge.context.currentScene,
        nodes: [
          { path: ".", name: "Main", type: "Node2D", properties: {} },
          { path: "Canvas/Title", name: "Title", type: "Label", properties: {} },
        ],
      },
    };
    bridge.sceneSignalsSnapshot = {
      path: "res://main.tscn",
      revision: "revision-1",
      nodes: [
        {
          nodePath: "Canvas/Title",
          signals: ["visibility_changed"],
          methods: ["show"],
          connections: [{ signalName: "visibility_changed", targetPath: ".", methodName: "other_handler" }],
        },
        {
          nodePath: ".",
          signals: ["tree_entered"],
          methods: ["_ready", "on_title_visibility_changed"],
          connections: [],
        },
      ],
    };
    const coordinator = new ChangeCoordinator(bridge);

    await assert.rejects(
      () => coordinator.previewSceneChange({
        projectRoot,
        reason: "Reject an absent exact signal connection.",
        operation: {
          kind: "scene.disconnect_signal",
          sourcePath: "Canvas/Title",
          signalName: "visibility_changed",
          targetPath: ".",
          methodName: "on_title_visibility_changed",
        } as never,
      }),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.OPERATION_REJECTED,
    );
  });

  test("previews, applies and rolls back one bounded scene group addition", async () => {
    const bridge = new FakeGodotBridge();
    bridge.context = {
      ...bridge.context,
      currentScene: {
        ...bridge.context.currentScene,
        nodes: [
          { path: ".", name: "Main", type: "Node2D", properties: {} },
          { path: "Player", name: "Player", type: "Node2D", properties: {}, groups: ["player"] },
        ],
      },
    };
    const coordinator = new ChangeCoordinator(bridge);

    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Tag the player node for gameplay lookups.",
      operation: { kind: "scene.add_group", nodePath: "Player", group: "hittable" } as never,
    });

    assert.equal(plan.operations[0]?.kind, "scene.add_group");
    assert.deepEqual(plan.diff[0], {
      kind: "scene.add_group",
      target: "res://main.tscn:Player:hittable",
      summary: "Add group hittable to Player in res://main.tscn",
      nodePath: "Player",
      group: "hittable",
    });
    const confirmation = await coordinator.confirmChange({
      projectRoot,
      planId: plan.planId,
      expectedRevision: plan.expectedRevision,
    });
    assert.equal(confirmation.status, "confirmed");
    const applied = await coordinator.applyChange({ projectRoot, planId: plan.planId });
    assert.equal(applied.status, "applied");
    assert.equal(bridge.applied[0]?.operations[0]?.kind, "scene.add_group");
    const rolledBack = await coordinator.rollbackChange({ projectRoot, planId: plan.planId });
    assert.equal(rolledBack.status, "rolled_back");
  });

  test("previews removing an existing scene group membership", async () => {
    const bridge = new FakeGodotBridge();
    bridge.context = {
      ...bridge.context,
      currentScene: {
        ...bridge.context.currentScene,
        nodes: [
          { path: ".", name: "Main", type: "Node2D", properties: {} },
          { path: "Player", name: "Player", type: "Node2D", properties: {}, groups: ["player", "hittable"] },
        ],
      },
    };
    const coordinator = new ChangeCoordinator(bridge);

    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Drop the temporary hittable tag.",
      operation: { kind: "scene.remove_group", nodePath: "Player", group: "hittable" } as never,
    });

    assert.equal(plan.operations[0]?.kind, "scene.remove_group");
    assert.deepEqual(plan.diff[0], {
      kind: "scene.remove_group",
      target: "res://main.tscn:Player:hittable",
      summary: "Remove group hittable from Player in res://main.tscn",
      nodePath: "Player",
      group: "hittable",
    });
    assert.equal(bridge.applied.length, 0);
  });

  test("rejects duplicate, absent and unsafe scene group operations", async () => {
    const bridge = new FakeGodotBridge();
    bridge.context = {
      ...bridge.context,
      currentScene: {
        ...bridge.context.currentScene,
        nodes: [
          { path: ".", name: "Main", type: "Node2D", properties: {} },
          { path: "Player", name: "Player", type: "Node2D", properties: {}, groups: ["player"] },
        ],
      },
    };
    const coordinator = new ChangeCoordinator(bridge);
    const preview = (operation: Record<string, unknown>) =>
      coordinator.previewSceneChange({
        projectRoot,
        reason: "Exercise group membership safety validation.",
        operation: operation as never,
      });

    await assert.rejects(
      () => preview({ kind: "scene.add_group", nodePath: "Player", group: "player" }),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.OPERATION_REJECTED,
    );
    await assert.rejects(
      () => preview({ kind: "scene.remove_group", nodePath: "Player", group: "hittable" }),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.OPERATION_REJECTED,
    );
    await assert.rejects(
      () => preview({ kind: "scene.add_group", nodePath: "Missing", group: "hittable" }),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.VALIDATION_FAILED,
    );
    await assert.rejects(() => preview({ kind: "scene.add_group", nodePath: "Player", group: "bad/group" }));
    await assert.rejects(() => preview({ kind: "scene.add_group", nodePath: "Player", group: "" }));
    assert.equal(bridge.applied.length, 0);
  });

  test("previews, applies and rolls back one bounded autoload registration", async () => {
    const bridge = new FakeGodotBridge();
    const coordinator = new ChangeCoordinator(bridge);

    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Register the game state singleton.",
      operation: { kind: "project.autoload.add", name: "Game", scriptPath: "res://diagnostic_scene.gd" } as never,
    });

    assert.equal(plan.operations[0]?.kind, "project.autoload.add");
    assert.deepEqual(plan.diff[0], {
      kind: "project.autoload.add",
      target: "project.godot:autoload/Game",
      summary: "Register res://diagnostic_scene.gd as autoload Game",
      name: "Game",
      scriptPath: "res://diagnostic_scene.gd",
    });
    assert.equal(plan.expectedFileRevision, "settings-revision-1");
    const confirmation = await coordinator.confirmChange({
      projectRoot,
      planId: plan.planId,
      expectedRevision: plan.expectedRevision,
    });
    assert.equal(confirmation.status, "confirmed");
    const applied = await coordinator.applyChange({ projectRoot, planId: plan.planId });
    assert.equal(applied.status, "applied");
    assert.equal(bridge.applied[0]?.operations[0]?.kind, "project.autoload.add");
    assert.equal(bridge.applied[0]?.expectedFileRevision, "settings-revision-1");
    const rolledBack = await coordinator.rollbackChange({ projectRoot, planId: plan.planId });
    assert.equal(rolledBack.status, "rolled_back");
  });

  test("previews removing an existing autoload registration", async () => {
    const bridge = new FakeGodotBridge();
    bridge.autoloadSnapshot = {
      name: "Game",
      revision: "settings-revision-1",
      exists: true,
      scriptPath: "res://game_state.gd",
    };
    const coordinator = new ChangeCoordinator(bridge);

    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Drop the unused game state singleton.",
      operation: { kind: "project.autoload.remove", name: "Game" } as never,
    });

    assert.equal(plan.operations[0]?.kind, "project.autoload.remove");
    assert.deepEqual(plan.diff[0], {
      kind: "project.autoload.remove",
      target: "project.godot:autoload/Game",
      summary: "Remove autoload Game (res://game_state.gd)",
      name: "Game",
      previousScriptPath: "res://game_state.gd",
    });
    assert.equal(bridge.applied.length, 0);
  });

  test("rejects duplicate, absent and unsafe autoload operations", async () => {
    const bridge = new FakeGodotBridge();
    bridge.autoloadSnapshot = {
      name: "Game",
      revision: "settings-revision-1",
      exists: true,
      scriptPath: "res://game_state.gd",
    };
    const coordinator = new ChangeCoordinator(bridge);
    const preview = (operation: Record<string, unknown>) =>
      coordinator.previewSceneChange({
        projectRoot,
        reason: "Exercise autoload safety validation.",
        operation: operation as never,
      });

    await assert.rejects(
      () => preview({ kind: "project.autoload.add", name: "Game", scriptPath: "res://diagnostic_scene.gd" }),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.VALIDATION_FAILED,
    );
    const absentBridge = new FakeGodotBridge();
    absentBridge.autoloadSnapshot = {
      name: "Missing",
      revision: "settings-revision-1",
      exists: false,
      scriptPath: null,
    };
    const absentCoordinator = new ChangeCoordinator(absentBridge);
    await assert.rejects(
      () =>
        absentCoordinator.previewSceneChange({
          projectRoot,
          reason: "Reject removing an autoload that does not exist.",
          operation: { kind: "project.autoload.remove", name: "Missing" } as never,
        }),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.VALIDATION_FAILED,
    );
    await assert.rejects(() =>
      preview({ kind: "project.autoload.add", name: "bad/name", scriptPath: "res://diagnostic_scene.gd" }));
    await assert.rejects(() =>
      preview({ kind: "project.autoload.add", name: "Game", scriptPath: "res://../outside.gd" }));
    assert.equal(bridge.applied.length, 0);
  });

  test("previews attaching an existing script without executing or editing it", async () => {
    const bridge = new FakeGodotBridge();
    const coordinator = new ChangeCoordinator(bridge);

    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Attach the existing diagnostic script.",
      operation: {
        kind: "scene.attach_script",
        nodePath: ".",
        scriptPath: "res://diagnostic_scene.gd",
      },
    });

    assert.equal(plan.operations[0]?.kind, "scene.attach_script");
    assert.equal(plan.diff[0]?.kind, "scene.attach_script");
    assert.match(plan.diff[0]?.summary ?? "", /diagnostic_scene.gd/);
    assert.equal(bridge.applied.length, 0);
  });

  test("previews detaching an existing project script and reports the previous script path", async () => {
    const bridge = new FakeGodotBridge();
    bridge.context = {
      ...bridge.context,
      currentScene: {
        ...bridge.context.currentScene,
        nodes: [
          ...bridge.context.currentScene.nodes,
          {
            path: "Scripted",
            name: "Scripted",
            type: "Node2D",
            properties: { scriptPath: "res://diagnostic_scene.gd" },
          },
        ],
      },
    };
    const coordinator = new ChangeCoordinator(bridge);

    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Detach the existing diagnostic script for a clean fixture state.",
      operation: { kind: "scene.detach_script", nodePath: "Scripted" } as never,
    });

    assert.equal(plan.operations[0]?.kind, "scene.detach_script");
    assert.deepEqual(plan.diff[0], {
      kind: "scene.detach_script",
      target: "res://main.tscn:Scripted:script",
      summary: "Detach res://diagnostic_scene.gd from Scripted in res://main.tscn",
      nodePath: "Scripted",
      scriptPath: "res://diagnostic_scene.gd",
    });
    assert.equal(bridge.applied.length, 0);
  });

  test("previews instantiating an existing scene with a source revision guard", async () => {
    const bridge = new FakeGodotBridge();
    bridge.resourceSnapshot = {
      path: "res://instance_source.tscn",
      revision: "scene-revision-1",
      content: "instance-source",
    };
    const coordinator = new ChangeCoordinator(bridge);

    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Insert the reusable fixture scene.",
      operation: {
        kind: "scene.instantiate_scene",
        parentPath: ".",
        scenePath: "res://instance_source.tscn",
        nodeName: "InstanceCopy",
      } as never,
    });

    assert.equal(plan.operations[0]?.kind, "scene.instantiate_scene");
    assert.equal(plan.expectedFileRevision, "scene-revision-1");
    assert.deepEqual(plan.diff[0], {
      kind: "scene.instantiate_scene",
      target: "res://main.tscn:InstanceCopy",
      summary: "Instantiate res://instance_source.tscn under . as InstanceCopy in res://main.tscn",
      parentPath: ".",
      scenePath: "res://instance_source.tscn",
      instancePath: "InstanceCopy",
      nodeName: "InstanceCopy",
    });
    assert.equal(bridge.applied.length, 0);
  });

  test("rejects unsafe, self-referential and colliding scene instances", async () => {
    const bridge = new FakeGodotBridge();
    bridge.resourceSnapshot = {
      path: "res://instance_source.tscn",
      revision: "scene-revision-1",
      content: "instance-source",
    };
    bridge.context = {
      ...bridge.context,
      currentScene: {
        ...bridge.context.currentScene,
        nodes: [
          ...bridge.context.currentScene.nodes,
          { path: "Existing", name: "Existing", type: "Node2D", properties: {} },
        ],
      },
    };
    const coordinator = new ChangeCoordinator(bridge);
    const preview = (parentPath: string, scenePath: string, nodeName: string) =>
      coordinator.previewSceneChange({
        projectRoot,
        reason: "Exercise scene instantiation safety validation.",
        operation: { kind: "scene.instantiate_scene", parentPath, scenePath, nodeName } as never,
      });

    await assert.rejects(
      () => preview("../", "res://instance_source.tscn", "Copy"),
    );
    await assert.rejects(
      () => preview(".", "res://main.tscn", "Recursive"),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.UNSAFE_OPERATION,
    );
    await assert.rejects(
      () => preview(".", "res://instance_source.tscn", "Existing"),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.VALIDATION_FAILED,
    );
    await assert.rejects(() => preview(".", "res://outside.res", "Copy"));
    assert.equal(bridge.applied.length, 0);
  });

  test("requires a separate confirmation before applying and uses UndoRedo through the bridge", async () => {
    const bridge = new FakeGodotBridge();
    const coordinator = new ChangeCoordinator(bridge);
    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Add a marker node.",
      operation: {
        kind: "scene.create_node",
        parentPath: ".",
        nodeName: "SafeMarker",
        nodeType: "Node2D",
      },
    });

    await assert.rejects(
      () => coordinator.applyChange({ planId: plan.planId, projectRoot }),
      (error: unknown) =>
        error instanceof DomainError && error.code === ERROR_CODES.CONFIRMATION_REQUIRED,
    );

    await coordinator.confirmChange({
      planId: plan.planId,
      projectRoot,
      expectedRevision: plan.expectedRevision,
    });
    const report = await coordinator.applyChange({ planId: plan.planId, projectRoot });

    assert.equal(report.status, "applied");
    assert.equal(bridge.applied.length, 1);
    assert.equal(bridge.applied[0]?.expectedRevision, "revision-1");
  });

  test("rejects a confirmed plan when the editor revision changed", async () => {
    const bridge = new FakeGodotBridge();
    const coordinator = new ChangeCoordinator(bridge);
    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Add a marker node.",
      operation: {
        kind: "scene.create_node",
        parentPath: ".",
        nodeName: "SafeMarker",
        nodeType: "Node2D",
      },
    });

    bridge.context = createContext("revision-changed-by-user");

    await assert.rejects(
      () =>
        coordinator.confirmChange({
          planId: plan.planId,
          projectRoot,
          expectedRevision: plan.expectedRevision,
        }),
      (error: unknown) =>
        error instanceof DomainError && error.code === ERROR_CODES.REVISION_CONFLICT,
    );
    assert.equal(bridge.applied.length, 0);
  });

  test("rejects another confirmed plan while an applied plan is still active", async () => {
    const bridge = new FakeGodotBridge();
    const coordinator = new ChangeCoordinator(bridge);
    const firstPlan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Apply the first marker.",
      operation: {
        kind: "scene.create_node",
        parentPath: ".",
        nodeName: "FirstMarker",
        nodeType: "Node2D",
      },
    });
    await coordinator.confirmChange({
      planId: firstPlan.planId,
      projectRoot,
      expectedRevision: firstPlan.expectedRevision,
    });
    await coordinator.applyChange({ planId: firstPlan.planId, projectRoot });

    const secondPlan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Prepare a second marker while the first is active.",
      operation: {
        kind: "scene.create_node",
        parentPath: ".",
        nodeName: "SecondMarker",
        nodeType: "Node2D",
      },
    });
    await coordinator.confirmChange({
      planId: secondPlan.planId,
      projectRoot,
      expectedRevision: secondPlan.expectedRevision,
    });

    await assert.rejects(
      () => coordinator.applyChange({ planId: secondPlan.planId, projectRoot }),
      (error: unknown) =>
        error instanceof DomainError && error.code === ERROR_CODES.PLAN_ALREADY_APPLIED,
    );
    assert.equal(bridge.applied.length, 1);

    await coordinator.rollbackChange({ planId: firstPlan.planId, projectRoot });
  });

  test("runs the current scene through the bridge and returns diagnostics", async () => {
    const bridge = new FakeGodotBridge();
    const coordinator = new ChangeCoordinator(bridge);

    const result = await coordinator.runCurrentScene({ projectRoot, timeoutMs: 1000 });

    assert.equal(result.status, "stopped");
    assert.deepEqual(result.errors, []);
    assert.equal(bridge.runCalls, 1);
  });

  test("runs a specific scene through the bridge and records the run operation", async () => {
    const bridge = new FakeGodotBridge();
    const coordinator = new ChangeCoordinator(bridge);

    const result = await coordinator.runScene({
      projectRoot,
      scenePath: "res://levels/main.tscn",
    });

    assert.equal(result.status, "stopped");
    assert.equal(result.scenePath, "res://levels/main.tscn");
    assert.deepEqual(bridge.sceneRunPaths, ["res://levels/main.tscn"]);

    const history = await coordinator.getOperationHistory({ projectRoot, limit: 5 });
    assert.equal(history.operations[0]?.kind, "run");
    assert.equal(history.operations[0]?.status, "succeeded");
  });

  test("rejects unsafe or non-scene run_scene inputs before the bridge", async () => {
    const bridge = new FakeGodotBridge();
    const coordinator = new ChangeCoordinator(bridge);

    await assert.rejects(() =>
      coordinator.runScene({ projectRoot, scenePath: "res://scripts/player.gd" }),
    );
    await assert.rejects(() =>
      coordinator.runScene({ projectRoot, scenePath: "res://../outside.tscn" }),
    );
    assert.deepEqual(bridge.sceneRunPaths, []);
  });

  test("rolls back only an applied plan at the applied revision", async () => {
    const bridge = new FakeGodotBridge();
    const coordinator = new ChangeCoordinator(bridge);
    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Add a marker node.",
      operation: {
        kind: "scene.create_node",
        parentPath: ".",
        nodeName: "SafeMarker",
        nodeType: "Node2D",
      },
    });

    await coordinator.confirmChange({
      planId: plan.planId,
      projectRoot,
      expectedRevision: plan.expectedRevision,
    });
    await coordinator.applyChange({ planId: plan.planId, projectRoot });
    const rollback = await coordinator.rollbackChange({ planId: plan.planId, projectRoot });

    assert.equal(rollback.status, "rolled_back");
    assert.equal(bridge.rolledBack.length, 1);
    assert.equal(bridge.rolledBack[0]?.expectedRevision, "revision-2");
  });

  test("rejects rollback after the editor revision changes", async () => {
    const bridge = new FakeGodotBridge();
    const coordinator = new ChangeCoordinator(bridge);
    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Add a marker node.",
      operation: {
        kind: "scene.create_node",
        parentPath: ".",
        nodeName: "SafeMarker",
        nodeType: "Node2D",
      },
    });

    await coordinator.confirmChange({
      planId: plan.planId,
      projectRoot,
      expectedRevision: plan.expectedRevision,
    });
    await coordinator.applyChange({ planId: plan.planId, projectRoot });
    bridge.context = createContext("revision-changed-by-user");

    await assert.rejects(
      () => coordinator.rollbackChange({ planId: plan.planId, projectRoot }),
      (error: unknown) =>
        error instanceof DomainError && error.code === ERROR_CODES.REVISION_CONFLICT,
    );
    assert.equal(bridge.rolledBack.length, 0);
  });

  test("records operation IDs and evidence for the full change lifecycle", async () => {
    const bridge = new FakeGodotBridge();
    const coordinator = new ChangeCoordinator(bridge);
    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Audit a marker node lifecycle.",
      operation: {
        kind: "scene.create_node",
        parentPath: ".",
        nodeName: "AuditMarker",
        nodeType: "Node2D",
      },
    });

    await coordinator.confirmChange({
      planId: plan.planId,
      projectRoot,
      expectedRevision: plan.expectedRevision,
    });
    await coordinator.applyChange({ planId: plan.planId, projectRoot });
    await coordinator.rollbackChange({ planId: plan.planId, projectRoot });
    await coordinator.runCurrentScene({ projectRoot, timeoutMs: 1000 });

    const history = await coordinator.getOperationHistory({ projectRoot, limit: 10 });
    assert.deepEqual(
      history.operations.map((operation) => operation.kind),
      ["run", "rollback", "apply", "confirm", "preview"],
    );
    assert.equal(new Set(history.operations.map((operation) => operation.operationId)).size, 5);
    assert.equal(
      (history.operations[1]?.output as { status?: string } | undefined)?.status,
      "rolled_back",
    );
    assert.equal(
      (history.operations[2]?.output as { status?: string } | undefined)?.status,
      "applied",
    );
  });

  test("associates diagnostics with the latest change and previews an explicit repair hint", async () => {
    const bridge = new FakeGodotBridge();
    const coordinator = new ChangeCoordinator(bridge);
    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Add a marker node before running the diagnostic fixture.",
      operation: {
        kind: "scene.create_node",
        parentPath: ".",
        nodeName: "DiagnosticMarker",
        nodeType: "Node2D",
      },
    });

    await coordinator.confirmChange({
      planId: plan.planId,
      projectRoot,
      expectedRevision: plan.expectedRevision,
    });
    await coordinator.applyChange({ planId: plan.planId, projectRoot });
    bridge.runDiagnosticsResult = {
      schemaVersion: "0.2",
      runId: "run-diagnostic",
      status: "stopped",
      scenePath: "res://main.tscn",
      output: [],
      warnings: [],
      errors: [
        {
          message: "The diagnostic marker is missing.",
          source: "res://diagnostic_scene.gd",
          line: 7,
          nodePath: ".",
          repairHint: {
            kind: "scene.create_node",
            parentPath: ".",
            nodeName: "RepairMarker",
            nodeType: "Node2D",
            reason: "Repair the missing diagnostic marker.",
          },
        },
      ],
    };

    const diagnostics = await coordinator.runCurrentScene({ projectRoot, timeoutMs: 1000 });
    assert.equal(diagnostics.errors[0]?.operationId !== undefined, true);
    assert.equal(diagnostics.errors[0]?.source, "res://diagnostic_scene.gd");
    assert.equal(diagnostics.errors[0]?.line, 7);

    const repairPlan = await coordinator.previewRepairFromDiagnostic({
      projectRoot,
      diagnostic: diagnostics.errors[0]!,
    });
    assert.equal(repairPlan.operations[0]?.kind, "scene.create_node");
    assert.equal(repairPlan.operations[0]?.nodeName, "RepairMarker");
  });

  test("previews a bounded script replacement without applying it", async () => {
    const bridge = new FakeGodotBridge();
    const coordinator = new ChangeCoordinator(bridge);

    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Update the fixture ready handler.",
      operation: {
        kind: "script.replace_range",
        scriptPath: "res://diagnostic_scene.gd",
        startLine: 1,
        endLine: 1,
        replacement: "extends Node2D\n",
      },
    });

    assert.equal(plan.expectedFileRevision, "script-revision-1");
    assert.equal(plan.operations[0]?.kind, "script.replace_range");
    assert.match(plan.diff[0]?.summary ?? "", /diagnostic_scene.gd/);
    assert.equal(bridge.applied.length, 0);
  });

  test("previews a bounded resource reference replacement without applying it", async () => {
    const bridge = new FakeGodotBridge();
    const coordinator = new ChangeCoordinator(bridge);

    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Preview a resource reference replacement.",
      operation: {
        kind: "resource.replace_reference",
        resourcePath: "res://resources/theme.tres",
        from: "res://old_theme.tres",
        to: "res://new_theme.tres",
      },
    });

    assert.equal(plan.expectedFileRevision, "resource-revision-1");
    assert.equal(plan.operations[0]?.kind, "resource.replace_reference");
    assert.equal(plan.diff[0]?.kind, "resource.replace_reference");
    assert.equal(bridge.applied.length, 0);
  });

  test("previews a bounded input action key addition", async () => {
    const bridge = new FakeGodotBridge();
    const coordinator = new ChangeCoordinator(bridge);

    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Preview a jump input action key.",
      operation: {
        kind: "project.input_action.add_key",
        actionName: "jump",
        physicalKeycode: 32,
        deadzone: 0.2,
      },
    });

    assert.equal(plan.operations[0]?.kind, "project.input_action.add_key");
    assert.equal(plan.diff[0]?.kind, "project.input_action.add_key");
    assert.match(plan.diff[0]?.summary ?? "", /jump/);
    assert.equal(plan.expectedFileRevision, "input-revision-1");
    assert.equal(bridge.applied.length, 0);
  });

  test("applies and rolls back an input action key with a file revision guard", async () => {
    const bridge = new FakeGodotBridge();
    const coordinator = new ChangeCoordinator(bridge);

    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Persist a jump input action key.",
      operation: {
        kind: "project.input_action.add_key",
        actionName: "jump",
        physicalKeycode: 32,
      },
    });
    await coordinator.confirmChange({
      projectRoot,
      planId: plan.planId,
      expectedRevision: plan.expectedRevision,
    });

    const applied = await coordinator.applyChange({ projectRoot, planId: plan.planId });
    assert.equal(applied.fileRevision, "input-revision-2");

    const rolledBack = await coordinator.rollbackChange({ projectRoot, planId: plan.planId });
    assert.equal(rolledBack.status, "rolled_back");
    assert.equal(bridge.rolledBack[0]?.expectedFileRevision, "input-revision-2");
  });

  test("previews, applies and rolls back removing one existing input action key", async () => {
    const bridge = new FakeGodotBridge();
    bridge.inputActionSnapshot = {
      actionName: "jump",
      revision: "input-revision-before-remove",
      exists: true,
      deadzone: 0.35,
      events: [{ type: "InputEventKey", physicalKeycode: 32, keycode: 0 }],
    };
    const coordinator = new ChangeCoordinator(bridge);
    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Remove the obsolete jump binding.",
      operation: {
        kind: "project.input_action.remove_key",
        actionName: "jump",
        physicalKeycode: 32,
      },
    });

    assert.equal(plan.expectedFileRevision, "input-revision-before-remove");
    assert.equal(plan.diff[0]?.kind, "project.input_action.remove_key");
    assert.match(plan.diff[0]?.summary ?? "", /Remove physical key 32/);
    await coordinator.confirmChange({ projectRoot, planId: plan.planId, expectedRevision: plan.expectedRevision });

    const applied = await coordinator.applyChange({ projectRoot, planId: plan.planId });
    assert.equal(applied.status, "applied");
    assert.deepEqual(bridge.inputActionSnapshot.events, []);
    assert.equal(bridge.inputActionSnapshot.exists, true);

    const rolledBack = await coordinator.rollbackChange({ projectRoot, planId: plan.planId });
    assert.equal(rolledBack.status, "rolled_back");
    assert.deepEqual(bridge.inputActionSnapshot.events, [
      { type: "InputEventKey", physicalKeycode: 32, keycode: 0 },
    ]);
    assert.equal(bridge.inputActionSnapshot.deadzone, 0.35);
  });

  test("rejects missing and ambiguous input action key removals", async () => {
    const bridge = new FakeGodotBridge();
    const coordinator = new ChangeCoordinator(bridge);
    const input = {
      projectRoot,
      reason: "Remove one explicitly selected physical key.",
      operation: {
        kind: "project.input_action.remove_key" as const,
        actionName: "jump",
        physicalKeycode: 32,
      },
    };

    await assert.rejects(
      () => coordinator.previewSceneChange(input),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.VALIDATION_FAILED,
    );

    bridge.inputActionSnapshot = {
      actionName: "jump",
      revision: "duplicate-input-revision",
      exists: true,
      deadzone: 0.2,
      events: [
        { type: "InputEventKey", physicalKeycode: 32, keycode: 0 },
        { type: "InputEventKey", physicalKeycode: 32, keycode: 0 },
      ],
    };
    await assert.rejects(
      () => coordinator.previewSceneChange(input),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.OPERATION_REJECTED,
    );
    assert.equal(bridge.applied.length, 0);
  });

  test("replaces one pure physical input key and restores the original action on rollback", async () => {
    const bridge = new FakeGodotBridge();
    bridge.inputActionSnapshot = {
      actionName: "jump",
      revision: "input-revision-before-replace",
      exists: true,
      deadzone: 0.45,
      events: [{ type: "InputEventKey", physicalKeycode: 74, keycode: 0 }],
    };
    const coordinator = new ChangeCoordinator(bridge);
    const plan = await coordinator.previewSceneChange({
      projectRoot,
      reason: "Replace the old jump key binding.",
      operation: {
        kind: "project.input_action.replace_key",
        actionName: "jump",
        fromPhysicalKeycode: 74,
        toPhysicalKeycode: 75,
      },
    });

    assert.equal(plan.expectedFileRevision, "input-revision-before-replace");
    assert.equal(plan.diff[0]?.kind, "project.input_action.replace_key");
    assert.match(plan.diff[0]?.summary ?? "", /74.*75/);
    await coordinator.confirmChange({ projectRoot, planId: plan.planId, expectedRevision: plan.expectedRevision });
    const applied = await coordinator.applyChange({ projectRoot, planId: plan.planId });
    assert.equal(applied.status, "applied");
    assert.deepEqual(bridge.inputActionSnapshot.events.map((event) => event.physicalKeycode), [75]);
    assert.equal(bridge.inputActionSnapshot.deadzone, 0.45);

    const rolledBack = await coordinator.rollbackChange({ projectRoot, planId: plan.planId });
    assert.equal(rolledBack.status, "rolled_back");
    assert.deepEqual(bridge.inputActionSnapshot.events, [
      { type: "InputEventKey", physicalKeycode: 74, keycode: 0 },
    ]);
    assert.equal(bridge.inputActionSnapshot.deadzone, 0.45);
  });
});

test("normalizes a symlinked project root before bridge requests", async () => {
  assert.equal(await normalizeProjectRoot("/tmp"), await realpath("/tmp"));
});

test("searches the project through the read-only search service", async () => {
  const bridge = new FakeGodotBridge();
  const service = new LocalProjectSearchService(bridge);

  const report = await service.search({
    projectRoot,
    query: "SafeMarker",
    kinds: ["node"],
    maxResults: 10,
  });

  assert.equal(report.results[0]?.nodePath, ".");
  assert.equal(bridge.searchCalls[0]?.query, "SafeMarker");
});

describe("HttpGodotBridge", () => {
  let server: ReturnType<typeof createServer>;
  let bridge: HttpGodotBridge;
  let runStatusCalls = 0;
  let activeRunScenePath = "res://main.tscn";
  let activeRunOutput: string[] = [];

  before(async () => {
    server = createServer(async (request, response) => {
      const bodyChunks: Buffer[] = [];
      for await (const chunk of request) bodyChunks.push(Buffer.from(chunk));
      const body = bodyChunks.length > 0 ? JSON.parse(Buffer.concat(bodyChunks).toString("utf8")) : null;
      response.setHeader("content-type", "application/json");

      if (request.url === "/v1/context" && request.method === "POST") {
        response.end(JSON.stringify({ ok: true, context: createContext() }));
        return;
      }

      if (request.url === "/v1/changes/apply" && request.method === "POST") {
        response.end(
          JSON.stringify({
            ok: true,
            report: {
              schemaVersion: "0.2",
              planId: body.planId,
              status: "applied",
              revision: "revision-2",
              operationCount: body.operations.length,
              undoLabel: "Godot Safe Change: Add node",
            },
          }),
        );
        return;
      }

      if (request.url === "/v1/changes/rollback" && request.method === "POST") {
        response.end(
          JSON.stringify({
            ok: true,
            report: {
              schemaVersion: "0.2",
              planId: body.planId,
              status: "rolled_back",
              revision: "revision-3",
              undoLabel: "Godot Safe Change: Add node",
            },
          }),
        );
        return;
      }

      if (request.url === "/v1/search" && request.method === "POST") {
        response.end(
          JSON.stringify({
            ok: true,
            report: {
              schemaVersion: "0.3",
              projectRoot,
              query: body.query,
              revision: "revision-1",
              results: [
                {
                  kind: "script",
                  path: "res://diagnostic_scene.gd",
                  name: "diagnostic_scene.gd",
                  nodePath: null,
                  nodeType: null,
                  matches: ["path"],
                },
              ],
            },
          }),
        );
        return;
      }

      if (request.url === "/v1/scripts/read" && request.method === "POST") {
        response.end(
          JSON.stringify({
            ok: true,
            snapshot: {
              path: body.scriptPath,
              revision: "script-revision-1",
              content: "extends Node2D\\n\\nfunc _ready() -> void:\\n    pass\\n",
            },
          }),
        );
        return;
      }

      if (request.url === "/v1/input-actions/read" && request.method === "POST") {
        response.end(
          JSON.stringify({
            ok: true,
            snapshot: {
              actionName: body.actionName,
              revision: "input-revision-1",
              exists: false,
              deadzone: null,
              events: [],
            },
          }),
        );
        return;
      }

      if (request.url === "/v1/run/current" && request.method === "POST") {
        activeRunScenePath = "res://main.tscn";
        activeRunOutput = ["scene requested"];
        response.end(
          JSON.stringify({
            ok: true,
            diagnostics: {
              schemaVersion: "0.2",
              runId: "run-http",
              status: "running",
              scenePath: activeRunScenePath,
              output: [...activeRunOutput],
              warnings: [],
              errors: [],
            },
          }),
        );
        return;
      }

      if (request.url === "/v1/run/scene" && request.method === "POST") {
        activeRunScenePath = body.scenePath;
        activeRunOutput = ["custom scene requested: " + body.scenePath];
        response.end(
          JSON.stringify({
            ok: true,
            diagnostics: {
              schemaVersion: "0.2",
              runId: "run-scene-http",
              status: "running",
              scenePath: activeRunScenePath,
              output: [...activeRunOutput],
              warnings: [],
              errors: [],
            },
          }),
        );
        return;
      }

      if (request.url === "/v1/run/status" && request.method === "POST") {
        runStatusCalls += 1;
        response.end(
          JSON.stringify({
            ok: true,
            diagnostics: {
              schemaVersion: "0.2",
              runId: body.runId ?? "run-http",
              status: "stopped",
              scenePath: activeRunScenePath,
              output: [...activeRunOutput, "scene stopped"],
              warnings: [],
              errors: [],
            },
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "Not found" } }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    bridge = new HttpGodotBridge("http://127.0.0.1:" + address.port);
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  test("uses the local bridge protocol for context and apply", async () => {
    const context = await bridge.getContext(projectRoot);
    assert.equal(context.currentScene.path, "res://main.tscn");

    const report = await bridge.applyChange(projectRoot, {
      planId: "plan-1",
      expectedRevision: "revision-1",
      operations: [
        {
          kind: "scene.create_node",
          parentPath: ".",
          nodeName: "SafeMarker",
          nodeType: "Node2D",
        },
      ],
    });

    assert.equal(report.status, "applied");
    assert.equal(report.operationCount, 1);

    const rollback = await bridge.rollbackChange(projectRoot, {
      planId: "plan-1",
      expectedRevision: "revision-2",
    });
    assert.equal(rollback.status, "rolled_back");

    const search = await bridge.searchProject(projectRoot, {
      query: "diagnostic",
      kinds: ["script"],
      maxResults: 10,
    });
    assert.equal(search.results[0]?.kind, "script");

    const snapshot = await bridge.readScript(projectRoot, "res://diagnostic_scene.gd");
    assert.equal(snapshot.revision, "script-revision-1");

    const inputSnapshot = await bridge.readInputAction(projectRoot, "jump");
    assert.equal(inputSnapshot.actionName, "jump");
    assert.equal(inputSnapshot.revision, "input-revision-1");
  });

  test("waits for the run status endpoint before returning diagnostics", async () => {
    const diagnostics = await bridge.runCurrentScene(projectRoot, 1000);

    assert.equal(diagnostics.status, "stopped");
    assert.deepEqual(diagnostics.output, ["scene requested", "scene stopped"]);
    assert.equal(runStatusCalls, 1);
  });

  test("runs a specific scene through the run/scene route and polls status", async () => {
    const diagnostics = await bridge.runScene(projectRoot, "res://levels/main.tscn", 1000);

    assert.equal(diagnostics.status, "stopped");
    assert.equal(diagnostics.scenePath, "res://levels/main.tscn");
    assert.deepEqual(diagnostics.output, [
      "custom scene requested: res://levels/main.tscn",
      "scene stopped",
    ]);
    assert.equal(runStatusCalls, 2);
  });
});

test("the Godot plugin exposes only the bounded vertical-link routes", async () => {
  const plugin = await readFile("godot-plugin/plugin.gd", "utf8");
  const bridgeServer = await readFile("godot-plugin/bridge_server.gd", "utf8");
  const source = plugin + "\n" + bridgeServer;

  assert.match(source, /TCPServer/);
  assert.match(source, /EditorInterface\.get_edited_scene_root/);
  assert.match(source, /get_undo_redo/);
  assert.match(source, /play_current_scene/);
  assert.match(source, /func _run_scene/);
  assert.match(source, /--audio-driver/);
  assert.match(source, /\/v1\/context/);
  assert.match(source, /\/v1\/changes\/apply/);
  assert.match(source, /\/v1\/changes\/rollback/);
  assert.match(source, /\/v1\/search/);
  assert.match(source, /\/v1\/scripts\/read/);
  assert.match(source, /\/v1\/input-actions\/read/);
  assert.match(source, /FileAccess\.READ/);
  assert.match(source, /\/v1\/run\/current/);
  assert.match(source, /\/v1\/run\/scene/);
  assert.match(source, /play_custom_scene/);
  assert.match(source, /\.undo\(\)/);
  assert.match(source, /properties/);
  assert.doesNotMatch(source, /execute_gdscript|OS\.execute/);
  assert.match(source, /_is_safe_script_path/);
  assert.match(source, /scene\.set_property/);
  assert.match(source, /\/v1\/signals\/read/);
  assert.match(source, /scene\.instantiate_scene/);
  assert.match(source, /PackedScene/);
  assert.match(source, /add_do_property/);
  assert.match(source, /scene\.attach_script/);
  assert.match(source, /scene\.detach_script/);
  assert.match(source, /Detach script/);
  assert.match(source, /project\.input_action\.remove_key/);
  assert.match(source, /_is_safe_scene_path/);
  assert.match(source, /scene\.add_group/);
  assert.match(source, /scene\.remove_group/);
  assert.match(source, /add_to_group/);
  assert.match(source, /remove_from_group/);
  assert.match(source, /"groups": group_names/);
  assert.match(source, /project\.autoload\.add/);
  assert.match(source, /\/v1\/autoloads\/read/);
  assert.match(source, /_is_safe_autoload_name/);
});
