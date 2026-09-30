import { appendFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  operationAuditEntrySchema,
  type OperationAuditEntry,
} from "../domain/contracts.js";

export interface OperationAuditStore {
  append(entry: OperationAuditEntry): Promise<void>;
  list(projectRoot: string, limit: number): Promise<OperationAuditEntry[]>;
}

export class InMemoryOperationAuditStore implements OperationAuditStore {
  private readonly entries: OperationAuditEntry[] = [];

  async append(entry: OperationAuditEntry): Promise<void> {
    this.entries.push(entry);
  }

  async list(projectRoot: string, limit: number): Promise<OperationAuditEntry[]> {
    const latest = new Map<string, OperationAuditEntry>();
    for (const entry of this.entries) {
      if (entry.projectRoot === projectRoot) {
        latest.set(entry.operationId, entry);
      }
    }
    return [...latest.values()].reverse().slice(0, limit);
  }
}

export class FileOperationAuditStore implements OperationAuditStore {
  private readonly baseDirectory: string;

  constructor(baseDirectory = process.env.GODOT_SAFE_CHANGE_STATE_DIR ?? path.join(os.homedir(), ".godot-safe-change-mcp")) {
    this.baseDirectory = baseDirectory;
  }

  async append(entry: OperationAuditEntry): Promise<void> {
    const filePath = this.filePath(entry.projectRoot);
    await mkdir(this.baseDirectory, { recursive: true });
    await appendFile(filePath, JSON.stringify(entry) + "\n", "utf8");
  }

  async list(projectRoot: string, limit: number): Promise<OperationAuditEntry[]> {
    const filePath = this.filePath(projectRoot);
    let contents: string;
    try {
      contents = await readFile(filePath, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const latest = new Map<string, OperationAuditEntry>();
    for (const line of contents.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      const parsed = operationAuditEntrySchema.safeParse(JSON.parse(line));
      if (parsed.success && parsed.data.projectRoot === projectRoot) {
        latest.set(parsed.data.operationId, parsed.data);
      }
    }
    return [...latest.values()]
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, limit);
  }

  private filePath(projectRoot: string): string {
    const key = createHash("sha256").update(projectRoot).digest("hex").slice(0, 32);
    return path.join(this.baseDirectory, "operations-" + key + ".jsonl");
  }
}
