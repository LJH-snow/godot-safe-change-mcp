import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acquireTaskLeaseInputSchema,
  createTaskInputSchema,
  taskTimelineInputSchema,
} from "../src/domain/task-contracts.js";

test("rejects duplicate task step IDs", () => {
  const result = createTaskInputSchema.safeParse({
    projectRoot: "/tmp/godot-project",
    title: "Duplicate step IDs",
    steps: [
      { kind: "run_current_scene", stepId: "same-step" },
      { kind: "run_current_scene", stepId: "same-step" },
    ],
  });

  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((issue) => issue.path.join(".") === "steps.1.stepId"));
  }
});

test("enforces task lease TTL boundaries", () => {
  const base = { projectRoot: "/tmp/godot-project", taskId: "task_safe" };

  assert.equal(acquireTaskLeaseInputSchema.safeParse({ ...base, ttlMs: 999 }).success, false);
  assert.equal(acquireTaskLeaseInputSchema.safeParse({ ...base, ttlMs: 1000 }).success, true);
  assert.equal(acquireTaskLeaseInputSchema.safeParse({ ...base, ttlMs: 3600000 }).success, true);
  assert.equal(acquireTaskLeaseInputSchema.safeParse({ ...base, ttlMs: 3600001 }).success, false);
  assert.equal(acquireTaskLeaseInputSchema.safeParse({ ...base, taskId: "../escape" }).success, false);
});

test("enforces filtered task timeline boundaries", () => {
  const base = { projectRoot: "/tmp/godot-project", taskId: "task_safe" };
  const sameTime = "2026-10-01T00:00:00.000Z";

  assert.equal(
    taskTimelineInputSchema.safeParse({ ...base, from: "2026-10-01T00:00:01.000Z", to: "2026-10-01T00:00:00.000Z" }).success,
    false,
  );
  assert.equal(taskTimelineInputSchema.safeParse({ ...base, from: sameTime, to: sameTime, limit: 500 }).success, true);
  assert.equal(taskTimelineInputSchema.safeParse({ ...base, limit: 0 }).success, false);
  assert.equal(taskTimelineInputSchema.safeParse({ ...base, limit: 501 }).success, false);
  assert.equal(taskTimelineInputSchema.safeParse({ ...base, eventTypes: [] }).success, false);
});
