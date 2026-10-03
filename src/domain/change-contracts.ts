import { z } from "zod";

export const safeNodeTypeSchema = z.enum([
  "Node",
  "Node2D",
  "Control",
  "Label",
  "ColorRect",
]);

export const nodeNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

const godotMemberNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export const signalNameSchema = godotMemberNameSchema.describe("Godot signal name.");
export const methodNameSchema = godotMemberNameSchema.describe("Godot target method name.");

const relativeNodePathPattern = /^(?:\.|[A-Za-z_][A-Za-z0-9_]*(?:\/[A-Za-z_][A-Za-z0-9_]*)*)$/;
const projectRelativePathPattern = /^res:\/\/(?!\/)(?:[^\/\\\0]+\/)*[^\/\\\0]+$/;
const resourceIdentifierPattern = /^(?:uid:\/\/[A-Za-z0-9_-]+|res:\/\/(?!\/)(?:[^\/\\\0]+\/)*[^\/\\\0]+)$/;

export const nodePathSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(relativeNodePathPattern, "NodePath must be relative and contain only safe segments.");

export const scriptPathSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(projectRelativePathPattern, "scriptPath must be a project-relative path.")
  .regex(/\.gd$/, "scriptPath must target a GDScript file.")
  .refine(
    (value) =>
      !value.includes("..") && value.split("/").every((segment) => segment !== "." && segment !== ".."),
    "scriptPath must not contain traversal segments.",
  );

export const resourcePathSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(projectRelativePathPattern, "resourcePath must be a project-relative path.")
  .regex(/\.(tscn|tres|res)$/, "resourcePath must target a supported Godot resource.")
  .refine(
    (value) =>
      !value.includes("..") && value.split("/").every((segment) => segment !== "." && segment !== ".."),
    "resourcePath must not contain traversal segments.",
  );

export const scenePathSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(projectRelativePathPattern, "scenePath must be a project-relative path.")
  .regex(/\.tscn$/, "scenePath must target a Godot scene.")
  .refine(
    (value) =>
      !value.includes("..") && value.split("/").every((segment) => segment !== "." && segment !== ".."),
    "scenePath must not contain traversal segments.",
  );

const resourceIdentifierSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(resourceIdentifierPattern, "Resource references must use safe res:// or uid:// identifiers.")
  .refine(
    (value) =>
      value.startsWith("uid://") ||
      (!value.includes("..") && value.split("/").every((segment) => segment !== "." && segment !== "..")),
    "Resource references must not contain traversal segments.",
  );

const finiteNumberSchema = z.number().finite();
const positionSchema = z
  .object({
    x: finiteNumberSchema.min(-1_000_000).max(1_000_000),
    y: finiteNumberSchema.min(-1_000_000).max(1_000_000),
  })
  .strict();
const rotationDegreesSchema = finiteNumberSchema.min(-360_000).max(360_000);
const scaleSchema = z
  .object({
    x: finiteNumberSchema.min(-1_000).max(1_000),
    y: finiteNumberSchema.min(-1_000).max(1_000),
  })
  .strict();
const sizeSchema = z
  .object({
    x: finiteNumberSchema.min(0).max(1_000_000),
    y: finiteNumberSchema.min(0).max(1_000_000),
  })
  .strict();
const colorSchema = z
  .object({
    r: finiteNumberSchema.min(0).max(1),
    g: finiteNumberSchema.min(0).max(1),
    b: finiteNumberSchema.min(0).max(1),
    a: finiteNumberSchema.min(0).max(1),
  })
  .strict();

export const createNodeOperationSchema = z
  .object({
    kind: z.literal("scene.create_node"),
    parentPath: nodePathSchema.describe("NodePath inside the current scene."),
    nodeName: nodeNameSchema.describe("Name for the new node."),
    nodeType: safeNodeTypeSchema.describe("Allowed Godot node class."),
  })
  .strict();

