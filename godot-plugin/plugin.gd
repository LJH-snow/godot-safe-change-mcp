@tool
extends EditorPlugin

const SafeChangeBridgeServer = preload("res://addons/godot-safe-change-bridge/bridge_server.gd")
const SafeChangeDiagnosticsDebugger = preload("res://addons/godot-safe-change-bridge/diagnostics_debugger.gd")
const BRIDGE_PORT := 8765
const ALLOWED_NODE_TYPES := {
    "Node": true,
    "Node2D": true,
    "Control": true,
    "Label": true,
    "ColorRect": true,
}

var dock: PanelContainer
var status_label: Label
var bridge_server: SafeChangeBridgeServer
var diagnostics_debugger: SafeChangeDiagnosticsDebugger
var bridge_status := "stopped"
var run_status := "idle"
var run_id := ""
var run_scene_path := ""
var run_started_at := 0
var last_applied_plan_id := ""
var last_applied_revision := ""
var last_applied_kind := ""
var last_applied_undo_history_id := -1
var last_applied_undo_version := -1
var last_applied_undo_action := -1
var last_applied_undo_label := ""
var last_applied_scene_path := ""
var last_script_path := ""
var last_script_original_content := ""
var last_script_applied_revision := ""
var last_resource_path := ""
var last_resource_original_content := ""
var last_resource_applied_revision := ""
var last_input_action_name := ""
var last_input_action_original_setting: Variant = null
var last_input_action_applied_revision := ""
var diagnostics := {
    "output": [],
    "warnings": [],
    "errors": [],
}

func _enter_tree() -> void:
    _create_dock()
    bridge_server = SafeChangeBridgeServer.new(self, BRIDGE_PORT)
    var listen_error := bridge_server.start()
    bridge_status = "connected" if listen_error == OK else "error"

    diagnostics_debugger = SafeChangeDiagnosticsDebugger.new()
    diagnostics_debugger.configure(self)
    add_debugger_plugin(diagnostics_debugger)
    set_process(true)
    _refresh_status_label()

func _exit_tree() -> void:
    set_process(false)
    if diagnostics_debugger != null:
        remove_debugger_plugin(diagnostics_debugger)
        diagnostics_debugger = null
    if bridge_server != null:
        bridge_server.stop()
        bridge_server = null
    if is_instance_valid(dock):
        remove_control_from_docks(dock)
        dock.queue_free()
        dock = null

func _process(_delta: float) -> void:
    if bridge_server != null:
        bridge_server.poll()
    _update_run_state()
    _refresh_status_label()

func handle_bridge_request(method: String, path: String, body: Variant) -> Dictionary:
    if method != "POST":
        return _failure("UNSAFE_OPERATION", "Only POST requests are accepted by the local bridge.", 405)

    var project_error := _validate_project(body)
    if not project_error.is_empty():
        return project_error

    match path:
        "/v1/context":
            return _success("context", _editor_context())
        "/v1/changes/apply":
            return _apply_change(body)
        "/v1/changes/rollback":
            return _rollback_change(body)
        "/v1/search":
            return _search_project(body)
        "/v1/scripts/read":
            return _read_script(body)
        "/v1/resources/read":
            return _read_resource(body)
        "/v1/input-actions/read":
            return _read_input_action(body)
        "/v1/run/current":
            return _run_current_scene()
        "/v1/run/scene":
            return _run_specific_scene(body)
        "/v1/run/status":
            return _run_status_response(body)
        _:
            return _failure("UNSAFE_OPERATION", "The requested bridge route is not enabled.", 404)

func record_debugger_message(data: Array) -> void:
    if data.size() < 2:
        return
    var severity := String(data[0]).to_lower()
    var message := String(data[1])
    var entry := {"message": message}
    if data.size() > 2 and String(data[2]) != "":
        entry["source"] = String(data[2])
    if data.size() > 3 and int(data[3]) >= 0:
        entry["line"] = int(data[3])
    if data.size() > 4 and String(data[4]) != "":
        entry["nodePath"] = String(data[4])
    if data.size() > 5 and typeof(data[5]) == TYPE_DICTIONARY:
        var repair_hint := _safe_repair_hint(data[5])
        if not repair_hint.is_empty():
            entry["repairHint"] = repair_hint
    if severity == "run_complete":
        run_status = "stopped"
        diagnostics["output"].append(message)
    elif severity == "error":
        diagnostics["errors"].append(entry)
    elif severity == "warning":
        diagnostics["warnings"].append(entry)
    else:
        diagnostics["output"].append(message)

func _safe_repair_hint(value: Dictionary) -> Dictionary:
    var node_type := String(value.get("nodeType", ""))
    var parent_path := String(value.get("parentPath", ""))
    var node_name := String(value.get("nodeName", ""))
    var reason := String(value.get("reason", ""))
    if String(value.get("kind", "")) != "scene.create_node":
        return {}
    if not ALLOWED_NODE_TYPES.has(node_type) or parent_path == "" or parent_path.begins_with("/"):
        return {}
    var name_regex := RegEx.new()
    name_regex.compile("^[A-Za-z_][A-Za-z0-9_]*$")
    if name_regex.search(node_name) == null or reason == "":
        return {}
    return {
        "kind": "scene.create_node",
        "parentPath": parent_path,
        "nodeName": node_name,
        "nodeType": node_type,
        "reason": reason,
    }

func _read_script(body: Variant) -> Dictionary:
    if typeof(body) != TYPE_DICTIONARY:
        return _failure("VALIDATION_FAILED", "The script read request body must be a JSON object.")
    var request_body: Dictionary = body
    var script_path := String(request_body.get("scriptPath", ""))
    if not _is_safe_script_path(script_path):
        return _failure("UNSAFE_OPERATION", "Only project-relative .gd scripts can be read.")
    if not FileAccess.file_exists(script_path):
        return _failure("PROJECT_NOT_FOUND", "The requested script does not exist.", 404, {"scriptPath": script_path})

    var file := FileAccess.open(script_path, FileAccess.READ)
    if file == null:
        return _failure("OPERATION_REJECTED", "Godot could not read the requested script.", 409)
    var content := file.get_as_text()
    return _success("snapshot", {
        "path": script_path,
        "revision": str(content.hash()),
        "content": content,
    })

func _is_safe_script_path(script_path: String) -> bool:
    return _is_safe_project_path(script_path) and script_path.ends_with(".gd")

func _is_safe_project_path(project_path: String) -> bool:
    if project_path.length() < 7 or project_path.length() > 256 or not project_path.begins_with("res://"):
        return false
    var relative_path := project_path.substr(6)
    if relative_path == "" or relative_path.contains("//") or relative_path.contains("\\") or project_path.contains(".."):
        return false
    for segment in relative_path.split("/"):
        if segment == "" or segment == "." or segment == "..":
            return false
    return true

func _is_safe_node_path(node_path: String) -> bool:
    if node_path == ".":
        return true
    if node_path.length() < 1 or node_path.length() > 256 or node_path.begins_with("/") or node_path.contains("..") or node_path.contains("\\") or node_path.contains(":"):
        return false
    var segment_regex := RegEx.new()
    segment_regex.compile("^[A-Za-z_][A-Za-z0-9_]*$")
    for segment in node_path.split("/"):
        if segment == "" or segment_regex.search(segment) == null:
            return false
    return true

func _is_safe_resource_identifier(identifier: String) -> bool:
    if identifier.begins_with("uid://"):
        var uid_regex := RegEx.new()
        uid_regex.compile("^uid://[A-Za-z0-9_-]+$")
        return uid_regex.search(identifier) != null
    return _is_safe_project_path(identifier)

