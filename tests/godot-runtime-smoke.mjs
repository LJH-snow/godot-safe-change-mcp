import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const repositoryRoot = process.cwd();
const godotBinary = process.env.GODOT_BIN;
const endpoint = "http://127.0.0.1:3100/mcp";
const bridgeEndpoint = "http://127.0.0.1:8765";
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

function stage(label) {
  console.log(`[godot-smoke] ${label}`);
}

function waitForExit(processHandle) {
  if (processHandle.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => processHandle.once("exit", resolve));
}

function waitFor(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
  const exited = await Promise.race([
    termination.then(() => true),
    waitFor(3000).then(() => false),
  ]);
  if (exited) {
    return;
  }
  if (processHandle.exitCode === null) {
    signalProcess(processHandle, "SIGKILL");
    await Promise.race([waitForExit(processHandle), waitFor(3000)]);
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

async function bridgeRequest(pathname, body, method = "POST") {
  const response = await fetch(bridgeEndpoint + pathname, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function structured(result) {
  if (result.isError) {
    throw new Error(result.content?.[0]?.text ?? "MCP tool error");
  }
  return result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? "null");
}

async function readEditorContext(projectRoot) {
  return structured(await request("tools/call", {
    name: "editor_context",
    arguments: { projectRoot },
  }));
}

function sceneNode(context, nodePath) {
  return context.currentScene.nodes.find((node) => node.path === nodePath);
}

function assertValueClose(actual, expected, label) {
  if (typeof expected === "number") {
    assert.equal(typeof actual, "number", `${label} should be numeric.`);
    assert.ok(Math.abs(actual - expected) <= 1e-5, `${label} differed: ${actual} vs ${expected}`);
    return;
  }
  if (expected !== null && typeof expected === "object") {
    assert.ok(actual !== null && typeof actual === "object", `${label} should be an object.`);
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
    for (const key of Object.keys(expected)) {
      assertValueClose(actual[key], expected[key], `${label}.${key}`);
    }
    return;
  }
  assert.deepEqual(actual, expected, label);
}

async function expectToolError(name, argumentsValue, pattern = null) {
  await assert.rejects(
    () => request("tools/call", { name, arguments: argumentsValue }).then(structured),
    (error) => pattern === null || pattern.test(error instanceof Error ? error.message : String(error)),
  );
}

async function roundTripSceneProperty(projectRoot, nodePath, property, value) {
  const beforeContext = await readEditorContext(projectRoot);
  const beforeNode = sceneNode(beforeContext, nodePath);
  assert.ok(beforeNode, `Expected ${nodePath} in the editor context.`);
  const beforeValue = beforeNode.properties[property];
  assert.notEqual(beforeValue, undefined, `Expected ${property} on ${nodePath}.`);

  const plan = structured(await request("tools/call", {
    name: "preview_scene_change",
    arguments: {
      projectRoot,
      reason: `CI ${property} apply and rollback smoke test.`,
      operation: { kind: "scene.set_property", nodePath, property, value },
    },
  }));
  assert.equal(plan.expectedRevision, beforeContext.revision);
  structured(await request("tools/call", {
    name: "confirm_scene_change",
    arguments: { projectRoot, planId: plan.planId, expectedRevision: plan.expectedRevision },
  }));
  const applied = structured(await request("tools/call", {
    name: "apply_scene_change",
    arguments: { projectRoot, planId: plan.planId },
  }));
  assert.equal(applied.status, "applied");
  assert.notEqual(applied.revision, beforeContext.revision);

  const appliedContext = await readEditorContext(projectRoot);
  assert.equal(appliedContext.revision, applied.revision);
  assertValueClose(sceneNode(appliedContext, nodePath)?.properties[property], value, `${nodePath}.${property}`);

  const rollback = structured(await request("tools/call", {
    name: "rollback_scene_change",
    arguments: { projectRoot, planId: plan.planId },
  }));
  assert.equal(rollback.status, "rolled_back");
  assert.equal(rollback.undoLabel, "Godot Safe Change: Set property");

  const restoredContext = await readEditorContext(projectRoot);
  assert.equal(restoredContext.revision, beforeContext.revision);
  assertValueClose(sceneNode(restoredContext, nodePath)?.properties[property], beforeValue, `${nodePath}.${property} restored`);
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
  stage("prepare fixture");
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

  godotProcess = spawn(
    godotBinary,
    [
      "--editor",
      "--headless",
      "--path",
      fixtureRoot,
      "--scene",
      "res://main.tscn",
    ],
    {
      cwd: fixtureRoot,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  capture(godotProcess, godotOutputRef);
  stage("wait for editor bridge");
  mcpProcess = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev", "--", "--no-open", "--host", "127.0.0.1", "--port", "3100"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  capture(mcpProcess, mcpOutputRef);
  const context = await waitForEditor(fixtureRoot, godotOutputRef);
  assert.equal(context.connection, "connected");
  assert.ok(context.currentScene.nodes.length > 0);
  stage("validate direct plugin input");

  const directInvalidChange = await bridgeRequest("/v1/changes/apply", {
    projectRoot: context.projectRoot,
    planId: "direct-plugin-validation",
    expectedRevision: context.revision,
    operations: [{
      kind: "scene.set_property",
      nodePath: "../Canvas",
      property: "size",
      value: { x: 10, y: 10 },
    }],
  });
  assert.equal(directInvalidChange.status, 400);
  assert.equal(directInvalidChange.body.ok, false);
  assert.equal(directInvalidChange.body.error.code, "VALIDATION_FAILED");

  const nodeSearch = structured(await request("tools/call", {
    name: "search_project",
    arguments: { projectRoot: fixtureRoot, query: "Main", kinds: ["node"] },
  }));
  assert.ok(nodeSearch.results.some((result) => result.nodePath === "."));
  stage("search complete");

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
  stage("scene create rollback complete");

  await roundTripSceneProperty(fixtureRoot, ".", "visible", false);
  await roundTripSceneProperty(fixtureRoot, ".", "position", { x: 12, y: 8 });
  await roundTripSceneProperty(fixtureRoot, "Canvas", "size", { x: 400, y: 220 });
  await roundTripSceneProperty(fixtureRoot, "Canvas/Title", "text", "Updated fixture title");
  await roundTripSceneProperty(fixtureRoot, "Canvas/ColorPanel", "color", { r: 0.8, g: 0.1, b: 0.3, a: 0.75 });
  stage("property round trips complete");

  await expectToolError("preview_scene_change", {
    projectRoot: fixtureRoot,
    reason: "Reject an incomplete property value.",
    operation: { kind: "scene.set_property", nodePath: "Canvas", property: "size", value: { x: 10 } },
  });
  await expectToolError("preview_scene_change", {
    projectRoot: fixtureRoot,
    reason: "Reject an out-of-range property value.",
    operation: { kind: "scene.set_property", nodePath: "Canvas", property: "size", value: { x: 1000001, y: 10 } },
  });
  await expectToolError("preview_scene_change", {
    projectRoot: fixtureRoot,
    reason: "Reject an unsafe scene node path.",
    operation: { kind: "scene.set_property", nodePath: "../Canvas", property: "size", value: { x: 10, y: 10 } },
  });

  const resourceFile = path.join(fixtureRoot, "resources/theme.tres");
  const originalResource = await readFile(resourceFile, "utf8");
  const resourcePlan = structured(await request("tools/call", {
    name: "preview_scene_change",
    arguments: {
      projectRoot: fixtureRoot,
      reason: "CI resource reference apply and rollback smoke test.",
      operation: {
        kind: "resource.replace_reference",
        resourcePath: "res://resources/theme.tres",
        from: "res://resources/old_theme.tres",
        to: "res://resources/new_theme.tres",
      },
    },
  }));
  structured(await request("tools/call", {
    name: "confirm_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: resourcePlan.planId, expectedRevision: resourcePlan.expectedRevision },
  }));
  const resourceApply = structured(await request("tools/call", {
    name: "apply_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: resourcePlan.planId },
  }));
  assert.equal(resourceApply.status, "applied");
  const appliedResource = await readFile(resourceFile, "utf8");
  assert.notEqual(appliedResource, originalResource);
  await writeFile(resourceFile, appliedResource + "\n; user edit after apply\n", "utf8");
  await expectToolError("rollback_scene_change", {
    projectRoot: fixtureRoot,
    planId: resourcePlan.planId,
  }, /REVISION_CONFLICT/);
  assert.match(await readFile(resourceFile, "utf8"), /user edit after apply/);
  await writeFile(resourceFile, appliedResource, "utf8");
  const resourceRollback = structured(await request("tools/call", {
    name: "rollback_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: resourcePlan.planId },
  }));
  assert.equal(resourceRollback.status, "rolled_back");
  assert.equal(await readFile(resourceFile, "utf8"), originalResource);
  stage("resource rollback complete");

  const projectSettingsFile = path.join(fixtureRoot, "project.godot");
  const inputPlan = structured(await request("tools/call", {
    name: "preview_scene_change",
    arguments: {
      projectRoot: fixtureRoot,
      reason: "CI input action apply and rollback smoke test.",
      operation: { kind: "project.input_action.add_key", actionName: "jump", physicalKeycode: 32, deadzone: 0.2 },
    },
  }));
  assert.ok(inputPlan.expectedFileRevision);
  structured(await request("tools/call", {
    name: "confirm_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: inputPlan.planId, expectedRevision: inputPlan.expectedRevision },
  }));
  const inputApply = structured(await request("tools/call", {
    name: "apply_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: inputPlan.planId },
  }));
  assert.equal(inputApply.status, "applied");
  assert.ok(inputApply.fileRevision);
  const changedProjectSettings = await readFile(projectSettingsFile, "utf8");
  assert.match(changedProjectSettings, /\[input\][\s\S]*\njump=/);
  const inputRollback = structured(await request("tools/call", {
    name: "rollback_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: inputPlan.planId },
  }));
  assert.equal(inputRollback.status, "rolled_back");
  const restoredProjectSettings = await readFile(projectSettingsFile, "utf8");
  assert.doesNotMatch(restoredProjectSettings, /\njump=\{/);
  stage("input action rollback complete");

  const attachBefore = await readEditorContext(fixtureRoot);
  assert.equal(sceneNode(attachBefore, "Scriptless")?.properties.scriptPath, null);
  const attachPlan = structured(await request("tools/call", {
    name: "preview_scene_change",
    arguments: {
      projectRoot: fixtureRoot,
      reason: "CI attach script apply and rollback smoke test.",
      operation: { kind: "scene.attach_script", nodePath: "Scriptless", scriptPath: "res://diagnostic_scene.gd" },
    },
  }));
  structured(await request("tools/call", {
    name: "confirm_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: attachPlan.planId, expectedRevision: attachPlan.expectedRevision },
  }));
  const attachApply = structured(await request("tools/call", {
    name: "apply_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: attachPlan.planId },
  }));
  assert.equal(attachApply.status, "applied");
  assert.equal(sceneNode(await readEditorContext(fixtureRoot), "Scriptless")?.properties.scriptPath, "res://diagnostic_scene.gd");
  const attachRollback = structured(await request("tools/call", {
    name: "rollback_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: attachPlan.planId },
  }));
  assert.equal(attachRollback.status, "rolled_back");
  assert.equal(attachRollback.undoLabel, "Godot Safe Change: Attach script");
  assert.equal(sceneNode(await readEditorContext(fixtureRoot), "Scriptless")?.properties.scriptPath, null);
  await expectToolError("rollback_scene_change", {
    projectRoot: fixtureRoot,
    planId: attachPlan.planId,
  }, /PLAN_NOT_APPLIED|PLAN_ALREADY_ROLLED_BACK/);
  stage("script attach rollback complete");

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
  stage("script rollback complete");

  const diagnostics = structured(await request("tools/call", {
    name: "run_scene",
    arguments: { projectRoot: fixtureRoot, scenePath: "res://main.tscn", timeoutMs: 15000 },
  }));
  assert.equal(diagnostics.status, "stopped");
  assert.equal(diagnostics.scenePath, "res://main.tscn");
  assert.ok(diagnostics.warnings.some((warning) => warning.source === "res://diagnostic_scene.gd"));

  const history = structured(await request("tools/call", {
    name: "operation_history",
    arguments: { projectRoot: fixtureRoot, limit: 50 },
  }));
  assert.ok(history.operations.length >= 9);
  stage("operation history complete");
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