export const sceneDeleteNodeSchema = z
  .object({
    kind: z.literal("scene.delete_node"),
    nodePath: nodePathSchema.describe("NodePath of a node inside the current scene."),
  })
  .strict();

export const sceneReparentNodeSchema = z
  .object({
    kind: z.literal("scene.reparent_node"),
    nodePath: nodePathSchema,
    newParentPath: nodePathSchema,
    keepGlobalTransform: z.boolean().default(true),
  })
  .strict();

export const sceneRenameNodeSchema = z
  .object({
    kind: z.literal("scene.rename_node"),
    nodePath: nodePathSchema,
    newName: nodeNameSchema,
  })
  .strict();

export const sceneDuplicateNodeSchema = z
  .object({
    kind: z.literal("scene.duplicate_node"),
    nodePath: nodePathSchema,
    newParentPath: nodePathSchema,
    newName: nodeNameSchema,
    keepGlobalTransform: z.boolean().default(true),
  })
  .strict();

export const sceneInstantiateSceneSchema = z
  .object({
    kind: z.literal("scene.instantiate_scene"),
    parentPath: nodePathSchema,
    scenePath: scenePathSchema,
    nodeName: nodeNameSchema,
  })
  .strict();

export const sceneConnectSignalSchema = z
  .object({
    kind: z.literal("scene.connect_signal"),
    sourcePath: nodePathSchema,
    signalName: signalNameSchema,
    targetPath: nodePathSchema,
    methodName: methodNameSchema,
  })
  .strict();

export const sceneDisconnectSignalSchema = z
  .object({
    kind: z.literal("scene.disconnect_signal"),
    sourcePath: nodePathSchema,
    signalName: signalNameSchema,
    targetPath: nodePathSchema,
    methodName: methodNameSchema,
  })
  .strict();

export const groupNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Group names must use letters, digits and underscores.");

export const sceneAddGroupSchema = z
  .object({
    kind: z.literal("scene.add_group"),
    nodePath: nodePathSchema.describe("NodePath inside the current scene."),
    group: groupNameSchema.describe("Group name to add the node to."),
  })
  .strict();

export const sceneRemoveGroupSchema = z
  .object({
    kind: z.literal("scene.remove_group"),
    nodePath: nodePathSchema.describe("NodePath inside the current scene."),
    group: groupNameSchema.describe("Group name to remove the node from."),
  })
  .strict();

export const sceneReorderNodeSchema = z
  .object({
    kind: z.literal("scene.reorder_node"),
    nodePath: nodePathSchema.describe("NodePath inside the current scene."),
    index: z.number().int().min(0).max(10000).describe("Final sibling index for the node after the move."),
  })
  .strict();

const sceneSetVisiblePropertySchema = z
  .object({
    kind: z.literal("scene.set_property"),
    nodePath: nodePathSchema,
    property: z.literal("visible"),
    value: z.boolean(),
  })
  .strict();
const sceneSetPositionPropertySchema = z
  .object({
    kind: z.literal("scene.set_property"),
    nodePath: nodePathSchema,
    property: z.literal("position"),
    value: positionSchema,
  })
  .strict();
const sceneSetRotationDegreesPropertySchema = z
  .object({
    kind: z.literal("scene.set_property"),
    nodePath: nodePathSchema,
    property: z.literal("rotation_degrees"),
    value: rotationDegreesSchema,
  })
  .strict();
const sceneSetScalePropertySchema = z
  .object({
    kind: z.literal("scene.set_property"),
    nodePath: nodePathSchema,
    property: z.literal("scale"),
    value: scaleSchema,
  })
  .strict();
const sceneSetSizePropertySchema = z
  .object({
    kind: z.literal("scene.set_property"),
    nodePath: nodePathSchema,
    property: z.literal("size"),
    value: sizeSchema,
  })
  .strict();
