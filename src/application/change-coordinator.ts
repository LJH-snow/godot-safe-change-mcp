import { createHash, randomUUID } from "node:crypto";
import {
  applyChangeInputSchema,
  changePlanSchema,
  confirmChangeInputSchema,
  previewSceneChangeInputSchema,
  type ApplyChangeInput,
  type ChangePlan,
  type ConfirmChangeInput,
  type PreviewSceneChangeInput,
} from "../domain/change-contracts.js";
import type {
  ChangeReport,
  DiagnosticEntry,
  EditorContext,
  OperationAuditEntry,
  OperationHistoryInput,
  OperationHistoryReport,
  OperationKind,
  PreviewRepairFromDiagnosticInput,
  RollbackReport,
  RunDiagnostics,
} from "../domain/contracts.js";
import { previewRepairFromDiagnosticInputSchema } from "../domain/contracts.js";
import { operationHistoryInputSchema } from "../domain/contracts.js";
import { DomainError, ERROR_CODES } from "../domain/errors.js";
import type { GodotBridge } from "../infrastructure/godot-bridge.js";
import { normalizeProjectRoot } from "../infrastructure/project-root.js";

type PlanState = "preview" | "confirmed" | "applied" | "rolled_back";

interface StoredPlan {
  plan: ChangePlan;
  state: PlanState;
  appliedRevision?: string;
  appliedFileRevision?: string;
}

export interface ConfirmedChange {
  planId: string;
  status: "confirmed";
  expectedRevision: string;
}

export interface RunCurrentSceneInput {
  projectRoot: string;
  timeoutMs?: number;
}

export class ChangeCoordinator {
  private readonly plans = new Map<string, StoredPlan>();
  private readonly auditLog: OperationAuditEntry[] = [];

  constructor(private readonly bridge: GodotBridge) {}

  async getContext(projectRootInput: string): Promise<EditorContext> {
    return this.bridge.getContext(await normalizeProjectRoot(projectRootInput));
  }

  async previewSceneChange(input: PreviewSceneChangeInput): Promise<ChangePlan> {
    return this.withAudit("preview", input.projectRoot, null, input, () =>
      this.previewSceneChangeInternal(input),
    );
  }

