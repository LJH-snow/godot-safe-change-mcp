import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  SearchProjectKind,
  SearchResult,
} from "../domain/contracts.js";
import { DomainError, ERROR_CODES } from "../domain/errors.js";

const DEFAULT_LIMIT = 50;
const MAX_SCENE_BYTES = 5 * 1024 * 1024;

const KIND_EXTENSIONS: Partial<Record<SearchProjectKind, ReadonlySet<string>>> = {
  scene: new Set([".tscn", ".scn"]),
  script: new Set([".gd", ".cs"]),
  resource: new Set([".tres", ".res", ".gdshader"]),
};

const NODE_LINE_PATTERN = /\[node\s+name="([^"]+)"(?:\s+type="([^"]+)")?(?:\s+parent="([^"]*)")?\s*\]/;
const CONNECTION_LINE_PATTERN = /\[connection\s+([^\]]+)\]/;
const ATTRIBUTE_PATTERN = /([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"/g;
const SCRIPT_SIGNAL_PATTERN = /^\s*signal\s+([A-Za-z_][A-Za-z0-9_]*)/;

interface IndexedFile {
  relativePath: string;
  absolutePath: string;
  extension: string;
  size: number;
}

interface SceneConnectionEntry {
  signal: string;
  from: string;
  to: string;
  method: string;
}

export interface LocalSearchOutcome {
  results: SearchResult[];
  truncated: boolean;
}

/**
 * Local, read-only index of the project on disk. Used as the offline fallback
 * for editor-backed search and as the only source for signal and input kinds,
 * which the editor bridge does not serve.
 */
export async function searchProjectIndex(
  projectRoot: string,
  input: { query: string; kinds?: SearchProjectKind[]; maxResults?: number },
): Promise<LocalSearchOutcome> {
  const query = input.query.trim().toLowerCase();
  if (query.length === 0) {
    throw new DomainError(ERROR_CODES.VALIDATION_FAILED, "The search query must not be empty.");
  }
  const kinds = input.kinds ?? ["scene", "node", "script", "resource", "signal", "input"];
  const maxResults = input.maxResults ?? DEFAULT_LIMIT;

  const results: SearchResult[] = [];
  const isFull = () => results.length >= maxResults;

  if (kinds.includes("input")) {
    for (const action of await readInputActions(projectRoot)) {
      if (isFull()) {
        break;
      }
      if (action.toLowerCase().includes(query)) {
        results.push({
          kind: "input",
          path: "res://project.godot",
          name: action,
          nodePath: null,
          nodeType: null,
          matches: ["name"],
        });
      }
    }
  }

  if (!isFull() && kinds.some((kind) => kind !== "input")) {
    const files = await walkProjectRoot(projectRoot);
    for (const file of files) {
      if (isFull()) {
        break;
      }
      const resPath = "res://" + file.relativePath;
      const fileKinds = fileKindsFor(file.extension).filter((kind) => kinds.includes(kind));
      if (fileKinds.length > 0 && file.relativePath.toLowerCase().includes(query)) {
        results.push({
          kind: fileKinds[0] as SearchProjectKind,
          path: resPath,
          name: path.posix.basename(file.relativePath),
          nodePath: null,
          nodeType: null,
          matches: ["path"],
        });
      }
      if (file.extension !== ".tscn" || file.size > MAX_SCENE_BYTES) {
        continue;
      }
      if (kinds.includes("node")) {
        for (const node of await readSceneNodes(file.absolutePath)) {
          if (isFull()) {
            break;
          }
          const matches = fieldMatches(query, [
            ["name", node.name],
            ["type", node.type],
          ]);
          if (matches.length > 0) {
            results.push({
              kind: "node",
              path: resPath,
              name: node.name,
              nodePath: node.parent,
              nodeType: node.type,
              matches,
            });
          }
        }
      }
      if (kinds.includes("signal")) {
        for (const connection of await readSceneConnections(file.absolutePath)) {
          if (isFull()) {
            break;
          }
          if (connection.signal.toLowerCase().includes(query)) {
            results.push({
              kind: "signal",
              path: resPath,
              name: connection.signal,
              nodePath: connection.from,
              nodeType: null,
              matches: ["name"],
            });
          }
        }
      }
    }
    if (!isFull() && kinds.includes("signal")) {
      for (const file of files) {
        if (isFull()) {
          break;
        }
        if (file.extension !== ".gd") {
          continue;
        }
        for (const signalName of await readScriptSignals(file.absolutePath)) {
          if (isFull()) {
            break;
          }
          if (signalName.toLowerCase().includes(query)) {
            results.push({
              kind: "signal",
              path: "res://" + file.relativePath,
              name: signalName,
              nodePath: null,
              nodeType: null,
              matches: ["name"],
            });
          }
        }
      }
    }
  }

  return { results, truncated: isFull() };
}

function fileKindsFor(extension: string): SearchProjectKind[] {
  const kinds: SearchProjectKind[] = [];
  for (const [kind, extensions] of Object.entries(KIND_EXTENSIONS) as [
    SearchProjectKind,
    ReadonlySet<string>,
  ][]) {
    if (extensions.has(extension)) {
      kinds.push(kind);
    }
  }
  return kinds;
}

function fieldMatches(
  query: string,
  fields: Array<[name: "name" | "type", value: string]>,
): Array<"name" | "type"> {
  const matches: Array<"name" | "type"> = [];
  for (const [name, value] of fields) {
    if (value.toLowerCase().includes(query)) {
      matches.push(name);
    }
  }
  return matches;
}

async function walkProjectRoot(projectRoot: string): Promise<IndexedFile[]> {
  const files: IndexedFile[] = [];
  const queue: string[] = [projectRoot];
  while (queue.length > 0) {
    const directory = queue.pop() as string;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      // Symlinks are skipped so the walk can never leave the project root.
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) {
          continue;
        }
        queue.push(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      // Defense in depth: every indexed file must resolve inside the project root.
      if (!isInsideRoot(projectRoot, absolutePath)) {
        continue;
      }
      const fileStat = await stat(absolutePath);
      files.push({
        relativePath: path.relative(projectRoot, absolutePath).split(path.sep).join("/"),
        absolutePath,
        extension: path.extname(entry.name).toLowerCase(),
        size: fileStat.size,
      });
    }
  }
  return files;
}

function isInsideRoot(projectRoot: string, absolutePath: string): boolean {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedPath = path.resolve(absolutePath);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + path.sep);
}

