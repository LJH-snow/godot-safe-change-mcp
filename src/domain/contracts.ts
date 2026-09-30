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

export const sceneNodeSchema = z.object({
  path: z.string(),
  name: z.string(),
  type: z.string(),
  properties: z.record(z.string(), z.unknown()),
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
    nodes: z.array(sceneNodeSchema),
  }),
  selection: z.array(sceneNodeSchema),
  openResources: z.array(z.string()),
  run: editorRunStateSchema,
  diagnostics: diagnosticsSchema,
});

export type DiagnosticEntry = z.infer<typeof diagnosticEntrySchema>;
export type Diagnostics = z.infer<typeof diagnosticsSchema>;
export type EditorRunState = z.infer<typeof editorRunStateSchema>;
export type SceneNode = z.infer<typeof sceneNodeSchema>;
export type EditorContext = z.infer<typeof editorContextSchema>;

export const searchProjectKindSchema = z.enum([
  "scene",
  "node",
  "script",
  "resource",
  "signal",
  "input",
]);

export const searchProjectInputSchema = z.object({
  projectRoot: z
    .string()
    .min(1)
    .describe("Absolute or workspace-relative path to the Godot project."),
  query: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Case-insensitive substring to match against file paths, node names and types, signal names and input actions.",
    ),
  kinds: z
    .array(searchProjectKindSchema)
    .min(1)
    .optional()
    .describe(
      "Result kinds to include; defaults to all kinds. The editor bridge serves scene, node, script and resource; signal and input always come from the local project index.",
    ),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum number of results to return; defaults to 50."),
});

export const searchResultSchema = z.object({
  kind: searchProjectKindSchema,
  path: z.string().min(1),
  name: z.string().min(1),
  nodePath: z.string().nullable(),
  nodeType: z.string().nullable(),
  matches: z.array(z.enum(["path", "name", "type", "node_path"])).min(1),
  source: z.enum(["editor", "local"]).optional(),
});

export const searchProjectReportSchema = z.object({
  schemaVersion: z.literal("0.3"),
  projectRoot: z.string().min(1),
  query: z.string().min(1),
  revision: z.string().nullable(),
  results: z.array(searchResultSchema),
  truncated: z.boolean().optional(),
});

export type SearchProjectKind = z.infer<typeof searchProjectKindSchema>;
export type SearchProjectInput = z.infer<typeof searchProjectInputSchema>;
export type SearchProjectRequest = Omit<SearchProjectInput, "projectRoot">;
export type SearchResult = z.infer<typeof searchResultSchema>;
export type SearchProjectReport = z.infer<typeof searchProjectReportSchema>;

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
