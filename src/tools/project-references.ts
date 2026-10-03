import type { MCPServer } from "mcp-use";
import {
  findReferencesInputSchema,
  findReferencesReportSchema,
  type FindReferencesInput,
} from "../domain/reference-contracts.js";
import type { ReferenceService } from "../application/reference-service.js";
import { toolError } from "./tool-errors.js";

export function registerFindReferencesTool(
  server: MCPServer,
  service: ReferenceService,
) {
  return server.tool(
    {
      name: "find_references",
      title: "Find resource references",
      description:
        "Read-only reverse lookup of which scenes, resources or scripts reference a given script, texture or other resource, by res:// path or uid:// identifier. Includes GDScript preload/load calls and is sourced from the local project index.",
      inputSchema: findReferencesInputSchema,
      outputSchema: findReferencesReportSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: FindReferencesInput) => {
      try {
        const report = await service.findReferences(input);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(report, null, 2),
            },
          ],
          structuredContent: report,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
