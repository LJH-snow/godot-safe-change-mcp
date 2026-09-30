import { z } from "zod";
import type { ChangeOperation } from "./change-contracts.js";

export const projectSectionSchema = z.enum([
  "scenes",
  "scripts",
  "resources",
  "settings",
]);

export const projectOverviewInputSchema = z.object({
  projectRoot: z
    .string()
    .min(1)
    .describe("Absolute or workspace-relative path to the Godot project."),
  include: z
    .array(projectSectionSchema)
    .min(1)
    .optional()
    .describe("Project sections to include in the overview."),
});

export type ProjectSection = z.infer<typeof projectSectionSchema>;
export type ProjectOverviewInput = z.infer<typeof projectOverviewInputSchema>;

export interface ProjectOverview {
  schemaVersion: "0.1";
  projectRoot: string;
  connection: "disconnected" | "connected";
  revision: string | null;
  sections: ProjectSection[];
  counts: {
    scenes: number;
    scripts: number;
    resources: number;
    settings: number;
  };
  notes: string[];
}

export const projectOverviewSchema = z.object({
  schemaVersion: z.literal("0.1"),
  projectRoot: z.string().min(1),
  connection: z.enum(["disconnected", "connected"]),
  revision: z.string().nullable(),
  sections: z.array(projectSectionSchema),
  counts: z.object({
    scenes: z.number().int().nonnegative(),
    scripts: z.number().int().nonnegative(),
    resources: z.number().int().nonnegative(),
    settings: z.number().int().nonnegative(),
  }),
  notes: z.array(z.string()),
});

export const diagnosticEntrySchema = z.object({
  message: z.string(),
  source: z.string().optional(),
  line: z.number().int().nonnegative().optional(),
  column: z.number().int().nonnegative().optional(),
});

export const diagnosticsSchema = z.object({
  output: z.array(z.string()),
  warnings: z.array(diagnosticEntrySchema),
  errors: z.array(diagnosticEntrySchema),
});

export const editorRunStateSchema = z.object({
  status: z.enum(["idle", "starting", "running", "stopped", "failed"]),
  scenePath: z.string().nullable(),
  runId: z.string().nullable(),
});

export const editorContextSchema = z.object({
  schemaVersion: z.literal("0.2"),
  projectRoot: z.string().min(1),
  connection: z.enum(["disconnected", "connected"]),
  revision: z.string().nullable(),
  project: z.object({
    name: z.string(),
    path: z.string(),
  }),
  currentScene: z.object({
    path: z.string().nullable(),
    rootName: z.string().nullable(),
    rootType: z.string().nullable(),
  }),
  selection: z.array(
    z.object({
      path: z.string(),
      name: z.string(),
      type: z.string(),
    }),
  ),
  openResources: z.array(z.string()),
  run: editorRunStateSchema,
  diagnostics: diagnosticsSchema,
});

export type DiagnosticEntry = z.infer<typeof diagnosticEntrySchema>;
export type Diagnostics = z.infer<typeof diagnosticsSchema>;
export type EditorRunState = z.infer<typeof editorRunStateSchema>;
export type EditorContext = z.infer<typeof editorContextSchema>;

export interface ApplyChangeRequest {
  planId: string;
  expectedRevision: string;
  operations: ChangeOperation[];
}

export interface RollbackRequest {
  planId: string;
  expectedRevision: string;
}

export const changeReportSchema = z.object({
  schemaVersion: z.literal("0.2"),
  planId: z.string().min(1),
  status: z.literal("applied"),
  revision: z.string().min(1),
  operationCount: z.number().int().nonnegative(),
  undoLabel: z.string().min(1),
});

export type ChangeReport = z.infer<typeof changeReportSchema>;

export const rollbackReportSchema = z.object({
  schemaVersion: z.literal("0.2"),
  planId: z.string().min(1),
  status: z.literal("rolled_back"),
  revision: z.string().min(1),
  undoLabel: z.string().min(1),
});

export type RollbackReport = z.infer<typeof rollbackReportSchema>;

export const runCurrentSceneInputSchema = z.object({
  projectRoot: z.string().min(1),
  timeoutMs: z.number().int().min(100).max(30000).optional(),
});

export type RunCurrentSceneInput = z.infer<typeof runCurrentSceneInputSchema>;

export const runDiagnosticsSchema = z.object({
  schemaVersion: z.literal("0.2"),
  runId: z.string().min(1),
  status: z.enum(["starting", "running", "stopped", "failed"]),
  scenePath: z.string().nullable(),
  output: z.array(z.string()),
  warnings: z.array(diagnosticEntrySchema),
  errors: z.array(diagnosticEntrySchema),
});

export type RunDiagnostics = z.infer<typeof runDiagnosticsSchema>;

export const searchSectionSchema = z.enum(["scenes", "scripts", "resources"]);

export const projectSearchInputSchema = z.object({
  projectRoot: z
    .string()
    .min(1)
    .describe("Absolute or workspace-relative path to the Godot project."),
  query: z
    .string()
    .min(1)
    .max(200)
    .describe("Case-insensitive substring to match against file paths, node names and node types."),
  sections: z
    .array(searchSectionSchema)
    .min(1)
    .optional()
    .describe("Project sections to search; defaults to scenes, scripts and resources."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum number of matches to return; defaults to 50."),
});

export type SearchSection = z.infer<typeof searchSectionSchema>;
export type ProjectSearchInput = z.infer<typeof projectSearchInputSchema>;

export const searchMatchSchema = z.object({
  section: searchSectionSchema,
  path: z.string().min(1).describe("res:// path of the containing file."),
  name: z.string().min(1).describe("File name for file matches; node name for node matches."),
  kind: z.string().min(1).describe("File extension for file matches; node type for node matches."),
  detail: z.string().optional().describe("Human-readable context for node matches."),
});

export type SearchMatch = z.infer<typeof searchMatchSchema>;

export const projectSearchResultSchema = z.object({
  schemaVersion: z.literal("0.1"),
  projectRoot: z.string().min(1),
  query: z.string().min(1),
  sections: z.array(searchSectionSchema),
  matches: z.array(searchMatchSchema),
  truncated: z.boolean(),
});

export type ProjectSearchResult = z.infer<typeof projectSearchResultSchema>;