const sceneSetTextPropertySchema = z
  .object({
    kind: z.literal("scene.set_property"),
    nodePath: nodePathSchema,
    property: z.literal("text"),
    value: z.string().max(10000),
  })
  .strict();
const sceneSetColorPropertySchema = z
  .object({
    kind: z.literal("scene.set_property"),
    nodePath: nodePathSchema,
    property: z.literal("color"),
    value: colorSchema,
  })
  .strict();

export const sceneSetPropertySchema = z.discriminatedUnion("property", [
  sceneSetVisiblePropertySchema,
  sceneSetPositionPropertySchema,
  sceneSetRotationDegreesPropertySchema,
  sceneSetScalePropertySchema,
  sceneSetSizePropertySchema,
  sceneSetTextPropertySchema,
  sceneSetColorPropertySchema,
]);

export const scenePropertyAssertionSchema = z.discriminatedUnion("property", [
  z.object({ property: z.literal("visible"), expected: z.boolean() }).strict(),
  z.object({ property: z.literal("position"), expected: positionSchema }).strict(),
  z.object({ property: z.literal("rotation_degrees"), expected: rotationDegreesSchema }).strict(),
  z.object({ property: z.literal("scale"), expected: scaleSchema }).strict(),
  z.object({ property: z.literal("size"), expected: sizeSchema }).strict(),
  z.object({ property: z.literal("text"), expected: z.string().max(10000) }).strict(),
  z.object({ property: z.literal("color"), expected: colorSchema }).strict(),
]);

export const sceneAttachScriptSchema = z
  .object({
    kind: z.literal("scene.attach_script"),
    nodePath: nodePathSchema,
    scriptPath: scriptPathSchema,
  })
  .strict();

export const sceneDetachScriptSchema = z
  .object({
    kind: z.literal("scene.detach_script"),
    nodePath: nodePathSchema.describe("NodePath of a node inside the current scene."),
  })
  .strict();

export const resourceReplaceReferenceSchema = z
  .object({
    kind: z.literal("resource.replace_reference"),
    resourcePath: resourcePathSchema,
    from: resourceIdentifierSchema,
    to: resourceIdentifierSchema,
  })
  .strict();

export const inputActionAddKeySchema = z
  .object({
    kind: z.literal("project.input_action.add_key"),
    actionName: z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    physicalKeycode: z.number().int().min(1).max(10000),
    deadzone: finiteNumberSchema.min(0).max(1).optional(),
  })
  .strict();

export const inputActionRemoveKeySchema = z
  .object({
    kind: z.literal("project.input_action.remove_key"),
    actionName: z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    physicalKeycode: z.number().int().min(1).max(10000),
  })
  .strict();

export const inputActionReplaceKeySchema = z
  .object({
    kind: z.literal("project.input_action.replace_key"),
    actionName: z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    fromPhysicalKeycode: z.number().int().min(1).max(10000),
    toPhysicalKeycode: z.number().int().min(1).max(10000),
  })
  .strict()
  .refine((value) => value.fromPhysicalKeycode !== value.toPhysicalKeycode, {
    message: "fromPhysicalKeycode and toPhysicalKeycode must differ.",
  });

export const scriptReplaceRangeSchema = z
  .object({
    kind: z.literal("script.replace_range"),
    scriptPath: scriptPathSchema,
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    replacement: z.string().max(100000),
  })
  .strict()
  .refine((value) => value.startLine <= value.endLine, {
    message: "startLine must be less than or equal to endLine.",
  });

export const autoloadNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Autoload names must use letters, digits and underscores.");

export const autoloadAddSchema = z
  .object({
    kind: z.literal("project.autoload.add"),
    name: autoloadNameSchema.describe("Singleton name for the autoload entry."),
    scriptPath: scriptPathSchema.describe("Project GDScript script to register."),
  })
  .strict();

export const autoloadRemoveSchema = z
  .object({
    kind: z.literal("project.autoload.remove"),
    name: autoloadNameSchema.describe("Autoload singleton name to remove."),
  })
  .strict();

