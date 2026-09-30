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

export const runCurrentSceneStepDeclSchema = z
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

export const runSceneStepDeclSchema = z
  .object({
    kind: z.literal("run_scene"),
    stepId: taskStepIdSchema,
    scenePath: z
      .string()
      .min(1)
      .max(256)
      .regex(/^res:\/\/[^\0]+\.tscn$/, "scenePath must be a res:// .tscn path.")
      .refine((value) => !value.includes(".."), "scenePath must not contain parent traversal."),
    timeoutMs: z.number().int().min(100).max(30000).optional(),
    note: taskStepNoteSchema.optional(),
  })
  .strict();

export const taskStepDeclSchema = z.discriminatedUnion("kind", [
  runSceneStepDeclSchema,
  runCurrentSceneStepDeclSchema,
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

export const taskTimelineEventSchema = z.object({
  eventId: z.string().min(1),
  stepId: taskStepIdSchema.nullable(),
  operationId: z.string().nullable().default(null),
  status: z.enum([
    "running",
    "succeeded",
    "failed",
    "paused",
    "resumed",
    "cancelled",
    "lease_acquired",
    "lease_renewed",
    "lease_released",
    "lease_reclaimed",
  ]),
  at: z.string().min(1),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

export const taskLeaseSchema = z.object({
  leaseId: z.string().min(1),
  ownerId: z.string().min(1),
  acquiredAt: z.string().min(1),
  expiresAt: z.string().min(1),
});

export const createTaskInputSchema = z.object({
  projectRoot: z.string().min(1),
  title: z.string().min(1).max(200),
  steps: z.array(taskStepDeclSchema).min(1).max(20),
});

export const taskIdInputSchema = z.object({
  projectRoot: z.string().min(1),
  taskId: taskIdSchema,
});

export const taskLeaseInputSchema = z.object({
  projectRoot: z.string().min(1),
  taskId: taskIdSchema,
  leaseId: z.string().min(1),
  ttlMs: z.number().int().min(1000).max(3600000).optional(),
});

export const acquireTaskLeaseInputSchema = z.object({
  projectRoot: z.string().min(1),
  taskId: taskIdSchema,
  ttlMs: z.number().int().min(1000).max(3600000).optional(),
});

export const taskStepStateSchema = z.object({
  stepId: taskStepIdSchema,
  kind: z.enum(["run_current_scene", "run_scene", "apply_plan", "rollback_plan"]),
  planId: z.string().nullable(),
  scenePath: z.string().nullable().default(null),
  timeoutMs: z.number().int().min(100).max(30000).nullable().default(null),
  expectedRevision: z.string().nullable(),
  status: taskStepStatusSchema,
  attempts: z.number().int().nonnegative(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  operationId: z.string().nullable().default(null),
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
  lease: taskLeaseSchema.nullable().default(null),
  recoverable: z.boolean().default(true),
  timeline: z.array(taskTimelineEventSchema).default([]),
});

export type TaskStepDecl = z.infer<typeof taskStepDeclSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskStepStatus = z.infer<typeof taskStepStatusSchema>;
export type TaskStepState = z.infer<typeof taskStepStateSchema>;
export type TaskState = z.infer<typeof taskStateSchema>;
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;
export type TaskIdInput = z.infer<typeof taskIdInputSchema>;
export type TaskLeaseInput = z.infer<typeof taskLeaseInputSchema>;
export type AcquireTaskLeaseInput = z.infer<typeof acquireTaskLeaseInputSchema>;
export type TaskLease = z.infer<typeof taskLeaseSchema>;
export type TaskTimelineEvent = z.infer<typeof taskTimelineEventSchema>;
