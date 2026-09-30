import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ChangeCoordinator } from "../src/application/change-coordinator.js";
import { TaskCoordinator } from "../src/application/task-coordinator.js";
import { DomainError, ERROR_CODES } from "../src/domain/errors.js";
import type {
  ApplyChangeRequest,
  ChangeReport,
  EditorContext,
  InputActionSnapshot,
  RollbackReport,
  RollbackRequest,
  RunDiagnostics,
  ResourceSnapshot,
  ScriptSnapshot,
  SearchProjectReport,
  SearchProjectRequest,
} from "../src/domain/contracts.js";
import type { GodotBridge } from "../src/infrastructure/godot-bridge.js";
import { FileTaskStore } from "../src/infrastructure/task-store.js";
import { InMemoryProjectLeaseStore } from "../src/infrastructure/project-lease-store.js";
import { normalizeProjectRoot } from "../src/infrastructure/project-root.js";

function createContext(projectRoot: string, revision = "revision-1"): EditorContext {
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
      nodes: [],
    },
    selection: [],
    openResources: ["res://main.tscn"],
    run: { status: "stopped", scenePath: "res://main.tscn", runId: null },
    diagnostics: { output: [], warnings: [], errors: [] },
  };
}

class FakeGodotBridge implements GodotBridge {
  context: EditorContext;
  applied: ApplyChangeRequest[] = [];
  rolledBack: RollbackRequest[] = [];
  scriptSnapshot: ScriptSnapshot = {
    path: "res://diagnostic_scene.gd",
    revision: "script-revision-1",
    content: "extends Node2D\n\nfunc _ready() -> void:\n    pass\n",
  };
  applyError: Error | null = null;
  runDiagnosticsResult: RunDiagnostics = {
    schemaVersion: "0.2",
    runId: "run-1",
    status: "stopped",
    scenePath: "res://main.tscn",
    output: ["scene started", "scene stopped"],
    warnings: [],
    errors: [],
  };

  constructor(private readonly projectRoot: string) {
    this.context = createContext(projectRoot);
  }

  async getContext(): Promise<EditorContext> {
    return this.context;
  }

  async applyChange(_projectRoot: string, request: ApplyChangeRequest): Promise<ChangeReport> {
    if (this.applyError !== null) {
      const error = this.applyError;
      this.applyError = null;
      throw error;
    }
    this.applied.push(request);
    this.context = createContext(this.projectRoot, "revision-2");
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
    this.context = createContext(this.projectRoot, "revision-3");
    return {
      schemaVersion: "0.2",
      planId: request.planId,
      status: "rolled_back",
      revision: "revision-3",
      undoLabel: "Godot Safe Change: Add node",
    };
  }

  async readScript(_projectRoot: string, scriptPath: string): Promise<ScriptSnapshot> {
    return { ...this.scriptSnapshot, path: scriptPath };
  }

  async readResource(_projectRoot: string, resourcePath: string): Promise<ResourceSnapshot> {
    return { path: resourcePath, revision: "resource-test", content: "" };
  }

  async readInputAction(_projectRoot: string, actionName: string): Promise<InputActionSnapshot> {
    return { actionName, revision: "input-test", exists: false, deadzone: null, events: [] };
  }

  async searchProject(projectRoot: string, request: SearchProjectRequest): Promise<SearchProjectReport> {
    return {
      schemaVersion: "0.3",
      projectRoot,
      query: request.query,
      revision: this.context.revision,
      results: [],
    };
  }
}

interface Harness {
  projectRoot: string;
  bridge: FakeGodotBridge;
  changeCoordinator: ChangeCoordinator;
  taskCoordinator: TaskCoordinator;
}

async function createHarness(): Promise<Harness> {
  const projectRoot = await mkdtemp(join(tmpdir(), "godot-task-test-"));
  const bridge = new FakeGodotBridge(projectRoot);
  const leaseStore = new InMemoryProjectLeaseStore();
  const changeCoordinator = new ChangeCoordinator(bridge, undefined, leaseStore);
  const taskCoordinator = new TaskCoordinator(changeCoordinator, new FileTaskStore(), leaseStore);
  return { projectRoot, bridge, changeCoordinator, taskCoordinator };
}

