import type {
  ApplyChangeRequest,
  AutoloadSnapshot,
  ChangeReport,
  EditorContext,
  InputActionSnapshot,
  ProjectOverview,
  ProjectSection,
  RollbackReport,
  RollbackRequest,
  RunDiagnostics,
  SearchProjectReport,
  SearchProjectRequest,
  ResourceSnapshot,
  SceneSignalsSnapshot,
  ScriptSnapshot,
} from "../domain/contracts.js";
import { ERROR_CODES, DomainError } from "../domain/errors.js";

export interface GodotBridge {
  getContext(projectRoot: string): Promise<EditorContext>;
  applyChange(projectRoot: string, request: ApplyChangeRequest): Promise<ChangeReport>;
  rollbackChange(projectRoot: string, request: RollbackRequest): Promise<RollbackReport>;
  searchProject(projectRoot: string, request: SearchProjectRequest): Promise<SearchProjectReport>;
  readScript(projectRoot: string, scriptPath: string): Promise<ScriptSnapshot>;
  readResource(projectRoot: string, resourcePath: string): Promise<ResourceSnapshot>;
  readInputAction(projectRoot: string, actionName: string): Promise<InputActionSnapshot>;
  readAutoload(projectRoot: string, name: string): Promise<AutoloadSnapshot>;
  readSceneSignals(projectRoot: string): Promise<SceneSignalsSnapshot>;
  runCurrentScene(projectRoot: string, timeoutMs: number): Promise<RunDiagnostics>;
  runScene(projectRoot: string, scenePath: string, timeoutMs: number): Promise<RunDiagnostics>;
}

export class PendingGodotBridge implements GodotBridge {
  async getContext(projectRoot: string): Promise<EditorContext> {
    return {
      schemaVersion: "0.2",
      projectRoot,
      connection: "disconnected",
      revision: null,
      project: { name: "", path: projectRoot },
      currentScene: { path: null, rootName: null, rootType: null, nodes: [] },
      selection: [],
      openResources: [],
      run: { status: "idle", scenePath: null, runId: null },
      diagnostics: { output: [], warnings: [], errors: [] },
    };
  }

  async applyChange(): Promise<ChangeReport> {
    throw new DomainError(
      ERROR_CODES.EDITOR_UNAVAILABLE,
      "The Godot EditorPlugin bridge is not connected.",
    );
  }

  async runCurrentScene(): Promise<RunDiagnostics> {
    throw new DomainError(
      ERROR_CODES.EDITOR_UNAVAILABLE,
      "The Godot EditorPlugin bridge is not connected.",
    );
  }

  async runScene(): Promise<RunDiagnostics> {
    throw new DomainError(
      ERROR_CODES.EDITOR_UNAVAILABLE,
      "The Godot EditorPlugin bridge is not connected.",
    );
  }

  async rollbackChange(): Promise<RollbackReport> {
    throw new DomainError(
      ERROR_CODES.EDITOR_UNAVAILABLE,
      "The Godot EditorPlugin bridge is not connected.",
    );
  }

  async searchProject(): Promise<SearchProjectReport> {
    throw new DomainError(
      ERROR_CODES.EDITOR_UNAVAILABLE,
      "The Godot EditorPlugin bridge is not connected.",
    );
  }

  async readScript(): Promise<ScriptSnapshot> {
    throw new DomainError(
      ERROR_CODES.EDITOR_UNAVAILABLE,
      "The Godot EditorPlugin bridge is not connected.",
    );
  }

  async readResource(): Promise<ResourceSnapshot> {
    throw new DomainError(
      ERROR_CODES.EDITOR_UNAVAILABLE,
      "The Godot EditorPlugin bridge is not connected.",
    );
  }

  async readInputAction(): Promise<InputActionSnapshot> {
    throw new DomainError(
      ERROR_CODES.EDITOR_UNAVAILABLE,
      "The Godot EditorPlugin bridge is not connected.",
    );
  }

  async readAutoload(): Promise<AutoloadSnapshot> {
    throw new DomainError(
      ERROR_CODES.EDITOR_UNAVAILABLE,
      "The Godot EditorPlugin bridge is not connected.",
    );
  }

  async readSceneSignals(): Promise<SceneSignalsSnapshot> {
    throw new DomainError(
      ERROR_CODES.EDITOR_UNAVAILABLE,
      "The Godot EditorPlugin bridge is not connected.",
    );
  }
}

export function overviewFromContext(
  context: EditorContext,
  sections: readonly ProjectSection[],
): ProjectOverview {
  return {
    schemaVersion: "0.1",
    projectRoot: context.projectRoot,
    connection: context.connection,
    revision: context.revision,
    sections: [...sections],
    counts: {
      scenes: context.currentScene.path === null ? 0 : 1,
      scripts: 0,
      resources: context.openResources.length,
      settings: 0,
    },
    notes:
      context.connection === "connected"
        ? ["Overview is sourced from the connected Godot EditorPlugin bridge."]
        : ["The Godot EditorPlugin bridge is not connected."],
  };
}
