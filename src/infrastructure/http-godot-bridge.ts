import { z } from "zod";
import {
  changeReportSchema,
  editorContextSchema,
  rollbackReportSchema,
  runDiagnosticsSchema,
  type ApplyChangeRequest,
  type ChangeReport,
  type EditorContext,
  inputActionSnapshotSchema,
  type InputActionSnapshot,
  type RollbackReport,
  type RollbackRequest,
  type RunDiagnostics,
  searchProjectReportSchema,
  resourceSnapshotSchema,
  sceneSignalsSnapshotSchema,
  type SearchProjectReport,
  type SearchProjectRequest,
  type ResourceSnapshot,
  type SceneSignalsSnapshot,
  scriptSnapshotSchema,
  type ScriptSnapshot,
} from "../domain/contracts.js";
import { ERROR_CODES, DomainError, type ErrorCode } from "../domain/errors.js";
import type { GodotBridge } from "./godot-bridge.js";

const bridgeErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export class HttpGodotBridge implements GodotBridge {
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(
    endpoint = process.env.GODOT_BRIDGE_URL ?? "http://127.0.0.1:8765",
    timeoutMs = 5000,
  ) {
    this.endpoint = endpoint.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  async getContext(projectRoot: string): Promise<EditorContext> {
    const payload = await this.post("/v1/context", { projectRoot });
    const parsed = z
      .object({ ok: z.literal(true), context: editorContextSchema })
      .safeParse(payload);
    if (!parsed.success) {
      throw this.protocolError("The bridge returned an invalid editor context.", parsed.error);
    }
    return parsed.data.context;
  }

  async applyChange(projectRoot: string, request: ApplyChangeRequest): Promise<ChangeReport> {
    const payload = await this.post("/v1/changes/apply", {
      projectRoot,
      ...request,
    });
    const parsed = z
      .object({ ok: z.literal(true), report: changeReportSchema })
      .safeParse(payload);
    if (!parsed.success) {
      throw this.protocolError("The bridge returned an invalid change report.", parsed.error);
    }
    return parsed.data.report;
  }

  async rollbackChange(projectRoot: string, request: RollbackRequest): Promise<RollbackReport> {
    const payload = await this.post("/v1/changes/rollback", {
      projectRoot,
      ...request,
    });
    const parsed = z
      .object({ ok: z.literal(true), report: rollbackReportSchema })
      .safeParse(payload);
    if (!parsed.success) {
      throw this.protocolError("The bridge returned an invalid rollback report.", parsed.error);
    }
    return parsed.data.report;
  }

  async searchProject(projectRoot: string, request: SearchProjectRequest): Promise<SearchProjectReport> {
    const payload = await this.post("/v1/search", {
      projectRoot,
      ...request,
    });
    const parsed = z
      .object({ ok: z.literal(true), report: searchProjectReportSchema })
      .safeParse(payload);
    if (!parsed.success) {
      throw this.protocolError("The bridge returned an invalid search report.", parsed.error);
    }
    return parsed.data.report;
  }

  async readScript(projectRoot: string, scriptPath: string): Promise<ScriptSnapshot> {
    const payload = await this.post("/v1/scripts/read", { projectRoot, scriptPath });
    const parsed = z
      .object({ ok: z.literal(true), snapshot: scriptSnapshotSchema })
      .safeParse(payload);
    if (!parsed.success) {
      throw this.protocolError("The bridge returned an invalid script snapshot.", parsed.error);
    }
    return parsed.data.snapshot;
  }

  async readResource(projectRoot: string, resourcePath: string): Promise<ResourceSnapshot> {
    const payload = await this.post("/v1/resources/read", { projectRoot, resourcePath });
    const parsed = z
      .object({ ok: z.literal(true), snapshot: resourceSnapshotSchema })
      .safeParse(payload);
    if (!parsed.success) {
      throw this.protocolError("The bridge returned an invalid resource snapshot.", parsed.error);
    }
    return parsed.data.snapshot;
  }

  async readInputAction(projectRoot: string, actionName: string): Promise<InputActionSnapshot> {
    const payload = await this.post("/v1/input-actions/read", { projectRoot, actionName });
    const parsed = z
      .object({ ok: z.literal(true), snapshot: inputActionSnapshotSchema })
      .safeParse(payload);
    if (!parsed.success) {
      throw this.protocolError("The bridge returned an invalid input action snapshot.", parsed.error);
    }
    return parsed.data.snapshot;
  }

  async readSceneSignals(projectRoot: string): Promise<SceneSignalsSnapshot> {
    const payload = await this.post("/v1/signals/read", { projectRoot });
    const parsed = z
      .object({ ok: z.literal(true), snapshot: sceneSignalsSnapshotSchema })
      .safeParse(payload);
    if (!parsed.success) {
      throw this.protocolError("The bridge returned an invalid scene signal snapshot.", parsed.error);
    }
    return parsed.data.snapshot;
  }

  async runCurrentScene(projectRoot: string, timeoutMs: number): Promise<RunDiagnostics> {
    const payload = await this.post("/v1/run/current", { projectRoot, timeoutMs });
    return this.waitForRunTerminalState(projectRoot, payload, timeoutMs);
  }

  async runScene(projectRoot: string, scenePath: string, timeoutMs: number): Promise<RunDiagnostics> {
    const payload = await this.post("/v1/run/scene", { projectRoot, scenePath, timeoutMs });
    return this.waitForRunTerminalState(projectRoot, payload, timeoutMs);
  }

  private async waitForRunTerminalState(
    projectRoot: string,
    startPayload: unknown,
    timeoutMs: number,
  ): Promise<RunDiagnostics> {
    let diagnostics = this.parseRunDiagnostics(startPayload);
    if (diagnostics.status === "stopped" || diagnostics.status === "failed") {
      return diagnostics;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.delay(100);
      const statusPayload = await this.post("/v1/run/status", {
        projectRoot,
        runId: diagnostics.runId,
      });
      diagnostics = this.parseRunDiagnostics(statusPayload);
      if (diagnostics.status === "stopped" || diagnostics.status === "failed") {
        return diagnostics;
      }
    }
    return diagnostics;
  }

  private parseRunDiagnostics(payload: unknown): RunDiagnostics {
    const parsed = z
      .object({ ok: z.literal(true), diagnostics: runDiagnosticsSchema })
      .safeParse(payload);
    if (!parsed.success) {
      throw this.protocolError("The bridge returned invalid run diagnostics.", parsed.error);
    }
    return parsed.data.diagnostics;
  }

  private async delay(delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }

  private async post(route: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.endpoint + route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw this.errorFromPayload(payload, response.status);
      }
      return payload;
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      throw new DomainError(
        ERROR_CODES.EDITOR_UNAVAILABLE,
        "The local Godot EditorPlugin bridge could not be reached.",
        { route, cause: error instanceof Error ? error.message : String(error) },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private errorFromPayload(payload: unknown, status: number): DomainError {
    const parsed = bridgeErrorSchema.safeParse(payload);
    if (!parsed.success) {
      return new DomainError(
        ERROR_CODES.BRIDGE_PROTOCOL_ERROR,
        "The local bridge returned an invalid error response.",
        { status },
      );
    }

    const code = this.toErrorCode(parsed.data.error.code);
    return new DomainError(code, parsed.data.error.message, parsed.data.error.details);
  }

  private protocolError(message: string, details: unknown): DomainError {
    return new DomainError(ERROR_CODES.BRIDGE_PROTOCOL_ERROR, message, details);
  }

  private toErrorCode(code: string): ErrorCode {
    if ((Object.values(ERROR_CODES) as string[]).includes(code)) {
      return code as ErrorCode;
    }
    return ERROR_CODES.BRIDGE_PROTOCOL_ERROR;
  }
}
