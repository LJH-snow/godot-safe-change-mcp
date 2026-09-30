import type {
  ProjectOverview,
  ProjectOverviewInput,
  ProjectSection,
} from "../domain/contracts.js";
import { overviewFromContext, type GodotBridge } from "../infrastructure/godot-bridge.js";
import { normalizeProjectRoot } from "../infrastructure/project-root.js";

const DEFAULT_SECTIONS: ProjectSection[] = [
  "scenes",
  "scripts",
  "resources",
  "settings",
];

export interface ProjectService {
  getOverview(input: ProjectOverviewInput): Promise<ProjectOverview>;
}

export class LocalProjectService implements ProjectService {
  constructor(private readonly bridge: GodotBridge) {}

  async getOverview(input: ProjectOverviewInput): Promise<ProjectOverview> {
    const projectRoot = await normalizeProjectRoot(input.projectRoot);
    const sections = input.include ?? DEFAULT_SECTIONS;
    const context = await this.bridge.getContext(projectRoot);
    return overviewFromContext(context, sections);
  }
}