export const changeOperationSchema = z.union([
  createNodeOperationSchema,
  sceneDeleteNodeSchema,
  sceneReparentNodeSchema,
  sceneRenameNodeSchema,
  sceneDuplicateNodeSchema,
  sceneInstantiateSceneSchema,
  sceneConnectSignalSchema,
  sceneDisconnectSignalSchema,
  sceneAddGroupSchema,
  sceneRemoveGroupSchema,
  sceneReorderNodeSchema,
  sceneSetPropertySchema,
  sceneAttachScriptSchema,
  sceneDetachScriptSchema,
  resourceReplaceReferenceSchema,
  inputActionAddKeySchema,
  inputActionRemoveKeySchema,
  inputActionReplaceKeySchema,
  autoloadAddSchema,
  autoloadRemoveSchema,
  scriptReplaceRangeSchema,
]);

export const previewSceneChangeInputSchema = z.object({
  projectRoot: z.string().min(1),
  reason: z.string().min(1).max(500),
  operation: changeOperationSchema,
});

export const confirmChangeInputSchema = z.object({
  projectRoot: z.string().min(1),
  planId: z.string().min(1),
  expectedRevision: z.string().min(1),
});

export const applyChangeInputSchema = z.object({
  projectRoot: z.string().min(1),
  planId: z.string().min(1),
  leaseId: z.string().min(1).optional(),
});

export const sceneChangeDiffSchema = z.object({
  kind: z.literal("scene.add_node"),
  target: z.string().min(1),
  summary: z.string().min(1),
});

export const sceneDeleteNodeDiffSchema = z.object({
  kind: z.literal("scene.delete_node"),
  target: z.string().min(1),
  summary: z.string().min(1),
  nodePath: nodePathSchema,
  deletedNodes: z
    .array(
      z
        .object({
          path: z.string().min(1),
          name: z.string().min(1),
          type: z.string().min(1),
          properties: z.record(z.string(), z.unknown()),
        })
        .strict(),
    )
    .min(1),
}).strict();

export const sceneReparentNodeDiffSchema = z
  .object({
    kind: z.literal("scene.reparent_node"),
    target: z.string().min(1),
    summary: z.string().min(1),
    fromNodePath: nodePathSchema,
    toNodePath: nodePathSchema,
    fromParentPath: nodePathSchema,
    fromIndex: z.number().int().nonnegative(),
    toParentPath: nodePathSchema,
    toIndex: z.number().int().nonnegative(),
    keepGlobalTransform: z.boolean(),
  })
  .strict();

export const sceneRenameNodeDiffSchema = z
  .object({
    kind: z.literal("scene.rename_node"),
    target: z.string().min(1),
    summary: z.string().min(1),
    nodePath: nodePathSchema,
    newNodePath: nodePathSchema,
    previousName: nodeNameSchema,
    newName: nodeNameSchema,
    affectedPaths: z.array(z.object({ from: nodePathSchema, to: nodePathSchema }).strict()).min(1),
  })
  .strict();

