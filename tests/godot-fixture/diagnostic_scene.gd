extends Node2D

func _ready() -> void:
    EngineDebugger.register_message_capture("godot_safe_change", _capture_debugger_message)
    EngineDebugger.send_message("godot_safe_change:diagnostic", ["output", "fixture scene started"])
    get_tree().create_timer(0.5).timeout.connect(_finish_fixture)

func _finish_fixture() -> void:
    get_tree().quit()

func _capture_debugger_message(_message: String, _data: Array) -> bool:
    return false
