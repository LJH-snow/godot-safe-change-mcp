import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileTaskStore } from "../src/infrastructure/task-store.js";
import { taskStateSchema } from "../src/domain/task-contracts.js";

test("serializes concurrent atomic saves for the same task", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "godot-task-store-concurrent-"));
  try {
    const store = new FileTaskStore();
    const task = taskStateSchema.parse({
      schemaVersion: "0.1",
      taskId: "task_concurrent_saves",
      projectRoot,
      title: "Concurrent task saves",
      status: "active",
      steps: [{
        stepId: "run-step",
        kind: "run_current_scene",
        planId: null,
        expectedRevision: null,
        status: "pending",
        attempts: 0,
        startedAt: null,
        finishedAt: null,
        operationId: null,
      }],
      nextStepId: "run-step",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    const snapshots = Array.from({ length: 32 }, (_, index) => ({
      ...task,
      title: "Concurrent snapshot " + index,
      updatedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, 0, index)).toISOString(),
    }));

    const results = await Promise.allSettled(snapshots.map((snapshot) => store.save(projectRoot, snapshot)));

    const failures = results.filter((result) => result.status === "rejected");
    assert.deepEqual(failures, []);
    const saved = await store.load(projectRoot, task.taskId);
    assert.equal(saved?.title, "Concurrent snapshot 31");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
