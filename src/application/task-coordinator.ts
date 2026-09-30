import { randomUUID } from "node:crypto";
import type { ChangeCoordinator } from "./change-coordinator.js";
import {
  createTaskInputSchema,
  taskIdInputSchema,
  type CreateTaskInput,
  type TaskIdInput,
  type TaskState,
  type TaskStepState,
} from "../domain/task-contracts.js";
import { DomainError, ERROR_CODES } from "../domain/errors.js";
import type { FileTaskStore } from "../infrastructure/task-store.js";
import { normalizeProjectRoot } from "../infrastructure/project-root.js";

const MAX_STEP_ATTEMPTS = 3;

/**
 * Orchestrates bounded multi-step Godot tasks on top of the existing
 * preview/confirm/apply/rollback/run use cases. A task never introduces a new
 * write capability: every step re-enters ChangeCoordinator, so confirmation,
 * revision guards, audit entries and Godot UndoRedo semantics stay in force.
 */
export class TaskCoordinator {
  private readonly tasks = new Map<string, TaskState>();

  constructor(
    private readonly changeCoordinator: ChangeCoordinator,
    private readonly store: FileTaskStore,
  ) {}

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
    };
    this.tasks.set(task.taskId, task);
    await this.store.save(projectRoot, task);
    return structuredClone(task);
  }

  async getTask(input: TaskIdInput): Promise<TaskState> {
    const parsedInput = taskIdInputSchema.parse(input);
    const projectRoot = await normalizeProjectRoot(parsedInput.projectRoot);
    return structuredClone(await this.requireTask(parsedInput.taskId, projectRoot));
  }

  async advanceTask(input: TaskIdInput): Promise<TaskState> {
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
    step.startedAt = new Date().toISOString();
    step.result = undefined;
    step.error = undefined;
    task.updatedAt = step.startedAt;
    await this.store.save(task.projectRoot, task);

    try {
      step.result = await this.executeStep(task, step);
      step.status = "succeeded";
      step.finishedAt = new Date().toISOString();
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
    const task = await this.transition(input, ["active"], "paused", "Only an active task can be paused.");
    await this.store.save(task.projectRoot, task);
    return structuredClone(task);
  }

  async resumeTask(input: TaskIdInput): Promise<TaskState> {
    const task = await this.transition(input, ["paused"], "active", "Only a paused task can be resumed.");
    await this.store.save(task.projectRoot, task);
    return structuredClone(task);
  }

  async cancelTask(input: TaskIdInput): Promise<TaskState> {
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
      return this.changeCoordinator.runCurrentScene({ projectRoot });
    }
    if (step.planId === null) {
      throw new DomainError(
        ERROR_CODES.VALIDATION_FAILED,
        "The step needs a planId for plan-based operations.",
        { taskId: task.taskId, stepId: step.stepId },
      );
    }
    if (step.kind === "rollback_plan") {
      return this.changeCoordinator.rollbackChange({ projectRoot, planId: step.planId });
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
    return this.changeCoordinator.applyChange({ projectRoot, planId: step.planId });
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
      expectedRevision: "expectedRevision" in step ? step.expectedRevision : null,
      status: "pending",
      attempts: 0,
      startedAt: null,
      finishedAt: null,
    };
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