func _read_resource(body: Variant) -> Dictionary:
    if typeof(body) != TYPE_DICTIONARY:
        return _failure("VALIDATION_FAILED", "The resource read request body must be a JSON object.")
    var request_body: Dictionary = body
    var resource_path := String(request_body.get("resourcePath", ""))
    if not _is_safe_resource_path(resource_path):
        return _failure("UNSAFE_OPERATION", "Only project-relative scene/resource files can be read.")
    if not FileAccess.file_exists(resource_path):
        return _failure("PROJECT_NOT_FOUND", "The requested resource does not exist.", 404, {"resourcePath": resource_path})

    var file := FileAccess.open(resource_path, FileAccess.READ)
    if file == null:
        return _failure("OPERATION_REJECTED", "Godot could not read the requested resource.", 409)
    var content := file.get_as_text()
    return _success("snapshot", {
        "path": resource_path,
        "revision": str(content.hash()),
        "content": content,
    })

func _is_safe_resource_path(resource_path: String) -> bool:
    var extension := resource_path.get_extension().to_lower()
    return _is_safe_project_path(resource_path) and extension in ["tscn", "tres", "res"]

func _read_input_action(body: Variant) -> Dictionary:
    if typeof(body) != TYPE_DICTIONARY:
        return _failure("VALIDATION_FAILED", "The input action read request body must be a JSON object.")
    var request_body: Dictionary = body
    var action_name := String(request_body.get("actionName", ""))
    if not _is_safe_input_action_name(action_name):
        return _failure("UNSAFE_OPERATION", "Only bounded input action names can be read.")

    var setting_value: Variant = ProjectSettings.get_setting("input/" + action_name, null)
    var exists := typeof(setting_value) == TYPE_DICTIONARY
    var deadzone: Variant = null
    var events: Array = []
    if exists:
        var setting: Dictionary = setting_value
        deadzone = float(setting.get("deadzone", 0.5))
        var configured_events: Variant = setting.get("events", [])
        if typeof(configured_events) == TYPE_ARRAY:
            for event in configured_events:
                var event_snapshot := _input_event_snapshot(event)
                if not event_snapshot.is_empty():
                    events.append(event_snapshot)

    return _success("snapshot", {
        "actionName": action_name,
        "revision": _project_settings_revision(),
        "exists": exists,
        "deadzone": deadzone,
        "events": events,
    })

func _is_safe_input_action_name(action_name: String) -> bool:
    if action_name.length() < 1 or action_name.length() > 128:
        return false
    var name_regex := RegEx.new()
    name_regex.compile("^[A-Za-z_][A-Za-z0-9_]*$")
    return name_regex.search(action_name) != null

func _input_event_snapshot(event: Variant) -> Dictionary:
    if not event is InputEvent:
        return {}
    if event is InputEventKey:
        return {
            "type": "InputEventKey",
            "physicalKeycode": int(event.physical_keycode),
            "keycode": int(event.keycode),
        }
    return {
        "type": event.get_class(),
        "physicalKeycode": null,
        "keycode": null,
    }

func _project_settings_revision() -> String:
    var project_path := ProjectSettings.globalize_path("res://project.godot")
    if not FileAccess.file_exists(project_path):
        return ""
    var file := FileAccess.open(project_path, FileAccess.READ)
    if file == null:
        return ""
    var content := file.get_as_text()
    file.close()
    return str(content.hash())

func _create_dock() -> void:
    dock = PanelContainer.new()
    dock.name = "SafeChangeDock"
    dock.custom_minimum_size = Vector2(280, 120)

    status_label = Label.new()
    status_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
    dock.add_child(status_label)
    add_control_to_dock(DOCK_SLOT_LEFT_BL, dock)

func _refresh_status_label() -> void:
    if status_label == null:
        return
    status_label.text = "Godot Safe Change Bridge\nHTTP: " + bridge_status + "\nRun: " + run_status

func _validate_project(body: Variant) -> Dictionary:
    if typeof(body) != TYPE_DICTIONARY:
        return _failure("VALIDATION_FAILED", "The bridge request body must be a JSON object.")
    var request_body: Dictionary = body
    if not request_body.has("projectRoot"):
        return _failure("VALIDATION_FAILED", "projectRoot is required.")

    var requested_root := String(request_body["projectRoot"]).simplify_path()
    var current_root := ProjectSettings.globalize_path("res://").simplify_path()
    if requested_root != current_root:
        return _failure(
            "PROJECT_NOT_FOUND",
            "The requested project root is not the project opened in this editor.",
            404,
            {"projectRoot": requested_root},
        )
    return {}

func _editor_context() -> Dictionary:
    var scene_root := EditorInterface.get_edited_scene_root()
    var scene_path := ""
    var root_name := ""
    var root_type := ""
    var scene_nodes: Array = []
    var selection: Array = []

    if scene_root != null:
        scene_path = String(scene_root.scene_file_path)
        root_name = String(scene_root.name)
        root_type = String(scene_root.get_class())
        _append_scene_node(scene_root, scene_root, scene_nodes)
        var selected_nodes = EditorInterface.get_selection().get_selected_nodes()
        for selected_node in selected_nodes:
            selection.append(_node_context(scene_root, selected_node))

    var open_resources: Array = []
    for open_scene in EditorInterface.get_open_scenes():
        open_resources.append(String(open_scene))

    return {
        "schemaVersion": "0.2",
        "projectRoot": ProjectSettings.globalize_path("res://").simplify_path(),
        "connection": "connected",
        "revision": _current_revision(scene_root, scene_path),
        "project": {
            "name": String(ProjectSettings.get_setting("application/config/name", "")),
            "path": ProjectSettings.globalize_path("res://").simplify_path(),
        },
        "currentScene": {
            "path": scene_path if scene_path != "" else null,
            "rootName": root_name if root_name != "" else null,
            "rootType": root_type if root_type != "" else null,
            "nodes": scene_nodes,
        },
        "selection": selection,
        "openResources": open_resources,
        "run": {
            "status": run_status,
            "scenePath": run_scene_path if run_scene_path != "" else null,
            "runId": run_id if run_id != "" else null,
        },
        "diagnostics": diagnostics.duplicate(true),
    }

func _append_scene_node(scene_root: Node, node: Node, nodes: Array) -> void:
    nodes.append(_node_context(scene_root, node))
    for child in node.get_children():
        _append_scene_node(scene_root, child, nodes)

func _node_context(scene_root: Node, node: Node) -> Dictionary:
    return {
        "path": String(scene_root.get_path_to(node)),
        "name": String(node.name),
        "type": String(node.get_class()),
        "properties": _safe_node_properties(node),
    }

func _scene_node(scene_root: Node, node_path: String) -> Node:
    if scene_root == null or not _is_safe_node_path(node_path):
        return null
    if node_path == ".":
        return scene_root
    var node := scene_root.get_node_or_null(NodePath(node_path))
    if node == null or not scene_root.is_ancestor_of(node):
        return null
    return node

func _safe_node_properties(node: Node) -> Dictionary:
    var properties := {}
    if node is CanvasItem:
        properties["visible"] = node.visible
    if node is Node2D:
        properties["position"] = {"x": node.position.x, "y": node.position.y}
    if node is Control:
        properties["size"] = {"x": node.size.x, "y": node.size.y}
    if node is Label:
        properties["text"] = node.text
    if node is ColorRect:
        properties["color"] = {
            "r": node.color.r,
            "g": node.color.g,
            "b": node.color.b,
            "a": node.color.a,
        }
    return properties

