import {
  searchProjectInputSchema,
  type SearchProjectInput,
  type SearchProjectKind,
  type SearchProjectReport,
  type SearchResult,
} from "../domain/contracts.js";
import { DomainError, ERROR_CODES } from "../domain/errors.js";
import type { GodotBridge } from "../infrastructure/godot-bridge.js";
import { searchProjectIndex } from "../infrastructure/project-index.js";
import { normalizeProjectRoot } from "../infrastructure/project-root.js";

export interface ProjectSearchService {
  search(input: SearchProjectInput): Promise<SearchProjectReport>;
}

const BRIDGE_KINDS: ReadonlySet<SearchProjectKind> = new Set([
  "scene",
  "node",
  "script",
  "resource",
]);
const LOCAL_ONLY_KINDS: ReadonlySet<SearchProjectKind> = new Set(["signal", "input"]);

export class LocalProjectSearchService implements ProjectSearchService {
  constructor(private readonly bridge: GodotBridge) {}

  async search(input: SearchProjectInput): Promise<SearchProjectReport> {
    const parsedInput = searchProjectInputSchema.parse(input);
    const projectRoot = await normalizeProjectRoot(parsedInput.projectRoot);
    const kinds = parsedInput.kinds ?? [
      "scene",
      "node",
      "script",
      "resource",
      "signal",
      "input",
    ];
    const maxResults = parsedInput.maxResults ?? 50;
    const bridgeKinds = kinds.filter((kind) => BRIDGE_KINDS.has(kind));
    const localOnlyKinds = kinds.filter((kind) => LOCAL_ONLY_KINDS.has(kind));

    const local = await searchProjectIndex(projectRoot, {
      query: parsedInput.query,
      kinds: localOnlyKinds,
      maxResults,
    });

    if (bridgeKinds.length === 0) {
      return {
        schemaVersion: "0.3",
        projectRoot,
        query: parsedInput.query,
        revision: null,
        results: local.results.map((result) => ({ ...result, source: "local" as const })),
        truncated: local.truncated,
      };
    }

    try {
      const report = await this.bridge.searchProject(projectRoot, {
        query: parsedInput.query,
        kinds: bridgeKinds,
        maxResults,
      });
      const bridgeResults = report.results.map((result) => ({
        ...result,
        source: "editor" as const,
      }));
      const localResults = local.results.map((result) => ({
        ...result,
        source: "local" as const,
      }));
      const results = [...bridgeResults, ...localResults].slice(0, maxResults);
      return {
        schemaVersion: "0.3",
        projectRoot,
        query: parsedInput.query,
        revision: report.revision,
        results,
        truncated: report.results.length >= maxResults || local.truncated,
      };
    } catch (error) {
      if (
        !(error instanceof DomainError) ||
        error.code !== ERROR_CODES.EDITOR_UNAVAILABLE
      ) {
        throw error;
      }
      const fallback = await searchProjectIndex(projectRoot, {
        query: parsedInput.query,
        kinds,
        maxResults,
      });
      return {
        schemaVersion: "0.3",
        projectRoot,
        query: parsedInput.query,
        revision: null,
        results: fallback.results.map((result) => ({ ...result, source: "local" as const })),
        truncated: fallback.truncated,
      };
    }
  }
}

export type { SearchResult };
