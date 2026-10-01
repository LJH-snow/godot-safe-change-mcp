import { randomUUID } from "node:crypto";
import type { ChangeCoordinator } from "./change-coordinator.js";
import {
  createTaskInputSchema,
  acquireTaskLeaseInputSchema,
  taskIdInputSchema,
  taskLeaseInputSchema,
  taskTimelineInputSchema,
  diagnosticRepairPreviewResultSchema,
  type AcquireTaskLeaseInput,
  type DiagnosticRepairPreviewResult,
  type CreateTaskInput,
  type TaskIdInput,
  type TaskState,
  type TaskLease,
  type TaskLeaseInput,
  type TaskStepState,
  type TaskTimelineInput,
  type TaskTimelineReport,
  type TaskTimelineEvent,
} from "../domain/task-contracts.js";
import { DomainError, ERROR_CODES } from "../domain/errors.js";
import { runDiagnosticsSchema } from "../domain/contracts.js";
import type { FileTaskStore } from "../infrastructure/task-store.js";
import {
  type ProjectLease,
  type ProjectLeaseStore,
} from "../infrastructure/project-lease-store.js";
import { normalizeProjectRoot } from "../infrastructure/project-root.js";

const MAX_STEP_ATTEMPTS = 3;
const DEFAULT_TASK_LEASE_TTL_MS = 120000;
const SCENE_VALUE_TOLERANCE = 0.00001;

function sceneValueMatches(expected: unknown, actual: unknown): boolean {
  if (typeof expected === "number") {
    return typeof actual === "number" && Math.abs(expected - actual) <= SCENE_VALUE_TOLERANCE;
  }
  if (expected === null || typeof expected !== "object") {
    return expected === actual;
  }
  if (Array.isArray(expected) || actual === null || typeof actual !== "object" || Array.isArray(actual)) {
    return false;
  }
  const expectedEntries = Object.entries(expected);
  const actualEntries = Object.entries(actual);
  return expectedEntries.length === actualEntries.length && expectedEntries.every(
    ([key, expectedValue]) => Object.hasOwn(actual, key) && sceneValueMatches(expectedValue, (actual as Record<string, unknown>)[key]),
  );
}

interface LeaseHeartbeat {
  timer: ReturnType<typeof setInterval>;
  leaseId: string;
  ttlMs: number;
  renewing: boolean;
}

/**
 * Orchestrates bounded multi-step Godot tasks on top of the existing
 * preview/confirm/apply/rollback/run use cases. A task never introduces a new
 * write capability: every step re-enters ChangeCoordinator, so confirmation,
 * revision guards, audit entries and Godot UndoRedo semantics stay in force.
 */
export class TaskCoordinator {
  private readonly tasks = new Map<string, TaskState>();
  private readonly advancingTasks = new Set<string>();
  private readonly taskLeases = new Map<string, ProjectLease>();
  private readonly taskLeaseTtls = new Map<string, number>();
  private readonly leaseHeartbeats = new Map<string, LeaseHeartbeat>();
  private readonly explicitLeaseTaskIds = new Set<string>();
  private readonly ownerId = "task-coordinator-" + process.pid + "-" + randomUUID();
  private readonly leaseStore: ProjectLeaseStore;

  constructor(
    private readonly changeCoordinator: ChangeCoordinator,
    private readonly store: FileTaskStore,
    leaseStore?: ProjectLeaseStore,
  ) {
    this.leaseStore = leaseStore ?? changeCoordinator.getProjectLeaseStore();
  }

  async createTask(input: CreateTaskInput): Promise<TaskState> {
    const parsedInput = createTaskInputSchema.parse(input);
    const projectRoot = await normalizeProjectRoot(parsedInput.projectRoot);
    const now = new Date().toISOString();
    const task: TaskState = {
      schemaVersion: "0.1",
      taskId: "task_" + randomUUID().replaceAll("-", "").slice(0, 16),
      projectRoot,
      title: parsedInput.title,
      status: "active",
      steps: parsedInput.steps.map((step) => this.toStepState(step)),
      nextStepId: parsedInput.steps[0]?.stepId ?? null,
      createdAt: now,
      updatedAt: now,
      lease: null,
      recoverable: true,
      timeline: [],
    };
    this.tasks.set(task.taskId, task);
    await this.store.save(projectRoot, task);
    return structuredClone(task);
  }

  async getTask(input: TaskIdInput): Promise<TaskState> {
    const parsedInput = taskIdInputSchema.parse(input);
    const projectRoot = await normalizeProjectRoot(parsedInput.projectRoot);
    const task = await this.requireTask(parsedInput.taskId, projectRoot);
    this.refreshTaskRecoverability(task);
    return structuredClone(task);
  }

