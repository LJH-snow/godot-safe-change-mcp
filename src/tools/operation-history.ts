import type { MCPServer } from "mcp-use";
import {
  operationHistoryInputSchema,
  operationHistoryReportSchema,
  type OperationHistoryInput,
} from "../domain/contracts.js";
import { ChangeCoordinator } from "../application/change-coordinator.js";
import { toolError } from "./tool-errors.js";

export function registerOperationHistoryTool(
  server: MCPServer,
  coordinator: ChangeCoordinator,
) {
  return server.tool(
    {
      name: "operation_history",
      title: "Godot operation history",
      description: "Read recent preview, confirmation, apply, rollback and run operations with evidence.",
      inputSchema: operationHistoryInputSchema,
      outputSchema: operationHistoryReportSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input: OperationHistoryInput) => {
      try {
        const report = await coordinator.getOperationHistory(input);
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
