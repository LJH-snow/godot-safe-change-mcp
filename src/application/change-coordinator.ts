import { createHash, randomUUID } from "node:crypto";
import {
  applyChangeInputSchema,
  changePlanSchema,
  confirmChangeInputSchema,
  previewSceneChangeInputSchema,
  scriptPathSchema,
  sceneSetPropertySchema,
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
  RunSceneInput,
} from "../domain/contracts.js";
import { previewRepairFromDiagnosticInputSchema } from "../domain/contracts.js";
import { operationHistoryInputSchema } from "../domain/contracts.js";
import { runSceneInputSchema } from "../domain/contracts.js";
import { DomainError, ERROR_CODES } from "../domain/errors.js";
import type { GodotBridge } from "../infrastructure/godot-bridge.js";
import { normalizeProjectRoot } from "../infrastructure/project-root.js";
import {
  InMemoryOperationAuditStore,
  type OperationAuditStore,
} from "../infrastructure/operation-audit-store.js";
import {
  InMemoryProjectLeaseStore,
  type ProjectLeaseStore,
} from "../infrastructure/project-lease-store.js";

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
  private readonly appliedPlanByProject = new Map<string, string>();
  private readonly auditLog: OperationAuditEntry[] = [];

  constructor(
    private readonly bridge: GodotBridge,
    private readonly auditStore: OperationAuditStore = new InMemoryOperationAuditStore(),
    private readonly leaseStore: ProjectLeaseStore = new InMemoryProjectLeaseStore(),
  ) {}

  getProjectLeaseStore(): ProjectLeaseStore {
    return this.leaseStore;
  }

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

    const operation = parsedInput.operation;
    const fingerprint = JSON.stringify({
      projectRoot,
      expectedRevision: context.revision,
      reason: parsedInput.reason,
      operation,
    });
    const basePlanId = createHash("sha256").update(fingerprint).digest("hex").slice(0, 20);
    let planId = basePlanId;
    let collision = 1;
    while (this.plans.has(planId)) {
      planId = basePlanId + "-" + collision;
      collision += 1;
    }
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
    } else if (operation.kind === "scene.delete_node") {
      if (operation.nodePath === ".") {
        throw new DomainError(
          ERROR_CODES.UNSAFE_OPERATION,
          "The current scene root cannot be deleted.",
          { nodePath: operation.nodePath },
        );
      }
      const node = context.currentScene.nodes.find((candidate) => candidate.path === operation.nodePath);
      if (node === undefined) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "The requested scene node does not exist.",
          { nodePath: operation.nodePath },
        );
      }
      const deletedNodes = context.currentScene.nodes
        .filter(
          (candidate) =>
            candidate.path === operation.nodePath || candidate.path.startsWith(operation.nodePath + "/"),
        )
        .map((candidate) => ({
          path: candidate.path,
          name: candidate.name,
          type: candidate.type,
          properties: structuredClone(candidate.properties),
        }));
      diff = {
        kind: "scene.delete_node" as const,
        target: scenePath + ":" + operation.nodePath,
        summary:
          "Delete " +
          node.type +
          " " +
          operation.nodePath +
          " and " +
          (deletedNodes.length - 1) +
          " descendant node(s) from " +
          scenePath,
        nodePath: operation.nodePath,
        deletedNodes,
      };
    } else if (operation.kind === "scene.reparent_node") {
      if (operation.nodePath === ".") {
        throw new DomainError(
          ERROR_CODES.UNSAFE_OPERATION,
          "The current scene root cannot be reparented.",
          { nodePath: operation.nodePath },
        );
      }
      const node = context.currentScene.nodes.find((candidate) => candidate.path === operation.nodePath);
      if (node === undefined) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "The requested scene node does not exist.",
          { nodePath: operation.nodePath },
        );
      }
      if (
        operation.newParentPath === operation.nodePath ||
        operation.newParentPath.startsWith(operation.nodePath + "/")
      ) {
        throw new DomainError(
          ERROR_CODES.UNSAFE_OPERATION,
          "A scene node cannot be reparented beneath itself or one of its descendants.",
          { nodePath: operation.nodePath, newParentPath: operation.newParentPath },
        );
      }
      const newParent = context.currentScene.nodes.find((candidate) => candidate.path === operation.newParentPath);
      if (newParent === undefined) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "The requested new parent does not exist in the current scene.",
          { newParentPath: operation.newParentPath },
        );
      }
      const lastSeparator = operation.nodePath.lastIndexOf("/");
      const fromParentPath = lastSeparator < 0 ? "." : operation.nodePath.slice(0, lastSeparator);
      if (fromParentPath === operation.newParentPath) {
        throw new DomainError(
          ERROR_CODES.OPERATION_REJECTED,
          "The requested node is already a child of the new parent.",
          { nodePath: operation.nodePath, newParentPath: operation.newParentPath },
        );
      }
      const toNodePath = operation.newParentPath === "."
        ? node.name
        : operation.newParentPath + "/" + node.name;
      if (context.currentScene.nodes.some((candidate) => candidate.path === toNodePath)) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "A node with the same name already exists under the requested new parent.",
          { nodePath: toNodePath },
        );
      }
      const fromSiblings = context.currentScene.nodes.filter((candidate) => {
        const separator = candidate.path.lastIndexOf("/");
        const candidateParentPath = separator < 0 ? "." : candidate.path.slice(0, separator);
        return candidate.path !== "." && candidateParentPath === fromParentPath;
      });
      const fromIndex = fromSiblings.findIndex((candidate) => candidate.path === operation.nodePath);
      if (fromIndex < 0) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "The scene context does not contain the node's original sibling position.",
          { nodePath: operation.nodePath, fromParentPath },
        );
      }
      const toIndex = context.currentScene.nodes.filter((candidate) => {
        const separator = candidate.path.lastIndexOf("/");
        const candidateParentPath = separator < 0 ? "." : candidate.path.slice(0, separator);
        return candidate.path !== "." && candidateParentPath === operation.newParentPath;
      }).length;
      diff = {
        kind: "scene.reparent_node" as const,
        target: scenePath + ":" + operation.nodePath,
        summary: "Move " + operation.nodePath + " under " + operation.newParentPath + " in " + scenePath,
        fromNodePath: operation.nodePath,
        toNodePath,
        fromParentPath,
        fromIndex,
        toParentPath: operation.newParentPath,
        toIndex,
        keepGlobalTransform: operation.keepGlobalTransform,
      };
    } else if (operation.kind === "scene.rename_node") {
      if (operation.nodePath === ".") {
        throw new DomainError(
          ERROR_CODES.UNSAFE_OPERATION,
          "The current scene root cannot be renamed.",
          { nodePath: operation.nodePath },
        );
      }
      const node = context.currentScene.nodes.find((candidate) => candidate.path === operation.nodePath);
      if (node === undefined) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "The requested scene node does not exist.",
          { nodePath: operation.nodePath },
        );
      }
      if (node.name === operation.newName) {
        throw new DomainError(
          ERROR_CODES.OPERATION_REJECTED,
          "The requested node already has that name.",
          { nodePath: operation.nodePath, newName: operation.newName },
        );
      }
      const lastSeparator = operation.nodePath.lastIndexOf("/");
      const parentPath = lastSeparator < 0 ? "." : operation.nodePath.slice(0, lastSeparator);
      const newNodePath = parentPath === "." ? operation.newName : parentPath + "/" + operation.newName;
      if (context.currentScene.nodes.some((candidate) => candidate.path === newNodePath)) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "A sibling node already uses the requested name.",
          { newNodePath },
        );
      }
      const affectedPaths = context.currentScene.nodes
        .filter(
          (candidate) =>
            candidate.path === operation.nodePath || candidate.path.startsWith(operation.nodePath + "/"),
        )
        .map((candidate) => ({
          from: candidate.path,
          to: newNodePath + candidate.path.slice(operation.nodePath.length),
        }));
      diff = {
        kind: "scene.rename_node" as const,
        target: scenePath + ":" + operation.nodePath,
        summary: "Rename " + node.name + " to " + operation.newName + " in " + scenePath,
        nodePath: operation.nodePath,
        newNodePath,
        previousName: node.name,
        newName: operation.newName,
        affectedPaths,
      };
    } else if (operation.kind === "scene.duplicate_node") {
      if (operation.nodePath === ".") {
        throw new DomainError(
          ERROR_CODES.UNSAFE_OPERATION,
          "The current scene root cannot be duplicated.",
          { nodePath: operation.nodePath },
        );
      }
      const node = context.currentScene.nodes.find((candidate) => candidate.path === operation.nodePath);
      if (node === undefined) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "The requested source scene node does not exist.",
          { nodePath: operation.nodePath },
        );
      }
      if (
        operation.newParentPath === operation.nodePath ||
        operation.newParentPath.startsWith(operation.nodePath + "/")
      ) {
        throw new DomainError(
          ERROR_CODES.UNSAFE_OPERATION,
          "A scene node cannot be duplicated beneath itself or one of its descendants.",
          { nodePath: operation.nodePath, newParentPath: operation.newParentPath },
        );
      }
      const newParent = context.currentScene.nodes.find((candidate) => candidate.path === operation.newParentPath);
      if (newParent === undefined) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "The requested duplicate parent does not exist in the current scene.",
          { newParentPath: operation.newParentPath },
        );
      }
      const targetPath = operation.newParentPath === "."
        ? operation.newName
        : operation.newParentPath + "/" + operation.newName;
      if (context.currentScene.nodes.some((candidate) => candidate.path === targetPath)) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "A node with the requested duplicate name already exists under the target parent.",
          { targetPath },
        );
      }
      const duplicatedNodes = context.currentScene.nodes
        .filter(
          (candidate) =>
            candidate.path === operation.nodePath || candidate.path.startsWith(operation.nodePath + "/"),
        )
        .map((candidate) => ({
          from: candidate.path,
          to: targetPath + candidate.path.slice(operation.nodePath.length),
          name: candidate.name,
          type: candidate.type,
          properties: structuredClone(candidate.properties),
        }));
      diff = {
        kind: "scene.duplicate_node" as const,
        target: scenePath + ":" + targetPath,
        summary: "Duplicate " + operation.nodePath + " under " + operation.newParentPath + " as " + operation.newName + " in " + scenePath,
        sourcePath: operation.nodePath,
        newParentPath: operation.newParentPath,
        targetPath,
        newName: operation.newName,
        keepGlobalTransform: operation.keepGlobalTransform,
        duplicatedNodes,
      };
    } else if (operation.kind === "scene.instantiate_scene") {
      const parent = context.currentScene.nodes.find((candidate) => candidate.path === operation.parentPath);
      if (parent === undefined) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "The requested scene instance parent does not exist.",
          { parentPath: operation.parentPath },
        );
      }
      if (operation.scenePath === scenePath) {
        throw new DomainError(
          ERROR_CODES.UNSAFE_OPERATION,
          "The current scene cannot be instantiated into itself.",
          { scenePath: operation.scenePath },
        );
      }
      const targetPath = operation.parentPath === "."
        ? operation.nodeName
        : operation.parentPath + "/" + operation.nodeName;
      if (context.currentScene.nodes.some((candidate) => candidate.path === targetPath)) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "A node with the requested instance name already exists under the target parent.",
          { targetPath },
        );
      }
      const snapshot = await this.bridge.readResource(projectRoot, operation.scenePath);
      expectedFileRevision = snapshot.revision;
      diff = {
        kind: "scene.instantiate_scene" as const,
        target: scenePath + ":" + targetPath,
        summary:
          "Instantiate " + operation.scenePath + " under " + operation.parentPath + " as " + operation.nodeName + " in " + scenePath,
        parentPath: operation.parentPath,
        scenePath: operation.scenePath,
        instancePath: targetPath,
        nodeName: operation.nodeName,
      };
    } else if (operation.kind === "scene.connect_signal") {
      const sourceNode = context.currentScene.nodes.find((candidate) => candidate.path === operation.sourcePath);
      const targetNode = context.currentScene.nodes.find((candidate) => candidate.path === operation.targetPath);
      if (sourceNode === undefined || targetNode === undefined) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "The signal source and target nodes must exist in the current scene.",
          { sourcePath: operation.sourcePath, targetPath: operation.targetPath },
        );
      }
      const signalSnapshot = await this.bridge.readSceneSignals(projectRoot);
      if (signalSnapshot.path !== scenePath || signalSnapshot.revision !== context.revision) {
        throw new DomainError(
          ERROR_CODES.REVISION_CONFLICT,
          "The scene changed while reading its signal declarations.",
          { expectedRevision: context.revision, actualRevision: signalSnapshot.revision },
        );
      }
      const sourceSignals = signalSnapshot.nodes.find((node) => node.nodePath === operation.sourcePath);
      const targetSignals = signalSnapshot.nodes.find((node) => node.nodePath === operation.targetPath);
      if (sourceSignals === undefined || !sourceSignals.signals.includes(operation.signalName)) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "The requested signal does not exist on the source node.",
          { sourcePath: operation.sourcePath, signalName: operation.signalName },
        );
      }
      if (targetSignals === undefined || !targetSignals.methods.includes(operation.methodName)) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "The requested target method does not exist on the target node.",
          { targetPath: operation.targetPath, methodName: operation.methodName },
        );
      }
      if (
        sourceSignals.connections.some(
          (connection) =>
            connection.signalName === operation.signalName &&
            connection.targetPath === operation.targetPath &&
            connection.methodName === operation.methodName,
        )
      ) {
        throw new DomainError(
          ERROR_CODES.OPERATION_REJECTED,
          "The requested signal connection already exists.",
          {
            sourcePath: operation.sourcePath,
            signalName: operation.signalName,
            targetPath: operation.targetPath,
            methodName: operation.methodName,
          },
        );
      }
      const targetMethod = operation.targetPath === "."
        ? "." + operation.methodName
        : operation.targetPath + "." + operation.methodName;
      diff = {
        kind: "scene.connect_signal" as const,
        target:
          scenePath + ":" + operation.sourcePath + "." + operation.signalName +
          " -> " + targetMethod,
        summary:
          "Connect " + operation.sourcePath + "." + operation.signalName +
          " to " + targetMethod + " in " + scenePath,
        sourcePath: operation.sourcePath,
        signalName: operation.signalName,
        targetPath: operation.targetPath,
        methodName: operation.methodName,
      };
    } else if (operation.kind === "scene.set_property") {
      const parsedOperation = sceneSetPropertySchema.parse(operation);
      const node = context.currentScene.nodes.find((candidate) => candidate.path === parsedOperation.nodePath);
      const before = node?.properties[parsedOperation.property];
      if (
        node === undefined ||
        before === undefined ||
        !this.nodeSupportsProperty(node.type, parsedOperation.property) ||
        !this.propertyValueMatches(parsedOperation.property, before)
      ) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "The requested node property is not available with a supported value in the current scene context.",
          { nodePath: parsedOperation.nodePath, property: parsedOperation.property, nodeType: node?.type },
        );
      }
      diff = {
        kind: "scene.set_property" as const,
        target: scenePath + ":" + operation.nodePath + ":" + operation.property,
        summary: "Set " + operation.property + " on " + operation.nodePath + " in " + scenePath,
        property: operation.property,
        before,
        after: operation.value,
      };
    } else if (operation.kind === "scene.attach_script") {
      const node = context.currentScene.nodes.find((candidate) => candidate.path === operation.nodePath);
      if (node === undefined) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "The requested node is not available in the current scene context.",
          { nodePath: operation.nodePath },
        );
      }
      await this.bridge.readScript(projectRoot, operation.scriptPath);
      diff = {
        kind: "scene.attach_script" as const,
        target: scenePath + ":" + operation.nodePath + ":script",
        summary: "Attach " + operation.scriptPath + " to " + operation.nodePath + " in " + scenePath,
        scriptPath: operation.scriptPath,
      };
    } else if (operation.kind === "scene.detach_script") {
      const node = context.currentScene.nodes.find((candidate) => candidate.path === operation.nodePath);
      if (node === undefined) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "The requested node is not available in the current scene context.",
          { nodePath: operation.nodePath },
        );
      }
      const scriptPath = node.properties.scriptPath;
      const parsedScriptPath = scriptPathSchema.safeParse(scriptPath);
      if (!parsedScriptPath.success) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "The requested node does not have an existing project-local GDScript.",
          { nodePath: operation.nodePath },
        );
      }
      await this.bridge.readScript(projectRoot, parsedScriptPath.data);
      diff = {
        kind: "scene.detach_script" as const,
        target: scenePath + ":" + operation.nodePath + ":script",
        summary: "Detach " + parsedScriptPath.data + " from " + operation.nodePath + " in " + scenePath,
        nodePath: operation.nodePath,
        scriptPath: parsedScriptPath.data,
      };
    } else if (operation.kind === "resource.replace_reference") {
      const snapshot = await this.bridge.readResource(projectRoot, operation.resourcePath);
      const matchCount = snapshot.content.split(operation.from).length - 1;
      if (matchCount < 1) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "The resource reference was not found in the target file.",
          { resourcePath: operation.resourcePath, from: operation.from },
        );
      }
      expectedFileRevision = snapshot.revision;
      diff = {
        kind: "resource.replace_reference" as const,
        target: operation.resourcePath,
        summary: "Replace " + operation.from + " with " + operation.to + " in " + operation.resourcePath,
        matchCount,
      };
    } else if (operation.kind === "project.input_action.add_key") {
      const snapshot = await this.bridge.readInputAction(projectRoot, operation.actionName);
      if (snapshot.events.some((event) => event.physicalKeycode === operation.physicalKeycode)) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "The requested physical key is already mapped to this input action.",
          { actionName: operation.actionName, physicalKeycode: operation.physicalKeycode },
        );
      }
      expectedFileRevision = snapshot.revision;
      const deadzone = operation.deadzone ?? snapshot.deadzone ?? 0.2;
      diff = {
        kind: "project.input_action.add_key" as const,
        target: "project.godot:input/" + operation.actionName,
        summary:
          "Add physical key " +
          operation.physicalKeycode +
          " to input action " +
          operation.actionName +
          " (deadzone " +
          deadzone +
          ")",
      };
    } else if (operation.kind === "project.input_action.remove_key") {
      const snapshot = await this.bridge.readInputAction(projectRoot, operation.actionName);
      const matchCount = snapshot.events.filter(
        (event) => event.type === "InputEventKey" && event.physicalKeycode === operation.physicalKeycode,
      ).length;
      if (!snapshot.exists || matchCount === 0) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "The requested physical key is not mapped to this input action.",
          { actionName: operation.actionName, physicalKeycode: operation.physicalKeycode },
        );
      }
      if (matchCount !== 1) {
        throw new DomainError(
          ERROR_CODES.OPERATION_REJECTED,
          "The input action contains duplicate matching key events; refusing an ambiguous removal.",
          { actionName: operation.actionName, physicalKeycode: operation.physicalKeycode, matchCount },
        );
      }
      expectedFileRevision = snapshot.revision;
      diff = {
        kind: "project.input_action.remove_key" as const,
        target: "project.godot:input/" + operation.actionName,
        summary: "Remove physical key " + operation.physicalKeycode + " from input action " + operation.actionName,
      };
    } else if (operation.kind === "project.input_action.replace_key") {
      const snapshot = await this.bridge.readInputAction(projectRoot, operation.actionName);
      const matchingSourceEvents = snapshot.events.filter(
        (event) => event.type === "InputEventKey" && event.physicalKeycode === operation.fromPhysicalKeycode,
      );
      if (!snapshot.exists || matchingSourceEvents.length === 0) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "The physical key to replace is not mapped to this input action.",
          { actionName: operation.actionName, physicalKeycode: operation.fromPhysicalKeycode },
        );
      }
      if (matchingSourceEvents.length !== 1 || matchingSourceEvents[0]?.keycode !== 0) {
        throw new DomainError(
          ERROR_CODES.OPERATION_REJECTED,
          "The source binding is ambiguous or also has a logical keycode; refusing to replace it.",
          { actionName: operation.actionName, physicalKeycode: operation.fromPhysicalKeycode },
        );
      }
      const targetMatches = snapshot.events.some(
        (event) =>
          event.type === "InputEventKey" &&
          (event.physicalKeycode === operation.toPhysicalKeycode || event.keycode === operation.toPhysicalKeycode),
      );
      if (targetMatches) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "The target key is already mapped to this input action.",
          { actionName: operation.actionName, physicalKeycode: operation.toPhysicalKeycode },
        );
      }
      expectedFileRevision = snapshot.revision;
      diff = {
        kind: "project.input_action.replace_key" as const,
        target: "project.godot:input/" + operation.actionName,
        summary:
          "Replace physical key " +
          operation.fromPhysicalKeycode +
          " with " +
          operation.toPhysicalKeycode +
          " in input action " +
          operation.actionName,
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

    if (storedPlan.plan.operations[0]?.kind === "scene.connect_signal") {
      throw new DomainError(
        ERROR_CODES.OPERATION_REJECTED,
        "scene.connect_signal is preview-only until its UndoRedo apply and rollback path is enabled.",
        { planId: storedPlan.plan.planId },
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
    return this.withProjectLease(parsedInput.projectRoot, parsedInput.leaseId, () =>
      this.applyChangeCore(parsedInput),
    );
  }

  private async applyChangeCore(parsedInput: ApplyChangeInput): Promise<ChangeReport> {
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

    const appliedPlanId = this.appliedPlanByProject.get(storedPlan.plan.projectRoot);
    if (appliedPlanId !== undefined && appliedPlanId !== storedPlan.plan.planId) {
      throw new DomainError(
        ERROR_CODES.PLAN_ALREADY_APPLIED,
        "Another change plan is already applied for this project; roll it back before applying a new plan.",
        { planId: appliedPlanId },
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
    this.appliedPlanByProject.set(storedPlan.plan.projectRoot, storedPlan.plan.planId);
    return report;
  }

  async rollbackChange(input: ApplyChangeInput): Promise<RollbackReport> {
    return this.withAudit("rollback", input.projectRoot, input.planId, input, () =>
      this.rollbackChangeInternal(input),
    );
  }

  private async rollbackChangeInternal(input: ApplyChangeInput): Promise<RollbackReport> {
    const parsedInput = applyChangeInputSchema.parse(input);
    return this.withProjectLease(parsedInput.projectRoot, parsedInput.leaseId, () =>
      this.rollbackChangeCore(parsedInput),
    );
  }

  private async rollbackChangeCore(parsedInput: ApplyChangeInput): Promise<RollbackReport> {
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
      if (
        operation.kind !== "script.replace_range" &&
        operation.kind !== "resource.replace_reference" &&
        operation.kind !== "project.input_action.add_key" &&
        operation.kind !== "project.input_action.remove_key" &&
        operation.kind !== "project.input_action.replace_key" &&
        operation.kind !== "scene.instantiate_scene"
      ) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "The applied file revision is only valid for file and project setting operations.",
        );
      }
      const snapshot =
        operation.kind === "script.replace_range"
          ? await this.bridge.readScript(storedPlan.plan.projectRoot, operation.scriptPath)
          : operation.kind === "resource.replace_reference"
            ? await this.bridge.readResource(storedPlan.plan.projectRoot, operation.resourcePath)
            : operation.kind === "scene.instantiate_scene"
              ? await this.bridge.readResource(storedPlan.plan.projectRoot, operation.scenePath)
              : await this.bridge.readInputAction(storedPlan.plan.projectRoot, operation.actionName);
      if (snapshot.revision !== storedPlan.appliedFileRevision) {
        throw new DomainError(
          ERROR_CODES.REVISION_CONFLICT,
          "The file changed after the plan was applied; refusing to overwrite it.",
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
    if (this.appliedPlanByProject.get(storedPlan.plan.projectRoot) === storedPlan.plan.planId) {
      this.appliedPlanByProject.delete(storedPlan.plan.projectRoot);
    }
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

  async runScene(input: RunSceneInput): Promise<RunDiagnostics> {
    return this.withAudit("run", input.projectRoot, null, input, () =>
      this.runSceneInternal(input),
    );
  }

  private async runSceneInternal(input: RunSceneInput): Promise<RunDiagnostics> {
    const parsedInput = runSceneInputSchema.parse(input);
    const projectRoot = await normalizeProjectRoot(parsedInput.projectRoot);
    const timeoutMs = Math.min(Math.max(parsedInput.timeoutMs ?? 10000, 100), 30000);
    await this.requireConnectedContext(projectRoot);
    const diagnostics = await this.bridge.runScene(
      projectRoot,
      parsedInput.scenePath,
      timeoutMs,
    );
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
      operations: await this.auditStore.list(projectRoot, parsedInput.limit ?? 20),
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
      if (
        operation.kind !== "script.replace_range" &&
        operation.kind !== "resource.replace_reference" &&
        operation.kind !== "project.input_action.add_key" &&
        operation.kind !== "project.input_action.remove_key" &&
        operation.kind !== "project.input_action.replace_key" &&
        operation.kind !== "scene.instantiate_scene"
      ) {
        throw new DomainError(
          ERROR_CODES.VALIDATION_FAILED,
          "The plan file revision is only valid for file and project setting operations.",
        );
      }
      const snapshot =
        operation.kind === "script.replace_range"
          ? await this.bridge.readScript(plan.projectRoot, operation.scriptPath)
          : operation.kind === "resource.replace_reference"
            ? await this.bridge.readResource(plan.projectRoot, operation.resourcePath)
            : operation.kind === "scene.instantiate_scene"
              ? await this.bridge.readResource(plan.projectRoot, operation.scenePath)
              : await this.bridge.readInputAction(plan.projectRoot, operation.actionName);
      if (snapshot.revision !== plan.expectedFileRevision) {
        throw new DomainError(
          ERROR_CODES.REVISION_CONFLICT,
          "The file changed after the plan was created.",
          {
            expectedFileRevision: plan.expectedFileRevision,
            actualFileRevision: snapshot.revision,
          },
        );
      }
    }
  }

  private nodeSupportsProperty(nodeType: string, property: string): boolean {
    if (property === "visible") {
      return ["Node2D", "Control", "Label", "ColorRect"].includes(nodeType);
    }
    if (property === "position") {
      return nodeType === "Node2D";
    }
    if (property === "rotation_degrees" || property === "scale") {
      return nodeType === "Node2D";
    }
    if (property === "size") {
      return ["Control", "Label", "ColorRect"].includes(nodeType);
    }
    if (property === "text") {
      return nodeType === "Label";
    }
    if (property === "color") {
      return nodeType === "ColorRect";
    }
    return false;
  }

  private propertyValueMatches(property: string, value: unknown): boolean {
    if (property === "visible") {
      return typeof value === "boolean";
    }
    if (property === "text") {
      return typeof value === "string" && value.length <= 10000;
    }
    if (property === "position" || property === "size") {
      if (!this.hasExactKeys(value, ["x", "y"])) {
        return false;
      }
      const point = value as { x: unknown; y: unknown };
      if (
        typeof point.x !== "number" ||
        !Number.isFinite(point.x) ||
        typeof point.y !== "number" ||
        !Number.isFinite(point.y)
      ) {
        return false;
      }
      const x = point.x;
      const y = point.y;
      if (property === "size") {
        return x >= 0 && x <= 1_000_000 && y >= 0 && y <= 1_000_000;
      }
      return x >= -1_000_000 && x <= 1_000_000 && y >= -1_000_000 && y <= 1_000_000;
    }
    if (property === "rotation_degrees") {
      return typeof value === "number" && Number.isFinite(value) && value >= -360_000 && value <= 360_000;
    }
    if (property === "scale") {
      if (!this.hasExactKeys(value, ["x", "y"])) {
        return false;
      }
      const scale = value as { x: unknown; y: unknown };
      return [scale.x, scale.y].every(
        (component) =>
          typeof component === "number" &&
          Number.isFinite(component) &&
          component >= -1_000 &&
          component <= 1_000,
      );
    }
    if (property === "color") {
      if (!this.hasExactKeys(value, ["r", "g", "b", "a"])) {
        return false;
      }
      const color = value as { r: unknown; g: unknown; b: unknown; a: unknown };
      return [color.r, color.g, color.b, color.a].every(
        (component) => typeof component === "number" && Number.isFinite(component) && component >= 0 && component <= 1,
      );
    }
    return false;
  }

  private hasExactKeys(value: unknown, keys: string[]): boolean {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const actualKeys = Object.keys(value).sort();
    return actualKeys.length === keys.length && actualKeys.every((key, index) => key === [...keys].sort()[index]);
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
    await this.auditStore.append(entry);

    try {
      const output = await action();
      entry.status = "succeeded";
      entry.finishedAt = new Date().toISOString();
      entry.output = output;
      await this.auditStore.append(entry);
      return output;
    } catch (error) {
      entry.status = "failed";
      entry.finishedAt = new Date().toISOString();
      entry.error =
        error instanceof DomainError
          ? { code: error.code, message: error.message, details: error.details }
          : { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) };
      try {
        await this.auditStore.append(entry);
      } catch {
      }
      throw error;
    }
  }

  private async withProjectLease<T>(
    projectRootInput: string,
    leaseId: string | undefined,
    action: () => Promise<T>,
  ): Promise<T> {
    const projectRoot = await normalizeProjectRoot(projectRootInput);
    if (leaseId !== undefined) {
      await this.leaseStore.assert(projectRoot, leaseId);
      return action();
    }

    const lease = await this.leaseStore.acquire(
      projectRoot,
      "coordinator-" + process.pid + "-" + randomUUID(),
      30000,
    );
    try {
      return await action();
    } finally {
      await this.leaseStore.release(lease).catch(() => undefined);
    }
  }
}