  private async previewSceneChangeInternal(input: PreviewSceneChangeInput): Promise<ChangePlan> {
    const parsedInput = previewSceneChangeInputSchema.parse(input);
    const projectRoot = await normalizeProjectRoot(parsedInput.projectRoot);
    const context = await this.requireConnectedContext(projectRoot);
    const scenePath = context.currentScene.path;

    if (scenePath === null) {
      throw new DomainError(
        ERROR_CODES.VALIDATION_FAILED,
        "A current scene is required before previewing a scene change.",
      );
    }

    const fingerprint = JSON.stringify({
      projectRoot,
      expectedRevision: context.revision,
      reason: parsedInput.reason,
      operation: parsedInput.operation,
    });
    const planId = createHash("sha256").update(fingerprint).digest("hex").slice(0, 20);
    const operation = parsedInput.operation;
    let expectedFileRevision: string | null = null;
    let diff;
    if (operation.kind === "scene.create_node") {
      const target =
        operation.parentPath === "."
          ? scenePath + ":" + operation.nodeName
          : scenePath + ":" + operation.parentPath + "/" + operation.nodeName;
      diff = {
        kind: "scene.add_node" as const,
        target,
        summary:
          "Create " +
          operation.nodeType +
          " " +
          operation.nodeName +
          " under " +
          operation.parentPath +
          " in " +
          scenePath,
      };
    } else {
      const snapshot = await this.bridge.readScript(projectRoot, operation.scriptPath);
      const lines = snapshot.content.split("\n");
      if (operation.endLine > lines.length) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "The script replacement range is outside the current file.",
          { scriptPath: operation.scriptPath, lineCount: lines.length },
        );
      }
      expectedFileRevision = snapshot.revision;
      diff = {
        kind: "script.replace_range" as const,
        target: operation.scriptPath + ":" + operation.startLine + "-" + operation.endLine,
        summary: "Replace lines " + operation.startLine + "-" + operation.endLine + " in " + operation.scriptPath,
        startLine: operation.startLine,
        endLine: operation.endLine,
        before: lines.slice(operation.startLine - 1, operation.endLine).join("\n"),
        after: operation.replacement,
      };
    }
    const plan = changePlanSchema.parse({
      schemaVersion: "0.2",
      planId,
      projectRoot,
      expectedRevision: context.revision,
      expectedFileRevision,
      mode: "preview",
      reason: parsedInput.reason,
      operations: [operation],
      diff: [diff],
    });

    this.plans.set(planId, { plan, state: "preview" });
    return plan;
  }

  async confirmChange(input: ConfirmChangeInput): Promise<ConfirmedChange> {
    return this.withAudit("confirm", input.projectRoot, input.planId, input, () =>
      this.confirmChangeInternal(input),
    );
  }

  private async confirmChangeInternal(input: ConfirmChangeInput): Promise<ConfirmedChange> {
    const parsedInput = confirmChangeInputSchema.parse(input);
    const storedPlan = await this.requirePlan(parsedInput.planId, parsedInput.projectRoot);

    if (storedPlan.state === "applied") {
      throw new DomainError(
        ERROR_CODES.PLAN_ALREADY_APPLIED,
        "The change plan has already been applied.",
        { planId: parsedInput.planId },
      );
    }

    if (storedPlan.state === "rolled_back") {
      throw new DomainError(
        ERROR_CODES.PLAN_ALREADY_ROLLED_BACK,
        "The change plan has already been rolled back.",
        { planId: parsedInput.planId },
      );
    }

    if (parsedInput.expectedRevision !== storedPlan.plan.expectedRevision) {
      throw new DomainError(
        ERROR_CODES.REVISION_CONFLICT,
        "The confirmation revision does not match the preview revision.",
        {
          expectedRevision: storedPlan.plan.expectedRevision,
          actualRevision: parsedInput.expectedRevision,
        },
      );
    }

    await this.assertPlanRevision(storedPlan.plan);
    storedPlan.state = "confirmed";
    return {
      planId: storedPlan.plan.planId,
      status: "confirmed",
      expectedRevision: storedPlan.plan.expectedRevision,
    };
  }

  async applyChange(input: ApplyChangeInput): Promise<ChangeReport> {
    return this.withAudit("apply", input.projectRoot, input.planId, input, () =>
      this.applyChangeInternal(input),
    );
  }

  private async applyChangeInternal(input: ApplyChangeInput): Promise<ChangeReport> {
    const parsedInput = applyChangeInputSchema.parse(input);
    const storedPlan = await this.requirePlan(parsedInput.planId, parsedInput.projectRoot);

    if (storedPlan.state === "applied") {
      throw new DomainError(
        ERROR_CODES.PLAN_ALREADY_APPLIED,
        "The change plan has already been applied.",
        { planId: parsedInput.planId },
      );
    }

    if (storedPlan.state !== "confirmed") {
      throw new DomainError(
        ERROR_CODES.CONFIRMATION_REQUIRED,
        "The change plan must be explicitly confirmed before apply.",
        { planId: parsedInput.planId },
      );
    }

    await this.assertPlanRevision(storedPlan.plan);
    const report = await this.bridge.applyChange(storedPlan.plan.projectRoot, {
      planId: storedPlan.plan.planId,
      expectedRevision: storedPlan.plan.expectedRevision,
      expectedFileRevision: storedPlan.plan.expectedFileRevision ?? undefined,
      operations: storedPlan.plan.operations,
    });
    storedPlan.state = "applied";
    storedPlan.appliedRevision = report.revision;
    storedPlan.appliedFileRevision = report.fileRevision;
    return report;
  }

  async rollbackChange(input: ApplyChangeInput): Promise<RollbackReport> {
    return this.withAudit("rollback", input.projectRoot, input.planId, input, () =>
      this.rollbackChangeInternal(input),
    );
  }

  private async rollbackChangeInternal(input: ApplyChangeInput): Promise<RollbackReport> {
    const parsedInput = applyChangeInputSchema.parse(input);
    const storedPlan = await this.requirePlan(parsedInput.planId, parsedInput.projectRoot);

    if (storedPlan.state === "rolled_back") {
      throw new DomainError(
        ERROR_CODES.PLAN_ALREADY_ROLLED_BACK,
        "The change plan has already been rolled back.",
        { planId: parsedInput.planId },
      );
    }

    if (storedPlan.state !== "applied" || storedPlan.appliedRevision === undefined) {
      throw new DomainError(
        ERROR_CODES.PLAN_NOT_APPLIED,
        "Only an applied change plan can be rolled back.",
        { planId: parsedInput.planId },
      );
    }

    const context = await this.requireConnectedContext(storedPlan.plan.projectRoot);
    if (context.revision !== storedPlan.appliedRevision) {
      throw new DomainError(
        ERROR_CODES.REVISION_CONFLICT,
        "The editor changed after the plan was applied; refusing to undo another change.",
        {
          expectedRevision: storedPlan.appliedRevision,
          actualRevision: context.revision,
        },
      );
    }

    if (storedPlan.appliedFileRevision !== undefined) {
      const operation = storedPlan.plan.operations[0];
      if (operation.kind !== "script.replace_range") {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "The applied file revision is only valid for script operations.",
        );
      }
      const snapshot = await this.bridge.readScript(storedPlan.plan.projectRoot, operation.scriptPath);
      if (snapshot.revision !== storedPlan.appliedFileRevision) {
        throw new DomainError(
          ERROR_CODES.REVISION_CONFLICT,
          "The script changed after the plan was applied; refusing to overwrite it.",
          {
            expectedFileRevision: storedPlan.appliedFileRevision,
            actualFileRevision: snapshot.revision,
          },
        );
      }
    }

    const report = await this.bridge.rollbackChange(storedPlan.plan.projectRoot, {
      planId: storedPlan.plan.planId,
      expectedRevision: storedPlan.appliedRevision,
      expectedFileRevision: storedPlan.appliedFileRevision,
    });
    storedPlan.state = "rolled_back";
    return report;
  }

  async runCurrentScene(input: RunCurrentSceneInput): Promise<RunDiagnostics> {
    return this.withAudit("run", input.projectRoot, null, input, () =>
      this.runCurrentSceneInternal(input),
    );
  }

  private async runCurrentSceneInternal(input: RunCurrentSceneInput): Promise<RunDiagnostics> {
    const projectRoot = await normalizeProjectRoot(input.projectRoot);
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 10000, 100), 30000);
    await this.requireConnectedContext(projectRoot);
    const diagnostics = await this.bridge.runCurrentScene(projectRoot, timeoutMs);
    return this.associateDiagnostics(projectRoot, diagnostics);
  }

  async previewRepairFromDiagnostic(
    input: PreviewRepairFromDiagnosticInput,
  ): Promise<ChangePlan> {
    return this.withAudit("preview", input.projectRoot, null, input, async () => {
      const parsedInput = previewRepairFromDiagnosticInputSchema.parse(input);
      const repairHint = parsedInput.diagnostic.repairHint;
      if (repairHint === undefined) {
        throw new DomainError(
          ERROR_CODES.OPERATION_REJECTED,
          "The diagnostic does not contain a supported repair hint.",
        );
      }

      return this.previewSceneChangeInternal({
        projectRoot: parsedInput.projectRoot,
        reason: repairHint.reason,
        operation: {
          kind: repairHint.kind,
          parentPath: repairHint.parentPath,
          nodeName: repairHint.nodeName,
          nodeType: repairHint.nodeType,
        },
      });
    });
  }

  async getOperationHistory(input: OperationHistoryInput): Promise<OperationHistoryReport> {
    const parsedInput = operationHistoryInputSchema.parse(input);
    const projectRoot = await normalizeProjectRoot(parsedInput.projectRoot);
    return {
      schemaVersion: "0.1",
      projectRoot,
      operations: this.auditLog
        .filter((operation) => operation.projectRoot === projectRoot)
        .slice(0, parsedInput.limit ?? 20),
    };
  }

  private async requireConnectedContext(projectRoot: string): Promise<EditorContext> {
    const context = await this.bridge.getContext(projectRoot);
    if (context.connection !== "connected" || context.revision === null) {
      throw new DomainError(
        ERROR_CODES.EDITOR_UNAVAILABLE,
        "The Godot EditorPlugin bridge is unavailable or has no revision.",
        { projectRoot },
      );
    }
    return context;
  }

  private async requirePlan(planId: string, projectRootInput: string): Promise<StoredPlan> {
    const storedPlan = this.plans.get(planId);
    if (storedPlan === undefined) {
      throw new DomainError(ERROR_CODES.PLAN_NOT_FOUND, "The change plan was not found.", {
        planId,
      });
    }

    const projectRoot = await normalizeProjectRoot(projectRootInput);
    if (storedPlan.plan.projectRoot !== projectRoot) {
      throw new DomainError(
        ERROR_CODES.UNSAFE_OPERATION,
        "The plan project root does not match the requested project root.",
        { planId },
      );
    }
    return storedPlan;
  }

  private async assertPlanRevision(plan: ChangePlan): Promise<void> {
    const context = await this.requireConnectedContext(plan.projectRoot);
    if (context.revision !== plan.expectedRevision) {
      throw new DomainError(
        ERROR_CODES.REVISION_CONFLICT,
        "The Godot project changed after the plan was created.",
        {
          expectedRevision: plan.expectedRevision,
          actualRevision: context.revision,
        },
      );
    }

    if (plan.expectedFileRevision !== null) {
      const operation = plan.operations[0];
      if (operation.kind !== "script.replace_range") {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "The plan file revision is only valid for script operations.",
        );
      }
      const snapshot = await this.bridge.readScript(plan.projectRoot, operation.scriptPath);
      if (snapshot.revision !== plan.expectedFileRevision) {
        throw new DomainError(
          ERROR_CODES.REVISION_CONFLICT,
          "The script changed after the plan was created.",
          {
            expectedFileRevision: plan.expectedFileRevision,
            actualFileRevision: snapshot.revision,
          },
        );
      }
    }
  }

  private associateDiagnostics(projectRoot: string, diagnostics: RunDiagnostics): RunDiagnostics {
    const recentMutation = this.auditLog.find(
      (operation) =>
        operation.projectRoot === projectRoot &&
        operation.status === "succeeded" &&
        (operation.kind === "apply" || operation.kind === "rollback"),
    );
    if (recentMutation === undefined) {
      return diagnostics;
    }

    const attachOperation = (entry: DiagnosticEntry): DiagnosticEntry =>
      entry.operationId === undefined
        ? { ...entry, operationId: recentMutation.operationId }
        : entry;
    return {
      ...diagnostics,
      warnings: diagnostics.warnings.map(attachOperation),
      errors: diagnostics.errors.map(attachOperation),
    };
  }

  private async withAudit<T>(
    kind: OperationKind,
    projectRootInput: string,
    planId: string | null,
    input: unknown,
    action: () => Promise<T>,
  ): Promise<T> {
    const entry: OperationAuditEntry = {
      operationId: randomUUID(),
      kind,
      status: "running",
      projectRoot: await normalizeProjectRoot(projectRootInput),
      planId,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      input,
    };
    this.auditLog.unshift(entry);

    try {
      const output = await action();
      entry.status = "succeeded";
      entry.finishedAt = new Date().toISOString();
      entry.output = output;
      return output;
    } catch (error) {
      entry.status = "failed";
      entry.finishedAt = new Date().toISOString();
      entry.error =
        error instanceof DomainError
          ? { code: error.code, message: error.message, details: error.details }
          : { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) };
      throw error;
    }
  }
}
