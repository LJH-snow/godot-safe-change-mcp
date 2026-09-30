import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import type { OperationAuditEntry } from "../src/domain/contracts.js";
import { FileOperationAuditStore } from "../src/infrastructure/operation-audit-store.js";

let stateDirectory: string;

before(async () => {
  stateDirectory = await mkdtemp(path.join(tmpdir(), "godot-safe-change-audit-"));
});

after(async () => {
  await rm(stateDirectory, { recursive: true, force: true });
});

function createEntry(
  operationId: string,
  status: OperationAuditEntry["status"],
): OperationAuditEntry {
  return {
    operationId,
    kind: "apply",
    status,
    projectRoot: "/tmp/example-project",
    planId: "plan-1",
    startedAt: "2026-09-30T00:00:00.000Z",
    finishedAt: status === "running" ? null : "2026-09-30T00:00:01.000Z",
    input: { planId: "plan-1" },
    output: status === "succeeded" ? { status: "applied" } : undefined,
  };
}

test("persists the latest lifecycle event across store instances", async () => {
  const firstStore = new FileOperationAuditStore(stateDirectory);
  await firstStore.append(createEntry("op-1", "running"));
  await firstStore.append(createEntry("op-1", "succeeded"));

  const restoredStore = new FileOperationAuditStore(stateDirectory);
  const history = await restoredStore.list("/tmp/example-project", 10);

  assert.equal(history.length, 1);
  assert.equal(history[0]?.operationId, "op-1");
  assert.equal(history[0]?.status, "succeeded");
});

test("keeps an interrupted running operation visible after restart", async () => {
  const firstStore = new FileOperationAuditStore(stateDirectory);
  await firstStore.append(createEntry("op-interrupted", "running"));

  const restoredStore = new FileOperationAuditStore(stateDirectory);
  const history = await restoredStore.list("/tmp/example-project", 10);

  assert.equal(history.find((entry) => entry.operationId === "op-interrupted")?.status, "running");
});
