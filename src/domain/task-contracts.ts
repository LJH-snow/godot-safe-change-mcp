import { z } from "zod";
import { changePlanSchema, nodePathSchema, resourcePathSchema, scriptPathSchema, scenePropertyAssertionSchema } from "./change-contracts.js";
import { diagnosticEntrySchema, diagnosticRepairHintSchema } from "./contracts.js";

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

export const verifySceneStateStepDeclSchema = z
  .object({
    kind: z.literal("verify_scene_state"),
    stepId: taskStepIdSchema,
    nodePath: nodePathSchema,
    expectedProperties: z.array(scenePropertyAssertionSchema).max(5).optional(),
    note: taskStepNoteSchema.optional(),
  })
  .strict();

export const resourceMatchCountAssertionSchema = z
  .object({
    text: z.string().min(1).max(512),
    expectedCount: z.number().int().min(0).max(1000),
  })
  .strict();

export const verifyResourceStateStepDeclSchema = z
  .object({
    kind: z.literal("verify_resource_state"),
    stepId: taskStepIdSchema,
    resourcePath: resourcePathSchema,
    expectedResourceRevision: z.string().min(1).optional(),
    contains: z.array(z.string().min(1).max(512)).max(10).optional(),
    matchCounts: z.array(resourceMatchCountAssertionSchema).max(10).optional(),
    note: taskStepNoteSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.expectedResourceRevision === undefined &&
      (value.contains?.length ?? 0) === 0 &&
      (value.matchCounts?.length ?? 0) === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contains"],
        message: "A resource verification step needs a revision, contains assertion, or match count.",
      });
    }
  });

export const verifyScriptStateStepDeclSchema = z
  .object({
    kind: z.literal("verify_script_state"),
    stepId: taskStepIdSchema,
    scriptPath: scriptPathSchema,
    expectedScriptRevision: z.string().min(1).optional(),
    contains: z.array(z.string().min(1).max(512)).max(10).optional(),
    matchCounts: z.array(resourceMatchCountAssertionSchema).max(10).optional(),
    note: taskStepNoteSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.expectedScriptRevision === undefined &&
      (value.contains?.length ?? 0) === 0 &&
      (value.matchCounts?.length ?? 0) === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contains"],
        message: "A script verification step needs a revision, contains assertion, or match count.",
      });
    }
  });

export const verifyDiagnosticsStepDeclSchema = z
  .object({
    kind: z.literal("verify_diagnostics"),
    stepId: taskStepIdSchema,
    runStepId: taskStepIdSchema,
    maxErrors: z.number().int().min(0).max(1000).optional(),
    maxWarnings: z.number().int().min(0).max(1000).optional(),
    note: taskStepNoteSchema.optional(),
  })
  .strict();

export const previewDiagnosticRepairStepDeclSchema = z
  .object({
    kind: z.literal("preview_diagnostic_repair"),
    stepId: taskStepIdSchema,
    runStepId: taskStepIdSchema,
    diagnosticKind: z.enum(["error", "warning"]),
    diagnosticIndex: z.number().int().min(0).max(1000),
    repairHint: diagnosticRepairHintSchema.optional(),
    note: taskStepNoteSchema.optional(),
  })
  .strict();

export const rerunDiagnosticsPolicySchema = z
  .object({
    maxErrors: z.number().int().min(0).max(1000).optional(),
    maxWarnings: z.number().int().min(0).max(1000).optional(),
    timeoutMs: z.number().int().min(100).max(30000).optional(),
  })
  .strict();

export type RerunDiagnosticsPolicy = z.infer<typeof rerunDiagnosticsPolicySchema>;

export const applyDiagnosticRepairStepDeclSchema = z
  .object({
    kind: z.literal("apply_diagnostic_repair"),
    stepId: taskStepIdSchema,
    previewStepId: taskStepIdSchema,
    rerunDiagnostics: rerunDiagnosticsPolicySchema.optional(),
    note: taskStepNoteSchema.optional(),
  })
  .strict();

export const diagnosticRepairPreviewResultSchema = z
  .object({
    runStepId: taskStepIdSchema,
    runId: z.string().min(1),
    diagnosticKind: z.enum(["error", "warning"]),
    diagnosticIndex: z.number().int().min(0).max(1000),
    diagnostic: diagnosticEntrySchema,
    repairHint: diagnosticRepairHintSchema,
    plan: changePlanSchema,
  })
  .strict();

export const taskStepDeclSchema = z.discriminatedUnion("kind", [
  runSceneStepDeclSchema,
  runCurrentSceneStepDeclSchema,
  applyPlanStepDeclSchema,
  rollbackPlanStepDeclSchema,
  verifySceneStateStepDeclSchema,
  verifyResourceStateStepDeclSchema,
  verifyScriptStateStepDeclSchema,
  verifyDiagnosticsStepDeclSchema,
  previewDiagnosticRepairStepDeclSchema,
  applyDiagnosticRepairStepDeclSchema,
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

export const taskTimelineEventStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "step_interrupted",
  "paused",
  "resumed",
  "cancelled",
  "lease_acquired",
  "lease_renewed",
  "lease_renew_failed",
  "lease_recovered",
  "lease_released",
  "lease_reclaimed",
]);

const timelineTimestampSchema = z
  .string()
  .min(1)
  .refine((value) => Number.isFinite(Date.parse(value)), "timestamp must be a valid ISO date.");

export const taskTimelineEventSchema = z.object({
  eventId: z.string().min(1),
  stepId: taskStepIdSchema.nullable(),
  operationId: z.string().nullable().default(null),
  status: taskTimelineEventStatusSchema,
  at: z.string().min(1),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    })
    .optional(),
});

