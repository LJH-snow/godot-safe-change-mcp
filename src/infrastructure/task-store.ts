import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskState } from "../domain/task-contracts.js";
import { taskStateSchema } from "../domain/task-contracts.js";

/**
 * Persists one JSON file per task under `<projectRoot>/.godot-safe-change/tasks/`
 * so a multi-step task survives an MCP server restart. Writes are atomic
 * (temp file + rename) and the stored document is re-validated on load so a
 * hand-edited or truncated file cannot inject an unknown task shape.
 */
export class FileTaskStore {
  async save(projectRoot: string, task: TaskState): Promise<void> {
    const tasksDir = this.tasksDir(projectRoot);
    await mkdir(tasksDir, { recursive: true });
    const target = join(tasksDir, task.taskId + ".json");
    const temp = join(tasksDir, "." + task.taskId + ".json.tmp");
    await writeFile(temp, JSON.stringify(task, null, 2), "utf8");
    await rename(temp, target);
  }

  async load(projectRoot: string, taskId: string): Promise<TaskState | null> {
    let raw: string;
    try {
      raw = await readFile(join(this.tasksDir(projectRoot), taskId + ".json"), "utf8");
    } catch {
      return null;
    }
    try {
      return taskStateSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  private tasksDir(projectRoot: string): string {
    return join(projectRoot, ".godot-safe-change", "tasks");
  }
}
