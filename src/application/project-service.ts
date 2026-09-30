import type {
  ProjectOverview,
  ProjectOverviewInput,
  ProjectSection,
} from "../domain/contracts.js";
import { overviewFromContext, type GodotBridge } from "../infrastructure/godot-bridge.js";
import { countProjectFiles, sharedProjectIndexCache } from "../infrastructure/project-index.js";
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
    const overview = overviewFromContext(context, sections);

    // Replace the bridge-derived placeholder counts with real counts from a
    // local read-only scan, so the overview stays accurate while offline and
    // reflects files the editor has not opened yet.
    const counts = await countProjectFiles(projectRoot, sharedProjectIndexCache);
    overview.counts = {
      scenes: counts.scenes,
      scripts: counts.scripts,
      resources: counts.resources,
      settings: counts.settings,
    };
    overview.notes = [
      ...overview.notes,
      "Counts come from a local read-only index scan of the project on disk.",
    ];
    return overview;
  }
}
