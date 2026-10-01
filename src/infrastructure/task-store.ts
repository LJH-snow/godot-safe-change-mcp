import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
  private readonly pendingSaves = new Map<string, Promise<void>>();

  async save(projectRoot: string, task: TaskState): Promise<void> {
    const tasksDir = this.tasksDir(projectRoot);
    const target = join(tasksDir, task.taskId + ".json");
    const serialized = JSON.stringify(task, null, 2);
    const previousSave = this.pendingSaves.get(target) ?? Promise.resolve();
    const currentSave = previousSave.catch(() => undefined).then(async () => {
      await mkdir(tasksDir, { recursive: true });
      const temporaryPath = join(tasksDir, "." + task.taskId + "." + randomUUID() + ".json.tmp");
      try {
        await writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx" });
        await rename(temporaryPath, target);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    });
    this.pendingSaves.set(target, currentSave);
    try {
      await currentSave;
    } finally {
      if (this.pendingSaves.get(target) === currentSave) {
        this.pendingSaves.delete(target);
      }
    }
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
