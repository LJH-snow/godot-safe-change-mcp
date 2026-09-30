import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { searchProjectFiles } from "../src/infrastructure/project-index.js";
import { LocalProjectService } from "../src/application/project-service.js";
import type { GodotBridge } from "../src/infrastructure/godot-bridge.js";

const SCENE_MAIN = [
  "[gd_scene load_steps=2 format=3 uid=\"uid://main\"]",
  "",
  "[node name=\"Main\" type=\"Node2D\"]",
  "",
  "[node name=\"Player\" type=\"CharacterBody2D\" parent=\".\"]",
  "",
  "[node name=\"ScoreLabel\" type=\"Label\" parent=\"Player\"]",
].join("\n");

const SCENE_LEVEL = [
  "[gd_scene load_steps=2 format=3 uid=\"uid://level\"]",
  "",
  "[node name=\"Level\" type=\"Node2D\"]",
  "",
  "[node name=\"Enemy\" type=\"Area2D\" parent=\".\"]",
].join("\n");

let fixtureRoot = "";

before(async () => {
  const base = await mkdtemp(path.join(tmpdir(), "godot-search-fixture-"));
  fixtureRoot = base;
  await mkdir(path.join(base, "scenes"));
  await mkdir(path.join(base, "scripts"));
  await mkdir(path.join(base, "resources"));
  await mkdir(path.join(base, ".godot"));
  await writeFile(path.join(base, "project.godot"), "config_version=5\n");
  await writeFile(path.join(base, "scenes", "main.tscn"), SCENE_MAIN + "\n");
  await writeFile(path.join(base, "scenes", "level.tscn"), SCENE_LEVEL + "\n");
  await writeFile(path.join(base, "scripts", "player.gd"), "extends CharacterBody2D\n");
  await writeFile(path.join(base, "resources", "theme.tres"), "[gd_resource type=\"Theme\"]\n");
  await writeFile(path.join(base, ".godot", "cache.tscn"), "[node name=\"Hidden\"]\n");
  // A symlink pointing outside the project root must never be followed.
  await symlink("/private/etc", path.join(base, "link-outside"));
});

after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("searchProjectFiles", () => {
  test("finds scene files and node names inside text scenes", async () => {
    const { matches } = await searchProjectFiles(fixtureRoot, { query: "player" });

    const paths = matches.map((match) => match.path);
    assert.ok(paths.includes("res://scenes/main.tscn"));
    const nodeMatch = matches.find((match) => match.name === "Player");
    assert.equal(nodeMatch?.kind, "CharacterBody2D");
    assert.match(nodeMatch?.detail ?? "", /res:\/\/scenes\/main\.tscn/);
  });

  test("matches node types and scripts by section", async () => {
    const byType = await searchProjectFiles(fixtureRoot, { query: "Area2D" });
    assert.equal(byType.matches[0]?.name, "Enemy");
    assert.equal(byType.matches[0]?.section, "scenes");

    const scriptOnly = await searchProjectFiles(fixtureRoot, {
      query: "player",
      sections: ["scripts"],
    });
    assert.deepEqual(
      scriptOnly.matches.map((match) => match.path),
      ["res://scripts/player.gd"],
    );
  });

  test("ignores hidden directories and never follows symlinks", async () => {
    const { matches } = await searchProjectFiles(fixtureRoot, { query: "hidden" });
    assert.deepEqual(matches, []);

    const { matches: all } = await searchProjectFiles(fixtureRoot, { query: "tscn" });
    for (const match of all) {
      assert.ok(!match.path.includes(".godot/"));
      assert.ok(!match.path.includes("link-outside"));
    }
  });

  test("reports truncation when the limit is reached", async () => {
    const { matches, truncated } = await searchProjectFiles(fixtureRoot, {
      query: "e",
      limit: 2,
    });

    assert.equal(matches.length, 2);
    assert.equal(truncated, true);
  });

  test("rejects an empty query", async () => {
    await assert.rejects(
      () => searchProjectFiles(fixtureRoot, { query: "   " }),
      /must not be empty/,
    );
  });
});

describe("LocalProjectService.searchProject", () => {
  test("returns a contract-shaped result with a normalized root", async () => {
    const service = new LocalProjectService({} as GodotBridge);
    const result = await service.searchProject({
      projectRoot: fixtureRoot,
      query: "theme",
    });

    assert.equal(result.schemaVersion, "0.1");
    assert.equal(result.query, "theme");
    assert.equal(
      result.projectRoot,
      await (await import("node:fs/promises")).realpath(fixtureRoot),
    );
    assert.equal(result.matches[0]?.path, "res://resources/theme.tres");
    assert.equal(result.matches[0]?.section, "resources");
    assert.equal(result.truncated, false);
  });
});