  async getTaskTimeline(input: TaskTimelineInput): Promise<TaskTimelineReport> {
    const parsedInput = taskTimelineInputSchema.parse(input);
    const projectRoot = await normalizeProjectRoot(parsedInput.projectRoot);
    const task = await this.requireTask(parsedInput.taskId, projectRoot);
    this.refreshTaskRecoverability(task);

    const fromMs = parsedInput.from === undefined ? undefined : Date.parse(parsedInput.from);
    const toMs = parsedInput.to === undefined ? undefined : Date.parse(parsedInput.to);
    const eventTypes = parsedInput.eventTypes === undefined ? undefined : new Set(parsedInput.eventTypes);
    const filteredEvents = task.timeline.filter((event) => {
      if (parsedInput.stepId !== undefined && event.stepId !== parsedInput.stepId) {
        return false;
      }
      if (parsedInput.operationId !== undefined && event.operationId !== parsedInput.operationId) {
        return false;
      }
      if (eventTypes !== undefined && !eventTypes.has(event.status)) {
        return false;
      }
      const timestamp = Date.parse(event.at);
      if (fromMs !== undefined && timestamp < fromMs) {
        return false;
      }
      if (toMs !== undefined && timestamp > toMs) {
        return false;
      }
      return true;
    });
    const limit = parsedInput.limit ?? 200;
    const events = filteredEvents.slice(0, limit);

    return {
      schemaVersion: "0.1",
      projectRoot,
      taskId: task.taskId,
      status: task.status,
      events: structuredClone(events),
      total: filteredEvents.length,
      returned: events.length,
      truncated: events.length < filteredEvents.length,
    };
  }

  async advanceTask(input: TaskIdInput): Promise<TaskState> {
    const parsedInput = taskIdInputSchema.parse(input);
    const projectRoot = await normalizeProjectRoot(parsedInput.projectRoot);
    const task = await this.requireTask(parsedInput.taskId, projectRoot);
    if (this.advancingTasks.has(task.taskId)) {
      throw new DomainError(ERROR_CODES.PROJECT_BUSY, "Another step for this task is already running.", {
        taskId: task.taskId,
      });
    }
    this.advancingTasks.add(task.taskId);
    try {
      await this.ensureTaskLease(task, projectRoot);
      return await this.advanceTaskInternal(input);
    } finally {
      this.advancingTasks.delete(task.taskId);
      const latestTask = this.tasks.get(task.taskId);
      if (!this.explicitLeaseTaskIds.has(task.taskId) || latestTask?.status !== "active") {
        await this.releaseHeldTaskLease(task.taskId);
      }
    }
  }

  private async advanceTaskInternal(input: TaskIdInput): Promise<TaskState> {
    const parsedInput = taskIdInputSchema.parse(input);
    const projectRoot = await normalizeProjectRoot(parsedInput.projectRoot);
    const task = await this.requireTask(parsedInput.taskId, projectRoot);

    if (task.status === "paused") {
      throw new DomainError(
        ERROR_CODES.TASK_INVALID_STATUS,
        "A paused task must be resumed before advancing.",
        { taskId: task.taskId, status: task.status },
      );
    }
    if (task.status === "completed" || task.status === "cancelled") {
      throw new DomainError(
        ERROR_CODES.TASK_INVALID_STATUS,
        "A finished task cannot be advanced.",
        { taskId: task.taskId, status: task.status },
      );
    }

    const step = this.findNextStep(task);
    if (step === undefined) {
      task.status = "completed";
      task.nextStepId = null;
      task.updatedAt = new Date().toISOString();
      await this.store.save(task.projectRoot, task);
      return structuredClone(task);
    }

    if (step.attempts >= MAX_STEP_ATTEMPTS) {
      throw new DomainError(
        ERROR_CODES.OPERATION_REJECTED,
        "The step already used its retry budget; cancel the task or create a new plan.",
        { taskId: task.taskId, stepId: step.stepId, attempts: step.attempts },
      );
    }

    if (step.status === "running") {
      this.appendTimeline(task, {
        stepId: step.stepId,
        operationId: step.operationId,
        status: "step_interrupted",
        at: new Date().toISOString(),
        result: { attempt: step.attempts, reason: "recovered_after_restart" },
      });
    }

    step.status = "running";
    step.attempts += 1;
    step.operationId = "taskop_" + randomUUID().replaceAll("-", "").slice(0, 20);
    step.startedAt = new Date().toISOString();
    step.result = undefined;
    step.error = undefined;
    task.updatedAt = step.startedAt;
    this.appendTimeline(task, {
      stepId: step.stepId,
      operationId: step.operationId,
      status: "running",
      at: step.startedAt,
    });
    await this.store.save(task.projectRoot, task);

    try {
      step.result = await this.executeStep(task, step);
      step.status = "succeeded";
      step.finishedAt = new Date().toISOString();
      this.appendTimeline(task, {
        stepId: step.stepId,
        operationId: step.operationId,
        status: "succeeded",
        at: step.finishedAt,
        result: step.result,
      });
    } catch (error) {
      const pausedForRecovery = this.isTaskPausedForRecovery(task.taskId);
      step.status = "failed";
      step.finishedAt = new Date().toISOString();
      step.error =
        error instanceof DomainError
          ? {
              code: error.code,
              message: error.message,
              ...(error.details === undefined ? {} : { details: error.details }),
            }
          : {
              code: "INTERNAL_ERROR",
              message: error instanceof Error ? error.message : String(error),
            };
      if (!pausedForRecovery) {
        task.status = "failed";
      }
      task.nextStepId = step.stepId;
      task.updatedAt = step.finishedAt;
      this.appendTimeline(task, {
        stepId: step.stepId,
        operationId: step.operationId,
        status: "failed",
        at: step.finishedAt,
        error: step.error,
      });
      await this.store.save(task.projectRoot, task);
      return structuredClone(task);
    }

    const pausedForRecovery = this.isTaskPausedForRecovery(task.taskId);
    const pausedForRepairReview = step.kind === "preview_diagnostic_repair" && !pausedForRecovery;
    if (!pausedForRecovery) {
      task.status = pausedForRepairReview ? "paused" : "active";
    }
    const next = this.findNextStep(task);
    task.nextStepId = next?.stepId ?? null;
    if (pausedForRepairReview) {
      task.updatedAt = new Date().toISOString();
      this.appendTimeline(task, {
        stepId: step.stepId,
        operationId: step.operationId,
        status: "paused",
        at: task.updatedAt,
        result: { reason: "diagnostic_repair_review_required" },
      });
    }
    if (next === undefined && !pausedForRecovery && !pausedForRepairReview) {
      task.status = "completed";
    }
    task.updatedAt = new Date().toISOString();
    await this.store.save(task.projectRoot, task);
    return structuredClone(task);
  }

