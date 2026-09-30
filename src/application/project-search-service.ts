import {
  searchProjectInputSchema,
  type SearchProjectInput,
  type SearchProjectReport,
} from "../domain/contracts.js";
import type { GodotBridge } from "../infrastructure/godot-bridge.js";
import { normalizeProjectRoot } from "../infrastructure/project-root.js";

export interface ProjectSearchService {
  search(input: SearchProjectInput): Promise<SearchProjectReport>;
}

export class LocalProjectSearchService implements ProjectSearchService {
  constructor(private readonly bridge: GodotBridge) {}

  async search(input: SearchProjectInput): Promise<SearchProjectReport> {
    const parsedInput = searchProjectInputSchema.parse(input);
    const projectRoot = await normalizeProjectRoot(parsedInput.projectRoot);
    return this.bridge.searchProject(projectRoot, {
      query: parsedInput.query,
      kinds: parsedInput.kinds,
      maxResults: parsedInput.maxResults,
    });
  }
}
