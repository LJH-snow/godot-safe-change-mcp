import type { MCPServer } from "mcp-use";
import {
  projectSearchInputSchema,
  projectSearchResultSchema,
  type ProjectSearchInput,
} from "../domain/contracts.js";
import type { ProjectService } from "../application/project-service.js";
import { toolError } from "./tool-errors.js";

export function registerProjectSearchTool(
  server: MCPServer,
  service: ProjectService,
) {
  return server.tool(
    {
      name: "search_project",
      title: "Search project",
      description:
        "Read-only search over a Godot project's scenes, scripts and resources, including node names and types inside text scenes.",
      inputSchema: projectSearchInputSchema,
      outputSchema: projectSearchResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async (input: ProjectSearchInput) => {
      try {
        const result = await service.searchProject(input);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