export const taskTimelineInputSchema = z
  .object({
    projectRoot: z.string().min(1),
    taskId: taskIdSchema,
    stepId: taskStepIdSchema.optional(),
    operationId: z.string().min(1).max(128).optional(),
    eventTypes: z.array(taskTimelineEventStatusSchema).min(1).max(13).optional(),
    from: timelineTimestampSchema.optional(),
    to: timelineTimestampSchema.optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .superRefine((value, context) => {
    if (value.from !== undefined && value.to !== undefined && Date.parse(value.from) > Date.parse(value.to)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "to must be greater than or equal to from.",
      });
    }
  });

export const taskLeaseSchema = z.object({
  leaseId: z.string().min(1),
  ownerId: z.string().min(1),
  acquiredAt: z.string().min(1),
  expiresAt: z.string().min(1),
});

export const createTaskInputSchema = z
  .object({
    projectRoot: z.string().min(1),
    title: z.string().min(1).max(200),
    steps: z.array(taskStepDeclSchema).min(1).max(20),
  })
  .superRefine((input, context) => {
    const findUniqueEarlierStep = (stepId: string, beforeIndex: number) => {
      const matches = input.steps
        .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
        .filter(({ candidate }) => candidate.stepId === stepId);
      const match = matches[0];
      if (matches.length !== 1 || match === undefined || match.candidateIndex >= beforeIndex) {
        return undefined;
      }
      return match.candidate;
    };
    const seenStepIds = new Set<string>();
    input.steps.forEach((step, index) => {
      if (seenStepIds.has(step.stepId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "stepId"],
          message: "stepId must be unique within a task.",
        });
      }
      seenStepIds.add(step.stepId);
      if (step.kind === "verify_diagnostics" || step.kind === "preview_diagnostic_repair") {
        const runStep = findUniqueEarlierStep(step.runStepId, index);
        if (runStep?.kind === "run_current_scene" || runStep?.kind === "run_scene") {
          return;
        }
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "runStepId"],
          message: "runStepId must uniquely reference an earlier run_current_scene or run_scene step.",
        });
        return;
      }
      if (step.kind === "apply_diagnostic_repair") {
        const previewStep = findUniqueEarlierStep(step.previewStepId, index);
        if (previewStep?.kind === "preview_diagnostic_repair") {
          return;
        }
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "previewStepId"],
          message: "previewStepId must uniquely reference an earlier preview_diagnostic_repair step.",
        });
      }
    });
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
  kind: z.enum(["run_current_scene", "run_scene", "apply_plan", "rollback_plan", "verify_scene_state", "verify_resource_state", "verify_script_state", "verify_diagnostics", "preview_diagnostic_repair", "apply_diagnostic_repair"]),
  planId: z.string().nullable(),
  scenePath: z.string().nullable().default(null),
  nodePath: z.string().nullable().default(null),
  resourcePath: z.string().nullable().default(null),
  expectedResourceRevision: z.string().nullable().default(null),
  resourceContains: z.array(z.string()).default([]),
  resourceMatchCounts: z.array(resourceMatchCountAssertionSchema).default([]),
  scriptPath: z.string().nullable().default(null),
  expectedScriptRevision: z.string().nullable().default(null),
  scriptContains: z.array(z.string()).default([]),
  scriptMatchCounts: z.array(resourceMatchCountAssertionSchema).default([]),
  expectedProperties: z.array(scenePropertyAssertionSchema).default([]),
  runStepId: taskStepIdSchema.nullable().default(null),
  maxErrors: z.number().int().min(0).max(1000).default(0),
  maxWarnings: z.number().int().min(0).max(1000).default(0),
  diagnosticKind: z.enum(["error", "warning"]).nullable().default(null),
  diagnosticIndex: z.number().int().min(0).max(1000).nullable().default(null),
  repairHint: diagnosticRepairHintSchema.nullable().default(null),
  previewStepId: taskStepIdSchema.nullable().default(null),
  rerunDiagnostics: rerunDiagnosticsPolicySchema.nullable().default(null),
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
      details: z.unknown().optional(),
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

export const taskTimelineReportSchema = z.object({
  schemaVersion: z.literal("0.1"),
  projectRoot: z.string().min(1),
  taskId: taskIdSchema,
  status: taskStatusSchema,
  events: z.array(taskTimelineEventSchema),
  total: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export type TaskStepDecl = z.infer<typeof taskStepDeclSchema>;
export type VerifySceneStateStepDecl = z.infer<typeof verifySceneStateStepDeclSchema>;
export type VerifyResourceStateStepDecl = z.infer<typeof verifyResourceStateStepDeclSchema>;
export type VerifyScriptStateStepDecl = z.infer<typeof verifyScriptStateStepDeclSchema>;
export type VerifyDiagnosticsStepDecl = z.infer<typeof verifyDiagnosticsStepDeclSchema>;
export type PreviewDiagnosticRepairStepDecl = z.infer<typeof previewDiagnosticRepairStepDeclSchema>;
export type ApplyDiagnosticRepairStepDecl = z.infer<typeof applyDiagnosticRepairStepDeclSchema>;
export type ScenePropertyAssertion = z.infer<typeof scenePropertyAssertionSchema>;
export type DiagnosticRepairPreviewResult = z.infer<typeof diagnosticRepairPreviewResultSchema>;
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
export type TaskTimelineInput = z.infer<typeof taskTimelineInputSchema>;
export type TaskTimelineReport = z.infer<typeof taskTimelineReportSchema>;
