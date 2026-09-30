import { z } from "zod";

export const taskIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "taskId must be a slug so it stays safe inside the task directory.");

export const taskStepIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "stepId must be a slug so timelines stay stable.");

export const taskStepNoteSchema = z.string().max(500);

export const runSceneStepDeclSchema = z
  .object({
    kind: z.literal("run_current_scene"),
    stepId: taskStepIdSchema,
    timeoutMs: z.number().int().min(100).max(30000).optional(),
    note: taskStepNoteSchema.optional(),
  })
  .strict();

export const applyPlanStepDeclSchema = z
  .object({
    kind: z.literal("apply_plan"),
    stepId: taskStepIdSchema,
    planId: z.string().min(1),
    expectedRevision: z.string().min(1),
    note: taskStepNoteSchema.optional(),
  })
  .strict();

export const rollbackPlanStepDeclSchema = z
  .object({
    kind: z.literal("rollback_plan"),
    stepId: taskStepIdSchema,
    planId: z.string().min(1),
    note: taskStepNoteSchema.optional(),
  })
  .strict();

export const taskStepDeclSchema = z.discriminatedUnion("kind", [
  runSceneStepDeclSchema,
  applyPlanStepDeclSchema,
  rollbackPlanStepDeclSchema,
]);

export const taskStatusSchema = z.enum([
  "active",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

export const taskStepStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const createTaskInputSchema = z.object({
  projectRoot: z.string().min(1),
  title: z.string().min(1).max(200),
  steps: z.array(taskStepDeclSchema).min(1).max(20),
});

export const taskIdInputSchema = z.object({
  projectRoot: z.string().min(1),
  taskId: taskIdSchema,
});

export const taskStepStateSchema = z.object({
  stepId: taskStepIdSchema,
  kind: z.enum(["run_current_scene", "apply_plan", "rollback_plan"]),
  planId: z.string().nullable(),
  expectedRevision: z.string().nullable(),
  status: taskStepStatusSchema,
  attempts: z.number().int().nonnegative(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

export const taskStateSchema = z.object({
  schemaVersion: z.literal("0.1"),
  taskId: taskIdSchema,
  projectRoot: z.string().min(1),
  title: z.string().min(1),
  status: taskStatusSchema,
  steps: z.array(taskStepStateSchema),
  nextStepId: z.string().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type TaskStepDecl = z.infer<typeof taskStepDeclSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskStepStatus = z.infer<typeof taskStepStatusSchema>;
export type TaskStepState = z.infer<typeof taskStepStateSchema>;
export type TaskState = z.infer<typeof taskStateSchema>;
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;
export type TaskIdInput = z.infer<typeof taskIdInputSchema>;
