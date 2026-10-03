import type { MCPServer } from "mcp-use";
import {
  searchProjectInputSchema,
  searchProjectReportSchema,
  type SearchProjectInput,
} from "../domain/contracts.js";
import type { ProjectSearchService } from "../application/project-search-service.js";
import { toolError } from "./tool-errors.js";

export function registerSearchProjectTool(
  server: MCPServer,
  service: ProjectSearchService,
) {
  return server.tool(
    {
      name: "search_project",
      title: "Search Godot project",
      description:
        "Find scenes, nodes, scripts, resources, signal connections and input actions without modifying the project. Editor-backed kinds are served by the connected Godot editor when available and fall back to a local read-only project index otherwise; signal and input results always come from the local index. Each result is tagged with its source.",
      inputSchema: searchProjectInputSchema,
      outputSchema: searchProjectReportSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input: SearchProjectInput) => {
      try {
        const report = await service.search(input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
          structuredContent: report,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
