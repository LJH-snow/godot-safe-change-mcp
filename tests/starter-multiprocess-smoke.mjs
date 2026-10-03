import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const repositoryRoot = process.cwd();
const godotBinary = process.env.GODOT_BIN;
const primaryEndpoint = "http://127.0.0.1:3200/mcp";
const secondaryEndpoint = "http://127.0.0.1:3201/mcp";
const bridgeEndpoint = "http://127.0.0.1:8765";
const runRoot = await mkdtemp(path.join(tmpdir(), "godot-safe-change-starter-ci-"));
const projectRoot = path.join(runRoot, "starter");
const stateDirectory = path.join(runRoot, "mcp-state");
let requestId = 1;
let godotProcess;
let primaryMcpProcess;
let secondaryMcpProcess;
const output = {
  godot: { value: "" },
  primary: { value: "" },
  secondary: { value: "" },
};

if (!godotBinary) {
  throw new Error("GODOT_BIN is required for the starter multi-process smoke test.");
}

function capture(processHandle, target) {
  processHandle.stdout.on("data", (chunk) => {
    target.value += chunk.toString();
  });
  processHandle.stderr.on("data", (chunk) => {
    target.value += chunk.toString();
  });
}

function waitFor(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForExit(processHandle) {
  if (processHandle.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => processHandle.once("exit", resolve));
}

function signalProcess(processHandle, signal) {
  if (process.platform !== "win32" && processHandle.pid !== undefined) {
    try {
      process.kill(-processHandle.pid, signal);
      return;
    } catch {
    }
  }
  processHandle.kill(signal);
}

async function stopProcess(processHandle) {
  if (processHandle === undefined || processHandle.exitCode !== null) {
    return;
  }
  const termination = waitForExit(processHandle);
  signalProcess(processHandle, "SIGTERM");
  if (await Promise.race([termination.then(() => true), waitFor(3000).then(() => false)])) {
    return;
  }
  if (processHandle.exitCode === null) {
    signalProcess(processHandle, "SIGKILL");
    await Promise.race([waitForExit(processHandle), waitFor(3000)]);
  }
}

async function requestAt(endpoint, method, params) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: requestId++, method, params }),
  });
  const text = await response.text();
  const match = text.match(/^data: (.*)$/m);
  if (!match) {
    throw new Error("Missing MCP SSE data: " + text);
  }
  const envelope = JSON.parse(match[1]);
  if (envelope.error) {
    throw new Error(JSON.stringify(envelope.error));
  }
  return envelope.result;
}

function structured(result) {
  if (result.isError) {
    throw new Error(result.content?.[0]?.text ?? "MCP tool error");
  }
  return result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? "null");
}

async function waitForMcp(endpoint) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await requestAt(endpoint, "tools/list", {});
      return;
    } catch {
      await waitFor(250);
    }
  }
  throw new Error("The starter MCP process did not become available: " + endpoint);
}

async function waitForEditor() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(bridgeEndpoint + "/v1/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectRoot }),
      });
      const body = await response.json();
      if (body.ok && body.context?.connection === "connected" && body.context.currentScene?.nodes?.length > 0) {
        return body.context;
      }
    } catch {
      await waitFor(250);
    }
  }
  throw new Error("The starter Godot bridge did not become available.");
}

async function expectToolErrorAt(endpoint, name, argumentsValue, pattern) {
  await assert.rejects(
    () => requestAt(endpoint, "tools/call", { name, arguments: argumentsValue }).then(structured),
    (error) => pattern.test(error instanceof Error ? error.message : String(error)),
  );
}

