import { DomainError } from "../domain/errors.js";

export interface ToolErrorResult {
  [key: string]: unknown;
  isError: true;
  content: [{ type: "text"; text: string }];
}

export function toolError(error: unknown): ToolErrorResult {
  const payload =
    error instanceof DomainError
      ? {
          code: error.code,
          message: error.message,
          details: error.details,
        }
      : {
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : String(error),
        };

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: payload }, null, 2),
      },
    ],
  };
}
