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
const SCRIPT_RESOURCE_REFERENCE_PATTERN = /\b(?:preload|load)\s*\(\s*["']((?:res|uid):\/\/[^"']+)["']\s*\)/g;
const EXT_RESOURCE_LINE_PATTERN = /\[ext_resource\s+([^\]]+)\]/;
const FILE_UID_PATTERN = /uid="(uid:\/\/[^"]+)"/;
const SCRIPT_UID_COMMENT_PATTERN = /^\s*#\s*uid\s+(uid:\/\/\S+)/;

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

interface ExtResourceEntry {
  type: string;
  path: string | null;
  uid: string | null;
}

interface ParsedReferenceFile {
  size: number;
  fileUid: string | null;
  extResources: ExtResourceEntry[];
  scriptResources: ExtResourceEntry[];
}

export interface LocalSearchOutcome {
  results: SearchResult[];
  truncated: boolean;
}

export interface ReferenceOutcome {
  references: Array<{
    path: string;
    kind: "scene" | "resource" | "script";
    targetPath: string | null;
    targetType: string | null;
    matchedBy: "path" | "uid";
  }>;
  truncated: boolean;
}

interface CacheEntry {
  files: IndexedFile[];
  createdAt: number;
}

/**
 * Process-wide TTL cache for the local project file walk. Repeated searches
 * and overview requests within the TTL reuse the same walk result instead of
 * rescanning the project directory.
 */
export class ProjectIndexCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs = 30_000,
    private readonly maxEntries = 8,
  ) {}

  async getOrScan(projectRoot: string): Promise<IndexedFile[]> {
    const hit = this.entries.get(projectRoot);
    if (hit !== undefined && Date.now() - hit.createdAt < this.ttlMs) {
      return hit.files;
    }
    const files = await walkProjectRoot(projectRoot);
    if (this.entries.size >= this.maxEntries) {
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        if (entry.createdAt < oldestAt) {
          oldestAt = entry.createdAt;
          oldestKey = key;
        }
      }
      if (oldestKey !== null) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(projectRoot, { files, createdAt: Date.now() });
    return files;
  }

  invalidate(projectRoot?: string): void {
    if (projectRoot === undefined) {
      this.entries.clear();
      return;
    }
    this.entries.delete(projectRoot);
  }
}

/**
 * Shared between the overview and search services so both benefit from the
 * same cached walk of a project directory.
 */
export const sharedProjectIndexCache = new ProjectIndexCache();

export interface ProjectFileCounts {
  scenes: number;
  scripts: number;
  resources: number;
  settings: number;
}

export async function countProjectFiles(
  projectRoot: string,
  cache: ProjectIndexCache = sharedProjectIndexCache,
): Promise<ProjectFileCounts> {
  const files = await cache.getOrScan(projectRoot);
  const counts: ProjectFileCounts = { scenes: 0, scripts: 0, resources: 0, settings: 0 };
  for (const file of files) {
    if (file.extension === ".tscn" || file.extension === ".scn") {
      counts.scenes += 1;
    } else if (file.extension === ".gd" || file.extension === ".cs") {
      counts.scripts += 1;
    } else if (KIND_EXTENSIONS.resource?.has(file.extension)) {
      counts.resources += 1;
    }
    if (file.relativePath === "project.godot") {
      counts.settings = 1;
    }
  }
  return counts;
}

/**
 * Parsed ext_resource entries cached per file, invalidated when the file size
 * changes. Bounded like the walk cache so long-lived servers cannot grow it
 * without limit.
 */
class ReferenceParseCache {
  private readonly entries = new Map<string, ParsedReferenceFile>();

  constructor(private readonly maxEntries = 512) {}

  get(absolutePath: string, size: number): ParsedReferenceFile | undefined {
    const hit = this.entries.get(absolutePath);
    return hit !== undefined && hit.size === size ? hit : undefined;
  }

  set(absolutePath: string, parsed: ParsedReferenceFile): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(absolutePath)) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(absolutePath, parsed);
  }
}

const sharedReferenceParseCache = new ReferenceParseCache();

