import type {
  ProjectOverview,
  ProjectOverviewInput,
  ProjectSearchInput,
  ProjectSearchResult,
  ProjectSection,
} from "../domain/contracts.js";
import { overviewFromContext, type GodotBridge } from "../infrastructure/godot-bridge.js";
import { searchProjectFiles } from "../infrastructure/project-index.js";
import { normalizeProjectRoot } from "../infrastructure/project-root.js";

const DEFAULT_SECTIONS: ProjectSection[] = [
  "scenes",
  "scripts",
  "resources",
  "settings",
];

export interface ProjectService {
  getOverview(input: ProjectOverviewInput): Promise<ProjectOverview>;
  searchProject(input: ProjectSearchInput): Promise<ProjectSearchResult>;
}

export class LocalProjectService implements ProjectService {
  constructor(private readonly bridge: GodotBridge) {}

  async getOverview(input: ProjectOverviewInput): Promise<ProjectOverview> {
    const projectRoot = await normalizeProjectRoot(input.projectRoot);
    const sections = input.include ?? DEFAULT_SECTIONS;
    const context = await this.bridge.getContext(projectRoot);
    return overviewFromContext(context, sections);
  }

  async searchProject(input: ProjectSearchInput): Promise<ProjectSearchResult> {
    const projectRoot = await normalizeProjectRoot(input.projectRoot);
    const { matches, truncated } = await searchProjectFiles(projectRoot, input);
    return {
      schemaVersion: "0.1",
      projectRoot,
      query: input.query,
      sections: input.sections ?? ["scenes", "scripts", "resources"],
      matches,
      truncated,
    };
  }
}
