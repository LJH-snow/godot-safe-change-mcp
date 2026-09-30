import { z } from "zod";

export const findReferencesInputSchema = z.object({
  projectRoot: z
    .string()
    .min(1)
    .describe("Absolute or workspace-relative path to the Godot project."),
  target: z
    .string()
    .min(1)
    .max(300)
    .describe(
      "Case-insensitive substring of the referenced resource, e.g. res://scripts/player.gd, player.gd or a uid:// identifier. Script preload/load references are included.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum number of referencing files to return; defaults to 50."),
});

export type FindReferencesInput = z.infer<typeof findReferencesInputSchema>;

export const referenceEntrySchema = z.object({
  path: z.string().min(1).describe("res:// path of the file that references the target."),
  kind: z
    .enum(["scene", "resource", "script"])
    .describe("Kind of the referencing file."),
  targetPath: z
    .string()
    .nullable()
    .describe("res:// path of the referenced resource as written in the file, if present."),
  targetType: z.string().nullable().describe("Declared ext_resource type, e.g. Script or Texture2D."),
  matchedBy: z.enum(["path", "uid"]).describe("How the reference was matched."),
});

export type ReferenceEntry = z.infer<typeof referenceEntrySchema>;

export const findReferencesReportSchema = z.object({
  schemaVersion: z.literal("0.1"),
  projectRoot: z.string().min(1),
  target: z.string().min(1),
  references: z.array(referenceEntrySchema),
  truncated: z.boolean(),
});

export type FindReferencesReport = z.infer<typeof findReferencesReportSchema>;