func _search_project(body: Variant) -> Dictionary:
    if typeof(body) != TYPE_DICTIONARY:
        return _failure("VALIDATION_FAILED", "The search request body must be a JSON object.")
    var request_body: Dictionary = body
    var query := String(request_body.get("query", "")).strip_edges().to_lower()
    if query == "":
        return _failure("VALIDATION_FAILED", "query is required.")

    var kinds: Array = request_body.get("kinds", ["scene", "node", "script", "resource"])
    if typeof(kinds) != TYPE_ARRAY or kinds.is_empty():
        return _failure("VALIDATION_FAILED", "kinds must be a non-empty array.")
    for kind in kinds:
        if not ["scene", "node", "script", "resource"].has(String(kind)):
            return _failure("VALIDATION_FAILED", "kinds contains an unsupported value.")

    var max_results := clamp(int(request_body.get("maxResults", 50)), 1, 100)
    var results: Array = []
    var scene_root := EditorInterface.get_edited_scene_root()
    var scene_path := ""
    var revision := ""
    if scene_root != null:
        scene_path = String(scene_root.scene_file_path)
        revision = _current_revision(scene_root, scene_path)
        if kinds.has("node"):
            _search_scene_nodes(scene_root, scene_root, query, results, max_results)

    var resource_filesystem = EditorInterface.get_resource_filesystem()
    if resource_filesystem != null and results.size() < max_results:
        var filesystem = resource_filesystem.get_filesystem()
        if filesystem != null:
            _search_filesystem_directory(filesystem, query, kinds, results, max_results, resource_filesystem)

    return _success("report", {
        "schemaVersion": "0.3",
        "projectRoot": ProjectSettings.globalize_path("res://").simplify_path(),
        "query": query,
        "revision": revision,
        "results": results,
    })

func _search_scene_nodes(scene_root: Node, node: Node, query: String, results: Array, max_results: int) -> void:
    if results.size() >= max_results:
        return
    var context := _node_context(scene_root, node)
    var matches := _field_matches(query, [context["path"], context["name"], context["type"]])
    if not matches.is_empty():
        results.append({
            "kind": "node",
            "path": String(scene_root.scene_file_path),
            "name": context["name"],
            "nodePath": context["path"],
            "nodeType": context["type"],
            "matches": matches,
        })
    for child in node.get_children():
        _search_scene_nodes(scene_root, child, query, results, max_results)
        if results.size() >= max_results:
            return

func _search_filesystem_directory(directory, query: String, kinds: Array, results: Array, max_results: int, resource_filesystem) -> void:
    for file_index in range(directory.get_file_count()):
        if results.size() >= max_results:
            return
        var file_path := String(directory.get_file_path(file_index))
        var kind := _file_kind(file_path)
        if not kinds.has(kind):
            continue
        var file_type := String(resource_filesystem.get_file_type(file_path))
        var matches := _field_matches(query, [file_path, file_path.get_file(), file_type])
        if matches.is_empty():
            continue
        results.append({
            "kind": kind,
            "path": file_path,
            "name": file_path.get_file(),
            "nodePath": null,
            "nodeType": null,
            "matches": matches,
        })

    for subdir_index in range(directory.get_subdir_count()):
        if results.size() >= max_results:
            return
        _search_filesystem_directory(directory.get_subdir(subdir_index), query, kinds, results, max_results, resource_filesystem)

func _file_kind(file_path: String) -> String:
    var extension := file_path.get_extension().to_lower()
    if extension == "tscn" or extension == "scn":
        return "scene"
    if extension == "gd":
        return "script"
    return "resource"

func _field_matches(query: String, fields: Array) -> Array:
    var matches: Array = []
    var field_names := ["path", "name", "type"]
    for index in range(min(fields.size(), field_names.size())):
        if String(fields[index]).to_lower().contains(query):
            matches.append(field_names[index])
    return matches

func _has_exact_keys(value: Dictionary, required: Array, optional: Array = []) -> bool:
    for key in required:
        if not value.has(key):
            return false
    for key in value.keys():
        if not required.has(key) and not optional.has(key):
            return false
    return true

func _is_finite_number(value: Variant) -> bool:
    if typeof(value) != TYPE_INT and typeof(value) != TYPE_FLOAT:
        return false
    return is_finite(float(value))

func _is_valid_number(value: Variant, minimum: float, maximum: float) -> bool:
    return _is_finite_number(value) and float(value) >= minimum and float(value) <= maximum

func _is_valid_integer(value: Variant, minimum: float, maximum: float) -> bool:
    return _is_valid_number(value, minimum, maximum) and int(value) == float(value)

func _is_valid_point(value: Variant, minimum: float, maximum: float) -> bool:
    if typeof(value) != TYPE_DICTIONARY:
        return false
    var point: Dictionary = value
    if not _has_exact_keys(point, ["x", "y"]):
        return false
    return _is_valid_number(point["x"], minimum, maximum) and _is_valid_number(point["y"], minimum, maximum)

func _is_valid_color(value: Variant) -> bool:
    if typeof(value) != TYPE_DICTIONARY:
        return false
    var color: Dictionary = value
    if not _has_exact_keys(color, ["r", "g", "b", "a"]):
        return false
    return _is_valid_number(color["r"], 0.0, 1.0) \
        and _is_valid_number(color["g"], 0.0, 1.0) \
        and _is_valid_number(color["b"], 0.0, 1.0) \
        and _is_valid_number(color["a"], 0.0, 1.0)

func _is_safe_plan_id(plan_id: String) -> bool:
    var plan_regex := RegEx.new()
    plan_regex.compile("^[A-Za-z0-9_-]{1,128}$")
    return plan_regex.search(plan_id) != null

