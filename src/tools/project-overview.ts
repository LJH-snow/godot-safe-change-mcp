import type { MCPServer } from "mcp-use";
import {
  projectOverviewSchema,
  projectOverviewInputSchema,
  type ProjectOverviewInput,
} from "../domain/contracts.js";
import type { ProjectService } from "../application/project-service.js";
import { toolError } from "./tool-errors.js";

export function registerProjectOverviewTool(
  server: MCPServer,
  service: ProjectService,
) {
  return server.tool(
    {
      name: "project_overview",
      title: "Project overview",
      description:
        "Return a contract-first overview of a Godot project and its editor bridge status.",
      inputSchema: projectOverviewInputSchema,
      outputSchema: projectOverviewSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async (input: ProjectOverviewInput) => {
      try {
        const overview = await service.getOverview(input);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(overview, null, 2),
            },
          ],
          structuredContent: overview,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
