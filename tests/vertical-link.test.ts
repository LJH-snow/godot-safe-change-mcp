import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import type { AddressInfo } from "node:net";
import { ChangeCoordinator } from "../src/application/change-coordinator.js";
import { DomainError, ERROR_CODES } from "../src/domain/errors.js";
import type {
  ApplyChangeRequest,
  ChangeReport,
  EditorContext,
  RollbackReport,
  RollbackRequest,
  RunDiagnostics,
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
    currentScene: { path: "res://main.tscn", rootName: "Main", rootType: "Node2D" },
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
  runCalls = 0;

  async getContext(): Promise<EditorContext> {
    return this.context;
  }

  async applyChange(_projectRoot: string, request: ApplyChangeRequest): Promise<ChangeReport> {
    this.applied.push(request);
    this.context = createContext("revision-2");
    return {
      schemaVersion: "0.2",
      planId: request.planId,
      status: "applied",
      revision: "revision-2",
      operationCount: request.operations.length,
      undoLabel: "Godot Safe Change: Add node",
    };
  }

  async runCurrentScene(): Promise<RunDiagnostics> {
    this.runCalls += 1;
    return {
      schemaVersion: "0.2",
      runId: "run-1",
      status: "stopped",
      scenePath: "res://main.tscn",
      output: ["scene started", "scene stopped"],
      warnings: [],
      errors: [],
    };
  }

  async rollbackChange(_projectRoot: string, request: RollbackRequest): Promise<RollbackReport> {
    this.rolledBack.push(request);
    this.context = createContext("revision-3");
    return {
      schemaVersion: "0.2",
      planId: request.planId,
      status: "rolled_back",
      revision: "revision-3",
      undoLabel: "Godot Safe Change: Add node",
    };
  }
}

describe("ChangeCoordinator", () => {
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

  test("runs the current scene through the bridge and returns diagnostics", async () => {
    const bridge = new FakeGodotBridge();
    const coordinator = new ChangeCoordinator(bridge);

    const result = await coordinator.runCurrentScene({ projectRoot, timeoutMs: 1000 });

    assert.equal(result.status, "stopped");
    assert.deepEqual(result.errors, []);
    assert.equal(bridge.runCalls, 1);
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
});

test("normalizes a symlinked project root before bridge requests", async () => {
  assert.equal(await normalizeProjectRoot("/tmp"), await realpath("/tmp"));
});

describe("HttpGodotBridge", () => {
  let server: ReturnType<typeof createServer>;
  let bridge: HttpGodotBridge;
  let runStatusCalls = 0;

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

      if (request.url === "/v1/run/current" && request.method === "POST") {
        response.end(
          JSON.stringify({
            ok: true,
            diagnostics: {
              schemaVersion: "0.2",
              runId: "run-http",
              status: "running",
              scenePath: "res://main.tscn",
              output: ["scene requested"],
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
              runId: "run-http",
              status: "stopped",
              scenePath: "res://main.tscn",
              output: ["scene requested", "scene stopped"],
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
  });

  test("waits for the run status endpoint before returning diagnostics", async () => {
    const diagnostics = await bridge.runCurrentScene(projectRoot, 1000);

    assert.equal(diagnostics.status, "stopped");
    assert.deepEqual(diagnostics.output, ["scene requested", "scene stopped"]);
    assert.equal(runStatusCalls, 1);
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
  assert.match(source, /\/v1\/context/);
  assert.match(source, /\/v1\/changes\/apply/);
  assert.match(source, /\/v1\/changes\/rollback/);
  assert.match(source, /\/v1\/run\/current/);
  assert.match(source, /\.undo\(\)/);
  assert.doesNotMatch(source, /execute_gdscript|OS\.execute|FileAccess/);
});
