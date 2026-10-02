# 60-second demo storyboard

目标：让第一次看到项目的人在一分钟内理解三件事：它能看到真实 Godot 场景、写入前会展示 Diff、变更可以验证并回滚。

## Recording setup

1. Open examples/starter/project.godot in Godot 4.x.
2. Copy the bridge plugin into the starter project and enable it.
3. From the repository root, run npm run dev -- --no-open.
4. Open http://127.0.0.1:3000/mcp/inspector at 1280×720.
5. Keep the Godot editor scene tree visible in a second window if recording the split-screen version.

## Timeline

| Time | Screen | Action | Message |
| --- | --- | --- | --- |
| 0–5s | README/Inspector | Show the project name and CI badge | “Safe Godot changes for AI agents.” |
| 5–12s | Inspector Tools | Call editor_context, then search_project for Canvas | “The agent starts from live editor context.” |
| 12–24s | Tool result | Preview scene.instantiate_scene for res://ui/hud.tscn | “The exact target and Diff appear before writing.” |
| 24–34s | Godot + Inspector | Confirm and apply; show HUDInstance in the scene tree | “The plugin applies through Godot UndoRedo.” |
| 34–44s | Inspector | Call editor_context or verify_scene_state | “The result is checked, not assumed.” |
| 44–54s | Inspector | Roll back the plan; show HUDInstance disappear | “Rollback is revision- and history-guarded.” |
| 54–60s | README/CI | Show the four green CI jobs | “Godot 4.5.1 and 4.7.2 run the same smoke.” |

## Voiceover / post copy

~~~text
Godot Safe Change MCP lets an agent work through a safe, reviewable loop.
It reads the live editor, shows a concrete diff, waits for confirmation,
applies through UndoRedo, verifies the result, and refuses unsafe rollback.
The same fixture runs on two Godot versions in CI.
~~~

## Acceptance checklist

- The repository URL and README are visible for the first five seconds.
- The preview result shows a real NodePath and target scene path.
- The apply result shows a specific UndoRedo label and changed scene tree.
- The rollback result is visible before the video ends.
- No tokens, private paths, or unrelated project files appear in the recording.
- Upload the final GIF/video to a GitHub Release or repository asset, not to an expiring local path.
