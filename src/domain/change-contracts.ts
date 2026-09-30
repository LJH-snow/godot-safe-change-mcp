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

export const nodePathSchema = z.string().min(1).max(256);

export const createNodeOperationSchema = z
  .object({
    kind: z.literal("scene.create_node"),
    parentPath: nodePathSchema.describe("NodePath inside the current scene."),
    nodeName: nodeNameSchema.describe("Name for the new node."),
    nodeType: safeNodeTypeSchema.describe("Allowed Godot node class."),
  })
  .strict();

export const sceneSetPropertySchema = z
  .object({
    kind: z.literal("scene.set_property"),
    nodePath: nodePathSchema,
    property: z.enum(["visible", "position", "size", "text", "color"]),
    value: z.union([
      z.boolean(),
      z.string().max(10000),
      z.object({ x: z.number(), y: z.number() }).strict(),
      z.object({ r: z.number(), g: z.number(), b: z.number(), a: z.number() }).strict(),
    ]),
  })
  .strict();

export const sceneAttachScriptSchema = z
  .object({
    kind: z.literal("scene.attach_script"),
    nodePath: nodePathSchema,
    scriptPath: z
      .string()
      .min(1)
      .max(256)
      .regex(/^res:\/\/[^\\0]+\.gd$/)
      .refine((value) => !value.includes(".."), "scriptPath must not contain parent traversal."),
  })
  .strict();

export const resourceReplaceReferenceSchema = z
  .object({
    kind: z.literal("resource.replace_reference"),
    resourcePath: z
      .string()
      .min(1)
      .max(256)
      .regex(/^res:\/\/[^\\0]+\.(tscn|tres|res)$/)
      .refine((value) => !value.includes(".."), "resourcePath must not contain parent traversal."),
    from: z.string().min(1).max(300).regex(/^(res:\/\/|uid:\/\/)/),
    to: z.string().min(1).max(300).regex(/^(res:\/\/|uid:\/\/)/),
  })
  .strict();

export const inputActionAddKeySchema = z
  .object({
    kind: z.literal("project.input_action.add_key"),
    actionName: z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    physicalKeycode: z.number().int().min(1).max(10000),
    deadzone: z.number().min(0).max(1).optional(),
  })
  .strict();

export const scriptReplaceRangeSchema = z
  .object({
    kind: z.literal("script.replace_range"),
    scriptPath: z
      .string()
      .min(1)
      .max(256)
      .regex(/^res:\/\/[^\\0]+\.gd$/)
      .refine((value) => !value.includes(".."), "scriptPath must not contain parent traversal."),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    replacement: z.string().max(100000),
  })
  .strict()
  .refine((value) => value.startLine <= value.endLine, {
    message: "startLine must be less than or equal to endLine.",
  });

export const changeOperationSchema = z.discriminatedUnion("kind", [
  createNodeOperationSchema,
  sceneSetPropertySchema,
  sceneAttachScriptSchema,
  resourceReplaceReferenceSchema,
  inputActionAddKeySchema,
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

export const scenePropertyDiffSchema = z.object({
  kind: z.literal("scene.set_property"),
  target: z.string().min(1),
  summary: z.string().min(1),
  property: z.string().min(1),
  before: z.unknown(),
  after: z.unknown(),
});

export const sceneAttachScriptDiffSchema = z.object({
  kind: z.literal("scene.attach_script"),
  target: z.string().min(1),
  summary: z.string().min(1),
  scriptPath: z.string().min(1),
});

export const changeDiffSchema = z.discriminatedUnion("kind", [
  sceneChangeDiffSchema,
  scenePropertyDiffSchema,
  sceneAttachScriptDiffSchema,
  resourceReferenceDiffSchema,
  inputActionDiffSchema,
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
