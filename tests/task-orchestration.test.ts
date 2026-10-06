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
  AutoloadSnapshot,
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
import { InMemoryProjectLeaseStore, type ProjectLease } from "../src/infrastructure/project-lease-store.js";
import { normalizeProjectRoot } from "../src/infrastructure/project-root.js";
import {
  previewDiagnosticRepairStepDeclSchema,
  verifyResourceStateStepDeclSchema,
  verifyScriptStateStepDeclSchema,
  verifySceneStateStepDeclSchema,
} from "../src/domain/task-contracts.js";

class RenewalFailureLeaseStore extends InMemoryProjectLeaseStore {
  failRenewal = true;

  async renew(_lease: ProjectLease, _ttlMs: number): Promise<ProjectLease> {
    if (this.failRenewal) {
      throw new DomainError(ERROR_CODES.OPERATION_REJECTED, "The test lease renewal temporarily failed.");
    }
    return super.renew(_lease, _ttlMs);
  }
}

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
  resourceSnapshot: ResourceSnapshot = {
    path: "res://instance_source.tscn",
    revision: "resource-revision-1",
    content: "[gd_scene load_steps=1 format=3]\n[node name=\"Instance\" type=\"Node2D\"]\n[node name=\"Child\" type=\"Label\" parent=\".\"]\n",
  };
  applyError: Error | null = null;
  projectSettingValue = 640;
  projectSettingRevision = "settings-revision-1";
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
  runDelayMs = 0;

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
    const operation = request.operations[0] as unknown as {
      kind?: string;
      settingKey?: string;
      value?: unknown;
    } | undefined;
    const isProjectSetting = operation?.kind === "project.setting.set";
    if (isProjectSetting && operation.value !== undefined) {
      this.projectSettingValue = operation.value as number;
      this.projectSettingRevision = "settings-revision-2";
    }
    return {
      schemaVersion: "0.2",
      planId: request.planId,
      status: "applied",
      revision: "revision-2",
      operationCount: request.operations.length,
      undoLabel: isProjectSetting ? "Godot Safe Change: Set project setting" : "Godot Safe Change: Add node",
      ...(isProjectSetting ? { fileRevision: this.projectSettingRevision } : {}),
    };
  }

  async runCurrentScene(): Promise<RunDiagnostics> {
    this.runCalls += 1;
    if (this.runDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.runDelayMs));
    }
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
    return { ...this.resourceSnapshot, path: resourcePath };
  }

  async readProjectSetting(
    _projectRoot: string,
    settingKey: "application/run/main_scene" | "display/window/size/viewport_width" | "display/window/size/viewport_height",
  ): Promise<{
    settingKey: "application/run/main_scene" | "display/window/size/viewport_width" | "display/window/size/viewport_height";
    exists: boolean;
    value: string | number | null;
    revision: string;
  }> {
    return {
      settingKey,
      exists: true,
      value: settingKey === "application/run/main_scene"
        ? "res://main.tscn"
        : settingKey.endsWith("viewport_width")
          ? this.projectSettingValue
          : 360,
      revision: settingKey.endsWith("viewport_width") ? this.projectSettingRevision : "settings-revision-1",
    };
  }

  async readInputAction(_projectRoot: string, actionName: string): Promise<InputActionSnapshot> {
    return { actionName, revision: "input-test", exists: false, deadzone: null, events: [] };
  }

  async readAutoload(_projectRoot: string, name: string): Promise<AutoloadSnapshot> {
    return { name, revision: "settings-test", exists: false, scriptPath: null };
  }

  async readSceneSignals(): Promise<{ path: string; revision: string; nodes: never[] }> {
    return { path: "res://main.tscn", revision: this.context.revision ?? "revision-1", nodes: [] };
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

  test("applies an approved project setting plan as a task step", async () => {
    const { projectRoot, changeCoordinator, taskCoordinator, bridge } = harness;
    const plan = await changeCoordinator.previewSceneChange({
      projectRoot,
      reason: "Resize the viewport through task orchestration.",
      operation: {
        kind: "project.setting.set",
        settingKey: "display/window/size/viewport_width",
        value: 1280,
      },
    });
    assert.equal(plan.expectedFileRevision, "settings-revision-1");

    const task = await taskCoordinator.createTask({
      projectRoot,
      title: "Apply the bounded viewport setting",
      steps: [{
        kind: "apply_plan",
        stepId: "apply-viewport",
        planId: plan.planId,
        expectedRevision: plan.expectedRevision,
      }],
    });

    const completed = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    assert.equal(completed.status, "completed");
    assert.equal(completed.steps[0]?.status, "succeeded");
    assert.equal((completed.steps[0]?.result as { status?: string } | undefined)?.status, "applied");
    assert.equal((completed.steps[0]?.result as { fileRevision?: string } | undefined)?.fileRevision, "settings-revision-2");
    assert.equal(bridge.projectSettingValue, 1280);
    assert.equal(bridge.projectSettingRevision, "settings-revision-2");
    assert.equal(bridge.applied[0]?.operations[0]?.kind, "project.setting.set");
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

  test("rejects concurrent advance attempts from the same coordinator", async () => {
    const { projectRoot, bridge, taskCoordinator } = harness;
    bridge.runDelayMs = 150;
    const task = await taskCoordinator.createTask({
      projectRoot,
      title: "Prevent duplicate in-flight task steps",
      steps: [{ kind: "run_current_scene", stepId: "single-flight-step" }],
    });

    const inFlight = taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(
      () => taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId }),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.PROJECT_BUSY,
    );

    const completed = await inFlight;
    assert.equal(completed.status, "completed");
    assert.equal(bridge.runCalls, 1);
  });

  test("records an interrupted step and owner takeover after lease TTL expiry", async () => {
    const { projectRoot, changeCoordinator } = harness;
    const store = new FileTaskStore();
    const leaseStore = changeCoordinator.getProjectLeaseStore() as InMemoryProjectLeaseStore;
    const originalCoordinator = new TaskCoordinator(changeCoordinator, store);
    const task = await originalCoordinator.createTask({
      projectRoot,
      title: "Recover interrupted run",
      steps: [{ kind: "run_current_scene", stepId: "interrupted-run" }],
    });
    const interrupted = structuredClone(task);
    const interruptedAt = new Date(Date.now() - 5000).toISOString();
    const normalizedProjectRoot = await normalizeProjectRoot(projectRoot);
    const crashedLease = await leaseStore.acquire(normalizedProjectRoot, "crashed-owner", 10000);
    const expiredLease = await leaseStore.renew(crashedLease, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    interrupted.steps[0]!.status = "running";
    interrupted.steps[0]!.attempts = 1;
    interrupted.steps[0]!.operationId = "taskop_abandoned_attempt";
    interrupted.steps[0]!.startedAt = interruptedAt;
    interrupted.nextStepId = "interrupted-run";
    interrupted.lease = {
      leaseId: expiredLease.leaseId,
      ownerId: expiredLease.ownerId,
      acquiredAt: expiredLease.acquiredAt,
      expiresAt: expiredLease.expiresAt,
    };
    interrupted.recoverable = true;
    interrupted.timeline.push({
      eventId: "event_abandoned_attempt",
      stepId: "interrupted-run",
      operationId: "taskop_abandoned_attempt",
      status: "running",
      at: interruptedAt,
    });
    await store.save(task.projectRoot, interrupted);

    const recoveredCoordinator = new TaskCoordinator(
      changeCoordinator,
      store,
      leaseStore,
    );
    const recovered = await recoveredCoordinator.advanceTask({ projectRoot, taskId: task.taskId });

    assert.equal(recovered.status, "completed");
    assert.equal(recovered.steps[0]?.attempts, 2);
    assert.notEqual(recovered.steps[0]?.operationId, "taskop_abandoned_attempt");
    assert.ok(
      recovered.timeline.some(
        (event) =>
          event.status === "step_interrupted" &&
          event.operationId === "taskop_abandoned_attempt" &&
          event.stepId === "interrupted-run",
      ),
    );
    const reclaimed = recovered.timeline.find((event) => event.status === "lease_reclaimed");
    assert.ok(reclaimed);
    assert.equal((reclaimed.result as { previousOwnerId?: string }).previousOwnerId, expiredLease.ownerId);
    assert.notEqual((reclaimed.result as { ownerId?: string }).ownerId, expiredLease.ownerId);
    assert.equal((reclaimed.result as { reason?: string }).reason, "lease_expired");

    const interruptedEvidence = await recoveredCoordinator.getTaskTimeline({
      projectRoot,
      taskId: task.taskId,
      operationId: "taskop_abandoned_attempt",
      eventTypes: ["running", "step_interrupted"],
    });
    assert.equal(interruptedEvidence.total, 2);
    assert.deepEqual(interruptedEvidence.events.map((event) => event.status), ["running", "step_interrupted"]);
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

  test("verifies diagnostics from a referenced run step within configured thresholds", async () => {
    const { projectRoot, taskCoordinator, bridge } = harness;
    bridge.runDiagnosticsResult = {
      ...bridge.runDiagnosticsResult,
      warnings: [{ message: "Expected visual warning", source: "res://main.tscn" }],
    };
    const task = await taskCoordinator.createTask({
      projectRoot,
      title: "Verify run diagnostics",
      steps: [
        { kind: "run_current_scene", stepId: "run-main" },
        { kind: "verify_diagnostics", stepId: "verify-run", runStepId: "run-main", maxErrors: 0, maxWarnings: 1 },
      ],
    });

    const afterRun = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    assert.equal(afterRun.status, "active");
    const completed = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });

    assert.equal(completed.status, "completed");
    assert.equal(completed.steps[1]?.status, "succeeded");
    assert.deepEqual(completed.steps[1]?.result, {
      passed: true,
      runStepId: "run-main",
      runId: "run-1",
      scenePath: "res://main.tscn",
      status: "stopped",
      errorCount: 0,
      warningCount: 1,
      maxErrors: 0,
      maxWarnings: 1,
    });
    const verificationEvent = completed.timeline.find((event) => event.stepId === "verify-run" && event.status === "succeeded");
    assert.equal(verificationEvent?.operationId, completed.steps[1]?.operationId);
  });

  test("fails diagnostics verification with run output and threshold evidence", async () => {
    const { projectRoot, taskCoordinator, bridge } = harness;
    bridge.runDiagnosticsResult = {
      ...bridge.runDiagnosticsResult,
      status: "failed",
      errors: [{ message: "Runtime failure", source: "res://main.gd", line: 12 }],
      warnings: [{ message: "Runtime warning", source: "res://main.gd", line: 7 }],
    };
    const task = await taskCoordinator.createTask({
      projectRoot,
      title: "Reject failed run diagnostics",
      steps: [
        { kind: "run_current_scene", stepId: "run-main" },
        { kind: "verify_diagnostics", stepId: "verify-run", runStepId: "run-main", maxErrors: 0, maxWarnings: 0 },
      ],
    });
    await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    const failed = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });

    assert.equal(failed.status, "failed");
    assert.equal(failed.steps[1]?.error?.code, ERROR_CODES.TASK_VERIFICATION_FAILED);
    assert.deepEqual(failed.steps[1]?.error?.details, {
      runStepId: "run-main",
      runId: "run-1",
      scenePath: "res://main.tscn",
      status: "failed",
      errorCount: 1,
      warningCount: 1,
      maxErrors: 0,
      maxWarnings: 0,
      errors: [{ message: "Runtime failure", source: "res://main.gd", line: 12 }],
      warnings: [{ message: "Runtime warning", source: "res://main.gd", line: 7 }],
    });
    const failedEvent = failed.timeline.find((event) => event.stepId === "verify-run" && event.status === "failed");
    assert.equal(failedEvent?.operationId, failed.steps[1]?.operationId);
    assert.deepEqual(failedEvent?.error?.details, failed.steps[1]?.error?.details);
  });

  test("requires verify_diagnostics to reference an earlier run step", async () => {
    const { projectRoot, taskCoordinator } = harness;
    await assert.rejects(() => taskCoordinator.createTask({
      projectRoot,
      title: "Reject a forward run reference",
      steps: [
        { kind: "verify_diagnostics", stepId: "verify-run", runStepId: "run-main" },
        { kind: "run_current_scene", stepId: "run-main" },
      ],
    }));
    await assert.rejects(() => taskCoordinator.createTask({
      projectRoot,
      title: "Reject a non-run reference",
      steps: [
        { kind: "apply_plan", stepId: "apply-plan", planId: "plan-1", expectedRevision: "revision-1" },
        { kind: "verify_diagnostics", stepId: "verify-run", runStepId: "apply-plan" },
      ],
    }));
    await assert.rejects(() => taskCoordinator.createTask({
      projectRoot,
      title: "Reject an ambiguous run reference",
      steps: [
        { kind: "run_current_scene", stepId: "run-main" },
        { kind: "run_scene", stepId: "run-main", scenePath: "res://levels/other.tscn" },
        { kind: "verify_diagnostics", stepId: "verify-run", runStepId: "run-main" },
      ],
    }));
  });

  test("pauses for a diagnostic repair preview and applies only after confirmation", async () => {
    const { projectRoot, taskCoordinator, changeCoordinator, bridge } = harness;
    bridge.runDiagnosticsResult = {
      ...bridge.runDiagnosticsResult,
      runId: "run-before-repair",
      warnings: [{
        message: "A safe repair is available.",
        source: "res://main.gd",
        line: 12,
        repairHint: {
          kind: "scene.create_node",
          parentPath: ".",
          nodeName: "RepairMarker",
          nodeType: "Node2D",
          reason: "Add a marker requested by the diagnostic.",
        },
      }],
    };
    const task = await taskCoordinator.createTask({
      projectRoot,
      title: "Preview and confirm a diagnostic repair",
      steps: [
        { kind: "run_current_scene", stepId: "run-before" },
        { kind: "preview_diagnostic_repair", stepId: "preview-repair", runStepId: "run-before", diagnosticKind: "warning", diagnosticIndex: 0 },
        { kind: "apply_diagnostic_repair", stepId: "apply-repair", previewStepId: "preview-repair" },
        { kind: "run_current_scene", stepId: "run-after" },
        { kind: "verify_diagnostics", stepId: "verify-after", runStepId: "run-after" },
      ],
    });

    const afterRun = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    assert.equal(afterRun.status, "active");
    const previewed = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    assert.equal(previewed.status, "paused");
    assert.equal(previewed.nextStepId, "apply-repair");
    assert.equal(bridge.applied.length, 0);
    const previewResult = previewed.steps[1]?.result as {
      runId: string;
      diagnosticKind: string;
      diagnosticIndex: number;
      diagnostic: { source?: string; line?: number };
      plan: { planId: string; expectedRevision: string; operations: Array<{ kind: string }> };
    };
    assert.equal(previewResult.runId, "run-before-repair");
    assert.equal(previewResult.diagnosticKind, "warning");
    assert.equal(previewResult.diagnosticIndex, 0);
    assert.equal(previewResult.diagnostic.source, "res://main.gd");
    assert.equal(previewResult.diagnostic.line, 12);
    assert.equal(previewResult.plan.operations[0]?.kind, "scene.create_node");
    assert.ok(previewResult.plan.planId);
    assert.ok(previewed.timeline.some((event) => event.status === "paused" && event.operationId === previewed.steps[1]?.operationId));

    await taskCoordinator.resumeTask({ projectRoot, taskId: task.taskId });
    const unconfirmedApply = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    assert.equal(unconfirmedApply.status, "failed");
    assert.equal(unconfirmedApply.steps[2]?.error?.code, ERROR_CODES.CONFIRMATION_REQUIRED);
    assert.equal(bridge.applied.length, 0);

    await changeCoordinator.confirmChange({
      projectRoot,
      planId: previewResult.plan.planId,
      expectedRevision: previewResult.plan.expectedRevision,
    });
    const afterConfirmedApply = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    assert.equal(afterConfirmedApply.status, "active");
    assert.equal(afterConfirmedApply.steps[2]?.status, "succeeded");
    assert.equal(bridge.applied[0]?.operations[0]?.kind, "scene.create_node");

    bridge.runDiagnosticsResult = {
      ...bridge.runDiagnosticsResult,
      runId: "run-after-repair",
      warnings: [],
      errors: [],
    };
    const afterRepairRun = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    assert.equal(afterRepairRun.steps[3]?.status, "succeeded");
    const completed = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    assert.equal(completed.status, "completed");
    assert.equal(completed.steps[4]?.result && (completed.steps[4]?.result as { passed?: boolean }).passed, true);
  });

  test("chains a rerun and diagnostics verification into the repair apply step", async () => {
    const { projectRoot, taskCoordinator, changeCoordinator, bridge } = harness;
    bridge.runDiagnosticsResult = {
      ...bridge.runDiagnosticsResult,
      runId: "run-before-chain",
      warnings: [{
        message: "A safe repair is available.",
        source: "res://main.gd",
        line: 12,
        repairHint: {
          kind: "scene.create_node",
          parentPath: ".",
          nodeName: "ChainedRepairMarker",
          nodeType: "Node2D",
          reason: "Add a marker requested by the diagnostic.",
        },
      }],
    };
    const task = await taskCoordinator.createTask({
      projectRoot,
      title: "Apply a repair and verify the rerun in one step",
      steps: [
        { kind: "run_current_scene", stepId: "run-before" },
        { kind: "preview_diagnostic_repair", stepId: "preview-repair", runStepId: "run-before", diagnosticKind: "warning", diagnosticIndex: 0 },
        {
          kind: "apply_diagnostic_repair",
          stepId: "apply-repair",
          previewStepId: "preview-repair",
          rerunDiagnostics: { maxErrors: 0, maxWarnings: 0 },
        },
      ],
    });

    await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    const previewed = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    assert.equal(previewed.status, "paused");
    const plan = (previewed.steps[1]?.result as { plan: { planId: string; expectedRevision: string } }).plan;
    await changeCoordinator.confirmChange({
      projectRoot,
      planId: plan.planId,
      expectedRevision: plan.expectedRevision,
    });
    await taskCoordinator.resumeTask({ projectRoot, taskId: task.taskId });
    // The repair fixes the diagnostic, so the rerun inside the apply step is clean.
    bridge.runDiagnosticsResult = {
      ...bridge.runDiagnosticsResult,
      runId: "run-after-chain",
      warnings: [],
      errors: [],
    };
    const applied = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    assert.equal(applied.status, "completed");
    assert.equal(applied.steps[2]?.status, "succeeded");
    const result = applied.steps[2]?.result as {
      alreadyApplied: boolean;
      rerun: { passed: boolean; rerunRunId: string; errorCount: number; warningCount: number; maxErrors: number; maxWarnings: number };
    };
    assert.equal(result.alreadyApplied, false);
    assert.equal(result.rerun.passed, true);
    assert.equal(result.rerun.rerunRunId, "run-after-chain");
    assert.equal(result.rerun.maxErrors, 0);
    assert.equal(result.rerun.maxWarnings, 0);
    assert.equal(bridge.runCalls, 2);
    assert.equal(bridge.applied.length, 1);
  });

  test("retries a failed repair verification without re-applying the plan", async () => {
    const { projectRoot, taskCoordinator, changeCoordinator, bridge } = harness;
    bridge.runDiagnosticsResult = {
      ...bridge.runDiagnosticsResult,
      runId: "run-before-retry",
      warnings: [{
        message: "A safe repair is available.",
        source: "res://main.gd",
        line: 12,
        repairHint: {
          kind: "scene.create_node",
          parentPath: ".",
          nodeName: "RetryVerificationMarker",
          nodeType: "Node2D",
          reason: "Add a marker requested by the diagnostic.",
        },
      }],
    };
    const task = await taskCoordinator.createTask({
      projectRoot,
      title: "Retry the verification leg of a repair",
      steps: [
        { kind: "run_current_scene", stepId: "run-before" },
        { kind: "preview_diagnostic_repair", stepId: "preview-repair", runStepId: "run-before", diagnosticKind: "warning", diagnosticIndex: 0 },
        {
          kind: "apply_diagnostic_repair",
          stepId: "apply-repair",
          previewStepId: "preview-repair",
          rerunDiagnostics: { maxErrors: 0, maxWarnings: 0 },
        },
      ],
    });

    await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    const previewed = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    const plan = (previewed.steps[1]?.result as { plan: { planId: string; expectedRevision: string } }).plan;
    await changeCoordinator.confirmChange({
      projectRoot,
      planId: plan.planId,
      expectedRevision: plan.expectedRevision,
    });
    await taskCoordinator.resumeTask({ projectRoot, taskId: task.taskId });
    // The rerun still reports the warning, so the verification leg fails while
    // the repair plan itself stays applied.
    const failed = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    assert.equal(failed.status, "failed");
    assert.equal(failed.steps[2]?.status, "failed");
    assert.equal(failed.steps[2]?.error?.code, ERROR_CODES.TASK_VERIFICATION_FAILED);
    assert.equal(bridge.applied.length, 1);

    // The retry treats the already-applied plan as the succeeded apply leg and
    // only re-runs the scene with the now-clean diagnostics.
    bridge.runDiagnosticsResult = {
      ...bridge.runDiagnosticsResult,
      runId: "run-after-retry",
      warnings: [],
      errors: [],
    };
    const recovered = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.steps[2]?.status, "succeeded");
    const result = recovered.steps[2]?.result as {
      alreadyApplied: boolean;
      rerun: { passed: boolean; rerunRunId: string };
    };
    assert.equal(result.alreadyApplied, true);
    assert.equal(result.rerun.passed, true);
    assert.equal(result.rerun.rerunRunId, "run-after-retry");
    assert.equal(bridge.applied.length, 1);
    assert.equal(bridge.runCalls, 3);
  });

  test("uses a bounded task repair hint when the run diagnostic has none", async () => {
    const { projectRoot, taskCoordinator, bridge } = harness;
    bridge.runDiagnosticsResult = {
      ...bridge.runDiagnosticsResult,
      runId: "run-without-hint",
      warnings: [{ message: "The warning has no server-generated repair hint." }],
    };
    const repairHint = {
      kind: "scene.create_node",
      parentPath: ".",
      nodeName: "ExplicitRepairMarker",
      nodeType: "Node2D",
      reason: "Create the bounded node requested for this warning.",
    };
    const previewStep = {
      kind: "preview_diagnostic_repair",
      stepId: "preview-repair",
      runStepId: "run-before",
      diagnosticKind: "warning",
      diagnosticIndex: 0,
      repairHint,
    } as never;
    assert.equal(previewDiagnosticRepairStepDeclSchema.safeParse(previewStep).success, true);
    const task = await taskCoordinator.createTask({
      projectRoot,
      title: "Use an explicit safe repair hint",
      steps: [
        { kind: "run_current_scene", stepId: "run-before" },
        previewStep,
      ],
    });
    await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    const previewed = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });

    assert.equal(previewed.status, "paused");
    assert.equal(bridge.applied.length, 0);
    const result = previewed.steps[1]?.result as { repairHint?: unknown; plan?: { operations: Array<{ kind: string }> } } | undefined;
    assert.deepEqual(result?.repairHint, repairHint);
    assert.equal(result?.plan?.operations[0]?.kind, "scene.create_node");
  });

  test("fails repair preview when the referenced diagnostic has no explicit repair hint", async () => {
    const { projectRoot, taskCoordinator, bridge } = harness;
    bridge.runDiagnosticsResult = {
      ...bridge.runDiagnosticsResult,
      warnings: [{ message: "No safe repair was supplied." }],
    };
    const task = await taskCoordinator.createTask({
      projectRoot,
      title: "Do not guess a diagnostic repair",
      steps: [
        { kind: "run_current_scene", stepId: "run-before" },
        { kind: "preview_diagnostic_repair", stepId: "preview-repair", runStepId: "run-before", diagnosticKind: "warning", diagnosticIndex: 0 },
      ],
    });
    await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    const failed = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });

    assert.equal(failed.status, "failed");
    assert.equal(failed.steps[1]?.error?.code, ERROR_CODES.TASK_VERIFICATION_FAILED);
    assert.equal((failed.steps[1]?.error?.details as { reason?: string } | undefined)?.reason, "missing_repair_hint");
    assert.equal(bridge.applied.length, 0);
  });

  test("requires repair steps to reference an earlier compatible step", async () => {
    const { projectRoot, taskCoordinator } = harness;
    await assert.rejects(() => taskCoordinator.createTask({
      projectRoot,
      title: "Reject forward repair references",
      steps: [
        { kind: "preview_diagnostic_repair", stepId: "preview-repair", runStepId: "run-after", diagnosticKind: "error", diagnosticIndex: 0 },
        { kind: "run_current_scene", stepId: "run-after" },
      ],
    }));
    await assert.rejects(() => taskCoordinator.createTask({
      projectRoot,
      title: "Reject apply without repair preview",
      steps: [{ kind: "apply_diagnostic_repair", stepId: "apply-repair", previewStepId: "preview-missing" }],
    }));
  });

  test("verifies a scene node and allowlisted properties with revision evidence", async () => {
    const { projectRoot, taskCoordinator, bridge } = harness;
    bridge.context.currentScene.nodes = [{
      path: "HUD/Title",
      name: "Title",
      type: "Label",
      properties: { visible: true, text: "Ready", position: { x: 10, y: 20 } },
    }];
    const task = await taskCoordinator.createTask({
      projectRoot,
      title: "Verify a scene node",
      steps: [{
        kind: "verify_scene_state",
        stepId: "verify-title",
        nodePath: "HUD/Title",
        expectedProperties: [
          { property: "visible", expected: true },
          { property: "text", expected: "Ready" },
          { property: "position", expected: { x: 10.000001, y: 20 } },
        ],
      }],
    });

    const completed = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });

    assert.equal(completed.status, "completed");
    assert.equal(completed.steps[0]?.status, "succeeded");
    assert.deepEqual(completed.steps[0]?.result, {
      passed: true,
      scenePath: "res://main.tscn",
      nodePath: "HUD/Title",
      revision: "revision-1",
      properties: [
        { property: "visible", expected: true, actual: true },
        { property: "text", expected: "Ready", actual: "Ready" },
        { property: "position", expected: { x: 10.000001, y: 20 }, actual: { x: 10, y: 20 } },
      ],
    });
    const succeededEvent = completed.timeline.find((event) => event.stepId === "verify-title" && event.status === "succeeded");
    assert.equal(succeededEvent?.operationId, completed.steps[0]?.operationId);
  });

  test("fails scene verification with structured evidence when the node is missing", async () => {
    const { projectRoot, taskCoordinator } = harness;
    const task = await taskCoordinator.createTask({
      projectRoot,
      title: "Reject a missing scene node",
      steps: [{ kind: "verify_scene_state", stepId: "verify-missing", nodePath: "Missing" }],
    });

    const failed = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });

    assert.equal(failed.status, "failed");
    assert.equal(failed.steps[0]?.status, "failed");
    assert.equal(failed.steps[0]?.error?.code, ERROR_CODES.TASK_VERIFICATION_FAILED);
    assert.deepEqual(failed.steps[0]?.error?.details, {
      nodePath: "Missing",
      expectedExists: true,
      actualExists: false,
      scenePath: "res://main.tscn",
      revision: "revision-1",
    });
    const failedEvent = failed.timeline.find((event) => event.stepId === "verify-missing" && event.status === "failed");
    assert.equal(failedEvent?.operationId, failed.steps[0]?.operationId);
    assert.equal(failedEvent?.error?.code, ERROR_CODES.TASK_VERIFICATION_FAILED);
    assert.deepEqual(failedEvent?.error?.details, failed.steps[0]?.error?.details);
  });

  test("fails scene verification with the expected and actual property values", async () => {
    const { projectRoot, taskCoordinator, bridge } = harness;
    bridge.context.currentScene.nodes = [{
      path: "HUD/Title",
      name: "Title",
      type: "Label",
      properties: { text: "Actual" },
    }];
    const task = await taskCoordinator.createTask({
      projectRoot,
      title: "Reject a mismatched property",
      steps: [{
        kind: "verify_scene_state",
        stepId: "verify-text",
        nodePath: "HUD/Title",
        expectedProperties: [
          { property: "text", expected: "Expected" },
          { property: "visible", expected: true },
        ],
      }],
    });

    const failed = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });

    assert.equal(failed.status, "failed");
    assert.equal(failed.steps[0]?.error?.code, ERROR_CODES.TASK_VERIFICATION_FAILED);
    assert.deepEqual(failed.steps[0]?.error?.details, {
      nodePath: "HUD/Title",
      scenePath: "res://main.tscn",
      revision: "revision-1",
      mismatches: [
        { property: "text", expected: "Expected", actual: "Actual", actualPresent: true },
        { property: "visible", expected: true, actual: null, actualPresent: false },
      ],
    });
  });

  test("verifies bounded resource content with revision and match-count evidence", async () => {
    const { projectRoot, taskCoordinator, bridge } = harness;
    const task = await taskCoordinator.createTask({
      projectRoot,
      title: "Verify an instance resource",
      steps: [{
        kind: "verify_resource_state",
        stepId: "verify-resource",
        resourcePath: "res://instance_source.tscn",
        expectedResourceRevision: "resource-revision-1",
        contains: ["[gd_scene", "[node name=\"Child\""],
        matchCounts: [{ text: "[node", expectedCount: 2 }],
      }],
    });

    const completed = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });

    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.steps[0]?.result, {
      passed: true,
      resourcePath: "res://instance_source.tscn",
      revision: "resource-revision-1",
      assertions: [
        { kind: "contains", text: "[gd_scene", matchCount: 1 },
        { kind: "contains", text: "[node name=\"Child\"", matchCount: 1 },
        { kind: "match_count", text: "[node", expectedCount: 2, actualCount: 2 },
      ],
    });
    assert.equal(bridge.resourceSnapshot.revision, "resource-revision-1");
  });

  test("fails resource verification with revision and match-count evidence", async () => {
    const { projectRoot, taskCoordinator, bridge } = harness;
    const task = await taskCoordinator.createTask({
      projectRoot,
      title: "Reject stale resource evidence",
      steps: [{
        kind: "verify_resource_state",
        stepId: "verify-resource",
        resourcePath: "res://instance_source.tscn",
        expectedResourceRevision: "resource-revision-old",
        matchCounts: [{ text: "[node", expectedCount: 3 }],
      }],
    });
    bridge.resourceSnapshot.revision = "resource-revision-2";

    const failed = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });

    assert.equal(failed.status, "failed");
    assert.equal(failed.steps[0]?.error?.code, ERROR_CODES.TASK_VERIFICATION_FAILED);
    assert.deepEqual(failed.steps[0]?.error?.details, {
      resourcePath: "res://instance_source.tscn",
      expectedResourceRevision: "resource-revision-old",
      actualResourceRevision: "resource-revision-2",
    });

    const matchTask = await taskCoordinator.createTask({
      projectRoot,
      title: "Reject a resource match count",
      steps: [{
        kind: "verify_resource_state",
        stepId: "verify-resource-count",
        resourcePath: "res://instance_source.tscn",
        matchCounts: [{ text: "[node", expectedCount: 3 }],
      }],
    });
    bridge.resourceSnapshot.revision = "resource-revision-1";
    const matchFailed = await taskCoordinator.advanceTask({ projectRoot, taskId: matchTask.taskId });
    assert.deepEqual(matchFailed.steps[0]?.error?.details, {
      resourcePath: "res://instance_source.tscn",
      revision: "resource-revision-1",
      mismatches: [{ kind: "match_count", text: "[node", expectedCount: 3, actualCount: 2 }],
    });
  });

  test("verifies bounded script content with revision and match-count evidence", async () => {
    const { projectRoot, taskCoordinator, bridge } = harness;
    const task = await taskCoordinator.createTask({
      projectRoot,
      title: "Verify a script snapshot",
      steps: [{
        kind: "verify_script_state",
        stepId: "verify-script",
        scriptPath: "res://diagnostic_scene.gd",
        expectedScriptRevision: "script-revision-1",
        contains: ["extends Node2D", "func _ready"],
        matchCounts: [{ text: "func", expectedCount: 1 }],
      }],
    });

    const completed = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });

    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.steps[0]?.result, {
      passed: true,
      scriptPath: "res://diagnostic_scene.gd",
      revision: "script-revision-1",
      assertions: [
        { kind: "contains", text: "extends Node2D", matchCount: 1 },
        { kind: "contains", text: "func _ready", matchCount: 1 },
        { kind: "match_count", text: "func", expectedCount: 1, actualCount: 1 },
      ],
    });
    assert.equal(bridge.scriptSnapshot.revision, "script-revision-1");
  });

  test("rejects unsafe node paths and unallowlisted properties in verification steps", async () => {
    const { projectRoot, taskCoordinator } = harness;
    await assert.rejects(() => taskCoordinator.createTask({
      projectRoot,
      title: "Reject unsafe verification input",
      steps: [{ kind: "verify_scene_state", stepId: "verify-unsafe-path", nodePath: "../Canvas" }],
    }));
    const invalidPropertyStep = verifySceneStateStepDeclSchema.safeParse({
      kind: "verify_scene_state",
      stepId: "verify-unsafe-property",
      nodePath: ".",
      expectedProperties: [{ property: "script", expected: "res://unsafe.gd" }],
    });
    assert.equal(invalidPropertyStep.success, false);
    const invalidResourceStep = verifyResourceStateStepDeclSchema.safeParse({
      kind: "verify_resource_state",
      stepId: "verify-resource-invalid",
      resourcePath: "res://instance_source.tscn",
    });
    assert.equal(invalidResourceStep.success, false);
    const invalidScriptStep = verifyScriptStateStepDeclSchema.safeParse({
      kind: "verify_script_state",
      stepId: "verify-script-invalid",
      scriptPath: "res://diagnostic_scene.gd",
    });
    assert.equal(invalidScriptStep.success, false);
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
      steps: [
        { kind: "run_current_scene", stepId: "timeline-step" },
        { kind: "run_current_scene", stepId: "timeline-step-two" },
      ],
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
      eventTypes: [
        "running",
        "succeeded",
        "failed",
        "step_interrupted",
        "paused",
        "resumed",
        "cancelled",
        "lease_acquired",
        "lease_renewed",
        "lease_renew_failed",
        "lease_recovered",
        "lease_released",
        "lease_reclaimed",
      ],
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

    const firstAdvance = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    const stepEvents = await taskCoordinator.getTaskTimeline({
      projectRoot,
      taskId: task.taskId,
      stepId: "timeline-step",
      eventTypes: ["running", "succeeded"],
      from,
      to: new Date(Date.now() + 1000).toISOString(),
    });
    assert.equal(stepEvents.total, 2);
    assert.ok(stepEvents.events.every((event) => event.stepId === "timeline-step"));

    const stepOperationId = firstAdvance.steps[0]?.operationId;
    assert.ok(stepOperationId);
    const operationEvents = await taskCoordinator.getTaskTimeline({
      projectRoot,
      taskId: task.taskId,
      operationId: stepOperationId,
      eventTypes: ["running", "succeeded"],
      from,
      to: new Date(Date.now() + 1000).toISOString(),
    });
    assert.equal(operationEvents.total, 2);
    assert.ok(operationEvents.events.every((event) => event.operationId === stepOperationId));
  });

  test("records heartbeat renewal failure and marks the task recoverable", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "godot-task-heartbeat-failure-"));
    const bridge = new FakeGodotBridge(projectRoot);
    const leaseStore = new RenewalFailureLeaseStore();
    const changeCoordinator = new ChangeCoordinator(bridge, undefined, leaseStore);
    const taskCoordinator = new TaskCoordinator(changeCoordinator, new FileTaskStore(), leaseStore);
    try {
      const task = await taskCoordinator.createTask({
        projectRoot,
        title: "Renewal failure",
        steps: [{ kind: "run_current_scene", stepId: "run-renewal-failure" }],
      });
      const acquired = await taskCoordinator.acquireTaskLease({
        projectRoot,
        taskId: task.taskId,
        ttlMs: 1000,
      });

      await new Promise((resolve) => setTimeout(resolve, 500));

      const recovered = await taskCoordinator.getTask({ projectRoot, taskId: task.taskId });
      assert.equal(recovered.recoverable, true);
      assert.equal(recovered.status, "paused");
      assert.ok(recovered.timeline.some((event) => String(event.status) === "lease_renew_failed"));
      assert.ok(recovered.timeline.some((event) => String(event.status) === "paused"));
      assert.equal(recovered.lease?.leaseId, acquired.lease?.leaseId);

      leaseStore.failRenewal = false;
      const resumed = await taskCoordinator.resumeTask({ projectRoot, taskId: task.taskId });
      assert.equal(resumed.status, "active");
      assert.equal(resumed.recoverable, false);
      assert.ok(resumed.timeline.some((event) => String(event.status) === "lease_recovered"));
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("keeps a task paused when its heartbeat fails during a running step", async () => {
    const { projectRoot } = harness;
    const bridge = new FakeGodotBridge(projectRoot);
    bridge.runDelayMs = 650;
    const leaseStore = new RenewalFailureLeaseStore();
    const changeCoordinator = new ChangeCoordinator(bridge, undefined, leaseStore);
    const coordinator = new TaskCoordinator(changeCoordinator, new FileTaskStore(), leaseStore);
    const task = await coordinator.createTask({
      projectRoot,
      title: "Pause during lost lease",
      steps: [{ kind: "run_current_scene", stepId: "run-lost-heartbeat" }],
    });
    await coordinator.acquireTaskLease({ projectRoot, taskId: task.taskId, ttlMs: 1000 });

    const advanced = await coordinator.advanceTask({ projectRoot, taskId: task.taskId });

    assert.equal(advanced.status, "paused");
    assert.equal(advanced.steps[0]?.status, "succeeded");
    assert.equal(advanced.nextStepId, null);
    assert.equal(advanced.recoverable, true);
    assert.ok(advanced.timeline.some((event) => event.status === "lease_renew_failed"));
  });

  test("records previous owner, new owner and expiry reason when a task lease is reclaimed", async () => {
    const { projectRoot, changeCoordinator, taskCoordinator } = harness;
    const leaseStore = changeCoordinator.getProjectLeaseStore() as InMemoryProjectLeaseStore;
    const task = await taskCoordinator.createTask({
      projectRoot,
      title: "Lease takeover timeline",
      steps: [{ kind: "run_current_scene", stepId: "run-takeover" }],
    });
    const acquired = await taskCoordinator.acquireTaskLease({
      projectRoot,
      taskId: task.taskId,
      ttlMs: 1000,
    });
    const previousOwnerId = acquired.lease!.ownerId;
    const normalizedProjectRoot = await normalizeProjectRoot(projectRoot);
    await leaseStore.renew(
      {
        leaseId: acquired.lease!.leaseId,
        projectRoot: normalizedProjectRoot,
        ownerId: previousOwnerId,
        acquiredAt: acquired.lease!.acquiredAt,
        expiresAt: acquired.lease!.expiresAt,
      },
      1,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(
      () => taskCoordinator.renewTaskLease({
        projectRoot,
        taskId: task.taskId,
        leaseId: acquired.lease!.leaseId,
      }),
      (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.LEASE_EXPIRED,
    );

    const recoveryCoordinator = new TaskCoordinator(changeCoordinator, new FileTaskStore(), leaseStore);
    await recoveryCoordinator.resumeTask({ projectRoot, taskId: task.taskId });
    const completed = await recoveryCoordinator.advanceTask({ projectRoot, taskId: task.taskId });
    assert.equal(completed.status, "completed");
    const reclaimed = completed.timeline.find((event) => event.status === "lease_reclaimed");
    assert.ok(reclaimed);
    assert.equal((reclaimed.result as { previousOwnerId?: string }).previousOwnerId, previousOwnerId);
    assert.notEqual((reclaimed.result as { ownerId?: string }).ownerId, previousOwnerId);
    assert.equal((reclaimed.result as { reason?: string }).reason, "lease_expired");
  });

  test("reclaims an expired lease already held in the same coordinator", async () => {
    const { projectRoot, changeCoordinator, taskCoordinator } = harness;
    const leaseStore = changeCoordinator.getProjectLeaseStore() as InMemoryProjectLeaseStore;
    const task = await taskCoordinator.createTask({
      projectRoot,
      title: "Same coordinator lease recovery",
      steps: [{ kind: "run_current_scene", stepId: "run-same-owner-recovery" }],
    });
    const acquired = await taskCoordinator.acquireTaskLease({
      projectRoot,
      taskId: task.taskId,
      ttlMs: 10000,
    });
    const normalizedProjectRoot = await normalizeProjectRoot(projectRoot);
    await leaseStore.renew(
      {
        leaseId: acquired.lease!.leaseId,
        projectRoot: normalizedProjectRoot,
        ownerId: acquired.lease!.ownerId,
        acquiredAt: acquired.lease!.acquiredAt,
        expiresAt: acquired.lease!.expiresAt,
      },
      1,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const completed = await taskCoordinator.advanceTask({ projectRoot, taskId: task.taskId });

    assert.equal(completed.status, "completed");
    const reclaimed = completed.timeline.find((event) => event.status === "lease_reclaimed");
    assert.ok(reclaimed);
    assert.equal((reclaimed.result as { reason?: string }).reason, "lease_expired");
    assert.equal((reclaimed.result as { previousOwnerId?: string }).previousOwnerId, acquired.lease!.ownerId);
  });
});
