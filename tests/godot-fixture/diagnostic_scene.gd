extends Node2D

func _ready() -> void:
    print("fixture scene started")
    EngineDebugger.register_message_capture("godot_safe_change", _capture_debugger_message)
    EngineDebugger.send_message("godot_safe_change:diagnostic", ["output", "fixture scene started"])
    EngineDebugger.send_message(
        "godot_safe_change:diagnostic",
        [
            "warning",
            "fixture warning has a bounded repair hint",
            "res://diagnostic_scene.gd",
            7,
            ".",
            {
                "kind": "scene.create_node",
                "parentPath": ".",
                "nodeName": "RepairMarker",
                "nodeType": "Node2D",
                "reason": "Repair the fixture warning.",
            },
        ],
    )
    get_tree().create_timer(0.5).timeout.connect(_finish_fixture)

func _finish_fixture() -> void:
    print("fixture scene stopping")
    get_tree().quit()

func _capture_debugger_message(_message: String, _data: Array) -> bool:
    return false
