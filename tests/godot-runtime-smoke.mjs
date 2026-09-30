import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const repositoryRoot = process.cwd();
const godotBinary = process.env.GODOT_BIN;
const endpoint = "http://127.0.0.1:3100/mcp";
const fixtureRoot = await mkdtemp(path.join(tmpdir(), "godot-safe-change-ci-"));
const scriptPath = path.join(fixtureRoot, "diagnostic_scene.gd");
let nextRequestId = 1;
let godotProcess;
let mcpProcess;
const godotOutputRef = { value: "" };
const mcpOutputRef = { value: "" };

if (!godotBinary) {
  throw new Error("GODOT_BIN is required for the Godot runtime smoke test.");
}

function capture(processHandle, target) {
  processHandle.stdout.on("data", (chunk) => {
    target.value += chunk.toString();
  });
  processHandle.stderr.on("data", (chunk) => {
    target.value += chunk.toString();
  });
}

function waitForExit(processHandle) {
  if (processHandle.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => processHandle.once("exit", resolve));
}

async function stopProcess(processHandle) {
  if (processHandle === undefined || processHandle.exitCode !== null) {
    return;
  }
  const termination = waitForExit(processHandle);
  processHandle.kill("SIGTERM");
  const exited = await Promise.race([
    termination.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
  ]);
  if (exited) {
    return;
  }
  if (processHandle.exitCode === null) {
    const forcedTermination = waitForExit(processHandle);
    processHandle.kill("SIGKILL");
    await forcedTermination;
  }
}

async function request(method, params) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRequestId++, method, params }),
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

async function waitForEditor(projectRoot, godotOutputRef) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const result = await request("tools/call", {
        name: "editor_context",
        arguments: { projectRoot },
      });
      const context = structured(result);
      if (context.connection === "connected") {
        return context;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("Godot EditorPlugin did not become available.\n" + godotOutputRef.value);
}

try {
  await cp(path.join(repositoryRoot, "tests/godot-fixture"), fixtureRoot, {
    recursive: true,
    force: true,
  });
  await cp(path.join(repositoryRoot, "godot-plugin"), path.join(fixtureRoot, "addons/godot-safe-change-bridge"), {
    recursive: true,
    force: true,
  });
  await writeFile(
    path.join(fixtureRoot, "project.godot"),
    (await readFile(path.join(fixtureRoot, "project.godot"), "utf8")) +
      '\n[editor_plugins]\nenabled=PackedStringArray("res://addons/godot-safe-change-bridge/plugin.cfg")\n',
    "utf8",
  );

  godotProcess = spawn(godotBinary, ["--editor", "--headless", "--path", fixtureRoot, "--scene", "res://main.tscn", "--quit-after", "0"], {
    cwd: fixtureRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  capture(godotProcess, godotOutputRef);
  mcpProcess = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev", "--", "--no-open", "--host", "127.0.0.1", "--port", "3100"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  capture(mcpProcess, mcpOutputRef);
  const context = await waitForEditor(fixtureRoot, godotOutputRef);
  assert.equal(context.connection, "connected");
  assert.ok(context.currentScene.nodes.length > 0);

  const nodeSearch = structured(await request("tools/call", {
    name: "search_project",
    arguments: { projectRoot: fixtureRoot, query: "Main", kinds: ["node"] },
  }));
  assert.ok(nodeSearch.results.some((result) => result.nodePath === "."));

  const scriptSearch = structured(await request("tools/call", {
    name: "search_project",
    arguments: { projectRoot: fixtureRoot, query: "diagnostic", kinds: ["script"] },
  }));
  assert.ok(scriptSearch.results.length > 0);

  const originalScript = await readFile(scriptPath, "utf8");
  const scenePlan = structured(await request("tools/call", {
    name: "preview_scene_change",
    arguments: {
      projectRoot: fixtureRoot,
      reason: "CI scene apply and rollback smoke test.",
      operation: { kind: "scene.create_node", parentPath: ".", nodeName: "CiMarker", nodeType: "Node2D" },
    },
  }));
  structured(await request("tools/call", {
    name: "confirm_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: scenePlan.planId, expectedRevision: scenePlan.expectedRevision },
  }));
  structured(await request("tools/call", {
    name: "apply_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: scenePlan.planId },
  }));
  const sceneRollback = structured(await request("tools/call", {
    name: "rollback_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: scenePlan.planId },
  }));
  assert.equal(sceneRollback.status, "rolled_back");

  const scriptPlan = structured(await request("tools/call", {
    name: "preview_scene_change",
    arguments: {
      projectRoot: fixtureRoot,
      reason: "CI script apply and rollback smoke test.",
      operation: { kind: "script.replace_range", scriptPath: "res://diagnostic_scene.gd", startLine: 2, endLine: 2, replacement: "# ci-smoke\n" },
    },
  }));
  structured(await request("tools/call", {
    name: "confirm_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: scriptPlan.planId, expectedRevision: scriptPlan.expectedRevision },
  }));
  const scriptApply = structured(await request("tools/call", {
    name: "apply_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: scriptPlan.planId },
  }));
  assert.notEqual(await readFile(scriptPath, "utf8"), originalScript);
  assert.ok(scriptApply.fileRevision);
  const scriptRollback = structured(await request("tools/call", {
    name: "rollback_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: scriptPlan.planId },
  }));
  assert.equal(scriptRollback.status, "rolled_back");
  assert.equal(await readFile(scriptPath, "utf8"), originalScript);

  const diagnostics = structured(await request("tools/call", {
    name: "run_current_scene",
    arguments: { projectRoot: fixtureRoot, timeoutMs: 5000 },
  }));
  assert.equal(diagnostics.status, "stopped");
  assert.ok(diagnostics.warnings.some((warning) => warning.source === "res://diagnostic_scene.gd"));

  const history = structured(await request("tools/call", {
    name: "operation_history",
    arguments: { projectRoot: fixtureRoot, limit: 50 },
  }));
  assert.ok(history.operations.length >= 9);
  console.log("Godot runtime smoke passed");
} catch (error) {
  console.error("Godot output:\n" + godotOutputRef.value);
  console.error("MCP output:\n" + mcpOutputRef.value);
  throw error;
} finally {
  await stopProcess(mcpProcess);
  await stopProcess(godotProcess);
  await rm(fixtureRoot, { recursive: true, force: true });
}
