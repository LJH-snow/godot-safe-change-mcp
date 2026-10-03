# Agent Examples

这些示例使用 MCP tool arguments 表示。把 projectRoot 换成目标 Godot 项目的绝对路径；不同 MCP 客户端的调用界面可能略有不同，但工具名和字段保持一致。

## 1. Search before editing

先确认 Agent 看到的是哪个场景、节点、脚本和资源：

~~~json
{
  "name": "search_project",
  "arguments": {
    "projectRoot": "/path/to/my-godot-project",
    "query": "Player",
    "kinds": ["scene", "node", "script", "resource"],
    "maxResults": 20
  }
}
~~~

需要读取当前编辑器状态时调用 editor_context：

~~~json
{
  "name": "editor_context",
  "arguments": { "projectRoot": "/path/to/my-godot-project" }
}
~~~

## 2. Create, verify, and roll back a node

写入永远拆成四次调用，不要把 apply 当成 preview 的一部分。

### Preview

~~~json
{
  "name": "preview_scene_change",
  "arguments": {
    "projectRoot": "/path/to/my-godot-project",
    "reason": "Add a marker for the loading screen.",
    "operation": {
      "kind": "scene.create_node",
      "parentPath": ".",
      "nodeName": "LoadingMarker",
      "nodeType": "Node2D"
    }
  }
}
~~~

### Confirm, apply, and rollback

Use the returned planId and expectedRevision exactly as returned by preview:

~~~json
{
  "name": "confirm_scene_change",
  "arguments": {
    "projectRoot": "/path/to/my-godot-project",
    "planId": "<preview.planId>",
    "expectedRevision": "<preview.expectedRevision>"
  }
}
~~~

~~~json
{
  "name": "apply_scene_change",
  "arguments": {
    "projectRoot": "/path/to/my-godot-project",
    "planId": "<preview.planId>"
  }
}
~~~

After checking the editor context or running the scene, roll back the same plan if needed:

~~~json
{
  "name": "rollback_scene_change",
  "arguments": {
    "projectRoot": "/path/to/my-godot-project",
    "planId": "<preview.planId>"
  }
}
~~~

## 3. Instantiate a scene and manage a signal

Both operations are bounded to the current scene. Existing scenes, signals, target methods, duplicate connections, and NodePaths are validated before apply.

~~~json
{
  "name": "preview_scene_change",
  "arguments": {
    "projectRoot": "/path/to/my-godot-project",
    "reason": "Add the reusable HUD scene and connect its visibility signal.",
    "operation": {
      "kind": "scene.instantiate_scene",
      "parentPath": ".",
      "scenePath": "res://ui/hud.tscn",
      "nodeName": "HUD"
    }
  }
}
~~~

For a signal connection, preview the source signal and target method separately:

~~~json
{
  "name": "preview_scene_change",
  "arguments": {
    "projectRoot": "/path/to/my-godot-project",
    "reason": "Connect the HUD visibility signal to the scene handler.",
    "operation": {
      "kind": "scene.connect_signal",
      "sourcePath": "HUD/Panel",
      "signalName": "visibility_changed",
      "targetPath": ".",
      "methodName": "_on_hud_visibility_changed"
    }
  }
}
~~~

Confirm and apply each plan independently, then use editor_context to verify the scene tree and signal behavior. Roll back in reverse order if the change is no longer wanted.

To remove only an existing exact connection, use the same source, signal, target and method tuple:

~~~json
{
  "name": "preview_scene_change",
  "arguments": {
    "projectRoot": "/path/to/my-godot-project",
    "reason": "Disconnect the HUD visibility handler without touching other connections.",
    "operation": {
      "kind": "scene.disconnect_signal",
      "sourcePath": "HUD/Panel",
      "signalName": "visibility_changed",
      "targetPath": ".",
      "methodName": "_on_hud_visibility_changed"
    }
  }
}
~~~

The preview is rejected when the exact connection is absent; applying and rolling back the plan only removes and restores that tuple.

## 4. Run and verify a task with a lease

Use a task lease when several steps must remain owned by one MCP process:

~~~json
{
  "name": "create_task",
  "arguments": {
    "projectRoot": "/path/to/my-godot-project",
    "title": "Run and verify the current scene",
    "steps": [
      { "kind": "run_current_scene", "stepId": "run-scene" },
      {
        "kind": "verify_diagnostics",
        "stepId": "verify-run",
        "runStepId": "run-scene",
        "maxErrors": 0,
        "maxWarnings": 0
      }
    ]
  }
}
~~~

Then call acquire_task_lease, advance_task once per step, inspect task_status/task_timeline, and release_task_lease when the task is complete. Heartbeats renew the lease automatically; an interrupted process can be replaced after TTL expiry.

## 5. Recover from a busy or stale window

When another MCP process owns the project, do not retry a write in a tight loop:

1. Read task_status and record owner, leaseId, expiresAt, and recoverable.
2. Inspect task_timeline for lease_acquired, lease_renewed, lease_reclaimed, or step_interrupted.
3. Wait for the owner to release the lease, or let TTL expiry make the task recoverable.
4. Acquire the task lease from the replacement window and advance from the persisted nextStepId.

The expected outcome for an active competing owner is the stable machine-readable error code PROJECT_BUSY. A stale revision is different: re-read editor_context, discard the old plan, and generate a fresh preview.