try {
  console.log("[starter-smoke] prepare starter project");
  await cp(path.join(repositoryRoot, "examples/starter"), projectRoot, { recursive: true, force: true });
  await cp(path.join(repositoryRoot, "godot-plugin"), path.join(projectRoot, "addons/godot-safe-change-bridge"), {
    recursive: true,
    force: true,
  });
  const projectFile = path.join(projectRoot, "project.godot");
  await writeFile(
    projectFile,
    (await readFile(projectFile, "utf8")) +
      '\n[editor_plugins]\nenabled=PackedStringArray("res://addons/godot-safe-change-bridge/plugin.cfg")\n',
    "utf8",
  );

  godotProcess = spawn(godotBinary, ["--editor", "--headless", "--path", projectRoot, "--scene", "res://main.tscn"], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  capture(godotProcess, output.godot);
  const environment = { ...process.env, GODOT_SAFE_CHANGE_STATE_DIR: stateDirectory };
  primaryMcpProcess = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev", "--", "--no-open", "--host", "127.0.0.1", "--port", "3200"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: environment,
  });
  capture(primaryMcpProcess, output.primary);
  secondaryMcpProcess = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev", "--", "--no-open", "--host", "127.0.0.1", "--port", "3201"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: environment,
  });
  capture(secondaryMcpProcess, output.secondary);

  const context = await waitForEditor();
  await waitForMcp(primaryEndpoint);
  await waitForMcp(secondaryEndpoint);
  assert.equal(context.projectRoot, projectRoot);
  console.log("[starter-smoke] starter editor and both MCP processes connected");

  const task = structured(await requestAt(secondaryEndpoint, "tools/call", {
    name: "create_task",
    arguments: {
      projectRoot,
      title: "Starter multi-process recovery",
      steps: [{ kind: "run_scene", stepId: "starter-run", scenePath: "res://main.tscn", timeoutMs: 30000 }],
    },
  }));
  const secondaryLease = structured(await requestAt(secondaryEndpoint, "tools/call", {
    name: "acquire_task_lease",
    arguments: { projectRoot, taskId: task.taskId, ttlMs: 1500 },
  }));
  assert.ok(secondaryLease.lease?.leaseId);
  await expectToolErrorAt(primaryEndpoint, "acquire_task_lease", {
    projectRoot,
    taskId: task.taskId,
    ttlMs: 1500,
  }, /PROJECT_BUSY/);
  const busyStatus = structured(await requestAt(primaryEndpoint, "tools/call", {
    name: "task_status",
    arguments: { projectRoot, taskId: task.taskId },
  }));
  assert.equal(busyStatus.lease?.ownerId, secondaryLease.lease.ownerId);

  signalProcess(secondaryMcpProcess, "SIGKILL");
  await waitForExit(secondaryMcpProcess);
  await waitFor(1800);
  const reclaimed = structured(await requestAt(primaryEndpoint, "tools/call", {
    name: "acquire_task_lease",
    arguments: { projectRoot, taskId: task.taskId, ttlMs: 2000 },
  }));
  const reclaimedEvent = reclaimed.timeline.find((event) => event.status === "lease_reclaimed");
  assert.ok(reclaimedEvent);
  assert.equal(reclaimedEvent.result?.previousOwnerId, secondaryLease.lease.ownerId);

  const completed = structured(await requestAt(primaryEndpoint, "tools/call", {
    name: "advance_task",
    arguments: { projectRoot, taskId: task.taskId },
  }));
  assert.equal(completed.status, "completed");
  assert.equal(completed.steps[0]?.status, "succeeded");
  assert.equal(completed.steps[0]?.result?.status, "stopped");
  assert.equal(completed.steps[0]?.result?.scenePath, "res://main.tscn");
  console.log("Starter multi-process smoke passed");
} catch (error) {
  console.error("Godot output:\n" + output.godot.value);
  console.error("Primary MCP output:\n" + output.primary.value);
  console.error("Secondary MCP output:\n" + output.secondary.value);
  throw error;
} finally {
  await stopProcess(secondaryMcpProcess);
  await stopProcess(primaryMcpProcess);
  await stopProcess(godotProcess);
  await rm(runRoot, { recursive: true, force: true });
}
