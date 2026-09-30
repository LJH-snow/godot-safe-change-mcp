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

export const changeOperationSchema = z.discriminatedUnion("kind", [
  createNodeOperationSchema,
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
});

export const changeDiffSchema = z.object({
  kind: z.literal("scene.add_node"),
  target: z.string().min(1),
  summary: z.string().min(1),
});

export const changePlanSchema = z.object({
  schemaVersion: z.literal("0.2"),
  planId: z.string().min(1),
  projectRoot: z.string().min(1),
  expectedRevision: z.string().min(1),
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
