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

const relativeNodePathPattern = /^(?:\.|[A-Za-z_][A-Za-z0-9_]*(?:\/[A-Za-z_][A-Za-z0-9_]*)*)$/;
const projectRelativePathPattern = /^res:\/\/(?!\/)(?:[^\/\\\0]+\/)*[^\/\\\0]+$/;
const resourceIdentifierPattern = /^(?:uid:\/\/[A-Za-z0-9_-]+|res:\/\/(?!\/)(?:[^\/\\\0]+\/)*[^\/\\\0]+)$/;

export const nodePathSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(relativeNodePathPattern, "NodePath must be relative and contain only safe segments.");

const scriptPathSchema = z
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

const resourcePathSchema = z
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
  sceneSetSizePropertySchema,
  sceneSetTextPropertySchema,
  sceneSetColorPropertySchema,
]);

export const sceneAttachScriptSchema = z
  .object({
    kind: z.literal("scene.attach_script"),
    nodePath: nodePathSchema,
    scriptPath: scriptPathSchema,
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

export const changeOperationSchema = z.union([
  createNodeOperationSchema,
  sceneSetPropertySchema,
  sceneAttachScriptSchema,
  resourceReplaceReferenceSchema,
  inputActionAddKeySchema,
  inputActionRemoveKeySchema,
  inputActionReplaceKeySchema,
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

export const changeDiffSchema = z.union([
  sceneChangeDiffSchema,
  scenePropertyDiffSchema,
  sceneAttachScriptDiffSchema,
  resourceReferenceDiffSchema,
  inputActionDiffSchema,
  inputActionRemoveKeyDiffSchema,
  inputActionReplaceKeyDiffSchema,
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
export type PreviewSceneChangeInput = z.infer<typeof previewSceneChangeInputSchema>;
export type ConfirmChangeInput = z.infer<typeof confirmChangeInputSchema>;
export type ApplyChangeInput = z.infer<typeof applyChangeInputSchema>;
export type ChangeDiff = z.infer<typeof changeDiffSchema>;
export type ChangePlan = z.infer<typeof changePlanSchema>;
export type ConfirmedChange = z.infer<typeof confirmedChangeSchema>;
