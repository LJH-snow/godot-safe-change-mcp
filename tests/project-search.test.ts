import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { searchProjectIndex } from "../src/infrastructure/project-index.js";
import { LocalProjectSearchService } from "../src/application/project-search-service.js";
import { DomainError, ERROR_CODES } from "../src/domain/errors.js";
import type { SearchProjectReport, SearchProjectRequest } from "../src/domain/contracts.js";
import type { GodotBridge } from "../src/infrastructure/godot-bridge.js";

const SCENE_MAIN = [
  "[gd_scene load_steps=2 format=3 uid=\"uid://main\"]",
  "",
  "[node name=\"Main\" type=\"Node2D\"]",
  "",
  "[node name=\"Player\" type=\"CharacterBody2D\" parent=\".\"]",
  "",
  "[node name=\"ScoreLabel\" type=\"Label\" parent=\"Player\"]",
  "",
  "[connection signal=\"pressed\" from=\"Player\" to=\".\" method=\"_on_player_pressed\"]",
].join("\n");

const SCRIPT_PLAYER = [
  "extends CharacterBody2D",
  "",
  "signal health_changed(new_value: int)",
  "",
  "func take_damage(amount: int) -> void:",
  "\tpass",
].join("\n");

const PROJECT_SETTINGS = [
  "config_version=5",
  "",
  "[application]",
  "config/name=\"SearchFixture\"",
  "",
  "[input]",
  "",
  "move_left={",
  "\"deadzone\": 0.5,",
  "\"events\": []",
  "}",
  "jump={",
  "\"deadzone\": 0.5,",
  "\"events\": []",
  "}",
].join("\n");

let fixtureRoot = "";

before(async () => {
  const base = await mkdtemp(path.join(tmpdir(), "godot-search-fixture-"));
  fixtureRoot = base;
  await mkdir(path.join(base, "scenes"));
  await mkdir(path.join(base, "scripts"));
  await mkdir(path.join(base, "resources"));
  await mkdir(path.join(base, ".godot"));
  await writeFile(path.join(base, "project.godot"), PROJECT_SETTINGS + "\n");
  await writeFile(path.join(base, "scenes", "main.tscn"), SCENE_MAIN + "\n");
  await writeFile(path.join(base, "scripts", "player.gd"), SCRIPT_PLAYER + "\n");
  await writeFile(path.join(base, "resources", "theme.tres"), "[gd_resource type=\"Theme\"]\n");
  await writeFile(path.join(base, ".godot", "cache.tscn"), "[node name=\"Hidden\"]\n");
  // A symlink pointing outside the project root must never be followed.
  await symlink("/private/etc", path.join(base, "link-outside"));
});

after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("searchProjectIndex", () => {
  test("finds scene files, node names and node types in the unified result shape", async () => {
    const { results } = await searchProjectIndex(fixtureRoot, { query: "player" });

    const nodeMatch = results.find((result) => result.kind === "node" && result.name === "Player");
    assert.equal(nodeMatch?.nodeType, "CharacterBody2D");
    assert.equal(nodeMatch?.nodePath, ".");
    assert.deepEqual(nodeMatch?.matches, ["name"]);

    const scriptMatch = results.find((result) => result.kind === "script");
    assert.equal(scriptMatch?.path, "res://scripts/player.gd");
    assert.deepEqual(scriptMatch?.matches, ["path"]);
  });

  test("finds signal connections, declarations and input actions", async () => {
    const signals = await searchProjectIndex(fixtureRoot, {
      query: "pressed",
      kinds: ["signal"],
    });
    assert.equal(signals.results[0]?.kind, "signal");
    assert.equal(signals.results[0]?.name, "pressed");
    assert.equal(signals.results[0]?.nodePath, "Player");

    const declarations = await searchProjectIndex(fixtureRoot, {
      query: "health_changed",
      kinds: ["signal"],
    });
    assert.equal(declarations.results[0]?.path, "res://scripts/player.gd");

    const inputs = await searchProjectIndex(fixtureRoot, { query: "jump", kinds: ["input"] });
    assert.equal(inputs.results[0]?.kind, "input");
    assert.equal(inputs.results[0]?.path, "res://project.godot");
  });

  test("ignores hidden directories and never follows symlinks", async () => {
    const { results } = await searchProjectIndex(fixtureRoot, { query: "tscn" });
    for (const result of results) {
      assert.ok(!result.path.includes(".godot/"));
      assert.ok(!result.path.includes("link-outside"));
    }
  });

  test("rejects an empty query", async () => {
    await assert.rejects(
      () => searchProjectIndex(fixtureRoot, { query: "   " }),
      /must not be empty/,
    );
  });
});

