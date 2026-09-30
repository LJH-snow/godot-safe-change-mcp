@tool
extends EditorDebuggerPlugin
class_name SafeChangeDiagnosticsDebugger

var plugin: Object

func configure(next_plugin: Object) -> void:
    plugin = next_plugin

func _has_capture(capture: String) -> bool:
    return capture == "godot_safe_change"

func _capture(message: String, data: Array, session_id: int) -> bool:
    if message == "godot_safe_change:diagnostic" or message == "diagnostic":
        if plugin != null:
            plugin.record_debugger_message(data)
        return true
    return false
