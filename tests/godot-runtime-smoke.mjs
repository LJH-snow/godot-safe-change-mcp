import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const repositoryRoot = process.cwd();
const godotBinary = process.env.GODOT_BIN;
const endpoint = "http://127.0.0.1:3100/mcp";
const secondaryEndpoint = "http://127.0.0.1:3101/mcp";
const bridgeEndpoint = "http://127.0.0.1:8765";
const fixtureRoot = await mkdtemp(path.join(tmpdir(), "godot-safe-change-ci-"));
const stateDirectory = path.join(fixtureRoot, ".mcp-state");
const scriptPath = path.join(fixtureRoot, "diagnostic_scene.gd");
let nextRequestId = 1;
let nextDirectPlanId = 1;
let godotProcess;
let mcpProcess;
let secondaryMcpProcess;
const godotOutputRef = { value: "" };
const mcpOutputRef = { value: "" };
const secondaryMcpOutputRef = { value: "" };

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

async function requestAt(endpointValue, method, params) {
  const response = await fetch(endpointValue, {
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

async function request(method, params) {
  return requestAt(endpoint, method, params);
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

async function waitForMcpEndpoint(endpointValue) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await requestAt(endpointValue, "tools/list", {});
      return;
    } catch {
      await waitFor(250);
    }
  }
  throw new Error("The secondary MCP process did not become available.");
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

async function expectToolErrorAt(endpointValue, name, argumentsValue, pattern = null) {
  await assert.rejects(
    () => requestAt(endpointValue, "tools/call", { name, arguments: argumentsValue }).then(structured),
    (error) => pattern === null || pattern.test(error instanceof Error ? error.message : String(error)),
  );
}

async function expectToolError(name, argumentsValue, pattern = null) {
  return expectToolErrorAt(endpoint, name, argumentsValue, pattern);
}

async function assertDirectChangeRejected(operation, expectedCode) {
  const editorContext = await readEditorContext(fixtureRoot);
  const settingsPath = path.join(fixtureRoot, "project.godot");
  const settingsBefore = await readFile(settingsPath, "utf8");
  const nodePathsBefore = editorContext.currentScene.nodes.map((node) => node.path);
  const response = await bridgeRequest("/v1/changes/apply", {
    projectRoot: editorContext.projectRoot,
    planId: "direct-boundary-" + nextDirectPlanId++,
    expectedRevision: editorContext.revision,
    operations: [operation],
  });
  assert.equal(response.status, 400, JSON.stringify(response.body));
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error.code, expectedCode);
  const editorContextAfter = await readEditorContext(fixtureRoot);
  assert.equal(editorContextAfter.revision, editorContext.revision);
  assert.deepEqual(editorContextAfter.currentScene.nodes.map((node) => node.path), nodePathsBefore);
  assert.equal(await readFile(settingsPath, "utf8"), settingsBefore);
}

async function assertDirectInputKeyReplacementRejected(actionName, fromPhysicalKeycode, toPhysicalKeycode, expectedStatus, expectedCode, expectedFileRevision = null) {
  const projectRoot = fixtureRoot;
  const editorContext = await readEditorContext(projectRoot);
  const bridgeProjectRoot = editorContext.projectRoot;
  const before = await bridgeRequest("/v1/input-actions/read", { projectRoot: bridgeProjectRoot, actionName });
  assert.equal(before.body.ok, true, JSON.stringify(before.body));
  const response = await bridgeRequest("/v1/changes/apply", {
    projectRoot: bridgeProjectRoot,
    planId: "direct-input-replace-" + actionName,
    expectedRevision: editorContext.revision,
    expectedFileRevision: expectedFileRevision ?? before.body.snapshot.revision,
    operations: [{ kind: "project.input_action.replace_key", actionName, fromPhysicalKeycode, toPhysicalKeycode }],
  });
  assert.equal(response.status, expectedStatus, JSON.stringify(response.body));
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error.code, expectedCode);
  const after = await bridgeRequest("/v1/input-actions/read", { projectRoot: bridgeProjectRoot, actionName });
  assert.deepEqual(after.body.snapshot, before.body.snapshot);
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
      if (context.connection === "connected" && context.currentScene.nodes.length > 0) {
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
  const mcpEnvironment = { ...process.env, GODOT_SAFE_CHANGE_STATE_DIR: stateDirectory };
  mcpProcess = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev", "--", "--no-open", "--host", "127.0.0.1", "--port", "3100"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: mcpEnvironment,
  });
  capture(mcpProcess, mcpOutputRef);
  secondaryMcpProcess = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev", "--", "--no-open", "--host", "127.0.0.1", "--port", "3101"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: mcpEnvironment,
  });
  capture(secondaryMcpProcess, secondaryMcpOutputRef);
  const context = await waitForEditor(fixtureRoot, godotOutputRef);
  await waitForMcpEndpoint(secondaryEndpoint);
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
  const directInvalidOperations = [
    { operation: { kind: "scene.create_node", parentPath: ".", nodeName: "UnsafeType", nodeType: "Object" }, errorCode: "UNSAFE_OPERATION" },
    { operation: { kind: "scene.delete_node", nodePath: "." }, errorCode: "UNSAFE_OPERATION" },
    { operation: { kind: "scene.delete_node", nodePath: "../Canvas" }, errorCode: "VALIDATION_FAILED" },
    { operation: { kind: "scene.delete_node", nodePath: "Canvas/Missing" }, errorCode: "VALIDATION_FAILED" },
    { operation: { kind: "scene.reparent_node", nodePath: ".", newParentPath: "Canvas", keepGlobalTransform: true }, errorCode: "UNSAFE_OPERATION" },
    { operation: { kind: "scene.reparent_node", nodePath: "../Canvas", newParentPath: ".", keepGlobalTransform: true }, errorCode: "VALIDATION_FAILED" },
    { operation: { kind: "scene.reparent_node", nodePath: "Canvas", newParentPath: "Canvas/Title", keepGlobalTransform: true }, errorCode: "UNSAFE_OPERATION" },
    { operation: { kind: "scene.reparent_node", nodePath: "Canvas/Title", newParentPath: "Canvas/Missing", keepGlobalTransform: true }, errorCode: "VALIDATION_FAILED" },
    { operation: { kind: "scene.reparent_node", nodePath: "Canvas/Title", newParentPath: "Canvas", keepGlobalTransform: true }, errorCode: "OPERATION_REJECTED" },
    { operation: { kind: "scene.rename_node", nodePath: ".", newName: "RenamedRoot" }, errorCode: "UNSAFE_OPERATION" },
    { operation: { kind: "scene.rename_node", nodePath: "Canvas/Missing", newName: "Renamed" }, errorCode: "VALIDATION_FAILED" },
    { operation: { kind: "scene.rename_node", nodePath: "Canvas", newName: "Scriptless" }, errorCode: "VALIDATION_FAILED" },
    { operation: { kind: "scene.rename_node", nodePath: "Canvas", newName: "bad/name" }, errorCode: "VALIDATION_FAILED" },
    { operation: { kind: "scene.duplicate_node", nodePath: ".", newParentPath: "Scriptless", newName: "RootCopy", keepGlobalTransform: true }, errorCode: "UNSAFE_OPERATION" },
    { operation: { kind: "scene.duplicate_node", nodePath: "Canvas/Missing", newParentPath: "Scriptless", newName: "Copy", keepGlobalTransform: true }, errorCode: "VALIDATION_FAILED" },
    { operation: { kind: "scene.duplicate_node", nodePath: "Canvas", newParentPath: "Canvas/Title", newName: "Copy", keepGlobalTransform: true }, errorCode: "UNSAFE_OPERATION" },
    { operation: { kind: "scene.instantiate_scene", parentPath: "../", scenePath: "res://instance_source.tscn", nodeName: "Copy" }, errorCode: "VALIDATION_FAILED" },
    { operation: { kind: "scene.instantiate_scene", parentPath: ".", scenePath: "res://../outside.tscn", nodeName: "Copy" }, errorCode: "UNSAFE_OPERATION" },
    { operation: { kind: "scene.connect_signal", sourcePath: "Canvas/Missing", signalName: "visibility_changed", targetPath: ".", methodName: "_ready" }, errorCode: "VALIDATION_FAILED" },
    { operation: { kind: "scene.add_group", nodePath: "Canvas/Missing", group: "ci_group_probe" }, errorCode: "VALIDATION_FAILED" },
    { operation: { kind: "scene.add_group", nodePath: "Canvas/Title", group: "bad/group" }, errorCode: "VALIDATION_FAILED" },
    { operation: { kind: "scene.remove_group", nodePath: "Canvas/Title", group: "bad/group" }, errorCode: "VALIDATION_FAILED" },
    { operation: { kind: "scene.set_property", nodePath: ".", property: "script", value: null }, errorCode: "UNSAFE_OPERATION" },
    { operation: { kind: "scene.attach_script", nodePath: ".", scriptPath: "res://../outside.gd" }, errorCode: "UNSAFE_OPERATION" },
    { operation: { kind: "scene.detach_script", nodePath: "Scriptless" }, errorCode: "VALIDATION_FAILED" },
    { operation: { kind: "resource.replace_reference", resourcePath: "res://../outside.tres", from: "res://old.tres", to: "res://new.tres" }, errorCode: "UNSAFE_OPERATION" },
    { operation: { kind: "script.replace_range", scriptPath: "res://../outside.gd", startLine: 1, endLine: 1, replacement: "safe" }, errorCode: "VALIDATION_FAILED" },
    { operation: { kind: "project.input_action.add_key", actionName: "bad/name", physicalKeycode: 70 }, errorCode: "VALIDATION_FAILED" },
  ];
  for (const invalidOperation of directInvalidOperations) {
    await assertDirectChangeRejected(invalidOperation.operation, invalidOperation.errorCode);
  }
  await assertDirectInputKeyReplacementRejected("remove_binding", 74, 74, 400, "VALIDATION_FAILED");
  await assertDirectInputKeyReplacementRejected("logical_binding", 74, 75, 409, "OPERATION_REJECTED");
  await assertDirectInputKeyReplacementRejected("duplicate_binding", 74, 75, 409, "OPERATION_REJECTED");
  await assertDirectInputKeyReplacementRejected("occupied_binding", 74, 75, 400, "VALIDATION_FAILED");
  await assertDirectInputKeyReplacementRejected("remove_binding", 74, 75, 409, "REVISION_CONFLICT", "stale-settings-revision");

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
  const signalPlan = structured(await request("tools/call", {
    name: "preview_scene_change",
    arguments: {
      projectRoot: fixtureRoot,
      reason: "CI signal connection preview validation smoke test.",
      operation: {
        kind: "scene.connect_signal",
        sourcePath: "Canvas/Title",
        signalName: "visibility_changed",
        targetPath: ".",
        methodName: "_ready",
      },
    },
  }));
  assert.deepEqual(signalPlan.diff[0], {
    kind: "scene.connect_signal",
    target: "res://main.tscn:Canvas/Title.visibility_changed -> ._ready",
    summary: "Connect Canvas/Title.visibility_changed to ._ready in res://main.tscn",
    sourcePath: "Canvas/Title",
    signalName: "visibility_changed",
    targetPath: ".",
    methodName: "_ready",
  });
  structured(await request("tools/call", {
    name: "confirm_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: signalPlan.planId, expectedRevision: signalPlan.expectedRevision },
  }));
  const signalApply = structured(await request("tools/call", {
    name: "apply_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: signalPlan.planId },
  }));
  assert.equal(signalApply.status, "applied");
  assert.equal(signalApply.undoLabel, "Godot Safe Change: Connect signal");
  const signalAfterApply = await bridgeRequest("/v1/signals/read", { projectRoot: fixtureRoot });
  assert.equal(signalAfterApply.body.ok, true, JSON.stringify(signalAfterApply.body));
  const appliedSignalNode = signalAfterApply.body.snapshot.nodes.find((node) => node.nodePath === "Canvas/Title");
  assert.ok(appliedSignalNode?.connections.some((connection) =>
    connection.signalName === "visibility_changed" &&
    connection.targetPath === "." &&
    connection.methodName === "_ready",
  ));
  const signalRollback = structured(await request("tools/call", {
    name: "rollback_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: signalPlan.planId },
  }));
  assert.equal(signalRollback.status, "rolled_back");
  assert.equal(signalRollback.undoLabel, "Godot Safe Change: Connect signal");
  const signalAfterRollback = await bridgeRequest("/v1/signals/read", { projectRoot: fixtureRoot });
  const restoredSignalNode = signalAfterRollback.body.snapshot.nodes.find((node) => node.nodePath === "Canvas/Title");
  assert.equal(restoredSignalNode?.connections.some((connection) =>
    connection.signalName === "visibility_changed" &&
    connection.targetPath === "." &&
    connection.methodName === "_ready",
  ), false);
  const disconnectPlan = structured(await request("tools/call", {
    name: "preview_scene_change",
    arguments: {
      projectRoot: fixtureRoot,
      reason: "Disconnect one exact signal connection through UndoRedo.",
      operation: {
        kind: "scene.disconnect_signal",
        sourcePath: "Canvas/Title",
        signalName: "tree_entered",
        targetPath: ".",
        methodName: "_ready",
      },
    },
  }));
  assert.deepEqual(disconnectPlan.diff[0], {
    kind: "scene.disconnect_signal",
    target: "res://main.tscn:Canvas/Title.tree_entered -> ._ready",
    summary: "Disconnect Canvas/Title.tree_entered from ._ready in res://main.tscn",
    sourcePath: "Canvas/Title",
    signalName: "tree_entered",
    targetPath: ".",
    methodName: "_ready",
  });
  structured(await request("tools/call", {
    name: "confirm_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: disconnectPlan.planId, expectedRevision: disconnectPlan.expectedRevision },
  }));
  const disconnectApply = structured(await request("tools/call", {
    name: "apply_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: disconnectPlan.planId },
  }));
  assert.equal(disconnectApply.status, "applied");
  assert.equal(disconnectApply.undoLabel, "Godot Safe Change: Disconnect signal");
  const signalAfterDisconnect = await bridgeRequest("/v1/signals/read", { projectRoot: fixtureRoot });
  const disconnectedSignalNode = signalAfterDisconnect.body.snapshot.nodes.find((node) => node.nodePath === "Canvas/Title");
  assert.equal(disconnectedSignalNode?.connections.some((connection) =>
    connection.signalName === "tree_entered" &&
    connection.targetPath === "." &&
    connection.methodName === "_ready",
  ), false);
  const disconnectRollback = structured(await request("tools/call", {
    name: "rollback_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: disconnectPlan.planId },
  }));
  assert.equal(disconnectRollback.status, "rolled_back");
  assert.equal(disconnectRollback.undoLabel, "Godot Safe Change: Disconnect signal");
  const signalAfterDisconnectRollback = await bridgeRequest("/v1/signals/read", { projectRoot: fixtureRoot });
  const restoredDisconnectNode = signalAfterDisconnectRollback.body.snapshot.nodes.find((node) => node.nodePath === "Canvas/Title");
  assert.ok(restoredDisconnectNode?.connections.some((connection) =>
    connection.signalName === "tree_entered" &&
    connection.targetPath === "." &&
    connection.methodName === "_ready",
  ));
  await expectToolError("preview_scene_change", {
    projectRoot: fixtureRoot,
    reason: "Reject an unknown signal.",
    operation: {
      kind: "scene.connect_signal",
      sourcePath: "Canvas/Title",
      signalName: "missing_signal",
      targetPath: ".",
      methodName: "_ready",
    },
  }, /VALIDATION_FAILED/);
  await expectToolError("preview_scene_change", {
    projectRoot: fixtureRoot,
    reason: "Reject an absent exact signal connection.",
    operation: {
      kind: "scene.disconnect_signal",
      sourcePath: "Canvas/Title",
      signalName: "tree_entered",
      targetPath: ".",
      methodName: "missing_method",
    },
  }, /VALIDATION_FAILED/);
  await expectToolError("preview_scene_change", {
    projectRoot: fixtureRoot,
    reason: "Reject a missing target method.",
    operation: {
      kind: "scene.connect_signal",
      sourcePath: "Canvas/Title",
      signalName: "visibility_changed",
      targetPath: ".",
      methodName: "missing_method",
    },
  }, /VALIDATION_FAILED/);
  await expectToolError("preview_scene_change", {
    projectRoot: fixtureRoot,
    reason: "Reject an unsafe signal source path.",
    operation: {
      kind: "scene.connect_signal",
      sourcePath: "../Canvas/Title",
      signalName: "visibility_changed",
      targetPath: ".",
      methodName: "_ready",
    },
  });
  stage("signal preview validation complete");
  stage("scene group membership");
  const addGroupPlan = structured(await request("tools/call", {
    name: "preview_scene_change",
    arguments: {
      projectRoot: fixtureRoot,
      reason: "Add a gameplay group through UndoRedo.",
      operation: { kind: "scene.add_group", nodePath: "Canvas/Title", group: "ci_group_probe" },
    },
  }));
  assert.deepEqual(addGroupPlan.diff[0], {
    kind: "scene.add_group",
    target: "res://main.tscn:Canvas/Title:ci_group_probe",
    summary: "Add group ci_group_probe to Canvas/Title in res://main.tscn",
    nodePath: "Canvas/Title",
    group: "ci_group_probe",
  });
  structured(await request("tools/call", {
    name: "confirm_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: addGroupPlan.planId, expectedRevision: addGroupPlan.expectedRevision },
  }));
  const addGroupApply = structured(await request("tools/call", {
    name: "apply_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: addGroupPlan.planId },
  }));
  assert.equal(addGroupApply.status, "applied");
  assert.equal(addGroupApply.undoLabel, "Godot Safe Change: Add group");
  const contextAfterAdd = structured(await request("tools/call", {
    name: "editor_context",
    arguments: { projectRoot: fixtureRoot },
  }));
  const titleAfterAdd = contextAfterAdd.currentScene.nodes.find((node) => node.path === "Canvas/Title");
  assert.ok(titleAfterAdd?.groups?.includes("ci_group_probe"));
  const addGroupRollback = structured(await request("tools/call", {
    name: "rollback_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: addGroupPlan.planId },
  }));
  assert.equal(addGroupRollback.status, "rolled_back");
  assert.equal(addGroupRollback.undoLabel, "Godot Safe Change: Add group");
  const contextAfterRollback = structured(await request("tools/call", {
    name: "editor_context",
    arguments: { projectRoot: fixtureRoot },
  }));
  const titleAfterRollback = contextAfterRollback.currentScene.nodes.find((node) => node.path === "Canvas/Title");
  assert.equal(titleAfterRollback?.groups?.includes("ci_group_probe"), false);
  await expectToolError("preview_scene_change", {
    projectRoot: fixtureRoot,
    reason: "Reject removing a group the node does not belong to.",
    operation: { kind: "scene.remove_group", nodePath: "Canvas/Title", group: "ci_group_probe" },
  }, /OPERATION_REJECTED/);
  await expectToolError("preview_scene_change", {
    projectRoot: fixtureRoot,
    reason: "Reject an unsafe group name.",
    operation: { kind: "scene.add_group", nodePath: "Canvas/Title", group: "bad/group" },
  }, /VALIDATION_FAILED/);
  stage("scene group membership complete");
  const initialCurrentSceneRun = structured(await request("tools/call", {
    name: "run_current_scene",
    arguments: { projectRoot: fixtureRoot, timeoutMs: 30000 },
  }));
  assert.equal(initialCurrentSceneRun.status, "stopped");
  stage("current scene run complete");

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
  const sceneApply = structured(await request("tools/call", {
    name: "apply_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: scenePlan.planId },
  }));
  assert.equal(sceneApply.status, "applied");
  const appliedSceneContext = await readEditorContext(fixtureRoot);
  assert.ok(sceneNode(appliedSceneContext, "CiMarker"));
  const forgedRollback = await bridgeRequest("/v1/changes/rollback", {
    projectRoot: appliedSceneContext.projectRoot,
    planId: "direct-foreign-plan",
    expectedRevision: appliedSceneContext.revision,
  });
  assert.equal(forgedRollback.status, 400);
  assert.equal(forgedRollback.body.error.code, "PLAN_NOT_APPLIED");
  const afterForgedRollback = await readEditorContext(fixtureRoot);
  assert.equal(afterForgedRollback.revision, appliedSceneContext.revision);
  assert.ok(sceneNode(afterForgedRollback, "CiMarker"));
  const staleRollback = await bridgeRequest("/v1/changes/rollback", {
    projectRoot: appliedSceneContext.projectRoot,
    planId: scenePlan.planId,
    expectedRevision: "stale-scene-revision",
  });
  assert.equal(staleRollback.status, 409);
  assert.equal(staleRollback.body.error.code, "REVISION_CONFLICT");
  const afterStaleRollback = await readEditorContext(fixtureRoot);
  assert.equal(afterStaleRollback.revision, appliedSceneContext.revision);
  assert.ok(sceneNode(afterStaleRollback, "CiMarker"));
  const sceneRollback = structured(await request("tools/call", {
    name: "rollback_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: scenePlan.planId },
  }));
  assert.equal(sceneRollback.status, "rolled_back");
  assert.equal(sceneNode(await readEditorContext(fixtureRoot), "CiMarker"), undefined);
  stage("scene create rollback complete");

  const beforeDeleteContext = await readEditorContext(fixtureRoot);
  const directChildrenBeforeDelete = beforeDeleteContext.currentScene.nodes
    .filter((node) => node.path !== "." && !node.path.includes("/"))
    .map((node) => node.path);
  const canvasSubtreeBefore = beforeDeleteContext.currentScene.nodes
    .filter((node) => node.path === "Canvas" || node.path.startsWith("Canvas/"))
    .map(({ path: nodePath, name, type, properties }) => ({ path: nodePath, name, type, properties }));
  assert.deepEqual(canvasSubtreeBefore.map((node) => node.path), ["Canvas", "Canvas/Title", "Canvas/ColorPanel"]);
  const deleteNodePlan = structured(await request("tools/call", {
    name: "preview_scene_change",
    arguments: {
      projectRoot: fixtureRoot,
      reason: "CI scene subtree deletion apply and rollback smoke test.",
      operation: { kind: "scene.delete_node", nodePath: "Canvas" },
    },
  }));
  assert.deepEqual(deleteNodePlan.diff[0]?.deletedNodes.map((node) => node.path), canvasSubtreeBefore.map((node) => node.path));
  structured(await request("tools/call", {
    name: "confirm_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: deleteNodePlan.planId, expectedRevision: deleteNodePlan.expectedRevision },
  }));
  const deleteNodeApply = structured(await request("tools/call", {
    name: "apply_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: deleteNodePlan.planId },
  }));
  assert.equal(deleteNodeApply.status, "applied");
  assert.equal(deleteNodeApply.undoLabel, "Godot Safe Change: Delete node");
  const afterDeleteContext = await readEditorContext(fixtureRoot);
  assert.equal(afterDeleteContext.currentScene.nodes.some((node) => node.path === "Canvas" || node.path.startsWith("Canvas/")), false);
  assert.deepEqual(
    afterDeleteContext.currentScene.nodes.filter((node) => node.path !== "." && !node.path.includes("/")).map((node) => node.path),
    directChildrenBeforeDelete.filter((nodePath) => nodePath !== "Canvas"),
  );
  const staleDeleteRollback = await bridgeRequest("/v1/changes/rollback", {
    projectRoot: afterDeleteContext.projectRoot,
    planId: deleteNodePlan.planId,
    expectedRevision: "stale-delete-scene-revision",
  });
  assert.equal(staleDeleteRollback.status, 409);
  assert.equal(staleDeleteRollback.body.error.code, "REVISION_CONFLICT");
  const afterStaleDeleteRollback = await readEditorContext(fixtureRoot);
  assert.equal(afterStaleDeleteRollback.revision, afterDeleteContext.revision);
  assert.equal(afterStaleDeleteRollback.currentScene.nodes.some((node) => node.path === "Canvas" || node.path.startsWith("Canvas/")), false);
  const deleteNodeRollback = structured(await request("tools/call", {
    name: "rollback_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: deleteNodePlan.planId },
  }));
  assert.equal(deleteNodeRollback.status, "rolled_back");
  const afterDeleteRollback = await readEditorContext(fixtureRoot);
  const restoredCanvasSubtree = afterDeleteRollback.currentScene.nodes
    .filter((node) => node.path === "Canvas" || node.path.startsWith("Canvas/"))
    .map(({ path: nodePath, name, type, properties }) => ({ path: nodePath, name, type, properties }));
  assert.deepEqual(restoredCanvasSubtree, canvasSubtreeBefore);
  assert.deepEqual(
    afterDeleteRollback.currentScene.nodes.filter((node) => node.path !== "." && !node.path.includes("/")).map((node) => node.path),
    directChildrenBeforeDelete,
  );
  stage("scene subtree delete apply and rollback complete");

  const beforeReparentContext = await readEditorContext(fixtureRoot);
  const reparentPlan = structured(await request("tools/call", {
    name: "preview_scene_change",
    arguments: {
      projectRoot: fixtureRoot,
      reason: "CI scene reparent apply and rollback smoke test.",
      operation: { kind: "scene.reparent_node", nodePath: "Canvas", newParentPath: "Scriptless" },
    },
  }));
  assert.equal(reparentPlan.diff[0]?.fromNodePath, "Canvas");
  assert.equal(reparentPlan.diff[0]?.toNodePath, "Scriptless/Canvas");
  assert.equal(reparentPlan.diff[0]?.fromIndex, 0);
  assert.equal(reparentPlan.diff[0]?.toIndex, 0);
  assert.equal(reparentPlan.diff[0]?.keepGlobalTransform, true);
  structured(await request("tools/call", {
    name: "confirm_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: reparentPlan.planId, expectedRevision: reparentPlan.expectedRevision },
  }));
  const reparentApply = structured(await request("tools/call", {
    name: "apply_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: reparentPlan.planId },
  }));
  assert.equal(reparentApply.status, "applied");
  assert.equal(reparentApply.undoLabel, "Godot Safe Change: Reparent node");
  const afterReparentContext = await readEditorContext(fixtureRoot);
  assert.equal(sceneNode(afterReparentContext, "Canvas"), undefined);
  assert.equal(sceneNode(afterReparentContext, "Scriptless/Canvas/Title")?.properties.text, "Fixture label");
  const reparentRollback = structured(await request("tools/call", {
    name: "rollback_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: reparentPlan.planId },
  }));
  assert.equal(reparentRollback.status, "rolled_back");
  const afterReparentRollback = await readEditorContext(fixtureRoot);
  assert.equal(sceneNode(afterReparentRollback, "Scriptless/Canvas"), undefined);
  assert.deepEqual(afterReparentRollback.currentScene.nodes, beforeReparentContext.currentScene.nodes);
  stage("scene reparent apply and rollback complete");

  const beforeRenameContext = await readEditorContext(fixtureRoot);
  const renamePlan = structured(await request("tools/call", {
    name: "preview_scene_change",
    arguments: {
      projectRoot: fixtureRoot,
      reason: "CI scene rename apply and rollback smoke test.",
      operation: { kind: "scene.rename_node", nodePath: "Canvas", newName: "HUD" },
    },
  }));
  assert.deepEqual(renamePlan.diff[0]?.affectedPaths, [
    { from: "Canvas", to: "HUD" },
    { from: "Canvas/Title", to: "HUD/Title" },
    { from: "Canvas/ColorPanel", to: "HUD/ColorPanel" },
  ]);
  structured(await request("tools/call", {
    name: "confirm_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: renamePlan.planId, expectedRevision: renamePlan.expectedRevision },
  }));
  const renameApply = structured(await request("tools/call", {
    name: "apply_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: renamePlan.planId },
  }));
  assert.equal(renameApply.status, "applied");
  assert.equal(renameApply.undoLabel, "Godot Safe Change: Rename node");
  const afterRenameContext = await readEditorContext(fixtureRoot);
  assert.equal(sceneNode(afterRenameContext, "Canvas"), undefined);
  assert.equal(sceneNode(afterRenameContext, "HUD/Title")?.properties.text, "Fixture label");
  const renameRollback = structured(await request("tools/call", {
    name: "rollback_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: renamePlan.planId },
  }));
  assert.equal(renameRollback.status, "rolled_back");
  const afterRenameRollback = await readEditorContext(fixtureRoot);
  assert.deepEqual(afterRenameRollback.currentScene.nodes, beforeRenameContext.currentScene.nodes);
  stage("scene rename apply and rollback complete");

  const beforeDuplicateContext = await readEditorContext(fixtureRoot);
  const duplicateSubtreeBefore = beforeDuplicateContext.currentScene.nodes
    .filter((node) => node.path === "Canvas" || node.path.startsWith("Canvas/"))
    .map(({ path: nodePath, name, type, properties }) => ({ path: nodePath, name, type, properties }));
  const duplicatePlan = structured(await request("tools/call", {
    name: "preview_scene_change",
    arguments: {
      projectRoot: fixtureRoot,
      reason: "CI scene subtree duplication apply and rollback smoke test.",
      operation: { kind: "scene.duplicate_node", nodePath: "Canvas", newParentPath: "Scriptless", newName: "CanvasCopy" },
    },
  }));
  assert.deepEqual(duplicatePlan.diff[0]?.duplicatedNodes.map((node) => node.to), [
    "Scriptless/CanvasCopy",
    "Scriptless/CanvasCopy/Title",
    "Scriptless/CanvasCopy/ColorPanel",
  ]);
  structured(await request("tools/call", {
    name: "confirm_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: duplicatePlan.planId, expectedRevision: duplicatePlan.expectedRevision },
  }));
  const duplicateApply = structured(await request("tools/call", {
    name: "apply_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: duplicatePlan.planId },
  }));
  assert.equal(duplicateApply.status, "applied");
  assert.equal(duplicateApply.undoLabel, "Godot Safe Change: Duplicate node");
  const afterDuplicateContext = await readEditorContext(fixtureRoot);
  assert.equal(sceneNode(afterDuplicateContext, "Scriptless/CanvasCopy/Title")?.properties.text, "Fixture label");
  assert.equal(sceneNode(afterDuplicateContext, "Scriptless/CanvasCopy/ColorPanel")?.properties.color.a, 1);
  const duplicateRollback = structured(await request("tools/call", {
    name: "rollback_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: duplicatePlan.planId },
  }));
  assert.equal(duplicateRollback.status, "rolled_back");
  const afterDuplicateRollback = await readEditorContext(fixtureRoot);
  assert.deepEqual(
    afterDuplicateRollback.currentScene.nodes
      .filter((node) => node.path === "Canvas" || node.path.startsWith("Canvas/"))
      .map(({ path: nodePath, name, type, properties }) => ({ path: nodePath, name, type, properties })),
    duplicateSubtreeBefore,
  );
  assert.equal(sceneNode(afterDuplicateRollback, "Scriptless/CanvasCopy"), undefined);
  stage("scene subtree duplicate apply and rollback complete");

  const beforeInstantiateContext = await readEditorContext(fixtureRoot);
  assert.equal(sceneNode(beforeInstantiateContext, "InstanceCopy"), undefined);
  const instanceSourcePath = path.join(fixtureRoot, "instance_source.tscn");
  const originalInstanceSource = await readFile(instanceSourcePath, "utf8");
  const staleInstantiatePlan = structured(await request("tools/call", {
    name: "preview_scene_change",
    arguments: {
      projectRoot: fixtureRoot,
      reason: "Reject a stale instanced scene source.",
      operation: {
        kind: "scene.instantiate_scene",
        parentPath: ".",
        scenePath: "res://instance_source.tscn",
        nodeName: "StaleInstance",
      },
    },
  }));
  await writeFile(instanceSourcePath, originalInstanceSource + "\n; external source edit\n", "utf8");
  await expectToolError("confirm_scene_change", {
    projectRoot: fixtureRoot,
    planId: staleInstantiatePlan.planId,
    expectedRevision: staleInstantiatePlan.expectedRevision,
  }, /REVISION_CONFLICT/);
  await writeFile(instanceSourcePath, originalInstanceSource, "utf8");
  const instantiatePlan = structured(await request("tools/call", {
    name: "preview_scene_change",
    arguments: {
      projectRoot: fixtureRoot,
      reason: "CI scene instantiation apply and rollback smoke test.",
      operation: {
        kind: "scene.instantiate_scene",
        parentPath: ".",
        scenePath: "res://instance_source.tscn",
        nodeName: "InstanceCopy",
      },
    },
  }));
  assert.ok(instantiatePlan.expectedFileRevision);
  assert.deepEqual(instantiatePlan.diff[0], {
    kind: "scene.instantiate_scene",
    target: "res://main.tscn:InstanceCopy",
    summary: "Instantiate res://instance_source.tscn under . as InstanceCopy in res://main.tscn",
    parentPath: ".",
    scenePath: "res://instance_source.tscn",
    instancePath: "InstanceCopy",
    nodeName: "InstanceCopy",
  });
  structured(await request("tools/call", {
    name: "confirm_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: instantiatePlan.planId, expectedRevision: instantiatePlan.expectedRevision },
  }));
  const instantiateApply = structured(await request("tools/call", {
    name: "apply_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: instantiatePlan.planId },
  }));
  assert.equal(instantiateApply.status, "applied");
  assert.equal(instantiateApply.undoLabel, "Godot Safe Change: Instantiate scene");
  const afterInstantiateContext = await readEditorContext(fixtureRoot);
  assert.equal(sceneNode(afterInstantiateContext, "InstanceCopy")?.type, "Node2D");
  assert.equal(sceneNode(afterInstantiateContext, "InstanceCopy/Badge")?.properties.text, "Instanced fixture");
  const instantiateRollback = structured(await request("tools/call", {
    name: "rollback_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: instantiatePlan.planId },
  }));
  assert.equal(instantiateRollback.status, "rolled_back");
  assert.equal(instantiateRollback.undoLabel, "Godot Safe Change: Instantiate scene");
  const afterInstantiateRollback = await readEditorContext(fixtureRoot);
  assert.deepEqual(afterInstantiateRollback.currentScene.nodes, beforeInstantiateContext.currentScene.nodes);
  await expectToolError("rollback_scene_change", {
    projectRoot: fixtureRoot,
    planId: instantiatePlan.planId,
  }, /PLAN_NOT_APPLIED|PLAN_ALREADY_ROLLED_BACK/);
  stage("scene instantiation apply and rollback complete");

  await roundTripSceneProperty(fixtureRoot, ".", "visible", false);
  await roundTripSceneProperty(fixtureRoot, ".", "position", { x: 12, y: 8 });
  await roundTripSceneProperty(fixtureRoot, ".", "rotation_degrees", 22.5);
  await roundTripSceneProperty(fixtureRoot, ".", "scale", { x: 1.25, y: 0.8 });
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

  const removalBefore = await bridgeRequest("/v1/input-actions/read", {
    projectRoot: context.projectRoot,
    actionName: "remove_binding",
  });
  assert.equal(removalBefore.body.ok, true, JSON.stringify(removalBefore.body));
  assert.equal(removalBefore.body.snapshot.exists, true);
  assert.deepEqual(removalBefore.body.snapshot.events.map((event) => event.physicalKeycode), [74]);
  const removeKeyPlan = structured(await request("tools/call", {
    name: "preview_scene_change",
    arguments: {
      projectRoot: fixtureRoot,
      reason: "CI input action remove and rollback smoke test.",
      operation: { kind: "project.input_action.remove_key", actionName: "remove_binding", physicalKeycode: 74 },
    },
  }));
  assert.ok(removeKeyPlan.expectedFileRevision);
  structured(await request("tools/call", {
    name: "confirm_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: removeKeyPlan.planId, expectedRevision: removeKeyPlan.expectedRevision },
  }));
  const removeKeyApply = structured(await request("tools/call", {
    name: "apply_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: removeKeyPlan.planId },
  }));
  assert.equal(removeKeyApply.status, "applied");
  const removalAfter = await bridgeRequest("/v1/input-actions/read", {
    projectRoot: context.projectRoot,
    actionName: "remove_binding",
  });
  assert.equal(removalAfter.body.snapshot.exists, true);
  assert.deepEqual(removalAfter.body.snapshot.events, []);
  assert.equal(removalAfter.body.snapshot.deadzone, 0.35);
  const removeKeyRollback = structured(await request("tools/call", {
    name: "rollback_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: removeKeyPlan.planId },
  }));
  assert.equal(removeKeyRollback.status, "rolled_back");
  const removalRestored = await bridgeRequest("/v1/input-actions/read", {
    projectRoot: context.projectRoot,
    actionName: "remove_binding",
  });
  assert.deepEqual(removalRestored.body.snapshot.events.map((event) => event.physicalKeycode), [74]);
  assert.equal(removalRestored.body.snapshot.deadzone, 0.35);
  stage("input action removal rollback complete");

  const replaceKeyPlan = structured(await request("tools/call", {
    name: "preview_scene_change",
    arguments: {
      projectRoot: fixtureRoot,
      reason: "CI input action replacement and rollback smoke test.",
      operation: {
        kind: "project.input_action.replace_key",
        actionName: "remove_binding",
        fromPhysicalKeycode: 74,
        toPhysicalKeycode: 75,
      },
    },
  }));
  assert.ok(replaceKeyPlan.expectedFileRevision);
  structured(await request("tools/call", {
    name: "confirm_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: replaceKeyPlan.planId, expectedRevision: replaceKeyPlan.expectedRevision },
  }));
  const replaceKeyApply = structured(await request("tools/call", {
    name: "apply_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: replaceKeyPlan.planId },
  }));
  assert.equal(replaceKeyApply.status, "applied");
  const replacementAfter = await bridgeRequest("/v1/input-actions/read", {
    projectRoot: context.projectRoot,
    actionName: "remove_binding",
  });
  assert.equal(replacementAfter.body.snapshot.exists, true);
  assert.deepEqual(replacementAfter.body.snapshot.events.map((event) => event.physicalKeycode), [75]);
  assert.equal(replacementAfter.body.snapshot.deadzone, 0.35);
  assert.match(await readFile(path.join(fixtureRoot, "project.godot"), "utf8"), /shift_pressed[" ]*[:=][ ]*true/);
  const appliedProjectSettings = await readFile(path.join(fixtureRoot, "project.godot"), "utf8");
  await writeFile(path.join(fixtureRoot, "project.godot"), appliedProjectSettings + "\n; external edit after input action apply\n", "utf8");
  await expectToolError("rollback_scene_change", { projectRoot: fixtureRoot, planId: replaceKeyPlan.planId }, /REVISION_CONFLICT/);
  assert.match(await readFile(path.join(fixtureRoot, "project.godot"), "utf8"), /external edit after input action apply/);
  await writeFile(path.join(fixtureRoot, "project.godot"), appliedProjectSettings, "utf8");
  const replaceKeyRollback = structured(await request("tools/call", {
    name: "rollback_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: replaceKeyPlan.planId },
  }));
  assert.equal(replaceKeyRollback.status, "rolled_back");
  const replacementRestored = await bridgeRequest("/v1/input-actions/read", {
    projectRoot: context.projectRoot,
    actionName: "remove_binding",
  });
  assert.deepEqual(replacementRestored.body.snapshot.events.map((event) => event.physicalKeycode), [74]);
  assert.equal(replacementRestored.body.snapshot.deadzone, 0.35);
  assert.match(await readFile(path.join(fixtureRoot, "project.godot"), "utf8"), /shift_pressed[" ]*[:=][ ]*true/);
  stage("input action replacement rollback complete");

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

  const detachBefore = await readEditorContext(fixtureRoot);
  assert.equal(sceneNode(detachBefore, ".")?.properties.scriptPath, "res://diagnostic_scene.gd");
  const detachPlan = structured(await request("tools/call", {
    name: "preview_scene_change",
    arguments: {
      projectRoot: fixtureRoot,
      reason: "CI detach script apply and rollback smoke test.",
      operation: { kind: "scene.detach_script", nodePath: "." },
    },
  }));
  assert.deepEqual(detachPlan.diff[0], {
    kind: "scene.detach_script",
    target: "res://main.tscn:.:script",
    summary: "Detach res://diagnostic_scene.gd from . in res://main.tscn",
    nodePath: ".",
    scriptPath: "res://diagnostic_scene.gd",
  });
  structured(await request("tools/call", {
    name: "confirm_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: detachPlan.planId, expectedRevision: detachPlan.expectedRevision },
  }));
  const detachApply = structured(await request("tools/call", {
    name: "apply_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: detachPlan.planId },
  }));
  assert.equal(detachApply.status, "applied");
  assert.equal(detachApply.undoLabel, "Godot Safe Change: Detach script");
  assert.equal(sceneNode(await readEditorContext(fixtureRoot), ".")?.properties.scriptPath, null);
  const detachRollback = structured(await request("tools/call", {
    name: "rollback_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: detachPlan.planId },
  }));
  assert.equal(detachRollback.status, "rolled_back");
  assert.equal(detachRollback.undoLabel, "Godot Safe Change: Detach script");
  assert.equal(sceneNode(await readEditorContext(fixtureRoot), ".")?.properties.scriptPath, "res://diagnostic_scene.gd");
  await expectToolError("rollback_scene_change", {
    projectRoot: fixtureRoot,
    planId: detachPlan.planId,
  }, /PLAN_NOT_APPLIED|PLAN_ALREADY_ROLLED_BACK/);
  stage("script detach rollback complete");

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

  const taskPlan = structured(await request("tools/call", {
    name: "preview_scene_change",
    arguments: {
      projectRoot: fixtureRoot,
      reason: "CI task apply and run integration smoke test.",
      operation: { kind: "scene.create_node", parentPath: ".", nodeName: "TaskMarker", nodeType: "Node2D" },
    },
  }));
  const task = structured(await request("tools/call", {
    name: "create_task",
    arguments: {
      projectRoot: fixtureRoot,
      title: "Godot runtime task smoke",
      steps: [
        { kind: "apply_plan", stepId: "apply-marker", planId: taskPlan.planId, expectedRevision: taskPlan.expectedRevision },
        { kind: "run_scene", stepId: "run-current", scenePath: "res://main.tscn", timeoutMs: 30000 },
        { kind: "verify_scene_state", stepId: "verify-marker", nodePath: "TaskMarker", expectedProperties: [{ property: "visible", expected: true }] },
        {
          kind: "verify_resource_state",
          stepId: "verify-resource",
          resourcePath: "res://instance_source.tscn",
          contains: ["[gd_scene", "InstanceSource"],
          matchCounts: [{ text: "[node", expectedCount: 2 }],
        },
        {
          kind: "verify_script_state",
          stepId: "verify-script",
          scriptPath: "res://diagnostic_scene.gd",
          contains: ["extends Node2D", "func _ready"],
          matchCounts: [{ text: "func _ready", expectedCount: 1 }],
        },
        { kind: "verify_diagnostics", stepId: "verify-diagnostics", runStepId: "run-current", maxErrors: 0, maxWarnings: 100 },
      ],
    },
  }));
  assert.equal(task.status, "active");
  const leasedTask = structured(await request("tools/call", {
    name: "acquire_task_lease",
    arguments: { projectRoot: fixtureRoot, taskId: task.taskId, ttlMs: 10000 },
  }));
  assert.ok(leasedTask.lease?.leaseId);
  assert.ok(leasedTask.lease?.expiresAt);
  const afterTaskApply = structured(await request("tools/call", {
    name: "advance_task",
    arguments: { projectRoot: fixtureRoot, taskId: task.taskId },
  }));
  assert.equal(afterTaskApply.status, "active");
  assert.equal(afterTaskApply.steps[0]?.status, "succeeded");
  const applyStepOperationId = afterTaskApply.steps[0]?.operationId;
  assert.match(applyStepOperationId ?? "", /^taskop_[A-Za-z0-9]+$/);
  assert.equal(afterTaskApply.lease?.leaseId, leasedTask.lease.leaseId);
  const taskStepTimeline = structured(await request("tools/call", {
    name: "task_timeline",
    arguments: { projectRoot: fixtureRoot, taskId: task.taskId, stepId: "apply-marker", operationId: applyStepOperationId },
  }));
  assert.deepEqual(taskStepTimeline.events.map((event) => event.status), ["running", "succeeded"]);
  const afterTaskRun = structured(await request("tools/call", {
    name: "advance_task",
    arguments: { projectRoot: fixtureRoot, taskId: task.taskId },
  }));
  assert.equal(afterTaskRun.status, "active");
  assert.equal(afterTaskRun.steps[1]?.status, "succeeded");
  assert.equal(afterTaskRun.steps[1]?.result?.status, "stopped");
  const afterTaskVerification = structured(await request("tools/call", {
    name: "advance_task",
    arguments: { projectRoot: fixtureRoot, taskId: task.taskId },
  }));
  assert.equal(afterTaskVerification.status, "active");
  assert.equal(afterTaskVerification.steps[2]?.status, "succeeded");
  assert.equal(afterTaskVerification.steps[2]?.result?.passed, true);
  assert.equal(afterTaskVerification.steps[2]?.result?.properties[0]?.actual, true);
  const verifyStepOperationId = afterTaskVerification.steps[2]?.operationId;
  const verifyStepTimeline = structured(await request("tools/call", {
    name: "task_timeline",
    arguments: { projectRoot: fixtureRoot, taskId: task.taskId, stepId: "verify-marker", operationId: verifyStepOperationId },
  }));
  assert.deepEqual(verifyStepTimeline.events.map((event) => event.status), ["running", "succeeded"]);
  const afterResourceVerification = structured(await request("tools/call", {
    name: "advance_task",
    arguments: { projectRoot: fixtureRoot, taskId: task.taskId },
  }));
  assert.equal(afterResourceVerification.status, "active");
  assert.equal(afterResourceVerification.steps[3]?.status, "succeeded");
  assert.equal(afterResourceVerification.steps[3]?.result?.passed, true);
  assert.equal(afterResourceVerification.steps[3]?.result?.resourcePath, "res://instance_source.tscn");
  const resourceStepOperationId = afterResourceVerification.steps[3]?.operationId;
  const resourceStepTimeline = structured(await request("tools/call", {
    name: "task_timeline",
    arguments: { projectRoot: fixtureRoot, taskId: task.taskId, stepId: "verify-resource", operationId: resourceStepOperationId },
  }));
  assert.deepEqual(resourceStepTimeline.events.map((event) => event.status), ["running", "succeeded"]);
  const afterDiagnosticsVerification = structured(await request("tools/call", {
    name: "advance_task",
    arguments: { projectRoot: fixtureRoot, taskId: task.taskId },
  }));
  assert.equal(afterDiagnosticsVerification.status, "active");
  assert.equal(afterDiagnosticsVerification.steps[4]?.status, "succeeded");
  assert.equal(afterDiagnosticsVerification.steps[4]?.result?.passed, true);
  assert.equal(afterDiagnosticsVerification.steps[4]?.result?.scriptPath, "res://diagnostic_scene.gd");
  const scriptStepOperationId = afterDiagnosticsVerification.steps[4]?.operationId;
  const scriptStepTimeline = structured(await request("tools/call", {
    name: "task_timeline",
    arguments: { projectRoot: fixtureRoot, taskId: task.taskId, stepId: "verify-script", operationId: scriptStepOperationId },
  }));
  assert.deepEqual(scriptStepTimeline.events.map((event) => event.status), ["running", "succeeded"]);
  const afterDiagnosticsComplete = structured(await request("tools/call", {
    name: "advance_task",
    arguments: { projectRoot: fixtureRoot, taskId: task.taskId },
  }));
  assert.equal(afterDiagnosticsComplete.status, "completed");
  assert.equal(afterDiagnosticsComplete.steps[5]?.status, "succeeded");
  assert.equal(afterDiagnosticsComplete.steps[5]?.result?.passed, true);
  assert.equal(afterDiagnosticsComplete.steps[5]?.result?.status, "stopped");
  assert.equal(afterDiagnosticsComplete.steps[5]?.result?.errorCount, 0);
  assert.ok(afterDiagnosticsComplete.steps[5]?.result?.warningCount <= 100);
  const diagnosticsStepOperationId = afterDiagnosticsComplete.steps[5]?.operationId;
  const diagnosticsStepTimeline = structured(await request("tools/call", {
    name: "task_timeline",
    arguments: { projectRoot: fixtureRoot, taskId: task.taskId, stepId: "verify-diagnostics", operationId: diagnosticsStepOperationId },
  }));
  assert.deepEqual(diagnosticsStepTimeline.events.map((event) => event.status), ["running", "succeeded"]);
  const completedTask = structured(await request("tools/call", {
    name: "task_status",
    arguments: { projectRoot: fixtureRoot, taskId: task.taskId },
  }));
  assert.equal(completedTask.status, "completed");
  assert.equal(completedTask.lease, null);
  assert.ok(completedTask.timeline.some((event) => event.status === "lease_acquired"));
  assert.ok(completedTask.timeline.some((event) => event.status === "lease_released"));
  assert.ok(sceneNode(await readEditorContext(fixtureRoot), "TaskMarker"));
  stage("task lease, apply, run, scene/resource verify, diagnostics verify and timeline complete");
  const taskPlanRollback = structured(await request("tools/call", {
    name: "rollback_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: taskPlan.planId },
  }));
  assert.equal(taskPlanRollback.status, "rolled_back");
  assert.equal(sceneNode(await readEditorContext(fixtureRoot), "TaskMarker"), undefined);

  stage("real bridge multi-process lease recovery");
  const crossProcessTask = structured(await requestAt(secondaryEndpoint, "tools/call", {
    name: "create_task",
    arguments: {
      projectRoot: fixtureRoot,
      title: "Real bridge multi-process lease smoke",
      steps: [{ kind: "run_scene", stepId: "cross-process-run", scenePath: "res://main.tscn", timeoutMs: 30000 }],
    },
  }));
  const secondaryLease = structured(await requestAt(secondaryEndpoint, "tools/call", {
    name: "acquire_task_lease",
    arguments: { projectRoot: fixtureRoot, taskId: crossProcessTask.taskId, ttlMs: 5000 },
  }));
  assert.ok(secondaryLease.lease?.leaseId);
  assert.ok(secondaryLease.lease?.ownerId);
  const blockedApplyPlan = structured(await request("tools/call", {
    name: "preview_scene_change",
    arguments: {
      projectRoot: fixtureRoot,
      reason: "Verify a second MCP process cannot write through another process lease.",
      operation: { kind: "scene.create_node", parentPath: ".", nodeName: "BlockedByLease", nodeType: "Node2D" },
    },
  }));
  await request("tools/call", {
    name: "confirm_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: blockedApplyPlan.planId, expectedRevision: blockedApplyPlan.expectedRevision },
  });
  await expectToolErrorAt(
    endpoint,
    "apply_scene_change",
    { projectRoot: fixtureRoot, planId: blockedApplyPlan.planId },
    /PROJECT_BUSY/,
  );
  assert.equal(sceneNode(await readEditorContext(fixtureRoot), "BlockedByLease"), undefined);
  const secondaryExpiresAt = Date.parse(secondaryLease.lease.expiresAt);
  assert.ok(Number.isFinite(secondaryExpiresAt));
  assert.ok(secondaryExpiresAt > Date.now());
  assert.ok(secondaryExpiresAt - Date.now() > 1000);
  await expectToolErrorAt(
    endpoint,
    "acquire_task_lease",
    { projectRoot: fixtureRoot, taskId: crossProcessTask.taskId, ttlMs: 5000 },
    /PROJECT_BUSY/,
  );
  const busyStatus = structured(await request("tools/call", {
    name: "task_status",
    arguments: { projectRoot: fixtureRoot, taskId: crossProcessTask.taskId },
  }));
  assert.equal(busyStatus.lease?.leaseId, secondaryLease.lease.leaseId);
  assert.equal(busyStatus.lease?.ownerId, secondaryLease.lease.ownerId);
  assert.equal(busyStatus.recoverable, false);
  assert.equal(Date.parse(busyStatus.lease.expiresAt), secondaryExpiresAt);
  assert.ok(Date.now() < secondaryExpiresAt);
  signalProcess(secondaryMcpProcess, "SIGKILL");
  await waitForExit(secondaryMcpProcess);
  await waitFor(Math.max(0, secondaryExpiresAt - Date.now() + 150));
  assert.ok(Date.now() > secondaryExpiresAt);

  const reclaimedCrossProcessTask = structured(await request("tools/call", {
    name: "acquire_task_lease",
    arguments: { projectRoot: fixtureRoot, taskId: crossProcessTask.taskId, ttlMs: 2000 },
  }));
  assert.equal(reclaimedCrossProcessTask.recoverable, false);
  assert.ok(reclaimedCrossProcessTask.lease?.expiresAt);
  assert.ok(Date.parse(reclaimedCrossProcessTask.lease.expiresAt) > Date.now());
  const reclaimedEvent = reclaimedCrossProcessTask.timeline.find((event) => event.status === "lease_reclaimed");
  assert.ok(reclaimedEvent);
  assert.equal(reclaimedEvent.result?.reason, "lease_expired");
  assert.equal(reclaimedEvent.result?.previousOwnerId, secondaryLease.lease.ownerId);
  assert.notEqual(reclaimedEvent.result?.ownerId, secondaryLease.lease.ownerId);
  const recoveredCrossProcessTask = structured(await request("tools/call", {
    name: "advance_task",
    arguments: { projectRoot: fixtureRoot, taskId: crossProcessTask.taskId },
  }));
  assert.equal(recoveredCrossProcessTask.status, "completed");
  assert.equal(recoveredCrossProcessTask.steps[0]?.status, "succeeded");
  const recoveredOperationId = recoveredCrossProcessTask.steps[0]?.operationId;
  assert.match(recoveredOperationId ?? "", /^taskop_[A-Za-z0-9]+$/);
  const recoveredTimeline = structured(await request("tools/call", {
    name: "task_timeline",
    arguments: { projectRoot: fixtureRoot, taskId: crossProcessTask.taskId, stepId: "cross-process-run", operationId: recoveredOperationId },
  }));
  assert.deepEqual(recoveredTimeline.events.map((event) => event.status), ["running", "succeeded"]);
  assert.equal(recoveredTimeline.events[1]?.operationId, recoveredOperationId);
  const appliedAfterTakeover = structured(await request("tools/call", {
    name: "apply_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: blockedApplyPlan.planId },
  }));
  assert.equal(appliedAfterTakeover.status, "applied");
  assert.ok(sceneNode(await readEditorContext(fixtureRoot), "BlockedByLease"));
  const rolledBackAfterTakeover = structured(await request("tools/call", {
    name: "rollback_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: blockedApplyPlan.planId },
  }));
  assert.equal(rolledBackAfterTakeover.status, "rolled_back");
  assert.equal(sceneNode(await readEditorContext(fixtureRoot), "BlockedByLease"), undefined);
  stage("real bridge multi-process lease recovery complete");

  const missingNodeTask = structured(await request("tools/call", {
    name: "create_task",
    arguments: {
      projectRoot: fixtureRoot,
      title: "Godot task verification failure smoke",
      steps: [{ kind: "verify_scene_state", stepId: "verify-missing", nodePath: "MissingTaskNode" }],
    },
  }));
  const failedVerificationTask = structured(await request("tools/call", {
    name: "advance_task",
    arguments: { projectRoot: fixtureRoot, taskId: missingNodeTask.taskId },
  }));
  assert.equal(failedVerificationTask.status, "failed");
  const failedVerificationStep = failedVerificationTask.steps[0];
  assert.equal(failedVerificationStep?.error?.code, "TASK_VERIFICATION_FAILED");
  assert.equal(failedVerificationStep?.error?.details?.nodePath, "MissingTaskNode");
  assert.equal(failedVerificationStep?.error?.details?.actualExists, false);
  const failedVerificationTimeline = structured(await request("tools/call", {
    name: "task_timeline",
    arguments: {
      projectRoot: fixtureRoot,
      taskId: missingNodeTask.taskId,
      stepId: "verify-missing",
      operationId: failedVerificationStep?.operationId,
    },
  }));
  assert.deepEqual(failedVerificationTimeline.events.map((event) => event.status), ["running", "failed"]);
  assert.deepEqual(failedVerificationTimeline.events[1]?.error?.details, failedVerificationStep?.error?.details);
  stage("task verification failure evidence complete");

  const repairTask = structured(await request("tools/call", {
    name: "create_task",
    arguments: {
      projectRoot: fixtureRoot,
      title: "Preview, approve and verify a diagnostic repair",
      steps: [
        { kind: "run_scene", stepId: "run-before-repair", scenePath: "res://main.tscn", timeoutMs: 30000 },
        {
          kind: "preview_diagnostic_repair",
          stepId: "preview-repair",
          runStepId: "run-before-repair",
          diagnosticKind: "warning",
          diagnosticIndex: 0,
          repairHint: {
            kind: "scene.create_node",
            parentPath: ".",
            nodeName: "TaskRepairMarker",
            nodeType: "Node2D",
            reason: "Add the explicitly approved task repair marker.",
          },
        },
        { kind: "apply_diagnostic_repair", stepId: "apply-repair", previewStepId: "preview-repair" },
        { kind: "run_scene", stepId: "run-after-repair", scenePath: "res://main.tscn", timeoutMs: 30000 },
        { kind: "verify_diagnostics", stepId: "verify-after-repair", runStepId: "run-after-repair", maxErrors: 0, maxWarnings: 100 },
      ],
    },
  }));
  const afterRepairSourceRun = structured(await request("tools/call", {
    name: "advance_task",
    arguments: { projectRoot: fixtureRoot, taskId: repairTask.taskId },
  }));
  assert.equal(afterRepairSourceRun.status, "active");
  const repairPreviewTask = structured(await request("tools/call", {
    name: "advance_task",
    arguments: { projectRoot: fixtureRoot, taskId: repairTask.taskId },
  }));
  assert.equal(repairPreviewTask.status, "paused");
  assert.equal(repairPreviewTask.nextStepId, "apply-repair");
  assert.equal(sceneNode(await readEditorContext(fixtureRoot), "TaskRepairMarker"), undefined);
  const repairPreviewResult = repairPreviewTask.steps[1]?.result;
  assert.ok(repairPreviewResult.plan.planId);
  assert.equal(repairPreviewResult.runStepId, "run-before-repair");
  assert.equal(repairPreviewResult.diagnostic.message.length > 0, true);
  assert.equal(repairPreviewResult.repairHint.nodeName, "TaskRepairMarker");
  const repairPlan = repairPreviewResult.plan;
  structured(await request("tools/call", {
    name: "confirm_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: repairPlan.planId, expectedRevision: repairPlan.expectedRevision },
  }));
  const resumedRepairTask = structured(await request("tools/call", {
    name: "resume_task",
    arguments: { projectRoot: fixtureRoot, taskId: repairTask.taskId },
  }));
  assert.equal(resumedRepairTask.status, "active");
  const appliedRepairTask = structured(await request("tools/call", {
    name: "advance_task",
    arguments: { projectRoot: fixtureRoot, taskId: repairTask.taskId },
  }));
  assert.equal(appliedRepairTask.steps[2]?.status, "succeeded");
  assert.equal(appliedRepairTask.steps[2]?.result?.planId, repairPlan.planId);
  assert.ok(sceneNode(await readEditorContext(fixtureRoot), "TaskRepairMarker"));
  const rerunRepairTask = structured(await request("tools/call", {
    name: "advance_task",
    arguments: { projectRoot: fixtureRoot, taskId: repairTask.taskId },
  }));
  assert.equal(rerunRepairTask.steps[3]?.status, "succeeded");
  const verifiedRepairTask = structured(await request("tools/call", {
    name: "advance_task",
    arguments: { projectRoot: fixtureRoot, taskId: repairTask.taskId },
  }));
  assert.equal(verifiedRepairTask.status, "completed");
  assert.equal(verifiedRepairTask.steps[4]?.result?.passed, true);
  const repairPreviewTimeline = structured(await request("tools/call", {
    name: "task_timeline",
    arguments: { projectRoot: fixtureRoot, taskId: repairTask.taskId, stepId: "preview-repair" },
  }));
  assert.ok(repairPreviewTimeline.events.some((event) => event.status === "paused"));
  const repairRollback = structured(await request("tools/call", {
    name: "rollback_scene_change",
    arguments: { projectRoot: fixtureRoot, planId: repairPlan.planId },
  }));
  assert.equal(repairRollback.status, "rolled_back");
  assert.equal(sceneNode(await readEditorContext(fixtureRoot), "TaskRepairMarker"), undefined);
  stage("task diagnostic repair preview, confirmation, apply and verification complete");

  const diagnostics = structured(await request("tools/call", {
    name: "run_scene",
    arguments: { projectRoot: fixtureRoot, scenePath: "res://main.tscn", timeoutMs: 30000 },
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
  console.error("Secondary MCP output:\n" + secondaryMcpOutputRef.value);
  throw error;
} finally {
  await stopProcess(secondaryMcpProcess);
  await stopProcess(mcpProcess);
  await stopProcess(godotProcess);
  await rm(fixtureRoot, { recursive: true, force: true });
}