export const sceneDuplicateNodeDiffSchema = z
  .object({
    kind: z.literal("scene.duplicate_node"),
    target: z.string().min(1),
    summary: z.string().min(1),
    sourcePath: nodePathSchema,
    newParentPath: nodePathSchema,
    targetPath: nodePathSchema,
    newName: nodeNameSchema,
    keepGlobalTransform: z.boolean(),
    duplicatedNodes: z
      .array(
        z
          .object({
            from: nodePathSchema,
            to: nodePathSchema,
            name: z.string().min(1),
            type: z.string().min(1),
            properties: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const sceneInstantiateSceneDiffSchema = z
  .object({
    kind: z.literal("scene.instantiate_scene"),
    target: z.string().min(1),
    summary: z.string().min(1),
    parentPath: nodePathSchema,
    scenePath: scenePathSchema,
    instancePath: nodePathSchema,
    nodeName: nodeNameSchema,
  })
  .strict();

export const sceneConnectSignalDiffSchema = z
  .object({
    kind: z.literal("scene.connect_signal"),
    target: z.string().min(1),
    summary: z.string().min(1),
    sourcePath: nodePathSchema,
    signalName: signalNameSchema,
    targetPath: nodePathSchema,
    methodName: methodNameSchema,
  })
  .strict();

export const sceneDisconnectSignalDiffSchema = z
  .object({
    kind: z.literal("scene.disconnect_signal"),
    target: z.string().min(1),
    summary: z.string().min(1),
    sourcePath: nodePathSchema,
    signalName: signalNameSchema,
    targetPath: nodePathSchema,
    methodName: methodNameSchema,
  })
  .strict();

export const sceneAddGroupDiffSchema = z
  .object({
    kind: z.literal("scene.add_group"),
    target: z.string().min(1),
    summary: z.string().min(1),
    nodePath: nodePathSchema,
    group: groupNameSchema,
  })
  .strict();

export const sceneRemoveGroupDiffSchema = z
  .object({
    kind: z.literal("scene.remove_group"),
    target: z.string().min(1),
    summary: z.string().min(1),
    nodePath: nodePathSchema,
    group: groupNameSchema,
  })
  .strict();

export const sceneReorderNodeDiffSchema = z
  .object({
    kind: z.literal("scene.reorder_node"),
    target: z.string().min(1),
    summary: z.string().min(1),
    nodePath: nodePathSchema,
    fromIndex: z.number().int().nonnegative(),
    toIndex: z.number().int().nonnegative(),
  })
  .strict();

export const scriptChangeDiffSchema = z.object({
  kind: z.literal("script.replace_range"),
  target: z.string().min(1),
  summary: z.string().min(1),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  before: z.string(),
  after: z.string(),
});

export const resourceReferenceDiffSchema = z.object({
  kind: z.literal("resource.replace_reference"),
  target: z.string().min(1),
  summary: z.string().min(1),
  matchCount: z.number().int().positive(),
});

export const inputActionDiffSchema = z.object({
  kind: z.literal("project.input_action.add_key"),
  target: z.string().min(1),
  summary: z.string().min(1),
});

export const inputActionRemoveKeyDiffSchema = z.object({
  kind: z.literal("project.input_action.remove_key"),
  target: z.string().min(1),
  summary: z.string().min(1),
});

export const inputActionReplaceKeyDiffSchema = z.object({
  kind: z.literal("project.input_action.replace_key"),
  target: z.string().min(1),
  summary: z.string().min(1),
});

export const autoloadAddDiffSchema = z
  .object({
    kind: z.literal("project.autoload.add"),
    target: z.string().min(1),
    summary: z.string().min(1),
    name: autoloadNameSchema,
    scriptPath: scriptPathSchema,
  })
  .strict();

export const autoloadRemoveDiffSchema = z
  .object({
    kind: z.literal("project.autoload.remove"),
    target: z.string().min(1),
    summary: z.string().min(1),
    name: autoloadNameSchema,
    previousScriptPath: scriptPathSchema,
  })
  .strict();

const scenePropertyDiffBase = {
  kind: z.literal("scene.set_property"),
  target: z.string().min(1),
  summary: z.string().min(1),
};

const scenePropertyDiffVisibleSchema = z.object({
  ...scenePropertyDiffBase,
  property: z.literal("visible"),
  before: z.boolean(),
  after: z.boolean(),
}).strict();
const scenePropertyDiffPositionSchema = z.object({
  ...scenePropertyDiffBase,
  property: z.literal("position"),
  before: positionSchema,
  after: positionSchema,
}).strict();
const scenePropertyDiffRotationDegreesSchema = z.object({
  ...scenePropertyDiffBase,
  property: z.literal("rotation_degrees"),
  before: rotationDegreesSchema,
  after: rotationDegreesSchema,
}).strict();
const scenePropertyDiffScaleSchema = z.object({
  ...scenePropertyDiffBase,
  property: z.literal("scale"),
  before: scaleSchema,
  after: scaleSchema,
}).strict();
const scenePropertyDiffSizeSchema = z.object({
  ...scenePropertyDiffBase,
  property: z.literal("size"),
  before: sizeSchema,
  after: sizeSchema,
}).strict();
const scenePropertyDiffTextSchema = z.object({
  ...scenePropertyDiffBase,
  property: z.literal("text"),
  before: z.string().max(10000),
  after: z.string().max(10000),
}).strict();
const scenePropertyDiffColorSchema = z.object({
  ...scenePropertyDiffBase,
  property: z.literal("color"),
  before: colorSchema,
  after: colorSchema,
}).strict();

export const scenePropertyDiffSchema = z.union([
  scenePropertyDiffVisibleSchema,
  scenePropertyDiffPositionSchema,
  scenePropertyDiffRotationDegreesSchema,
  scenePropertyDiffScaleSchema,
  scenePropertyDiffSizeSchema,
  scenePropertyDiffTextSchema,
  scenePropertyDiffColorSchema,
]);

export const sceneAttachScriptDiffSchema = z.object({
  kind: z.literal("scene.attach_script"),
  target: z.string().min(1),
  summary: z.string().min(1),
  scriptPath: z.string().min(1),
});

export const sceneDetachScriptDiffSchema = z.object({
  kind: z.literal("scene.detach_script"),
  target: z.string().min(1),
  summary: z.string().min(1),
  nodePath: nodePathSchema,
  scriptPath: scriptPathSchema,
}).strict();

export const changeDiffSchema = z.union([
  sceneChangeDiffSchema,
  sceneDeleteNodeDiffSchema,
  sceneReparentNodeDiffSchema,
  sceneRenameNodeDiffSchema,
  sceneDuplicateNodeDiffSchema,
  sceneInstantiateSceneDiffSchema,
  sceneConnectSignalDiffSchema,
  sceneDisconnectSignalDiffSchema,
  sceneAddGroupDiffSchema,
  sceneRemoveGroupDiffSchema,
  sceneReorderNodeDiffSchema,
  scenePropertyDiffSchema,
  sceneAttachScriptDiffSchema,
  sceneDetachScriptDiffSchema,
  resourceReferenceDiffSchema,
  inputActionDiffSchema,
  inputActionRemoveKeyDiffSchema,
  inputActionReplaceKeyDiffSchema,
  autoloadAddDiffSchema,
  autoloadRemoveDiffSchema,
  scriptChangeDiffSchema,
]);

export const changePlanSchema = z.object({
  schemaVersion: z.literal("0.2"),
  planId: z.string().min(1),
  projectRoot: z.string().min(1),
  expectedRevision: z.string().min(1),
  expectedFileRevision: z.string().nullable(),
  mode: z.literal("preview"),
  reason: z.string().min(1),
  operations: z.array(changeOperationSchema).min(1),
  diff: z.array(changeDiffSchema).min(1),
});

export const confirmedChangeSchema = z.object({
  planId: z.string().min(1),
  status: z.literal("confirmed"),
  expectedRevision: z.string().min(1),
});

export type SafeNodeType = z.infer<typeof safeNodeTypeSchema>;
export type ChangeOperation = z.infer<typeof changeOperationSchema>;
export type PreviewSceneChangeInput = z.input<typeof previewSceneChangeInputSchema>;
export type ConfirmChangeInput = z.infer<typeof confirmChangeInputSchema>;
export type ApplyChangeInput = z.infer<typeof applyChangeInputSchema>;
export type ChangeDiff = z.infer<typeof changeDiffSchema>;
export type ChangePlan = z.infer<typeof changePlanSchema>;
export type ConfirmedChange = z.infer<typeof confirmedChangeSchema>;