function parseAttributes(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of text.matchAll(ATTRIBUTE_PATTERN)) {
    attributes[match[1] as string] = match[2] as string;
  }
  return attributes;
}

interface SceneNodeEntry {
  name: string;
  type: string;
  parent: string;
}

async function readSceneNodes(absolutePath: string): Promise<SceneNodeEntry[]> {
  const text = await readFile(absolutePath, "utf8");
  const nodes: SceneNodeEntry[] = [];
  for (const line of text.split("\n")) {
    const match = line.trim().match(NODE_LINE_PATTERN);
    if (match === null) {
      continue;
    }
    nodes.push({
      name: match[1] ?? "",
      type: match[2] ?? "",
      parent: match[3] ?? ".",
    });
  }
  return nodes;
}

async function readSceneConnections(absolutePath: string): Promise<SceneConnectionEntry[]> {
  const text = await readFile(absolutePath, "utf8");
  const connections: SceneConnectionEntry[] = [];
  for (const line of text.split("\n")) {
    const match = line.trim().match(CONNECTION_LINE_PATTERN);
    if (match === null) {
      continue;
    }
    const attributes = parseAttributes(match[1] ?? "");
    if (attributes.signal === undefined || attributes.to === undefined) {
      continue;
    }
    connections.push({
      signal: attributes.signal,
      from: attributes.from ?? ".",
      to: attributes.to,
      method: attributes.method ?? "",
    });
  }
  return connections;
}

async function readScriptSignals(absolutePath: string): Promise<string[]> {
  const text = await readFile(absolutePath, "utf8");
  const signals: string[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(SCRIPT_SIGNAL_PATTERN);
    if (match !== null) {
      signals.push(match[1] ?? "");
    }
  }
  return signals;
}

async function readInputActions(projectRoot: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path.join(projectRoot, "project.godot"), "utf8");
  } catch {
    return [];
  }

  const actions: string[] = [];
  let insideInputSection = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      insideInputSection = trimmed === "[input]";
      continue;
    }
    if (!insideInputSection) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    actions.push(trimmed.slice(0, separator).trim().replace(/^"|"$/g, ""));
  }
  return actions;
}
