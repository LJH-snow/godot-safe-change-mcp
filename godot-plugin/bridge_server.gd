extends RefCounted
class_name SafeChangeBridgeServer

var plugin: Object
var port: int
var tcp_server := TCPServer.new()
var clients: Array[StreamPeerTCP] = []
var buffers: Dictionary = {}

func _init(next_plugin: Object, next_port: int) -> void:
    plugin = next_plugin
    port = next_port

func start() -> int:
    return tcp_server.listen(port, "127.0.0.1")

func stop() -> void:
    for peer in clients:
        peer.disconnect_from_host()
    clients.clear()
    buffers.clear()
    tcp_server.stop()

func poll() -> void:
    while tcp_server.is_connection_available():
        var peer := tcp_server.take_connection()
        if peer == null:
            break
        clients.append(peer)
        buffers[peer.get_instance_id()] = PackedByteArray()

    var index := clients.size() - 1
    while index >= 0:
        var peer: StreamPeerTCP = clients[index]
        peer.poll()
        if peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
            _remove_client(index, peer)
            index -= 1
            continue

        var available_bytes := peer.get_available_bytes()
        if available_bytes <= 0:
            index -= 1
            continue

        var packet: Array = peer.get_data(available_bytes)
        if packet.size() < 2 or packet[0] != OK:
            _send_json(peer, 400, {"ok": false, "error": {"code": "BRIDGE_PROTOCOL_ERROR", "message": "Could not read the HTTP request."}})
            _remove_client(index, peer)
            index -= 1
            continue

        var key := peer.get_instance_id()
        var buffer: PackedByteArray = buffers.get(key, PackedByteArray())
        buffer.append_array(packet[1] as PackedByteArray)
        buffers[key] = buffer
        var request := _parse_request(buffer)
        if request.is_empty():
            index -= 1
            continue

        var result: Dictionary = plugin.handle_bridge_request(
            String(request.get("method", "")),
            String(request.get("path", "")),
            request.get("body", {}),
        )
        _send_json(peer, int(result.get("status", 500)), result.get("body", {"ok": false}))
        _remove_client(index, peer)
        index -= 1

func _parse_request(raw_request: PackedByteArray) -> Dictionary:
    var header_end := _find_header_end(raw_request)
    if header_end < 0:
        return {}

    var header_text := raw_request.slice(0, header_end).get_string_from_ascii()
    var body_bytes := raw_request.slice(header_end + 4)
    var content_length := 0
    var header_lines := header_text.split("\r\n")
    if header_lines.is_empty():
        return {}

    for header_line in header_lines.slice(1):
        var separator := String(header_line).find(":")
        if separator < 0:
            continue
        var header_name := String(header_line).substr(0, separator).strip_edges().to_lower()
        if header_name == "content-length":
            content_length = int(String(header_line).substr(separator + 1).strip_edges())

    if body_bytes.size() < content_length:
        return {}

    var request_line := String(header_lines[0]).split(" ")
    if request_line.size() < 2:
        return {}

    var body: Variant = {}
    if content_length > 0:
        body = JSON.parse_string(body_bytes.slice(0, content_length).get_string_from_utf8())
        if body == null:
            return {}

    return {
        "method": String(request_line[0]),
        "path": String(request_line[1]).split("?")[0],
        "body": body,
    }

func _find_header_end(raw_request: PackedByteArray) -> int:
    if raw_request.size() < 4:
        return -1
    for index in range(raw_request.size() - 3):
        if raw_request[index] == 13 and raw_request[index + 1] == 10 and raw_request[index + 2] == 13 and raw_request[index + 3] == 10:
            return index
    return -1

func _send_json(peer: StreamPeerTCP, status: int, body: Variant) -> void:
    var response_body := JSON.stringify(body)
    var status_text := "OK"
    if status == 400:
        status_text = "Bad Request"
    elif status == 405:
        status_text = "Method Not Allowed"
    elif status == 403:
        status_text = "Forbidden"
    elif status == 404:
        status_text = "Not Found"
    elif status == 409:
        status_text = "Conflict"
    elif status == 422:
        status_text = "Unprocessable Entity"
    elif status >= 500:
        status_text = "Internal Server Error"

    var body_bytes := response_body.to_utf8_buffer()
    var response := "HTTP/1.1 " + str(status) + " " + status_text + "\r\n"
    response += "Content-Type: application/json\r\n"
    response += "Content-Length: " + str(body_bytes.size()) + "\r\n"
    response += "Connection: close\r\n\r\n"
    response += response_body
    peer.put_data(response.to_utf8_buffer())

func _remove_client(index: int, peer: StreamPeerTCP) -> void:
    buffers.erase(peer.get_instance_id())
    peer.disconnect_from_host()
    clients.remove_at(index)