func _validate_change_request(request_body: Dictionary) -> Dictionary:
    if not _has_exact_keys(request_body, ["projectRoot", "planId", "expectedRevision", "operations"], ["expectedFileRevision"]):
        return _failure("VALIDATION_FAILED", "The change request contains unsupported or missing fields.")
    if typeof(request_body.get("projectRoot")) != TYPE_STRING or String(request_body["projectRoot"]) == "":
        return _failure("VALIDATION_FAILED", "projectRoot is required.")
    if not _is_safe_plan_id(String(request_body.get("planId", ""))):
        return _failure("VALIDATION_FAILED", "planId contains unsupported characters.")
    if typeof(request_body.get("expectedRevision")) != TYPE_STRING or String(request_body["expectedRevision"]) == "":
        return _failure("VALIDATION_FAILED", "expectedRevision is required.")
    if request_body.has("expectedFileRevision") and (typeof(request_body["expectedFileRevision"]) != TYPE_STRING or String(request_body["expectedFileRevision"]) == ""):
        return _failure("VALIDATION_FAILED", "expectedFileRevision must be a non-empty string when provided.")
    var operations: Variant = request_body["operations"]
    if typeof(operations) != TYPE_ARRAY or operations.size() != 1 or typeof(operations[0]) != TYPE_DICTIONARY:
        return _failure("UNSAFE_OPERATION", "Exactly one bounded operation is supported.")
    var operation: Dictionary = operations[0]
    var kind := String(operation.get("kind", ""))
    if kind == "scene.create_node":
        if not _has_exact_keys(operation, ["kind", "parentPath", "nodeName", "nodeType"]):
            return _failure("VALIDATION_FAILED", "scene.create_node contains unsupported or missing fields.")
        if not _is_safe_node_path(String(operation["parentPath"])):
            return _failure("VALIDATION_FAILED", "parentPath must be a safe relative NodePath.")
        if typeof(operation["nodeName"]) != TYPE_STRING or String(operation["nodeName"]) == "":
            return _failure("VALIDATION_FAILED", "nodeName is required.")
    elif kind == "scene.set_property":
        if not _has_exact_keys(operation, ["kind", "nodePath", "property", "value"]):
            return _failure("VALIDATION_FAILED", "scene.set_property contains unsupported or missing fields.")
        if not _is_safe_node_path(String(operation["nodePath"])):
            return _failure("VALIDATION_FAILED", "nodePath must be a safe relative NodePath.")
        var property := String(operation["property"])
        var value: Variant = operation["value"]
        if property == "visible":
            if typeof(value) != TYPE_BOOL:
                return _failure("VALIDATION_FAILED", "visible must be a boolean.")
        elif property == "position":
            if not _is_valid_point(value, -1000000.0, 1000000.0):
                return _failure("VALIDATION_FAILED", "position must contain finite x and y values in range.")
        elif property == "size":
            if not _is_valid_point(value, 0.0, 1000000.0):
                return _failure("VALIDATION_FAILED", "size must contain finite non-negative x and y values.")
        elif property == "text":
            if typeof(value) != TYPE_STRING or String(value).length() > 10000:
                return _failure("VALIDATION_FAILED", "text must be a bounded string.")
        elif property == "color":
            if not _is_valid_color(value):
                return _failure("VALIDATION_FAILED", "color must contain finite channel values from 0 to 1.")
        else:
            return _failure("UNSAFE_OPERATION", "The requested node property is not allowlisted.")
    elif kind == "scene.attach_script":
        if not _has_exact_keys(operation, ["kind", "nodePath", "scriptPath"]):
            return _failure("VALIDATION_FAILED", "scene.attach_script contains unsupported or missing fields.")
        if not _is_safe_node_path(String(operation["nodePath"])) or not _is_safe_script_path(String(operation["scriptPath"])):
            return _failure("UNSAFE_OPERATION", "Only safe scene node paths and project-relative scripts can be attached.")
    elif kind == "resource.replace_reference":
        if not _has_exact_keys(operation, ["kind", "resourcePath", "from", "to"]):
            return _failure("VALIDATION_FAILED", "resource.replace_reference contains unsupported or missing fields.")
        if not _is_safe_resource_path(String(operation["resourcePath"])) or not _is_safe_resource_identifier(String(operation["from"])) or not _is_safe_resource_identifier(String(operation["to"])):
            return _failure("UNSAFE_OPERATION", "Only safe resource paths and identifiers can be changed.")
    elif kind == "project.input_action.add_key":
        if not _has_exact_keys(operation, ["kind", "actionName", "physicalKeycode"], ["deadzone"]):
            return _failure("VALIDATION_FAILED", "project.input_action.add_key contains unsupported or missing fields.")
        var physical_keycode_value: Variant = operation["physicalKeycode"]
        if not _is_safe_input_action_name(String(operation["actionName"])) or not _is_valid_number(physical_keycode_value, 1.0, 10000.0) or int(physical_keycode_value) != float(physical_keycode_value):
            return _failure("VALIDATION_FAILED", "The input action name or physical keycode is invalid.")
        if operation.has("deadzone") and not _is_valid_number(operation["deadzone"], 0.0, 1.0):
            return _failure("VALIDATION_FAILED", "deadzone must be a finite number from 0 to 1.")
    elif kind == "script.replace_range":
        if not _has_exact_keys(operation, ["kind", "scriptPath", "startLine", "endLine", "replacement"]):
            return _failure("VALIDATION_FAILED", "script.replace_range contains unsupported or missing fields.")
        if not _is_safe_script_path(String(operation["scriptPath"])) or not _is_valid_integer(operation["startLine"], 1.0, 1000000.0) or not _is_valid_integer(operation["endLine"], 1.0, 1000000.0) or int(operation["endLine"]) < int(operation["startLine"]) or typeof(operation["replacement"]) != TYPE_STRING or String(operation["replacement"]).length() > 100000:
            return _failure("VALIDATION_FAILED", "The script replacement range or content is invalid.")
    else:
        return _failure("UNSAFE_OPERATION", "Only the bounded safe change operations are enabled.")
    return {}

func _apply_change(body: Variant) -> Dictionary:
    var request_body: Dictionary = body
    var request_error := _validate_change_request(request_body)
    if not request_error.is_empty():
        return request_error
    var scene_root := EditorInterface.get_edited_scene_root()
    if scene_root == null:
        return _failure("VALIDATION_FAILED", "A current scene is required before applying a change.")

    var expected_revision := String(request_body.get("expectedRevision", ""))
    var scene_path := String(scene_root.scene_file_path)
    var actual_revision := _current_revision(scene_root, scene_path)
    if expected_revision == "" or expected_revision != actual_revision:
        return _failure(
            "REVISION_CONFLICT",
            "The current editor revision does not match the requested revision.",
            409,
            {"expectedRevision": expected_revision, "actualRevision": actual_revision},
        )

    var operations: Variant = request_body.get("operations", [])
    if typeof(operations) != TYPE_ARRAY or operations.size() != 1:
        return _failure("UNSAFE_OPERATION", "Exactly one bounded scene operation is supported.")
    var operation: Variant = operations[0]
    if typeof(operation) != TYPE_DICTIONARY:
        return _failure("UNSAFE_OPERATION", "The operation must be a bounded object.")
    if String(operation.get("kind", "")) == "script.replace_range":
        return _apply_script_change(request_body, scene_root, scene_path)
    if String(operation.get("kind", "")) == "scene.set_property":
        return _apply_scene_property_change(request_body, scene_root, scene_path)
    if String(operation.get("kind", "")) == "scene.attach_script":
        return _apply_attach_script(request_body, scene_root, scene_path)
    if String(operation.get("kind", "")) == "resource.replace_reference":
        return _apply_resource_change(request_body, scene_root, scene_path)
    if String(operation.get("kind", "")) == "project.input_action.add_key":
        return _apply_input_action_change(request_body, scene_root, scene_path)
    if String(operation.get("kind", "")) != "scene.create_node":
        return _failure("UNSAFE_OPERATION", "Only the bounded safe change operations are enabled.")

    var create_result := _apply_create_node(scene_root, operation)
    if not create_result.is_empty():
        return create_result

    var applied_revision := _current_revision(scene_root, scene_path)
    last_applied_plan_id = String(request_body.get("planId", ""))
    last_applied_revision = applied_revision
    last_applied_kind = "scene"
    last_script_path = ""
    last_script_original_content = ""
    last_script_applied_revision = ""
    var report := {
        "schemaVersion": "0.2",
        "planId": String(request_body.get("planId", "")),
        "status": "applied",
        "revision": applied_revision,
        "operationCount": 1,
        "undoLabel": "Godot Safe Change: Add node",
    }
    return _success("report", report)

func _apply_scene_property_change(request_body: Dictionary, scene_root: Node, scene_path: String) -> Dictionary:
    var operation: Dictionary = request_body["operations"][0]
    var node_path := String(operation.get("nodePath", ""))
    var property := String(operation.get("property", ""))
    if not _is_safe_node_path(node_path):
        return _failure("VALIDATION_FAILED", "nodePath must be a safe relative NodePath.")
    var node: Node = _scene_node(scene_root, node_path)
    if node == null:
        return _failure("VALIDATION_FAILED", "The requested scene node does not exist.")

    var converted = _property_value(node, property, operation.get("value"))
    if converted == null:
        return _failure("UNSAFE_OPERATION", "The requested node property is not allowlisted for this node type.")
    var old_value = _property_snapshot(node, property)
    if old_value == null:
        return _failure("VALIDATION_FAILED", "The requested node property is not readable.")

    var undo_redo := get_undo_redo()
    undo_redo.create_action("Godot Safe Change: Set property")
    undo_redo.add_do_property(node, property, converted)
    undo_redo.add_undo_property(node, property, _property_value(node, property, old_value))
    undo_redo.commit_action()
    EditorInterface.mark_scene_as_unsaved()
    last_applied_plan_id = String(request_body.get("planId", ""))
    last_applied_revision = _current_revision(scene_root, scene_path)
    last_applied_kind = "scene"
    last_script_path = ""
    last_script_original_content = ""
    last_script_applied_revision = ""
    return _success("report", {
        "schemaVersion": "0.2",
        "planId": String(request_body.get("planId", "")),
        "status": "applied",
        "revision": last_applied_revision,
        "operationCount": 1,
        "undoLabel": "Godot Safe Change: Set property",
    })

