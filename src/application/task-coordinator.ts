import { randomUUID } from "node:crypto";
import type { ChangeCoordinator } from "./change-coordinator.js";
import {
  createTaskInputSchema,
  acquireTaskLeaseInputSchema,
  taskIdInputSchema,
  taskLeaseInputSchema,
  type AcquireTaskLeaseInput,
  type CreateTaskInput,
  type TaskIdInput,
  type TaskState,
  type TaskLease,
  type TaskLeaseInput,
  type TaskStepState,
  type TaskTimelineEvent,
} from "../domain/task-contracts.js";
import { DomainError, ERROR_CODES } from "../domain/errors.js";
import type { FileTaskStore } from "../infrastructure/task-store.js";
import {
  type ProjectLease,
  type ProjectLeaseStore,
} from "../infrastructure/project-lease-store.js";
import { normalizeProjectRoot } from "../infrastructure/project-root.js";

const MAX_STEP_ATTEMPTS = 3;
const DEFAULT_TASK_LEASE_TTL_MS = 120000;

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
  private readonly taskLeases = new Map<string, ProjectLease>();
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

  async advanceTask(input: TaskIdInput): Promise<TaskState> {
    const parsedInput = taskIdInputSchema.parse(input);
    const projectRoot = await normalizeProjectRoot(parsedInput.projectRoot);
    const task = await this.requireTask(parsedInput.taskId, projectRoot);
    await this.ensureTaskLease(task, projectRoot);
    try {
      return await this.advanceTaskInternal(input);
    } finally {
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
      step.status = "failed";
      step.finishedAt = new Date().toISOString();
      step.error =
        error instanceof DomainError
          ? { code: error.code, message: error.message }
          : {
              code: "INTERNAL_ERROR",
              message: error instanceof Error ? error.message : String(error),
            };
      task.status = "failed";
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

    task.status = "active";
    const next = this.findNextStep(task);
    task.nextStepId = next?.stepId ?? null;
    if (next === undefined) {
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
    const existingLease = this.taskLeases.get(task.taskId);
    if (existingLease !== undefined) {
      await this.leaseStore.assert(projectRoot, existingLease.leaseId);
      this.startLeaseHeartbeat(task, existingLease, ttlMs);
      return existingLease;
    }
    let reclaimed = false;
    if (task.lease !== null) {
      try {
        await this.leaseStore.assert(projectRoot, task.lease.leaseId);
        throw new DomainError(ERROR_CODES.PROJECT_BUSY, "The task is leased by another coordinator.", {
          taskId: task.taskId,
          ownerId: task.lease.ownerId,
          expiresAt: task.lease.expiresAt,
        });
      } catch (error) {
        if (
          !(error instanceof DomainError) ||
          (error.code !== ERROR_CODES.LEASE_EXPIRED && error.code !== ERROR_CODES.LEASE_NOT_FOUND)
        ) {
          throw error;
        }
        reclaimed = true;
      }
    }
    const lease = await this.leaseStore.acquire(projectRoot, this.ownerId + ":" + task.taskId, ttlMs);
    this.taskLeases.set(task.taskId, lease);
    task.lease = this.taskLeaseState(lease);
    task.recoverable = false;
    task.updatedAt = new Date().toISOString();
    this.appendTimeline(task, {
      stepId: null,
      operationId: null,
      status: reclaimed ? "lease_reclaimed" : "lease_acquired",
      at: task.updatedAt,
      result: { leaseId: lease.leaseId, ownerId: lease.ownerId, expiresAt: lease.expiresAt },
    });
    await this.store.save(task.projectRoot, task);
    this.startLeaseHeartbeat(task, lease, ttlMs);
    return lease;
  }

  private async releaseHeldTaskLease(taskId: string): Promise<void> {
    const lease = this.taskLeases.get(taskId);
    if (lease === undefined) {
      return;
    }
    this.stopLeaseHeartbeat(taskId);
    this.taskLeases.delete(taskId);
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
      } else {
        this.startLeaseHeartbeat(task, renewed, ttlMs);
      }
    } catch (error) {
      this.stopLeaseHeartbeat(taskId);
      const task = this.tasks.get(taskId);
      if (task !== undefined) {
        task.recoverable = true;
        task.updatedAt = new Date().toISOString();
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
    task.recoverable = task.lease === null || Date.parse(task.lease.expiresAt) <= Date.now();
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