  async pauseTask(input: TaskIdInput): Promise<TaskState> {
    return this.withTaskLease(input, async () => {
      const task = await this.transition(input, ["active"], "paused", "Only an active task can be paused.");
      await this.store.save(task.projectRoot, task);
      return structuredClone(task);
    });
  }

  async resumeTask(input: TaskIdInput): Promise<TaskState> {
    return this.withTaskLease(input, async () => {
      const task = await this.transition(input, ["paused"], "active", "Only a paused task can be resumed.");
      await this.store.save(task.projectRoot, task);
      return structuredClone(task);
    });
  }

  async cancelTask(input: TaskIdInput): Promise<TaskState> {
    return this.withTaskLease(input, async () => {
      const task = await this.transition(
        input,
        ["active", "paused", "failed"],
        "cancelled",
        "Only an active, paused or failed task can be cancelled.",
      );
      for (const step of task.steps) {
        if (step.status === "pending" || step.status === "running") {
          step.status = "cancelled";
        }
      }
      task.nextStepId = null;
      task.updatedAt = new Date().toISOString();
      await this.store.save(task.projectRoot, task);
      return structuredClone(task);
    });
  }

  async acquireTaskLease(input: Omit<AcquireTaskLeaseInput, "taskId"> & { taskId: string }): Promise<TaskState> {
    const parsedInput = acquireTaskLeaseInputSchema.parse(input);
    const projectRoot = await normalizeProjectRoot(parsedInput.projectRoot);
    const task = await this.requireTask(parsedInput.taskId, projectRoot);
    await this.ensureTaskLease(task, projectRoot, parsedInput.ttlMs ?? DEFAULT_TASK_LEASE_TTL_MS);
    this.explicitLeaseTaskIds.add(task.taskId);
    await this.store.save(task.projectRoot, task);
    return structuredClone(task);
  }

  async renewTaskLease(input: TaskLeaseInput): Promise<TaskState> {
    const parsedInput = taskLeaseInputSchema.parse(input);
    const projectRoot = await normalizeProjectRoot(parsedInput.projectRoot);
    const task = await this.requireTask(parsedInput.taskId, projectRoot);
    const currentLease = this.taskLeases.get(task.taskId);
    const leaseId = currentLease?.leaseId ?? task.lease?.leaseId;
    if (leaseId === undefined || leaseId !== parsedInput.leaseId) {
      throw new DomainError(ERROR_CODES.LEASE_INVALID, "The task lease is not owned by this coordinator.");
    }
    if (currentLease === undefined) {
      this.taskLeases.set(task.taskId, {
        leaseId,
        projectRoot,
        ownerId: task.lease?.ownerId ?? "",
        acquiredAt: task.lease?.acquiredAt ?? new Date().toISOString(),
        expiresAt: task.lease?.expiresAt ?? new Date().toISOString(),
      });
      this.taskLeaseTtls.set(task.taskId, parsedInput.ttlMs ?? DEFAULT_TASK_LEASE_TTL_MS);
    }
    await this.renewHeldTaskLease(task.taskId, parsedInput.ttlMs ?? DEFAULT_TASK_LEASE_TTL_MS);
    return structuredClone(this.tasks.get(task.taskId) ?? task);
  }

  async releaseTaskLease(input: TaskLeaseInput): Promise<TaskState> {
    const parsedInput = taskLeaseInputSchema.parse(input);
    const projectRoot = await normalizeProjectRoot(parsedInput.projectRoot);
    const task = await this.requireTask(parsedInput.taskId, projectRoot);
    const currentLease = this.taskLeases.get(task.taskId);
    const leaseId = currentLease?.leaseId ?? task.lease?.leaseId;
    if (leaseId === undefined || leaseId !== parsedInput.leaseId) {
      throw new DomainError(ERROR_CODES.LEASE_INVALID, "The task lease is not owned by this coordinator.");
    }
    this.explicitLeaseTaskIds.delete(task.taskId);
    if (currentLease === undefined) {
      this.taskLeases.set(task.taskId, {
        leaseId,
        projectRoot,
        ownerId: task.lease?.ownerId ?? "",
        acquiredAt: task.lease?.acquiredAt ?? new Date().toISOString(),
        expiresAt: task.lease?.expiresAt ?? new Date().toISOString(),
      });
      this.taskLeaseTtls.set(task.taskId, parsedInput.ttlMs ?? DEFAULT_TASK_LEASE_TTL_MS);
    }
    await this.releaseHeldTaskLease(task.taskId);
    return structuredClone(this.tasks.get(task.taskId) ?? task);
  }