class SearchBridgeStub implements GodotBridge {
  searchCalls: SearchProjectRequest[] = [];
  failSearch = false;

  async searchProject(
    _projectRoot: string,
    request: SearchProjectRequest,
  ): Promise<SearchProjectReport> {
    if (this.failSearch) {
      throw new DomainError(
        ERROR_CODES.EDITOR_UNAVAILABLE,
        "The Godot EditorPlugin bridge is not connected.",
      );
    }
    this.searchCalls.push(request);
    return {
      schemaVersion: "0.3",
      projectRoot: _projectRoot,
      query: request.query,
      revision: "revision-1",
      results: [
        {
          kind: "node",
          path: "res://scenes/main.tscn",
          name: "EditorPlayer",
          nodePath: ".",
          nodeType: "CharacterBody2D",
          matches: ["name"],
        },
      ],
    };
  }

  async getContext(): Promise<never> {
    throw new Error("not used");
  }

  async applyChange(): Promise<never> {
    throw new Error("not used");
  }

  async rollbackChange(): Promise<never> {
    throw new Error("not used");
  }

  async runCurrentScene(): Promise<never> {
    throw new Error("not used");
  }
}

describe("LocalProjectSearchService", () => {
  test("serves editor-backed kinds through the bridge and tags results", async () => {
    const bridge = new SearchBridgeStub();
    const service = new LocalProjectSearchService(bridge);

    const report = await service.search({
      projectRoot: fixtureRoot,
      query: "player",
      kinds: ["node"],
    });

    assert.equal(bridge.searchCalls.length, 1);
    assert.equal(report.results[0]?.name, "EditorPlayer");
    assert.equal(report.results[0]?.source, "editor");
    assert.equal(report.revision, "revision-1");
  });

  test("strips local-only kinds from the bridge request and merges local signal results", async () => {
    const bridge = new SearchBridgeStub();
    const service = new LocalProjectSearchService(bridge);

    const report = await service.search({
      projectRoot: fixtureRoot,
      query: "e",
      kinds: ["node", "signal"],
      maxResults: 100,
    });

    assert.deepEqual(bridge.searchCalls[0]?.kinds, ["node"]);
    const sources = report.results.map((result) => result.source);
    assert.ok(sources.includes("editor"));
    assert.ok(sources.includes("local"));
    assert.ok(
      report.results.some((result) => result.kind === "signal" && result.name === "pressed"),
    );
  });

  test("never calls the bridge for signal- and input-only requests", async () => {
    const bridge = new SearchBridgeStub();
    const service = new LocalProjectSearchService(bridge);

    const report = await service.search({
      projectRoot: fixtureRoot,
      query: "jump",
      kinds: ["input"],
    });

    assert.equal(bridge.searchCalls.length, 0);
    assert.equal(report.results[0]?.source, "local");
    assert.equal(report.results[0]?.name, "jump");
  });

  test("falls back to the local index when the editor bridge is unavailable", async () => {
    const bridge = new SearchBridgeStub();
    bridge.failSearch = true;
    const service = new LocalProjectSearchService(bridge);

    const report = await service.search({
      projectRoot: fixtureRoot,
      query: "theme",
      kinds: ["resource"],
    });

    assert.equal(bridge.searchCalls.length, 0);
    assert.equal(report.revision, null);
    assert.equal(report.results[0]?.path, "res://resources/theme.tres");
    assert.equal(report.results[0]?.source, "local");
  });
});