func _apply_attach_script(request_body: Dictionary, scene_root: Node, scene_path: String) -> Dictionary:
    var operation: Dictionary = request_body["operations"][0]
    var node_path := String(operation.get("nodePath", ""))
    var script_path := String(operation.get("scriptPath", ""))
    if not _is_safe_node_path(node_path) or not _is_safe_script_path(script_path):
        return _failure("UNSAFE_OPERATION", "Only safe scene node paths and project-relative .gd scripts can be attached.")
    var node: Node = _scene_node(scene_root, node_path)
    if node == null:
        return _failure("VALIDATION_FAILED", "The requested scene node does not exist.")
    var script_resource: Variant = ResourceLoader.load(script_path)
    if script_resource == null or not script_resource is Script:
        return _failure("OPERATION_REJECTED", "The requested resource is not an attachable script.")

    var undo_redo := get_undo_redo()
    undo_redo.create_action("Godot Safe Change: Attach script")
    undo_redo.add_do_property(node, "script", script_resource)
    undo_redo.add_undo_property(node, "script", node.get_script())
    undo_redo.commit_action()
    EditorInterface.mark_scene_as_unsaved()
    last_applied_plan_id = String(request_body.get("planId", ""))
    last_applied_revision = _current_revision(scene_root, scene_path)
    last_applied_kind = "scene"
    last_script_path = ""
    last_script_original_content = ""
    last_script_applied_revision = ""
    return _success("report", {
        "schemaVersion": "0.2",
        "planId": last_applied_plan_id,
        "status": "applied",
        "revision": last_applied_revision,
        "operationCount": 1,
        "undoLabel": "Godot Safe Change: Attach script",
    })

func _apply_resource_change(request_body: Dictionary, scene_root: Node, scene_path: String) -> Dictionary:
    var operation: Dictionary = request_body["operations"][0]
    var resource_path := String(operation.get("resourcePath", ""))
    var from_path := String(operation.get("from", ""))
    var to_path := String(operation.get("to", ""))
    if not _is_safe_resource_path(resource_path):
        return _failure("UNSAFE_OPERATION", "Only project-relative scene/resource files can be modified.")
    if not (from_path.begins_with("res://") or from_path.begins_with("uid://")) or not (to_path.begins_with("res://") or to_path.begins_with("uid://")):
        return _failure("VALIDATION_FAILED", "Resource references must use res:// or uid:// identifiers.")

    var snapshot_result := _read_resource_snapshot(resource_path)
    if snapshot_result.is_empty() or not snapshot_result.get("ok", false):
        return snapshot_result
    var snapshot: Dictionary = snapshot_result["snapshot"]
    var expected_file_revision := String(request_body.get("expectedFileRevision", ""))
    if expected_file_revision == "" or expected_file_revision != String(snapshot["revision"]):
        return _failure("REVISION_CONFLICT", "The resource changed after preview.", 409)
    var content := String(snapshot["content"])
    if not content.contains(from_path):
        return _failure("VALIDATION_FAILED", "The resource reference was not found in the target file.")
    var next_content := content.replace(from_path, to_path)
    var plan_id := String(request_body.get("planId", ""))
    var write_error := _atomic_replace_script(resource_path, next_content, plan_id)
    if not write_error.is_empty():
        return write_error

    var file_revision := str(next_content.hash())
    last_applied_plan_id = plan_id
    last_applied_revision = _current_revision(scene_root, scene_path)
    last_applied_kind = "resource"
    last_resource_path = resource_path
    last_resource_original_content = content
    last_resource_applied_revision = file_revision
    last_script_path = ""
    last_script_original_content = ""
    last_script_applied_revision = ""
    return _success("report", {
        "schemaVersion": "0.2",
        "planId": plan_id,
        "status": "applied",
        "revision": last_applied_revision,
        "fileRevision": file_revision,
        "operationCount": 1,
        "undoLabel": "Godot Safe Change: Replace resource reference",
    })

func _apply_input_action_change(request_body: Dictionary, scene_root: Node, scene_path: String) -> Dictionary:
    var operation: Dictionary = request_body["operations"][0]
    var action_name := String(operation.get("actionName", ""))
    var physical_keycode := int(operation.get("physicalKeycode", 0))
    if not _is_safe_input_action_name(action_name) or physical_keycode < 1:
        return _failure("VALIDATION_FAILED", "The input action name or physical keycode is invalid.")

    var expected_file_revision := String(request_body.get("expectedFileRevision", ""))
    var actual_file_revision := _project_settings_revision()
    if expected_file_revision == "" or expected_file_revision != actual_file_revision:
        return _failure(
            "REVISION_CONFLICT",
            "The project settings changed after preview.",
            409,
            {"expectedFileRevision": expected_file_revision, "actualFileRevision": actual_file_revision},
        )

    var setting_key := "input/" + action_name
    var raw_setting: Variant = ProjectSettings.get_setting(setting_key, null)
    var original_setting: Variant = null
    var next_setting: Dictionary = {}
    var existing_events: Array = []
    if typeof(raw_setting) == TYPE_DICTIONARY:
        original_setting = raw_setting.duplicate(true)
        next_setting = raw_setting.duplicate(true)
        var configured_events: Variant = next_setting.get("events", [])
        if typeof(configured_events) == TYPE_ARRAY:
            existing_events = configured_events.duplicate(true)
    for event in existing_events:
        var event_snapshot := _input_event_snapshot(event)
        if not event_snapshot.is_empty() and int(event_snapshot.get("physicalKeycode", -1)) == physical_keycode:
            return _failure("VALIDATION_FAILED", "The physical key is already mapped to this input action.")

    var key_event := InputEventKey.new()
    key_event.physical_keycode = physical_keycode
    key_event.pressed = true
    var deadzone := float(operation.get("deadzone", next_setting.get("deadzone", 0.2)))
    next_setting["deadzone"] = deadzone
    existing_events.append(key_event)
    next_setting["events"] = existing_events
    ProjectSettings.set_setting(setting_key, next_setting)
    var save_error := ProjectSettings.save()
    if save_error != OK:
        if original_setting == null:
            ProjectSettings.set_setting(setting_key, null)
        else:
            ProjectSettings.set_setting(setting_key, original_setting)
        return _failure("OPERATION_REJECTED", "Godot could not save the input action change.", 409, {"error": save_error})
    InputMap.load_from_project_settings()

    var plan_id := String(request_body.get("planId", ""))
    var applied_revision := _current_revision(scene_root, scene_path)
    var applied_file_revision := _project_settings_revision()
    last_applied_plan_id = plan_id
    last_applied_revision = applied_revision
    last_applied_kind = "input"
    last_input_action_name = action_name
    last_input_action_original_setting = original_setting
    last_input_action_applied_revision = applied_file_revision
    last_script_path = ""
    last_script_original_content = ""
    last_script_applied_revision = ""
    last_resource_path = ""
    last_resource_original_content = ""
    last_resource_applied_revision = ""
    return _success("report", {
        "schemaVersion": "0.2",
        "planId": plan_id,
        "status": "applied",
        "revision": applied_revision,
        "fileRevision": applied_file_revision,
        "operationCount": 1,
        "undoLabel": "Godot Safe Change: Add input action key",
    })