  private async transition(
    input: TaskIdInput,
    allowedFrom: TaskState["status"][],
    to: TaskState["status"],
    message: string,
  ): Promise<TaskState> {
    const parsedInput = taskIdInputSchema.parse(input);
    const projectRoot = await normalizeProjectRoot(parsedInput.projectRoot);
    const task = await this.requireTask(parsedInput.taskId, projectRoot);
    if (!allowedFrom.includes(task.status)) {
      throw new DomainError(ERROR_CODES.TASK_INVALID_STATUS, message, {
        taskId: task.taskId,
        status: task.status,
      });
    }
    task.status = to;
    task.updatedAt = new Date().toISOString();
    this.appendTimeline(task, {
      stepId: null,
      operationId: null,
      status: to === "paused" ? "paused" : to === "active" ? "resumed" : "cancelled",
      at: task.updatedAt,
    });
    // Callers keep mutating the live task (for example cancelling pending
    // steps) and persist it themselves; returning the clone here would fork
    // the in-memory state from the saved file.
    return task;
  }

  private async executeStep(
    task: TaskState,
    step: TaskStepState,
  ): Promise<unknown> {
    const projectRoot = task.projectRoot;
    if (step.kind === "preview_diagnostic_repair") {
      return this.previewDiagnosticRepair(task, step);
    }
    if (step.kind === "apply_diagnostic_repair") {
      return this.applyDiagnosticRepair(task, step);
    }
    if (step.kind === "verify_diagnostics") {
      return this.verifyDiagnostics(task, step);
    }
    if (step.kind === "verify_scene_state") {
      return this.verifySceneState(projectRoot, step);
    }
    if (step.kind === "run_current_scene") {
      return this.changeCoordinator.runCurrentScene({
        projectRoot,
        timeoutMs: step.timeoutMs ?? undefined,
      });
    }
    if (step.kind === "run_scene") {
      if (step.scenePath === null) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "The run_scene step needs a scenePath.",
          { taskId: task.taskId, stepId: step.stepId },
        );
      }
      return this.changeCoordinator.runScene({
        projectRoot,
        scenePath: step.scenePath,
        timeoutMs: step.timeoutMs ?? undefined,
      });
    }
    if (step.planId === null) {
      throw new DomainError(
        ERROR_CODES.VALIDATION_FAILED,
        "The step needs a planId for plan-based operations.",
        { taskId: task.taskId, stepId: step.stepId },
      );
    }
    if (step.kind === "rollback_plan") {
      return this.changeCoordinator.rollbackChange({
        projectRoot,
        planId: step.planId,
        leaseId: this.taskLeases.get(task.taskId)?.leaseId,
      });
    }
    if (step.expectedRevision === null) {
      throw new DomainError(
        ERROR_CODES.VALIDATION_FAILED,
        "The apply step needs an expectedRevision; that is the explicit confirmation.",
        { taskId: task.taskId, stepId: step.stepId },
      );
    }
    await this.changeCoordinator.confirmChange({
      projectRoot,
      planId: step.planId,
      expectedRevision: step.expectedRevision,
    });
    return this.changeCoordinator.applyChange({
      projectRoot,
      planId: step.planId,
      leaseId: this.taskLeases.get(task.taskId)?.leaseId,
    });
  }

  private findUniqueEarlierStep(
    task: TaskState,
    referenceStepId: string | null,
    consumingStep: TaskStepState,
  ): TaskStepState | undefined {
    if (referenceStepId === null) {
      return undefined;
    }
    const matches = task.steps
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => candidate.stepId === referenceStepId);
    const match = matches[0];
    if (matches.length !== 1 || match === undefined || match.index >= task.steps.indexOf(consumingStep)) {
      return undefined;
    }
    return match.candidate;
  }

  private async previewDiagnosticRepair(
    task: TaskState,
    step: TaskStepState,
  ): Promise<DiagnosticRepairPreviewResult> {
    const runStep = this.findUniqueEarlierStep(task, step.runStepId, step);
    if (
      runStep === undefined ||
      (runStep.kind !== "run_current_scene" && runStep.kind !== "run_scene")
    ) {
      throw new DomainError(
        ERROR_CODES.TASK_VERIFICATION_FAILED,
        "The preview_diagnostic_repair step must reference an earlier run step.",
        { runStepId: step.runStepId, stepId: step.stepId },
      );
    }
    if (runStep.status !== "succeeded") {
      throw new DomainError(
        ERROR_CODES.TASK_VERIFICATION_FAILED,
        "The referenced run step did not complete successfully.",
        { runStepId: runStep.stepId, runStepStatus: runStep.status },
      );
    }
    const parsedDiagnostics = runDiagnosticsSchema.safeParse(runStep.result);
    if (!parsedDiagnostics.success) {
      throw new DomainError(
        ERROR_CODES.TASK_VERIFICATION_FAILED,
        "The referenced run step did not contain valid diagnostics.",
        { runStepId: runStep.stepId, reason: "invalid_run_diagnostics" },
      );
    }
    if (step.diagnosticKind === null || step.diagnosticIndex === null) {
      throw new DomainError(
        ERROR_CODES.TASK_VERIFICATION_FAILED,
        "The diagnostic kind and index are required for a repair preview.",
        { runStepId: runStep.stepId, stepId: step.stepId },
      );
    }

    const diagnostics = parsedDiagnostics.data;
    const entries = step.diagnosticKind === "error" ? diagnostics.errors : diagnostics.warnings;
    const diagnostic = entries[step.diagnosticIndex];
    if (diagnostic === undefined) {
      throw new DomainError(
        ERROR_CODES.TASK_VERIFICATION_FAILED,
        "The selected diagnostic does not exist in the referenced run.",
        {
          runStepId: runStep.stepId,
          runId: diagnostics.runId,
          diagnosticKind: step.diagnosticKind,
          diagnosticIndex: step.diagnosticIndex,
          availableCount: entries.length,
        },
      );
    }
    const repairHint = step.repairHint ?? diagnostic.repairHint;
    if (repairHint === undefined) {
      throw new DomainError(
        ERROR_CODES.TASK_VERIFICATION_FAILED,
        "The selected diagnostic does not contain an explicit safe repair hint.",
        {
          runStepId: runStep.stepId,
          runId: diagnostics.runId,
          diagnosticKind: step.diagnosticKind,
          diagnosticIndex: step.diagnosticIndex,
          diagnostic,
          reason: "missing_repair_hint",
        },
      );
    }

    const diagnosticForPreview = { ...diagnostic, repairHint };
    const plan = await this.changeCoordinator.previewRepairFromDiagnostic({
      projectRoot: task.projectRoot,
      diagnostic: diagnosticForPreview,
    });
    return diagnosticRepairPreviewResultSchema.parse({
      runStepId: runStep.stepId,
      runId: diagnostics.runId,
      diagnosticKind: step.diagnosticKind,
      diagnosticIndex: step.diagnosticIndex,
      diagnostic,
      repairHint,
      plan,
    });
  }

  private async applyDiagnosticRepair(task: TaskState, step: TaskStepState): Promise<unknown> {
    const previewStep = this.findUniqueEarlierStep(task, step.previewStepId, step);
    if (previewStep === undefined || previewStep.kind !== "preview_diagnostic_repair" || previewStep.status !== "succeeded") {
      throw new DomainError(
        ERROR_CODES.TASK_VERIFICATION_FAILED,
        "The apply_diagnostic_repair step must reference a successful earlier repair preview.",
        { previewStepId: step.previewStepId, stepId: step.stepId },
      );
    }
    const preview = diagnosticRepairPreviewResultSchema.safeParse(previewStep.result);
    if (!preview.success) {
      throw new DomainError(
        ERROR_CODES.TASK_VERIFICATION_FAILED,
        "The referenced repair preview evidence is invalid.",
        { previewStepId: previewStep.stepId },
      );
    }
    const report = await this.changeCoordinator.applyChange({
      projectRoot: task.projectRoot,
      planId: preview.data.plan.planId,
      leaseId: this.taskLeases.get(task.taskId)?.leaseId,
    });
    return {
      previewStepId: previewStep.stepId,
      runStepId: preview.data.runStepId,
      runId: preview.data.runId,
      planId: preview.data.plan.planId,
      report,
    };
  }

  private verifyDiagnostics(task: TaskState, step: TaskStepState): unknown {
    const runStepId = step.runStepId;
    const verificationStepIndex = task.steps.indexOf(step);
    const runStepMatches = runStepId === null
      ? []
      : task.steps
          .map((candidate, index) => ({ candidate, index }))
          .filter(({ candidate }) => candidate.stepId === runStepId);
    const runStepMatch = runStepMatches[0];
    if (
      runStepId === null ||
      runStepMatches.length !== 1 ||
      runStepMatch === undefined ||
      runStepMatch.index >= verificationStepIndex ||
      (runStepMatch.candidate.kind !== "run_current_scene" && runStepMatch.candidate.kind !== "run_scene")
    ) {
      throw new DomainError(
        ERROR_CODES.TASK_VERIFICATION_FAILED,
        "The verify_diagnostics step must reference an earlier run step.",
        { runStepId, verificationStepId: step.stepId },
      );
    }
    const runStep = runStepMatch.candidate;
    if (runStep.status !== "succeeded") {
      throw new DomainError(
        ERROR_CODES.TASK_VERIFICATION_FAILED,
        "The referenced run step did not complete successfully.",
        { runStepId, runStepStatus: runStep.status },
      );
    }

    const parsedDiagnostics = runDiagnosticsSchema.safeParse(runStep.result);
    if (!parsedDiagnostics.success) {
      throw new DomainError(
        ERROR_CODES.TASK_VERIFICATION_FAILED,
        "The referenced run step did not contain valid diagnostics.",
        { runStepId, reason: "invalid_run_diagnostics" },
      );
    }

    const diagnostics = parsedDiagnostics.data;
    const evidence = {
      runStepId,
      runId: diagnostics.runId,
      scenePath: diagnostics.scenePath,
      status: diagnostics.status,
      errorCount: diagnostics.errors.length,
      warningCount: diagnostics.warnings.length,
      maxErrors: step.maxErrors,
      maxWarnings: step.maxWarnings,
    };
    if (
      diagnostics.status !== "stopped" ||
      diagnostics.errors.length > step.maxErrors ||
      diagnostics.warnings.length > step.maxWarnings
    ) {
      throw new DomainError(
        ERROR_CODES.TASK_VERIFICATION_FAILED,
        "Run diagnostics did not meet the configured thresholds.",
        { ...evidence, errors: diagnostics.errors, warnings: diagnostics.warnings },
      );
    }
    return { passed: true, ...evidence };
  }

  private async verifySceneState(projectRoot: string, step: TaskStepState): Promise<unknown> {
    const nodePath = step.nodePath;
    if (nodePath === null) {
      throw new DomainError(
        ERROR_CODES.TASK_VERIFICATION_FAILED,
        "The verify_scene_state step is missing its NodePath.",
        { stepId: step.stepId },
      );
    }

    const context = await this.changeCoordinator.getContext(projectRoot);
    if (context.connection !== "connected") {
      throw new DomainError(ERROR_CODES.EDITOR_UNAVAILABLE, "The Godot editor is not connected.");
    }
    const scenePath = context.currentScene.path;
    if (scenePath === null) {
      throw new DomainError(
        ERROR_CODES.TASK_VERIFICATION_FAILED,
        "The current scene is unavailable for verification.",
        { nodePath, expectedScene: true, actualScene: null, revision: context.revision },
      );
    }

    const node = context.currentScene.nodes.find((candidate) => candidate.path === nodePath);
    if (node === undefined) {
      throw new DomainError(
        ERROR_CODES.TASK_VERIFICATION_FAILED,
        "The expected scene node does not exist.",
        { nodePath, expectedExists: true, actualExists: false, scenePath, revision: context.revision },
      );
    }

    const properties = step.expectedProperties.map((assertion) => {
      const actualPresent = Object.hasOwn(node.properties, assertion.property);
      const actual = actualPresent ? node.properties[assertion.property] : null;
      return {
        property: assertion.property,
        expected: assertion.expected,
        actual,
        actualPresent,
        matches: actualPresent && sceneValueMatches(assertion.expected, actual),
      };
    });
    const mismatches = properties
      .filter((property) => !property.matches)
      .map(({ property, expected, actual, actualPresent }) => ({ property, expected, actual, actualPresent }));
    if (mismatches.length > 0) {
      throw new DomainError(
        ERROR_CODES.TASK_VERIFICATION_FAILED,
        "One or more expected scene properties did not match.",
        { nodePath, scenePath, revision: context.revision, mismatches },
      );
    }

    return {
      passed: true,
      scenePath,
      nodePath,
      revision: context.revision,
      properties: properties.map(({ property, expected, actual }) => ({ property, expected, actual })),
    };
  }

  private async withTaskLease<T>(input: TaskIdInput, action: () => Promise<T>): Promise<T> {
    const parsedInput = taskIdInputSchema.parse(input);
    const projectRoot = await normalizeProjectRoot(parsedInput.projectRoot);
    const task = await this.requireTask(parsedInput.taskId, projectRoot);
    await this.ensureTaskLease(task, projectRoot);
    try {
      return await action();
    } finally {
      const latestTask = this.tasks.get(task.taskId);
      if (!this.explicitLeaseTaskIds.has(task.taskId) || latestTask?.status !== "active") {
        await this.releaseHeldTaskLease(task.taskId);
      }
    }
  }

  private async ensureTaskLease(
    task: TaskState,
    projectRoot: string,
    ttlMs = DEFAULT_TASK_LEASE_TTL_MS,
  ): Promise<ProjectLease> {
    let reclaimReason: "lease_expired" | "lease_missing" | "lease_replaced" | null = null;
    const previousLease = task.lease;
    const existingLease = this.taskLeases.get(task.taskId);
    if (existingLease !== undefined) {
      try {
        await this.leaseStore.assert(projectRoot, existingLease.leaseId);
        const heartbeatTtlMs =
          this.taskLeaseTtls.get(task.taskId) ?? this.leaseHeartbeats.get(task.taskId)?.ttlMs ?? ttlMs;
        if (task.status === "paused" && task.recoverable) {
          await this.renewHeldTaskLease(task.taskId, heartbeatTtlMs);
          const recoveredLease = this.taskLeases.get(task.taskId);
          if (recoveredLease === undefined) {
            throw new DomainError(ERROR_CODES.LEASE_NOT_FOUND, "The task lease was lost during recovery.");
          }
          task.updatedAt = new Date().toISOString();
          this.appendTimeline(task, {
            stepId: null,
            operationId: null,
            status: "lease_recovered",
            at: task.updatedAt,
            result: {
              leaseId: recoveredLease.leaseId,
              previousOwnerId: recoveredLease.ownerId,
              ownerId: recoveredLease.ownerId,
              reason: "same_owner_resume",
            },
          });
          await this.store.save(task.projectRoot, task);
          return recoveredLease;
        }
        if (task.recoverable) {
          task.lease = this.taskLeaseState(existingLease);
          task.recoverable = false;
          task.updatedAt = new Date().toISOString();
          await this.store.save(task.projectRoot, task);
        }
        this.startLeaseHeartbeat(task, existingLease, heartbeatTtlMs);
        return existingLease;
      } catch (error) {
        reclaimReason = this.taskLeaseReclaimReason(error);
        if (reclaimReason === null) {
          throw error;
        }
        if (this.taskLeases.get(task.taskId)?.leaseId === existingLease.leaseId) {
          this.taskLeases.delete(task.taskId);
          this.taskLeaseTtls.delete(task.taskId);
        }
        this.stopLeaseHeartbeat(task.taskId);
      }
    }
    if (reclaimReason === null && previousLease !== null) {
      try {
        await this.leaseStore.assert(projectRoot, previousLease.leaseId);
        throw new DomainError(ERROR_CODES.PROJECT_BUSY, "The task is leased by another coordinator.", {
          taskId: task.taskId,
          ownerId: previousLease.ownerId,
          expiresAt: previousLease.expiresAt,
        });
      } catch (error) {
        reclaimReason = this.taskLeaseReclaimReason(error);
        if (reclaimReason === null) {
          throw error;
        }
      }
    }
    const lease = await this.leaseStore.acquire(projectRoot, this.ownerId + ":" + task.taskId, ttlMs);
    this.taskLeases.set(task.taskId, lease);
    this.taskLeaseTtls.set(task.taskId, ttlMs);
    task.lease = this.taskLeaseState(lease);
    task.recoverable = false;
    task.updatedAt = new Date().toISOString();
    this.appendTimeline(task, {
      stepId: null,
      operationId: null,
      status: reclaimReason === null ? "lease_acquired" : "lease_reclaimed",
      at: task.updatedAt,
      result: {
        leaseId: lease.leaseId,
        ownerId: lease.ownerId,
        expiresAt: lease.expiresAt,
        ...(reclaimReason === null
          ? {}
          : { previousOwnerId: previousLease?.ownerId ?? null, reason: reclaimReason }),
      },
    });
    await this.store.save(task.projectRoot, task);
    this.startLeaseHeartbeat(task, lease, ttlMs);
    return lease;
  }

  private taskLeaseReclaimReason(
    error: unknown,
  ): "lease_expired" | "lease_missing" | "lease_replaced" | null {
    if (!(error instanceof DomainError)) {
      return null;
    }
    if (error.code === ERROR_CODES.LEASE_EXPIRED) {
      return "lease_expired";
    }
    if (error.code === ERROR_CODES.LEASE_NOT_FOUND) {
      return "lease_missing";
    }
    if (error.code === ERROR_CODES.LEASE_INVALID) {
      return "lease_replaced";
    }
    return null;
  }

  private async releaseHeldTaskLease(taskId: string): Promise<void> {
    const lease = this.taskLeases.get(taskId);
    if (lease === undefined) {
      return;
    }
    this.stopLeaseHeartbeat(taskId);
    this.taskLeases.delete(taskId);
    this.taskLeaseTtls.delete(taskId);
    await this.leaseStore.release(lease).catch(() => undefined);
    const task = this.tasks.get(taskId);
    if (task !== undefined) {
      task.lease = null;
      task.recoverable = true;
      task.updatedAt = new Date().toISOString();
      this.appendTimeline(task, {
        stepId: null,
        operationId: null,
        status: "lease_released",
        at: task.updatedAt,
        result: { leaseId: lease.leaseId, ownerId: lease.ownerId },
      });
      await this.store.save(task.projectRoot, task);
    }
  }

  private startLeaseHeartbeat(task: TaskState, lease: ProjectLease, ttlMs: number): void {
    const current = this.leaseHeartbeats.get(task.taskId);
    if (current?.leaseId === lease.leaseId && current.ttlMs === ttlMs) {
      return;
    }
    this.stopLeaseHeartbeat(task.taskId);
    const timer = setInterval(() => {
      void this.renewHeldTaskLease(task.taskId, ttlMs).catch(() => undefined);
    }, Math.max(100, Math.floor(ttlMs / 3)));
    timer.unref?.();
    this.leaseHeartbeats.set(task.taskId, { timer, leaseId: lease.leaseId, ttlMs, renewing: false });
  }

  private stopLeaseHeartbeat(taskId: string): void {
    const heartbeat = this.leaseHeartbeats.get(taskId);
    if (heartbeat === undefined) {
      return;
    }
    clearInterval(heartbeat.timer);
    this.leaseHeartbeats.delete(taskId);
  }

  private async renewHeldTaskLease(taskId: string, ttlMs: number): Promise<void> {
    const heartbeat = this.leaseHeartbeats.get(taskId);
    if (heartbeat?.renewing) {
      return;
    }
    if (heartbeat !== undefined) {
      heartbeat.renewing = true;
    }
    try {
      const task = this.tasks.get(taskId);
      const lease = this.taskLeases.get(taskId);
      if (task === undefined || lease === undefined) {
        return;
      }
      const renewed = await this.leaseStore.renew(lease, ttlMs);
      this.taskLeases.set(taskId, renewed);
      this.taskLeaseTtls.set(taskId, ttlMs);
      task.lease = this.taskLeaseState(renewed);
      task.recoverable = false;
      task.updatedAt = new Date().toISOString();
      this.appendTimeline(task, {
        stepId: null,
        operationId: null,
        status: "lease_renewed",
        at: task.updatedAt,
        result: { leaseId: renewed.leaseId, ownerId: renewed.ownerId, expiresAt: renewed.expiresAt },
      });
      await this.store.save(task.projectRoot, task);
      if (heartbeat !== undefined) {
        heartbeat.leaseId = renewed.leaseId;
      }
      this.startLeaseHeartbeat(task, renewed, ttlMs);
    } catch (error) {
      this.stopLeaseHeartbeat(taskId);
      const failedLease = this.taskLeases.get(taskId);
      if (failedLease !== undefined && (heartbeat === undefined || failedLease.leaseId === heartbeat.leaseId)) {
        let leaseStillValid = false;
        try {
          await this.leaseStore.assert(failedLease.projectRoot, failedLease.leaseId);
          leaseStillValid = true;
        } catch {
        }
        if (!leaseStillValid) {
          this.taskLeases.delete(taskId);
          this.taskLeaseTtls.delete(taskId);
        }
      }
      const task = this.tasks.get(taskId);
      if (task !== undefined) {
        task.recoverable = true;
        const shouldPause = task.status === "active";
        if (shouldPause) {
          task.status = "paused";
        }
        task.updatedAt = new Date().toISOString();
        const renewalError =
          error instanceof DomainError
            ? { code: error.code, message: error.message }
            : { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) };
        this.appendTimeline(task, {
          stepId: null,
          operationId: null,
          status: "lease_renew_failed",
          at: task.updatedAt,
          error: renewalError,
        });
        if (shouldPause) {
          this.appendTimeline(task, {
            stepId: null,
            operationId: null,
            status: "paused",
            at: task.updatedAt,
            error: renewalError,
          });
        }
        await this.store.save(task.projectRoot, task).catch(() => undefined);
      }
      throw error;
    } finally {
      if (heartbeat !== undefined && this.leaseHeartbeats.get(taskId) === heartbeat) {
        heartbeat.renewing = false;
      }
    }
  }

  private taskLeaseState(lease: ProjectLease): TaskLease {
    return {
      leaseId: lease.leaseId,
      ownerId: lease.ownerId,
      acquiredAt: lease.acquiredAt,
      expiresAt: lease.expiresAt,
    };
  }

  private refreshTaskRecoverability(task: TaskState): void {
    task.recoverable =
      task.recoverable || task.lease === null || Date.parse(task.lease.expiresAt) <= Date.now();
  }

  private isTaskPausedForRecovery(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    return task?.status === "paused" && task.recoverable;
  }

  private findNextStep(task: TaskState): TaskStepState | undefined {
    return task.steps.find(
      (step) => step.status === "pending" || step.status === "failed" || step.status === "running",
    );
  }

  private toStepState(step: CreateTaskInput["steps"][number]): TaskStepState {
    return {
      stepId: step.stepId,
      kind: step.kind,
      planId: "planId" in step ? step.planId : null,
      scenePath: "scenePath" in step ? step.scenePath : null,
      nodePath: "nodePath" in step ? step.nodePath : null,
      expectedProperties: "expectedProperties" in step ? step.expectedProperties ?? [] : [],
      runStepId: "runStepId" in step ? step.runStepId : null,
      maxErrors: "maxErrors" in step ? step.maxErrors ?? 0 : 0,
      maxWarnings: "maxWarnings" in step ? step.maxWarnings ?? 0 : 0,
      diagnosticKind: "diagnosticKind" in step ? step.diagnosticKind : null,
      diagnosticIndex: "diagnosticIndex" in step ? step.diagnosticIndex : null,
      repairHint: "repairHint" in step ? step.repairHint ?? null : null,
      previewStepId: "previewStepId" in step ? step.previewStepId : null,
      timeoutMs: "timeoutMs" in step ? step.timeoutMs ?? null : null,
      expectedRevision: "expectedRevision" in step ? step.expectedRevision : null,
      status: "pending",
      attempts: 0,
      startedAt: null,
      finishedAt: null,
      operationId: null,
    };
  }

  private appendTimeline(task: TaskState, event: Omit<TaskTimelineEvent, "eventId">): void {
    task.timeline.push({
      eventId: "event_" + randomUUID().replaceAll("-", "").slice(0, 20),
      ...event,
    });
  }

  private async requireTask(taskId: string, projectRoot: string): Promise<TaskState> {
    const inMemory = this.tasks.get(taskId);
    if (inMemory !== undefined) {
      if (inMemory.projectRoot !== projectRoot) {
        throw new DomainError(
          ERROR_CODES.UNSAFE_OPERATION,
          "The task project root does not match the requested project root.",
          { taskId },
        );
      }
      return inMemory;
    }

    const restored = await this.store.load(projectRoot, taskId);
    if (restored === null) {
      throw new DomainError(ERROR_CODES.TASK_NOT_FOUND, "The task was not found.", { taskId });
    }
    if (restored.projectRoot !== projectRoot) {
      throw new DomainError(
        ERROR_CODES.UNSAFE_OPERATION,
        "The task project root does not match the requested project root.",
        { taskId },
      );
    }
    // A step left "running" means the process died mid-advance; keep it
    // retryable so the task can recover from the last durable state.
    if (restored.status === "active" && restored.nextStepId === null) {
      restored.nextStepId = this.findNextStep(restored)?.stepId ?? null;
    }
    this.tasks.set(taskId, restored);
    return restored;
  }
}