describe("TaskCoordinator", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await rm(harness.projectRoot, { recursive: true, force: true });
  });

  test("runs a multi-step task through apply and run until completion", async () => {
    const { projectRoot, changeCoordinator, taskCoordinator, bridge } = harness;
    const plan = await changeCoordinator.previewSceneChange({
      projectRoot,
      reason: "Prepare a node before the task run.",
      operation: {
        kind: "scene.create_node",
        parentPath: ".",
        nodeName: "TaskMarker",
        nodeType: "Node2D",
      },
    });

    const task = await taskCoordinator.createTask({
      projectRoot,
      title: "Add marker and verify by running",
      steps: [
        {
          kind: "apply_plan",
          stepId: "apply-marker",
          planId: plan.planId,
          expectedRevision: plan.expectedRevision,
        },
        { kind: "run_current_scene", stepId: "run-verify" },
      ],
    });
    assert.equal(task.status, "active");
    assert.equal(task.nextStepId, "apply-marker");
    assert.equal(task.steps[0]?.status, "pending");

    const afterApply = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    assert.equal(afterApply.status, "active");
    assert.equal(afterApply.nextStepId, "run-verify");
    assert.equal(afterApply.steps[0]?.status, "succeeded");
    assert.ok(afterApply.steps[0]?.operationId);
    assert.ok(afterApply.timeline.some((event) => event.operationId === afterApply.steps[0]?.operationId));
    assert.equal(
      (afterApply.steps[0]?.result as { status?: string } | undefined)?.status,
      "applied",
    );

    const finished = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    assert.equal(finished.status, "completed");
    assert.equal(finished.nextStepId, null);
    assert.equal(finished.steps[1]?.status, "succeeded");
    assert.ok(finished.steps[1]?.operationId);
    assert.ok(finished.timeline.some((event) => event.operationId === finished.steps[1]?.operationId));
    assert.equal(
      (finished.steps[1]?.result as { status?: string } | undefined)?.status,
      "stopped",
    );
    assert.equal(bridge.applied.length, 1);
  });

  test("fails the task and recovers by retrying the failed step", async () => {
    const { projectRoot, changeCoordinator, taskCoordinator, bridge } = harness;
    const plan = await changeCoordinator.previewSceneChange({
      projectRoot,
      reason: "Prepare a node whose apply fails once.",
      operation: {
        kind: "scene.create_node",
        parentPath: ".",
        nodeName: "RetryMarker",
        nodeType: "Node2D",
      },
    });
    const task = await taskCoordinator.createTask({
      projectRoot,
      title: "Recover from a failed apply",
      steps: [
        {
          kind: "apply_plan",
          stepId: "apply-retry",
          planId: plan.planId,
          expectedRevision: plan.expectedRevision,
        },
      ],
    });

    bridge.applyError = new Error("bridge exploded");
    const appliedBefore = bridge.applied.length;
    const failed = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    assert.equal(failed.status, "failed");
    assert.equal(failed.nextStepId, "apply-retry");
    assert.equal(failed.steps[0]?.status, "failed");
    assert.equal(failed.steps[0]?.attempts, 1);
    assert.equal(failed.steps[0]?.error?.code, "INTERNAL_ERROR");

    const recovered = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.steps[0]?.status, "succeeded");
    assert.equal(recovered.steps[0]?.attempts, 2);
    assert.equal(bridge.applied.length, appliedBefore + 1);
  });

  test("pauses, resumes and cancels tasks with bounded transitions", async () => {
    const { projectRoot, taskCoordinator } = harness;
    const task = await taskCoordinator.createTask({
      projectRoot,
      title: "Pause and cancel a task",
      steps: [
        { kind: "run_current_scene", stepId: "run-first" },
        { kind: "run_current_scene", stepId: "run-second" },
      ],
    });

    await taskCoordinator.pauseTask({ projectRoot, taskId: task.taskId });
    await assert.rejects(
      () => taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId }),
      (error: unknown) =>
        error instanceof DomainError && error.code === ERROR_CODES.TASK_INVALID_STATUS,
    );

    const resumed = await taskCoordinator.resumeTask({ projectRoot, taskId: task.taskId });
    assert.equal(resumed.status, "active");

    const afterFirst = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    assert.equal(afterFirst.status, "active");
    assert.equal(afterFirst.nextStepId, "run-second");

    const cancelled = await taskCoordinator.cancelTask({ projectRoot, taskId: task.taskId });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.nextStepId, null);
    assert.equal(cancelled.steps[1]?.status, "cancelled");

    await assert.rejects(
      () => taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId }),
      (error: unknown) =>
        error instanceof DomainError && error.code === ERROR_CODES.TASK_INVALID_STATUS,
    );
  });

  test("restores a task from the project task directory after restart", async () => {
    const { projectRoot, changeCoordinator, bridge } = harness;
    const store = new FileTaskStore();
    const firstCoordinator = new TaskCoordinator(changeCoordinator, store);
    const plan = await changeCoordinator.previewSceneChange({
      projectRoot,
      reason: "Prepare a node for the restore check.",
      operation: {
        kind: "scene.create_node",
        parentPath: ".",
        nodeName: "RestoreMarker",
        nodeType: "Node2D",
      },
    });
    const task = await firstCoordinator.createTask({
      projectRoot,
      title: "Restore task state",
      steps: [
        {
          kind: "apply_plan",
          stepId: "apply-restore",
          planId: plan.planId,
          expectedRevision: plan.expectedRevision,
        },
        { kind: "run_current_scene", stepId: "run-restore" },
      ],
    });
    const appliedBefore = bridge.applied.length;
    await firstCoordinator.advanceTask({ projectRoot, taskId: task.taskId });

    const restoredCoordinator = new TaskCoordinator(changeCoordinator, store, changeCoordinator.getProjectLeaseStore());
    const restored = await restoredCoordinator.getTask({ projectRoot, taskId: task.taskId });
    assert.equal(restored.taskId, task.taskId);
    assert.equal(restored.status, "active");
    assert.equal(restored.steps[0]?.status, "succeeded");
    assert.equal(restored.nextStepId, "run-restore");

    const finished = await restoredCoordinator.advanceTask({
      projectRoot,
      taskId: task.taskId,
    });
    assert.equal(finished.status, "completed");
    assert.equal(bridge.applied.length, appliedBefore + 1);
  });

  test("executes a run_scene step for a specific scene", async () => {
    const { projectRoot, taskCoordinator, bridge } = harness;
    const task = await taskCoordinator.createTask({
      projectRoot,
      title: "Run one specific scene",
      steps: [{ kind: "run_scene", stepId: "run-main", scenePath: "res://levels/main.tscn" }],
    });

    const finished = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });

    assert.equal(finished.status, "completed");
    assert.equal(finished.steps[0]?.status, "succeeded");
    assert.deepEqual(bridge.sceneRunPaths, ["res://levels/main.tscn"]);
    assert.equal(
      (finished.steps[0]?.result as { scenePath?: string } | undefined)?.scenePath,
      "res://levels/main.tscn",
    );
  });

  test("rejects unknown tasks and stops retries after the attempt limit", async () => {
    const { projectRoot, changeCoordinator, taskCoordinator, bridge } = harness;
    await assert.rejects(
      () => taskCoordinator.getTask({ projectRoot, taskId: "task_unknown" }),
      (error: unknown) =>
        error instanceof DomainError && error.code === ERROR_CODES.TASK_NOT_FOUND,
    );

    const plan = await changeCoordinator.previewSceneChange({
      projectRoot,
      reason: "Prepare a node that keeps failing.",
      operation: {
        kind: "scene.create_node",
        parentPath: ".",
        nodeName: "LimitMarker",
        nodeType: "Node2D",
      },
    });
    const task = await taskCoordinator.createTask({
      projectRoot,
      title: "Stop retrying after the attempt limit",
      steps: [
        {
          kind: "apply_plan",
          stepId: "apply-limit",
          planId: plan.planId,
          expectedRevision: plan.expectedRevision,
        },
      ],
    });

    const persistentError = new Error("bridge keeps failing");
    let lastState = task;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      bridge.applyError = persistentError;
      lastState = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
      assert.equal(lastState.steps[0]?.attempts, attempt + 1);
    }
    assert.equal(lastState.status, "failed");
    assert.equal(lastState.steps[0]?.attempts, 3);

    bridge.applyError = persistentError;
    await assert.rejects(
      () => taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId }),
      (error: unknown) =>
        error instanceof DomainError && error.code === ERROR_CODES.OPERATION_REJECTED,
    );
  });

  test("rejects task advancement while another window owns the project lease", async () => {
    const { projectRoot, changeCoordinator } = harness;
    const leaseStore = changeCoordinator.getProjectLeaseStore() as InMemoryProjectLeaseStore;
    const coordinator = new TaskCoordinator(changeCoordinator, new FileTaskStore(), leaseStore);
    const task = await coordinator.createTask({
      projectRoot,
      title: "Lease conflict",
      steps: [{ kind: "run_current_scene", stepId: "run-lease" }],
    });
    const normalizedProjectRoot = await normalizeProjectRoot(projectRoot);
    const otherWindowLease = await leaseStore.acquire(normalizedProjectRoot, "other-window", 10000);

    await assert.rejects(
      () => coordinator.advanceTask({ projectRoot, taskId: task.taskId }),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.PROJECT_BUSY,
    );

    await leaseStore.release(otherWindowLease);
  });

  test("supports explicit task lease acquire, renew, status and release", async () => {
    const { projectRoot, taskCoordinator } = harness;
    const task = await taskCoordinator.createTask({
      projectRoot,
      title: "Explicit task lease lifecycle",
      steps: [{ kind: "run_current_scene", stepId: "run-lease-lifecycle" }],
    });

    const acquired = await taskCoordinator.acquireTaskLease({
      projectRoot,
      taskId: task.taskId,
      ttlMs: 10000,
    });
    assert.equal(acquired.recoverable, false);
    assert.equal(acquired.lease?.ownerId.includes("task-coordinator"), true);
    assert.ok(acquired.lease?.expiresAt);

    const renewed = await taskCoordinator.renewTaskLease({
      projectRoot,
      taskId: task.taskId,
      leaseId: acquired.lease!.leaseId,
      ttlMs: 20000,
    });
    assert.equal(renewed.recoverable, false);
    assert.equal(renewed.lease?.leaseId, acquired.lease?.leaseId);

    const released = await taskCoordinator.releaseTaskLease({
      projectRoot,
      taskId: task.taskId,
      leaseId: renewed.lease!.leaseId,
    });
    assert.equal(released.lease, null);
    assert.equal(released.recoverable, true);
  });

  test("heartbeats an explicit task lease and records lease timeline events", async () => {
    const { projectRoot, taskCoordinator } = harness;
    const task = await taskCoordinator.createTask({
      projectRoot,
      title: "Heartbeat lease",
      steps: [{ kind: "run_current_scene", stepId: "run-heartbeat" }],
    });

    const acquired = await taskCoordinator.acquireTaskLease({
      projectRoot,
      taskId: task.taskId,
      ttlMs: 1000,
    });
    const acquiredExpiresAt = Date.parse(acquired.lease!.expiresAt);

    await new Promise((resolve) => setTimeout(resolve, 700));

    const renewedStatus = await taskCoordinator.getTask({ projectRoot, taskId: task.taskId });
    assert.ok(Date.parse(renewedStatus.lease!.expiresAt) > acquiredExpiresAt);
    assert.ok(renewedStatus.timeline.some((event) => String(event.status) === "lease_acquired"));
    assert.ok(renewedStatus.timeline.some((event) => String(event.status) === "lease_renewed"));

    const released = await taskCoordinator.releaseTaskLease({
      projectRoot,
      taskId: task.taskId,
      leaseId: renewedStatus.lease!.leaseId,
    });
    assert.equal(released.lease, null);
    assert.equal(released.recoverable, true);
    assert.ok(released.timeline.some((event) => String(event.status) === "lease_released"));
  });

  test("filters task timeline by step, event type and time range", async () => {
    const { projectRoot, taskCoordinator } = harness;
    const task = await taskCoordinator.createTask({
      projectRoot,
      title: "Filtered timeline",
      steps: [{ kind: "run_current_scene", stepId: "timeline-step" }],
    });
    const from = new Date(Date.now() - 1000).toISOString();
    const acquired = await taskCoordinator.acquireTaskLease({
      projectRoot,
      taskId: task.taskId,
      ttlMs: 10000,
    });
    const released = await taskCoordinator.releaseTaskLease({
      projectRoot,
      taskId: task.taskId,
      leaseId: acquired.lease!.leaseId,
    });
    const to = new Date(Date.now() + 1000).toISOString();

    const report = await taskCoordinator.getTaskTimeline({
      projectRoot,
      taskId: task.taskId,
      eventTypes: ["lease_acquired", "lease_released"],
      from,
      to,
      limit: 1,
    });

    assert.equal(report.taskId, task.taskId);
    assert.equal(report.total, 2);
    assert.equal(report.events.length, 1);
    assert.equal(report.truncated, true);
    assert.ok(["lease_acquired", "lease_released"].includes(String(report.events[0]?.status)));
    assert.equal(released.lease, null);
  });
});