func _read_resource_snapshot(resource_path: String) -> Dictionary:
    if not FileAccess.file_exists(resource_path):
        return _failure("PROJECT_NOT_FOUND", "The requested resource does not exist.", 404)
    var file := FileAccess.open(resource_path, FileAccess.READ)
    if file == null:
        return _failure("OPERATION_REJECTED", "Godot could not read the requested resource.", 409)
    var content := file.get_as_text()
    return {"ok": true, "snapshot": {"path": resource_path, "revision": str(content.hash()), "content": content}}

func _property_value(node: Node, property: String, value: Variant):
    if property == "visible" and node is CanvasItem and typeof(value) == TYPE_BOOL:
        return value
    if property == "text" and node is Label and typeof(value) == TYPE_STRING and String(value).length() <= 10000:
        return value
    if property == "position" and node is Node2D and _is_valid_point(value, -1000000.0, 1000000.0):
        var position: Dictionary = value
        return Vector2(float(position["x"]), float(position["y"]))
    if property == "size" and node is Control and _is_valid_point(value, 0.0, 1000000.0):
        var size: Dictionary = value
        return Vector2(float(size["x"]), float(size["y"]))
    if property == "color" and node is ColorRect and _is_valid_color(value):
        var color: Dictionary = value
        return Color(
            float(color["r"]),
            float(color["g"]),
            float(color["b"]),
            float(color["a"]),
        )
    return null

func _property_snapshot(node: Node, property: String):
    if property == "visible" and node is CanvasItem:
        return node.visible
    if property == "text" and node is Label:
        return node.text
    if property == "position" and node is Node2D:
        return {"x": node.position.x, "y": node.position.y}
    if property == "size" and node is Control:
        return {"x": node.size.x, "y": node.size.y}
    if property == "color" and node is ColorRect:
        return {"r": node.color.r, "g": node.color.g, "b": node.color.b, "a": node.color.a}
    return null

func _record_scene_action(scene_root: Node, scene_path: String, kind: String, label: String) -> void:
    var undo_manager := get_undo_redo()
    var history_id := undo_manager.get_object_history_id(scene_root)
    var scene_undo_redo: UndoRedo = undo_manager.get_history_undo_redo(history_id)
    last_applied_undo_history_id = history_id
    last_applied_undo_version = scene_undo_redo.get_version()
    last_applied_undo_action = scene_undo_redo.get_current_action()
    last_applied_undo_label = scene_undo_redo.get_current_action_name()
    if last_applied_undo_label == "":
        last_applied_undo_label = label
    last_applied_kind = kind
    last_applied_scene_path = scene_path

func _clear_scene_action_state() -> void:
    last_applied_undo_history_id = -1
    last_applied_undo_version = -1
    last_applied_undo_action = -1
    last_applied_undo_label = ""
    last_applied_scene_path = ""

func _clear_file_action_state() -> void:
    last_script_path = ""
    last_script_original_content = ""
    last_script_applied_revision = ""
    last_resource_path = ""
    last_resource_original_content = ""
    last_resource_applied_revision = ""
    last_input_action_name = ""
    last_input_action_original_setting = null
    last_input_action_applied_revision = ""

func _clear_applied_state() -> void:
    last_applied_plan_id = ""
    last_applied_revision = ""
    last_applied_kind = ""
    _clear_scene_action_state()
    _clear_file_action_state()

func _apply_script_change(request_body: Dictionary, scene_root: Node, scene_path: String) -> Dictionary:
    var operation: Dictionary = request_body["operations"][0]
    var script_path := String(operation.get("scriptPath", ""))
    if not _is_safe_script_path(script_path):
        return _failure("UNSAFE_OPERATION", "Only project-relative .gd scripts can be modified.")

    var snapshot_result := _read_script_snapshot(script_path)
    if not snapshot_result.is_empty() and not snapshot_result.get("ok", false):
        return snapshot_result
    var snapshot: Dictionary = snapshot_result["snapshot"]
    var expected_file_revision := String(request_body.get("expectedFileRevision", ""))
    if expected_file_revision == "" or expected_file_revision != String(snapshot["revision"]):
        return _failure(
            "REVISION_CONFLICT",
            "The script changed after the preview was created.",
            409,
            {"expectedFileRevision": expected_file_revision, "actualFileRevision": snapshot["revision"]},
        )

    var content := String(snapshot["content"])
    var lines := content.split("\n")
    var start_line := int(operation.get("startLine", 0))
    var end_line := int(operation.get("endLine", 0))
    if start_line < 1 or end_line < start_line or end_line > lines.size():
        return _failure("VALIDATION_FAILED", "The script replacement range is outside the current file.")

    var next_lines: Array = []
    for line_index in range(start_line - 1):
        next_lines.append(lines[line_index])
    for replacement_line in String(operation.get("replacement", "")).split("\n"):
        next_lines.append(replacement_line)
    for line_index in range(end_line, lines.size()):
        next_lines.append(lines[line_index])
    var next_content := "\n".join(next_lines)
    var plan_id := String(request_body.get("planId", ""))
    var write_error := _atomic_replace_script(script_path, next_content, plan_id)
    if not write_error.is_empty():
        return write_error

    var file_revision := str(next_content.hash())
    last_applied_plan_id = plan_id
    last_applied_revision = _current_revision(scene_root, scene_path)
    last_applied_kind = "script"
    last_script_path = script_path
    last_script_original_content = content
    last_script_applied_revision = file_revision
    return _success("report", {
        "schemaVersion": "0.2",
        "planId": plan_id,
        "status": "applied",
        "revision": last_applied_revision,
        "fileRevision": file_revision,
        "operationCount": 1,
        "undoLabel": "Godot Safe Change: Replace script range",
    })

func _read_script_snapshot(script_path: String) -> Dictionary:
    if not FileAccess.file_exists(script_path):
        return _failure("PROJECT_NOT_FOUND", "The requested script does not exist.", 404, {"scriptPath": script_path})
    var file := FileAccess.open(script_path, FileAccess.READ)
    if file == null:
        return _failure("OPERATION_REJECTED", "Godot could not read the requested script.", 409)
    var content := file.get_as_text()
    return {"ok": true, "snapshot": {"path": script_path, "revision": str(content.hash()), "content": content}}

func _atomic_replace_script(script_path: String, content: String, operation_id: String) -> Dictionary:
    var temporary_path := script_path + ".safe-change-" + operation_id + ".tmp"
    var temporary_file := FileAccess.open(temporary_path, FileAccess.WRITE)
    if temporary_file == null:
        return _failure("OPERATION_REJECTED", "Godot could not create the temporary script file.", 409)
    temporary_file.store_string(content)
    temporary_file.close()
    var rename_error := DirAccess.rename_absolute(
        ProjectSettings.globalize_path(temporary_path),
        ProjectSettings.globalize_path(script_path),
    )
    if rename_error != OK:
        DirAccess.remove_absolute(ProjectSettings.globalize_path(temporary_path))
        return _failure("OPERATION_REJECTED", "Godot could not atomically replace the script.", 409, {"error": rename_error})
    return {}

