import { FileProjectLeaseStore } from "../.test-dist/src/infrastructure/project-lease-store.js";
import { ChangeCoordinator } from "../.test-dist/src/application/change-coordinator.js";
import { TaskCoordinator } from "../.test-dist/src/application/task-coordinator.js";
import { FileTaskStore } from "../.test-dist/src/infrastructure/task-store.js";

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function createBridge(projectRoot, holdMs) {
  return {
    async getContext() {
      return {
        schemaVersion: "0.2",
        projectRoot,
        connection: "connected",
        revision: "worker-revision",
        project: { name: "Worker fixture", path: projectRoot },
        currentScene: { path: "res://main.tscn", rootName: "Main", rootType: "Node2D", nodes: [] },
        selection: [],
        openResources: [],
        run: { status: "stopped", scenePath: "res://main.tscn", runId: null },
        diagnostics: { output: [], warnings: [], errors: [] },
      };
    },
    async runCurrentScene() {
      if (holdMs > 0) {
        emit({ event: "step_running" });
        await wait(holdMs);
      }
      return {
        schemaVersion: "0.2",
        runId: "worker-run-" + process.pid,
        status: "stopped",
        scenePath: "res://main.tscn",
        output: [],
        warnings: [],
        errors: [],
      };
    },
  };
}

async function waitForInputClose() {
  process.stdin.resume();
  await new Promise((resolve) => process.stdin.once("end", resolve));
}

async function runLeaseWorker(stateDirectory, projectRoot, ownerId, ttlMs, hold) {
  const store = new FileProjectLeaseStore(stateDirectory);
  const lease = await store.acquire(projectRoot, ownerId, ttlMs);
  emit({ event: "lease_acquired", lease });
  if (hold) {
    await waitForInputClose();
    return;
  }
  await store.release(lease);
}

async function runTaskWorker(mode, stateDirectory, projectRoot, taskId, ttlMs, holdMs) {
  const leaseStore = new FileProjectLeaseStore(stateDirectory);
  const bridge = createBridge(projectRoot, holdMs);
  const changeCoordinator = new ChangeCoordinator(bridge, undefined, leaseStore);
  const taskCoordinator = new TaskCoordinator(changeCoordinator, new FileTaskStore(), leaseStore);
  if (mode === "task-create") {
    const task = await taskCoordinator.createTask({
      projectRoot,
      title: "Cross-process task recovery",
      steps: [{ kind: "run_current_scene", stepId: "run-step" }],
    });
    emit({ event: "task_created", taskId: task.taskId });
    return;
  }

  const leased = await taskCoordinator.acquireTaskLease({ projectRoot, taskId, ttlMs });
  emit({ event: "lease_acquired", taskId, leaseId: leased.lease?.leaseId });
  const result = await taskCoordinator.advanceTask({ projectRoot, taskId });
  emit({
    event: "task_result",
    status: result.status,
    stepStatus: result.steps[0]?.status,
    timeline: result.timeline.map((entry) => ({ status: entry.status, operationId: entry.operationId })),
  });
}

const [mode, stateDirectory, projectRoot, ownerOrTaskId, ttlText, holdText] = process.argv.slice(2);
const ttlMs = Number(ttlText ?? 0);
const hold = holdText === "hold";
const holdMs = Number(holdText ?? 0);

try {
  if (mode === "lease") {
    await runLeaseWorker(stateDirectory, projectRoot, ownerOrTaskId, ttlMs, hold);
  } else if (mode === "task-create") {
    await runTaskWorker(mode, stateDirectory, projectRoot, "", 0, 0);
  } else if (mode === "task-advance") {
    await runTaskWorker(mode, stateDirectory, projectRoot, ownerOrTaskId, ttlMs, holdMs);
  } else {
    throw new Error("Unknown worker mode: " + mode);
  }
} catch (error) {
  emit({
    event: "error",
    code: error?.code ?? "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