async function parseReferenceFile(file: IndexedFile): Promise<ParsedReferenceFile> {
  const cached = sharedReferenceParseCache.get(file.absolutePath, file.size);
  if (cached !== undefined) {
    return cached;
  }
  const text = await readFile(file.absolutePath, "utf8");
  const uidMatch = text.match(FILE_UID_PATTERN) ?? text.match(SCRIPT_UID_COMMENT_PATTERN);
  const extResources: ExtResourceEntry[] = [];
  const scriptResources: ExtResourceEntry[] = [];
  for (const line of text.split("\n")) {
    const match = line.trim().match(EXT_RESOURCE_LINE_PATTERN);
    if (match !== null) {
      const attributes = parseAttributes(match[1] ?? "");
      if (attributes.path !== undefined || attributes.uid !== undefined) {
        extResources.push({
          type: attributes.type ?? "",
          path: attributes.path ?? null,
          uid: attributes.uid ?? null,
        });
      }
    }
    if (file.extension !== ".gd" || line.trimStart().startsWith("#")) {
      continue;
    }
    for (const referenceMatch of line.matchAll(SCRIPT_RESOURCE_REFERENCE_PATTERN)) {
      const target = referenceMatch[1] ?? "";
      if (target.startsWith("res://")) {
        scriptResources.push({ type: "", path: target, uid: null });
      } else if (target.startsWith("uid://")) {
        scriptResources.push({ type: "", path: null, uid: target });
      }
    }
  }
  const parsed = {
    size: file.size,
    fileUid: uidMatch?.[1] ?? null,
    extResources,
    scriptResources,
  };
  sharedReferenceParseCache.set(file.absolutePath, parsed);
  return parsed;
}

/**
 * Reverse lookup: which scene, resource and script files reference the given target.
 * The target is matched case-insensitively as a substring against each
 * resource path, or through a uid:// identifier resolved from the target file.
 */
export async function findProjectReferences(
  projectRoot: string,
  target: string,
  options: { limit?: number; cache?: ProjectIndexCache } = {},
): Promise<ReferenceOutcome> {
  const normalizedTarget = target.trim().toLowerCase();
  const limit = options.limit ?? 50;
  const cache = options.cache ?? sharedProjectIndexCache;
  const files = await cache.getOrScan(projectRoot);

  // Resolve the uids of files whose path matches the target, so references
  // written uid-only (Godot 4.4+ scenes may omit the path) still match.
  const targetIsUid = normalizedTarget.startsWith("uid://");
  const targetUids = new Set<string>();
  const targetPaths = new Set<string>();
  const candidates: IndexedFile[] = [];
  for (const file of files) {
    if (
      file.extension === ".tscn" ||
      file.extension === ".scn" ||
      KIND_EXTENSIONS.resource?.has(file.extension) ||
      file.extension === ".gd"
    ) {
      candidates.push(file);
    }
    const resourcePath = "res://" + file.relativePath;
    if (targetIsUid) {
      const parsed = candidates.includes(file) ? await parseReferenceFile(file) : null;
      if (parsed?.fileUid?.toLowerCase() === normalizedTarget) {
        targetPaths.add(resourcePath.toLowerCase());
      }
      continue;
    }
    if (!resourcePath.toLowerCase().includes(normalizedTarget)) {
      continue;
    }
    const parsed = await parseReferenceFile(file);
    if (parsed.fileUid !== null) {
      targetUids.add(parsed.fileUid);
    }
  }

  const references: ReferenceOutcome["references"] = [];
  let truncated = false;
  for (const file of candidates) {
    if (references.length >= limit) {
      truncated = true;
      break;
    }
    const parsed = await parseReferenceFile(file);
    for (const extResource of [...parsed.extResources, ...parsed.scriptResources]) {
      if (references.length >= limit) {
        truncated = true;
        break;
      }
      const referencedPath = extResource.path?.toLowerCase() ?? null;
      const matchesPath = referencedPath !== null && referencedPath.includes(normalizedTarget);
      const matchesResolvedPath = referencedPath !== null && targetPaths.has(referencedPath);
      const matchesUid =
        (targetIsUid && extResource.uid?.toLowerCase() === normalizedTarget) ||
        (extResource.uid !== null && targetUids.has(extResource.uid));
      if (!matchesPath && !matchesResolvedPath && !matchesUid) {
        continue;
      }
      references.push({
        path: "res://" + file.relativePath,
        kind:
          file.extension === ".tscn" || file.extension === ".scn"
            ? "scene"
            : file.extension === ".gd"
              ? "script"
              : "resource",
        targetPath: extResource.path,
        targetType: extResource.type === "" ? null : extResource.type,
        matchedBy: matchesPath ? "path" : "uid",
      });
    }
  }
  return { references, truncated };
}

/**
 * Local, read-only index of the project on disk. Used as the offline fallback
 * for editor-backed search and as the only source for signal and input kinds,
 * which the editor bridge does not serve.
 */
export async function searchProjectIndex(
  projectRoot: string,
  input: { query: string; kinds?: SearchProjectKind[]; maxResults?: number; cache?: ProjectIndexCache },
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
    const files = await (input.cache?.getOrScan(projectRoot) ?? walkProjectRoot(projectRoot));
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
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      // Unreadable directories are skipped rather than failing the whole scan.
      continue;
    }
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
      const fileStat = await stat(absolutePath).catch(() => null);
      if (fileStat === null) {
        continue;
      }
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
