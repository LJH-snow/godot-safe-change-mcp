import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { FileTaskStore } from "../src/infrastructure/task-store.js";

type WorkerEvent = Record<string, unknown>;
type WorkerWaiter = { resolve: (event: WorkerEvent) => void; reject: (error: Error) => void };

interface WorkerHandle {
  child: ChildProcessWithoutNullStreams;
  nextEvent: () => Promise<WorkerEvent>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const workerPath = join(process.cwd(), "tests", "project-process-worker.mjs");

function startWorker(args: string[]): WorkerHandle {
  const child = spawn(process.execPath, [workerPath, ...args], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let ended = false;
  const events: WorkerEvent[] = [];
  const waiters: WorkerWaiter[] = [];
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        const event = JSON.parse(line) as WorkerEvent;
        const waiter = waiters.shift();
        if (waiter === undefined) {
          events.push(event);
        } else {
          waiter.resolve(event);
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });
  child.stdout.on("end", () => {
    ended = true;
    const error = new Error("Worker exited without the expected event." + (stderr.length > 0 ? " stderr: " + stderr : ""));
    while (waiters.length > 0) {
      waiters.shift()!.reject(error);
    }
  });

  return {
    child,
    nextEvent: () => {
      const event = events.shift();
      if (event !== undefined) {
        return Promise.resolve(event);
      }
      if (ended) {
        return Promise.reject(new Error("Worker output ended." + (stderr.length > 0 ? " stderr: " + stderr : "")));
      }
      return new Promise<WorkerEvent>((resolve, reject) => waiters.push({ resolve, reject }));
    },
    exited: new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
  };
}

async function waitForEvent(worker: WorkerHandle, predicate: (event: WorkerEvent) => boolean): Promise<WorkerEvent> {
  while (true) {
    const event = await worker.nextEvent();
    if (event.event === "error") {
      throw new Error(String(event.message ?? "Worker failed."));
    }
    if (predicate(event)) {
      return event;
    }
  }
}

async function stopWorker(worker: WorkerHandle): Promise<void> {
  if (worker.child.exitCode === null && !worker.child.killed) {
    worker.child.kill("SIGKILL");
  }
  await worker.exited;
}

function stringValue(event: WorkerEvent, key: string): string {
  const value = event[key];
  if (typeof value !== "string") {
    throw new Error("Expected worker event field to be a string: " + key);
  }
  return value;
}

test("serializes concurrent process lease owners", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "godot-process-lease-state-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "godot-process-lease-project-"));
  const workers: WorkerHandle[] = [];
  try {
    const holder = startWorker(["lease", stateDirectory, projectRoot, "holder", "5000", "hold"]);
    workers.push(holder);
    await waitForEvent(holder, (event) => event.event === "lease_acquired");

    const contenders = Array.from({ length: 8 }, (_, index) => {
      const worker = startWorker(["lease", stateDirectory, projectRoot, "contender-" + index, "5000", "hold"]);
      workers.push(worker);
      return worker;
    });
    const results = await Promise.all(contenders.map((worker) => worker.nextEvent()));
    assert.deepEqual(results.map((event) => event.code), Array.from({ length: 8 }, () => "PROJECT_BUSY"));
  } finally {
    await Promise.all(workers.map(stopWorker));
    await rm(projectRoot, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("allows exactly one process to reclaim an expired lease", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "godot-expired-lease-state-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "godot-expired-lease-project-"));
  const workers: WorkerHandle[] = [];
  try {
    const crashedOwner = startWorker(["lease", stateDirectory, projectRoot, "crashed-owner", "100", "hold"]);
    workers.push(crashedOwner);
    await waitForEvent(crashedOwner, (event) => event.event === "lease_acquired");
    await stopWorker(crashedOwner);
    await new Promise((resolve) => setTimeout(resolve, 180));

    const contenders = Array.from({ length: 12 }, (_, index) => {
      const worker = startWorker(["lease", stateDirectory, projectRoot, "takeover-" + index, "5000", "hold"]);
      workers.push(worker);
      return worker;
    });
    const results = await Promise.all(contenders.map((worker) => worker.nextEvent()));
    assert.equal(results.filter((event) => event.event === "lease_acquired").length, 1);
    assert.equal(results.filter((event) => event.code === "PROJECT_BUSY").length, 11);
  } finally {
    await Promise.all(workers.map(stopWorker));
    await rm(projectRoot, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("recovers a crashed task step across processes with timeline evidence", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "godot-task-process-state-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "godot-task-process-project-"));
  try {
    const creator = startWorker(["task-create", stateDirectory, projectRoot]);
    const created = await waitForEvent(creator, (event) => event.event === "task_created");
    await creator.exited;
    const taskId = stringValue(created, "taskId");

    const crashedOwner = startWorker(["task-advance", stateDirectory, projectRoot, taskId, "1000", "10000"]);
    await waitForEvent(crashedOwner, (event) => event.event === "step_running");
    await stopWorker(crashedOwner);
    await new Promise((resolve) => setTimeout(resolve, 1250));

    const recovery = startWorker(["task-advance", stateDirectory, projectRoot, taskId, "2000", "0"]);
    const recovered = await waitForEvent(recovery, (event) => event.event === "task_result");
    await recovery.exited;
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.stepStatus, "succeeded");

    const task = await new FileTaskStore().load(projectRoot, taskId);
    assert.ok(task);
    const reclaimed = task.timeline.find((event) => event.status === "lease_reclaimed");
    assert.ok(reclaimed);
    const reclaimedResult = reclaimed.result as { previousOwnerId?: string; ownerId?: string; reason?: string };
    assert.equal(reclaimedResult.reason, "lease_expired");
    assert.ok(reclaimedResult.previousOwnerId);
    assert.ok(reclaimedResult.ownerId);
    assert.notEqual(reclaimedResult.previousOwnerId, reclaimedResult.ownerId);
    const interrupted = task.timeline.find((event) => event.status === "step_interrupted");
    assert.ok(interrupted?.operationId);
    const runningEvents = task.timeline.filter((event) => event.stepId === "run-step" && event.status === "running");
    assert.equal(runningEvents.length, 2);
    assert.notEqual(runningEvents[0]?.operationId, runningEvents[1]?.operationId);
    assert.equal(interrupted.operationId, runningEvents[0]?.operationId);
    const succeeded = task.timeline.find((event) => event.stepId === "run-step" && event.status === "succeeded");
    assert.ok(succeeded);
    assert.equal(succeeded.operationId, runningEvents[1]?.operationId);
    const reclaimedIndex = task.timeline.indexOf(reclaimed);
    const interruptedIndex = task.timeline.indexOf(interrupted);
    const rerunIndex = task.timeline.indexOf(runningEvents[1]!);
    const succeededIndex = task.timeline.indexOf(succeeded);
    const releasedIndex = task.timeline.findIndex((event) => event.status === "lease_released");
    assert.ok(reclaimedIndex < interruptedIndex);
    assert.ok(interruptedIndex < rerunIndex);
    assert.ok(rerunIndex < succeededIndex);
    assert.ok(succeededIndex < releasedIndex);
    assert.equal(task.steps[0]?.status, "succeeded");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