func _validate_rollback_request(request_body: Dictionary) -> Dictionary:
    if not _has_exact_keys(request_body, ["planId", "expectedRevision"], ["expectedFileRevision", "projectRoot"]):
        return _failure("VALIDATION_FAILED", "The rollback request contains unsupported or missing fields.")
    if not _is_safe_plan_id(String(request_body.get("planId", ""))):
        return _failure("VALIDATION_FAILED", "planId contains unsupported characters.")
    if typeof(request_body.get("expectedRevision")) != TYPE_STRING or String(request_body["expectedRevision"]) == "":
        return _failure("VALIDATION_FAILED", "expectedRevision is required.")
    if request_body.has("expectedFileRevision") and (typeof(request_body["expectedFileRevision"]) != TYPE_STRING or String(request_body["expectedFileRevision"]) == ""):
        return _failure("VALIDATION_FAILED", "expectedFileRevision must be a non-empty string when provided.")
    return {}

func _rollback_change(body: Variant) -> Dictionary:
    if typeof(body) != TYPE_DICTIONARY:
        return _failure("VALIDATION_FAILED", "The rollback request body must be a JSON object.")
    var request_body: Dictionary = body
    var request_error := _validate_rollback_request(request_body)
    if not request_error.is_empty():
        return request_error
    var scene_root := EditorInterface.get_edited_scene_root()
    if scene_root == null:
        return _failure("VALIDATION_FAILED", "A current scene is required before rollback.")

    var plan_id := String(request_body.get("planId", ""))
    var expected_revision := String(request_body.get("expectedRevision", ""))
    var scene_path := String(scene_root.scene_file_path)
    var actual_revision := _current_revision(scene_root, scene_path)
    if plan_id == "" or plan_id != last_applied_plan_id:
        return _failure("PLAN_NOT_APPLIED", "The requested plan is not the latest applied plan.")
    if expected_revision == "" or expected_revision != last_applied_revision or actual_revision != last_applied_revision:
        return _failure(
            "REVISION_CONFLICT",
            "The editor changed after the plan was applied; refusing to undo another change.",
            409,
            {"expectedRevision": last_applied_revision, "actualRevision": actual_revision},
        )

    if last_applied_kind == "script":
        return _rollback_script_change(request_body, scene_root, scene_path, plan_id)
    if last_applied_kind == "resource":
        return _rollback_resource_change(request_body, scene_root, scene_path, plan_id)
    if last_applied_kind == "input":
        return _rollback_input_action_change(request_body, scene_root, scene_path, plan_id)

    if last_applied_scene_path != scene_path or last_applied_undo_history_id < 0 or last_applied_undo_version < 0:
        return _failure("REVISION_CONFLICT", "The applied scene history is no longer available for a safe rollback.", 409)

    var undo_manager := get_undo_redo()
    var history_id := undo_manager.get_object_history_id(scene_root)
    var scene_undo_redo: UndoRedo = undo_manager.get_history_undo_redo(history_id)
    var current_action := scene_undo_redo.get_current_action()
    var current_label := scene_undo_redo.get_current_action_name()
    if history_id != last_applied_undo_history_id \
        or scene_undo_redo.get_version() != last_applied_undo_version \
        or current_action != last_applied_undo_action \
        or current_label != last_applied_undo_label:
        return _failure(
            "REVISION_CONFLICT",
            "The editor UndoRedo history changed after the plan was applied; refusing to undo another action.",
            409,
            {
                "expectedHistoryId": last_applied_undo_history_id,
                "actualHistoryId": history_id,
                "expectedVersion": last_applied_undo_version,
                "actualVersion": scene_undo_redo.get_version(),
                "expectedAction": last_applied_undo_action,
                "actualAction": current_action,
                "expectedLabel": last_applied_undo_label,
                "actualLabel": current_label,
            },
        )
    if not scene_undo_redo.undo():
        return _failure("ROLLBACK_FAILED", "Godot could not undo the applied scene change.", 409)

    var rollback_revision := _current_revision(scene_root, scene_path)
    var undo_label := last_applied_undo_label
    _clear_applied_state()
    return _success("report", {
        "schemaVersion": "0.2",
        "planId": plan_id,
        "status": "rolled_back",
        "revision": rollback_revision,
        "undoLabel": undo_label,
    })

func _rollback_script_change(request_body: Dictionary, scene_root: Node, scene_path: String, plan_id: String) -> Dictionary:
    var expected_file_revision := String(request_body.get("expectedFileRevision", ""))
    if expected_file_revision == "" or expected_file_revision != last_script_applied_revision:
        return _failure("REVISION_CONFLICT", "The script revision does not match the applied plan.", 409)

    var snapshot_result := _read_script_snapshot(last_script_path)
    if snapshot_result.is_empty() or not snapshot_result.get("ok", false):
        return snapshot_result
    var current_snapshot: Dictionary = snapshot_result["snapshot"]
    if String(current_snapshot["revision"]) != last_script_applied_revision:
        return _failure("REVISION_CONFLICT", "The script changed after apply; refusing to overwrite it.", 409)

    var write_error := _atomic_replace_script(last_script_path, last_script_original_content, plan_id + "-rollback")
    if not write_error.is_empty():
        return write_error

    var rollback_revision := _current_revision(scene_root, scene_path)
    var restored_file_revision := str(last_script_original_content.hash())
    last_applied_plan_id = ""
    last_applied_revision = ""
    last_applied_kind = ""
    last_script_path = ""
    last_script_original_content = ""
    last_script_applied_revision = ""
    return _success("report", {
        "schemaVersion": "0.2",
        "planId": plan_id,
        "status": "rolled_back",
        "revision": rollback_revision,
        "fileRevision": restored_file_revision,
        "undoLabel": "Godot Safe Change: Restore script content",
    })

func _rollback_resource_change(request_body: Dictionary, scene_root: Node, scene_path: String, plan_id: String) -> Dictionary:
    var expected_file_revision := String(request_body.get("expectedFileRevision", ""))
    if expected_file_revision == "" or expected_file_revision != last_resource_applied_revision:
        return _failure("REVISION_CONFLICT", "The resource revision does not match the applied plan.", 409)

    var snapshot_result := _read_resource_snapshot(last_resource_path)
    if snapshot_result.is_empty() or not snapshot_result.get("ok", false):
        return snapshot_result
    var current_snapshot: Dictionary = snapshot_result["snapshot"]
    if String(current_snapshot["revision"]) != last_resource_applied_revision:
        return _failure("REVISION_CONFLICT", "The resource changed after apply; refusing to overwrite it.", 409)

    var write_error := _atomic_replace_script(last_resource_path, last_resource_original_content, plan_id + "-rollback")
    if not write_error.is_empty():
        return write_error

    var rollback_revision := _current_revision(scene_root, scene_path)
    var restored_file_revision := str(last_resource_original_content.hash())
    last_applied_plan_id = ""
    last_applied_revision = ""
    last_applied_kind = ""
    last_resource_path = ""
    last_resource_original_content = ""
    last_resource_applied_revision = ""
    return _success("report", {
        "schemaVersion": "0.2",
        "planId": plan_id,
        "status": "rolled_back",
        "revision": rollback_revision,
        "fileRevision": restored_file_revision,
        "undoLabel": "Godot Safe Change: Restore resource content",
    })

func _rollback_input_action_change(request_body: Dictionary, scene_root: Node, scene_path: String, plan_id: String) -> Dictionary:
    var expected_file_revision := String(request_body.get("expectedFileRevision", ""))
    var actual_file_revision := _project_settings_revision()
    if expected_file_revision == "" or expected_file_revision != last_input_action_applied_revision or actual_file_revision != last_input_action_applied_revision:
        return _failure(
            "REVISION_CONFLICT",
            "The project settings changed after input action apply; refusing to overwrite it.",
            409,
            {"expectedFileRevision": last_input_action_applied_revision, "actualFileRevision": actual_file_revision},
        )

    var setting_key := "input/" + last_input_action_name
    if last_input_action_original_setting == null:
        ProjectSettings.set_setting(setting_key, null)
    else:
        ProjectSettings.set_setting(setting_key, last_input_action_original_setting)
    var save_error := ProjectSettings.save()
    if save_error != OK:
        return _failure("OPERATION_REJECTED", "Godot could not roll back the input action change.", 409, {"error": save_error})
    InputMap.load_from_project_settings()

    var rollback_revision := _current_revision(scene_root, scene_path)
    var restored_file_revision := _project_settings_revision()
    last_applied_plan_id = ""
    last_applied_revision = ""
    last_applied_kind = ""
    last_input_action_name = ""
    last_input_action_original_setting = null
    last_input_action_applied_revision = ""
    return _success("report", {
        "schemaVersion": "0.2",
        "planId": plan_id,
        "status": "rolled_back",
        "revision": rollback_revision,
        "fileRevision": restored_file_revision,
        "undoLabel": "Godot Safe Change: Restore input action",
    })

