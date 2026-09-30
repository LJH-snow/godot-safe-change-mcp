import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  ProjectSearchInput,
  SearchMatch,
  SearchSection,
} from "../domain/contracts.js";
import { DomainError, ERROR_CODES } from "../domain/errors.js";

const DEFAULT_SECTIONS: SearchSection[] = ["scenes", "scripts", "resources"];
const DEFAULT_LIMIT = 50;
const MAX_SCENE_BYTES = 5 * 1024 * 1024;

const SECTION_EXTENSIONS: Record<SearchSection, ReadonlySet<string>> = {
  scenes: new Set([".tscn", ".scn"]),
  scripts: new Set([".gd", ".cs"]),
  resources: new Set([".tres", ".res", ".gdshader"]),
};

const NODE_LINE_PATTERN = /\[node\s+name="([^"]+)"(?:\s+type="([^"]+)")?(?:\s+parent="([^"]*)")?\s*\]/;

interface IndexedFile {
  relativePath: string;
  absolutePath: string;
  extension: string;
  size: number;
}

export async function searchProjectFiles(
  projectRoot: string,
  input: Pick<ProjectSearchInput, "query" | "sections" | "limit">,
): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
  const query = input.query.trim().toLowerCase();
  if (query.length === 0) {
    throw new DomainError(ERROR_CODES.VALIDATION_FAILED, "The search query must not be empty.");
  }

  const sections = input.sections ?? DEFAULT_SECTIONS;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const files = await walkProjectRoot(projectRoot);

  const matches: SearchMatch[] = [];
  let truncated = false;
  for (const section of sections) {
    for (const file of files) {
      if (matches.length >= limit) {
        truncated = true;
        break;
      }
      if (!SECTION_EXTENSIONS[section].has(file.extension)) {
        continue;
      }
      const resPath = "res://" + file.relativePath;
      if (file.relativePath.toLowerCase().includes(query)) {
        matches.push({
          section,
          path: resPath,
          name: path.posix.basename(file.relativePath),
          kind: file.extension.slice(1),
        });
      }
      if (section !== "scenes" || file.extension !== ".tscn" || file.size > MAX_SCENE_BYTES) {
        continue;
      }
      for (const node of await readSceneNodes(file.absolutePath)) {
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
        if (node.name.toLowerCase().includes(query) || node.type.toLowerCase().includes(query)) {
          matches.push({
            section,
            path: resPath,
            name: node.name,
            kind: node.type,
            detail: "node " + node.name + " under " + node.parent + " in " + resPath,
          });
        }
      }
    }
    if (matches.length >= limit) {
      truncated = true;
      break;
    }
  }
  return { matches, truncated };
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
