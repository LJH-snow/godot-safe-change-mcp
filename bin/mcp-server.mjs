#!/usr/bin/env node
import http from "node:http";
import { toNodeHandler } from "mcp-use/node";
import server from "../.mcp-use/build/index.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

const httpServer = http.createServer(toNodeHandler(server));
httpServer.listen(port, host, () => {
  console.log(`godot-safe-change-mcp listening on http://${host}:${port}/mcp`);
  console.log(
    "Expects the Godot Safe Change Bridge plugin on " +
      (process.env.GODOT_BRIDGE_URL ?? "http://127.0.0.1:8765"),
  );
});
