# Godot Safe Change Starter

这是一个最小、可复制的 Godot 项目，用来体验 Godot Safe Change MCP 的第一条安全闭环：

~~~text
editor_context → search_project → preview → confirm → apply → verify → rollback
~~~

## 启动

在仓库根目录安装依赖并构建 MCP Server：

~~~bash
npm ci
npm run build
~~~

把 Godot bridge 插件复制到这个示例项目：

~~~bash
mkdir -p examples/starter/addons
cp -R godot-plugin examples/starter/addons/godot-safe-change-bridge
~~~

然后：

1. 用 Godot 4.x 打开 examples/starter/project.godot。
2. 在 Project → Project Settings → Plugins 中启用 Godot Safe Change Bridge。
3. 在仓库根目录运行 npm run dev。
4. 打开 MCP Inspector 或连接你常用的 MCP 客户端。

## 可以尝试的请求

~~~text
读取当前编辑器上下文，告诉我当前场景树和所有可见节点。
搜索项目中的 Canvas、HUD 和 PackedScene。
预览把 res://ui/hud.tscn 实例化到当前场景根节点下，名称为 HUDInstance。
确认并应用刚才的计划，然后验证 HUDInstance 是否出现。
把 Canvas/Title 的 text 改成 "Safe Change"，运行前先给我看 Diff。
完成验证后回滚刚才的变更。
~~~

这个 fixture 没有依赖外部资源或服务，适合录制演示、复现 issue 和验证新操作。写操作仍必须经过 preview、confirm、revision、lease、apply 和 rollback。
