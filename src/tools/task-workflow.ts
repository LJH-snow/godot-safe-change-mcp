import type { MCPServer } from "mcp-use";
import {
  acquireTaskLeaseInputSchema,
  createTaskInputSchema,
  taskIdInputSchema,
  taskLeaseInputSchema,
  taskTimelineInputSchema,
  taskTimelineReportSchema,
  taskStateSchema,
  type CreateTaskInput,
  type TaskIdInput,
} from "../domain/task-contracts.js";
import type { TaskCoordinator } from "../application/task-coordinator.js";
import { toolError } from "./tool-errors.js";

export function registerCreateTaskTool(server: MCPServer, coordinator: TaskCoordinator) {
  return server.tool(
    {
      name: "create_task",
      title: "Create a multi-step Godot task",
      description:
        "Declare bounded apply, rollback, run, verification and diagnostic-repair steps; repair previews pause for user review and apply only after confirmation.",
      inputSchema: createTaskInputSchema,
      outputSchema: taskStateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input: CreateTaskInput) => {
      try {
        const task = await coordinator.createTask(input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }],
          structuredContent: task,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

export function registerGetTaskTool(server: MCPServer, coordinator: TaskCoordinator) {
  return server.tool(
    {
      name: "get_task",
      title: "Read a Godot task state",
      description:
        "Read the persisted task timeline, including per-step status, attempts and evidence.",
      inputSchema: taskIdInputSchema,
      outputSchema: taskStateSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input: TaskIdInput) => {
      try {
        const task = await coordinator.getTask(input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }],
          structuredContent: task,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

export function registerTaskStatusTool(server: MCPServer, coordinator: TaskCoordinator) {
  return server.tool(
    {
      name: "task_status",
      title: "Read task status",
      description: "Read task state, lease owner, expiry and recoverability after a restart.",
      inputSchema: taskIdInputSchema,
      outputSchema: taskStateSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input: TaskIdInput) => {
      try {
        const task = await coordinator.getTask(input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }],
          structuredContent: task,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

export function registerTaskTimelineTool(server: MCPServer, coordinator: TaskCoordinator) {
  return server.tool(
    {
      name: "task_timeline",
      title: "Read task timeline",
      description:
        "Read a filtered, read-only task timeline by step, event type and ISO time range.",
      inputSchema: taskTimelineInputSchema,
      outputSchema: taskTimelineReportSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        const report = await coordinator.getTaskTimeline(input);
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

export function registerAcquireTaskLeaseTool(server: MCPServer, coordinator: TaskCoordinator) {
  return server.tool(
    {
      name: "acquire_task_lease",
      title: "Acquire task lease",
      description: "Hold a project lease across multiple task steps until released or expired.",
      inputSchema: acquireTaskLeaseInputSchema,
      outputSchema: taskStateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      try {
        const task = await coordinator.acquireTaskLease(input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }],
          structuredContent: task,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

export function registerRenewTaskLeaseTool(server: MCPServer, coordinator: TaskCoordinator) {
  return server.tool(
    {
      name: "renew_task_lease",
      title: "Renew task lease",
      description: "Extend an owned task lease before it expires.",
      inputSchema: taskLeaseInputSchema,
      outputSchema: taskStateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      try {
        const task = await coordinator.renewTaskLease(input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }],
          structuredContent: task,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

export function registerReleaseTaskLeaseTool(server: MCPServer, coordinator: TaskCoordinator) {
  return server.tool(
    {
      name: "release_task_lease",
      title: "Release task lease",
      description: "Release an owned task lease so another window can resume the task.",
      inputSchema: taskLeaseInputSchema,
      outputSchema: taskStateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      try {
        const task = await coordinator.releaseTaskLease(input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }],
          structuredContent: task,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

export function registerAdvanceTaskTool(server: MCPServer, coordinator: TaskCoordinator) {
  return server.tool(
    {
      name: "advance_task",
      title: "Advance a Godot task",
      description:
        "Execute the next pending or failed step; a failed step is retried through the same guards.",
      inputSchema: taskIdInputSchema,
      outputSchema: taskStateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input: TaskIdInput) => {
      try {
        const task = await coordinator.advanceTask(input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }],
          structuredContent: task,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

export function registerPauseTaskTool(server: MCPServer, coordinator: TaskCoordinator) {
  return server.tool(
    {
      name: "pause_task",
      title: "Pause a Godot task",
      description: "Pause an active task so advance_task is rejected until it is resumed.",
      inputSchema: taskIdInputSchema,
      outputSchema: taskStateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input: TaskIdInput) => {
      try {
        const task = await coordinator.pauseTask(input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }],
          structuredContent: task,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

export function registerResumeTaskTool(server: MCPServer, coordinator: TaskCoordinator) {
  return server.tool(
    {
      name: "resume_task",
      title: "Resume a Godot task",
      description: "Resume a paused task so its remaining steps can advance again.",
      inputSchema: taskIdInputSchema,
      outputSchema: taskStateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input: TaskIdInput) => {
      try {
        const task = await coordinator.resumeTask(input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }],
          structuredContent: task,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

export function registerCancelTaskTool(server: MCPServer, coordinator: TaskCoordinator) {
  return server.tool(
    {
      name: "cancel_task",
      title: "Cancel a Godot task",
      description:
        "Cancel an active, paused or failed task; pending steps become cancelled and cannot advance.",
      inputSchema: taskIdInputSchema,
      outputSchema: taskStateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input: TaskIdInput) => {
      try {
        const task = await coordinator.cancelTask(input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }],
          structuredContent: task,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