func _apply_create_node(scene_root: Node, operation: Dictionary) -> Dictionary:
    var parent_path := String(operation.get("parentPath", ""))
    var node_name := String(operation.get("nodeName", ""))
    var node_type := String(operation.get("nodeType", ""))
    if parent_path == "" or parent_path.begins_with("/"):
        return _failure("VALIDATION_FAILED", "parentPath must be a relative NodePath.")
    if not ALLOWED_NODE_TYPES.has(node_type):
        return _failure("UNSAFE_OPERATION", "The requested node type is not allowlisted.")

    var name_regex := RegEx.new()
    name_regex.compile("^[A-Za-z_][A-Za-z0-9_]*$")
    if name_regex.search(node_name) == null:
        return _failure("VALIDATION_FAILED", "nodeName contains unsupported characters.")

    var parent: Node = scene_root
    if parent_path != ".":
        parent = scene_root.get_node_or_null(NodePath(parent_path))
    if parent == null:
        return _failure("VALIDATION_FAILED", "The requested parent node does not exist.")
    if parent != scene_root and not scene_root.is_ancestor_of(parent):
        return _failure("UNSAFE_OPERATION", "The requested parent is outside the current scene.")
    if parent.get_node_or_null(NodePath(node_name)) != null:
        return _failure("VALIDATION_FAILED", "A node with that name already exists under the parent.")

    var node_variant: Variant = ClassDB.instantiate(node_type)
    if node_variant == null or not node_variant is Node:
        return _failure("OPERATION_REJECTED", "Godot could not instantiate the requested node type.")
    var new_node: Node = node_variant as Node
    new_node.name = node_name

    var undo_redo := get_undo_redo()
    undo_redo.create_action("Godot Safe Change: Add node")
    undo_redo.add_do_method(parent, "add_child", new_node)
    undo_redo.add_do_method(self, "_set_node_owner", new_node, scene_root)
    undo_redo.add_undo_method(self, "_undo_remove_node", parent, new_node)
    undo_redo.add_do_reference(new_node)
    undo_redo.commit_action()
    EditorInterface.mark_scene_as_unsaved()
    return {}

func _set_node_owner(node: Node, scene_root: Node) -> void:
    if not is_instance_valid(node) or not is_instance_valid(scene_root):
        return
    node.owner = scene_root

func _undo_remove_node(parent: Node, node: Node) -> void:
    if not is_instance_valid(parent) or not is_instance_valid(node):
        return
    if node.get_parent() == parent:
        parent.remove_child(node)

func _run_current_scene() -> Dictionary:
    var scene_root := EditorInterface.get_edited_scene_root()
    if scene_root == null or String(scene_root.scene_file_path) == "":
        return _failure("VALIDATION_FAILED", "A saved current scene is required before running.")
    if EditorInterface.is_playing_scene():
        return _success("diagnostics", _run_diagnostics_snapshot())

    diagnostics = {
        "output": ["current scene requested: " + String(scene_root.scene_file_path)],
        "warnings": [],
        "errors": [],
    }
    run_id = "run-" + str(Time.get_ticks_msec())
    run_scene_path = String(scene_root.scene_file_path)
    run_started_at = Time.get_ticks_msec()
    run_status = "starting"
    EditorInterface.play_current_scene()
    return _success("diagnostics", _run_diagnostics_snapshot())

func _run_scene(_scene: String, args: PackedStringArray) -> PackedStringArray:
    var adjusted_args := args.duplicate()
    if not adjusted_args.has("--headless"):
        adjusted_args.append("--headless")
    if not adjusted_args.has("--audio-driver"):
        adjusted_args.append("--audio-driver")
        adjusted_args.append("Dummy")
    return adjusted_args

func _run_specific_scene(body: Variant) -> Dictionary:
    var scene_path := String(body.get("scenePath", ""))
    if not _is_safe_scene_path(scene_path):
        return _failure("VALIDATION_FAILED", "Only a res:// .tscn scene path without traversal is allowed.")
    if EditorInterface.is_playing_scene():
        return _failure("RUN_FAILED", "A scene is already playing; stop it before starting another run.")
    if not ResourceLoader.exists(scene_path):
        return _failure("VALIDATION_FAILED", "The scene path does not exist in the project.", 404)
    diagnostics = {
        "output": ["custom scene requested: " + scene_path],
        "warnings": [],
        "errors": [],
    }
    run_id = "run-" + str(Time.get_ticks_msec())
    run_scene_path = scene_path
    run_started_at = Time.get_ticks_msec()
    run_status = "starting"
    EditorInterface.play_custom_scene(scene_path)
    return _success("diagnostics", _run_diagnostics_snapshot())

func _is_safe_scene_path(scene_path: String) -> bool:
    return scene_path.begins_with("res://") \
        and scene_path.ends_with(".tscn") \
        and not scene_path.contains("..")

func _run_status_response(body: Variant) -> Dictionary:
    var requested_run_id := String(body.get("runId", ""))
    if requested_run_id != "" and requested_run_id != run_id:
        return _failure("RUN_FAILED", "The requested run ID is not active.", 404)
    return _success("diagnostics", _run_diagnostics_snapshot())

func _update_run_state() -> void:
    if run_status == "starting" and EditorInterface.is_playing_scene():
        run_status = "running"
        diagnostics["output"].append("scene started")
    elif run_status == "running" and not EditorInterface.is_playing_scene():
        run_status = "stopped"
        diagnostics["output"].append("scene stopped")
    elif run_status == "starting" and Time.get_ticks_msec() - run_started_at > 30000:
        run_status = "failed"
        diagnostics["errors"].append({"message": "The current scene did not start within 30 seconds."})

func _run_diagnostics_snapshot() -> Dictionary:
    return {
        "schemaVersion": "0.2",
        "runId": run_id,
        "status": run_status,
        "scenePath": run_scene_path if run_scene_path != "" else null,
        "output": diagnostics["output"].duplicate(),
        "warnings": diagnostics["warnings"].duplicate(true),
        "errors": diagnostics["errors"].duplicate(true),
    }

func _current_revision(scene_root: Node, scene_path: String) -> String:
    if scene_root == null:
        return ""
    return str((scene_path + "|" + _scene_fingerprint(scene_root)).hash())

func _scene_fingerprint(node: Node) -> String:
    var fingerprint := String(node.name) + ":" + String(node.get_class())
    for child in node.get_children():
        fingerprint += "[" + _scene_fingerprint(child) + "]"
    return fingerprint

func _success(key: String, value: Variant) -> Dictionary:
    var body := {"ok": true}
    body[key] = value
    return {"status": 200, "body": body}

func _failure(code: String, message: String, status: int = 400, details: Variant = {}) -> Dictionary:
    return {
        "status": status,
        "body": {
            "ok": false,
            "error": {
                "code": code,
                "message": message,
                "details": details,
            },
        },
    }
