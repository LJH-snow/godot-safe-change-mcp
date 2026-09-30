import { createHash } from "node:crypto";
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
  EditorContext,
  RollbackReport,
  RunDiagnostics,
} from "../domain/contracts.js";
import { DomainError, ERROR_CODES } from "../domain/errors.js";
import type { GodotBridge } from "../infrastructure/godot-bridge.js";
import { normalizeProjectRoot } from "../infrastructure/project-root.js";

type PlanState = "preview" | "confirmed" | "applied" | "rolled_back";

interface StoredPlan {
  plan: ChangePlan;
  state: PlanState;
  appliedRevision?: string;
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

  constructor(private readonly bridge: GodotBridge) {}

  async getContext(projectRootInput: string): Promise<EditorContext> {
    return this.bridge.getContext(await normalizeProjectRoot(projectRootInput));
  }

  async previewSceneChange(input: PreviewSceneChangeInput): Promise<ChangePlan> {
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
    const target =
      operation.parentPath === "."
        ? scenePath + ":" + operation.nodeName
        : scenePath + ":" + operation.parentPath + "/" + operation.nodeName;
    const plan = changePlanSchema.parse({
      schemaVersion: "0.2",
      planId,
      projectRoot,
      expectedRevision: context.revision,
      mode: "preview",
      reason: parsedInput.reason,
      operations: [operation],
      diff: [
        {
          kind: "scene.add_node",
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
        },
      ],
    });

    this.plans.set(planId, { plan, state: "preview" });
    return plan;
  }

  async confirmChange(input: ConfirmChangeInput): Promise<ConfirmedChange> {
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
      operations: storedPlan.plan.operations,
    });
    storedPlan.state = "applied";
    storedPlan.appliedRevision = report.revision;
    return report;
  }

  async rollbackChange(input: ApplyChangeInput): Promise<RollbackReport> {
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

    const report = await this.bridge.rollbackChange(storedPlan.plan.projectRoot, {
      planId: storedPlan.plan.planId,
      expectedRevision: storedPlan.appliedRevision,
    });
    storedPlan.state = "rolled_back";
    return report;
  }

  async runCurrentScene(input: RunCurrentSceneInput): Promise<RunDiagnostics> {
    const projectRoot = await normalizeProjectRoot(input.projectRoot);
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 10000, 100), 30000);
    await this.requireConnectedContext(projectRoot);
    return this.bridge.runCurrentScene(projectRoot, timeoutMs);
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
  }
}
