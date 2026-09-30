import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { findProjectReferences } from "../src/infrastructure/project-index.js";
import { LocalReferenceService } from "../src/application/reference-service.js";
import { DomainError, ERROR_CODES } from "../src/domain/errors.js";

const SCRIPT_PLAYER = [
  "# uid uid://bplayer0123456",
  "extends CharacterBody2D",
].join("\n");

const SCRIPT_CONSUMER = [
  "extends Node",
  "const Player = preload(\"res://scripts/player.gd\")",
  "const Theme = load('res://resources/theme.tres')",
  "const Level = load(\"uid://clevel01234567\")",
].join("\n");

const SCENE_MAIN = [
  '[gd_scene load_steps=3 format=3 uid="uid://cmain01234567"]',
  "",
  '[ext_resource type="Script" path="res://scripts/player.gd" id="1_abcde"]',
  '[ext_resource type="Resource" path="res://resources/theme.tres" id="2_fghij"]',
  "",
  '[node name="Main" type="Node2D"]',
].join("\n");

// Godot 4.4+ may write references with the uid only, omitting the path.
const SCENE_LEVEL = [
  '[gd_scene load_steps=2 format=3 uid="uid://clevel01234567"]',
  "",
  '[ext_resource type="Script" uid="uid://bplayer0123456" id="1_klmno"]',
  "",
  '[node name="Level" type="Node2D"]',
].join("\n");

const RESOURCE_THEME = [
  '[gd_resource type="Theme" format=3 uid="uid://ctheme01234567"]',
].join("\n");

let fixtureRoot = "";

before(async () => {
  const base = await mkdtemp(path.join(tmpdir(), "godot-refs-fixture-"));
  fixtureRoot = base;
  await mkdir(path.join(base, "scenes"));
  await mkdir(path.join(base, "scripts"));
  await mkdir(path.join(base, "resources"));
  await writeFile(path.join(base, "scripts", "player.gd"), SCRIPT_PLAYER + "\n");
  await writeFile(path.join(base, "scripts", "consumer.gd"), SCRIPT_CONSUMER + "\n");
  await writeFile(path.join(base, "scenes", "main.tscn"), SCENE_MAIN + "\n");
  await writeFile(path.join(base, "scenes", "level.tscn"), SCENE_LEVEL + "\n");
  await writeFile(path.join(base, "resources", "theme.tres"), RESOURCE_THEME + "\n");
});

after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("findProjectReferences", () => {
  test("finds references written with an explicit res:// path", async () => {
    const { references, truncated } = await findProjectReferences(fixtureRoot, "player.gd");

    const pathRef = references.find(
      (ref) => ref.path === "res://scenes/main.tscn" && ref.matchedBy === "path",
    );
    assert.equal(pathRef?.path, "res://scenes/main.tscn");
    assert.equal(pathRef?.kind, "scene");
    assert.equal(pathRef?.targetPath, "res://scripts/player.gd");
    assert.equal(pathRef?.targetType, "Script");
    assert.equal(truncated, false);
  });

  test("resolves uid-only references through the script uid comment", async () => {
    const { references } = await findProjectReferences(fixtureRoot, "scripts/player.gd");

    const uidRef = references.find((ref) => ref.matchedBy === "uid");
    assert.equal(uidRef?.path, "res://scenes/level.tscn");
    assert.equal(uidRef?.targetPath, null);
    assert.equal(uidRef?.targetType, "Script");
  });

  test("supports a uid:// target directly", async () => {
    const { references } = await findProjectReferences(fixtureRoot, "uid://bplayer0123456");
    assert.deepEqual(
      references.map((ref) => ref.path).sort(),
      [
        "res://scenes/level.tscn",
        "res://scenes/main.tscn",
        "res://scripts/consumer.gd",
      ].sort(),
    );
  });

  test("finds references from resource files as well", async () => {
    const { references } = await findProjectReferences(fixtureRoot, "theme.tres");
    const sceneReference = references.find((reference) => reference.path === "res://scenes/main.tscn");
    assert.equal(sceneReference?.kind, "scene");
    assert.equal(sceneReference?.targetType, "Resource");
  });

  test("finds GDScript preload and load references", async () => {
    const { references } = await findProjectReferences(fixtureRoot, "player.gd");
    const scriptReference = references.find(
      (reference) => reference.path === "res://scripts/consumer.gd" && reference.matchedBy === "path",
    );
    assert.equal(scriptReference?.kind, "script");
    assert.equal(scriptReference?.targetPath, "res://scripts/player.gd");

    const uidReference = await findProjectReferences(fixtureRoot, "uid://clevel01234567");
    assert.deepEqual(
      uidReference.references.map((reference) => reference.path),
      ["res://scripts/consumer.gd"],
    );
    assert.equal(uidReference.references[0]?.kind, "script");
    assert.equal(uidReference.references[0]?.targetPath, null);
  });

  test("reports truncation when the limit cuts results", async () => {
    const { references, truncated } = await findProjectReferences(fixtureRoot, "player.gd", {
      limit: 1,
    });
    assert.equal(references.length, 1);
    assert.equal(truncated, true);
  });
});

describe("LocalReferenceService", () => {
  test("returns a contract-shaped report with a normalized root", async () => {
    const service = new LocalReferenceService();
    const report = await service.findReferences({
      projectRoot: fixtureRoot,
      target: "player.gd",
    });

    assert.equal(report.schemaVersion, "0.1");
    assert.equal(report.target, "player.gd");
    assert.equal(report.references.length >= 1, true);
  });

  test("rejects a blank target", async () => {
    const service = new LocalReferenceService();
    await assert.rejects(
      () => service.findReferences({ projectRoot: fixtureRoot, target: "   " }),
      (error: unknown) =>
        error instanceof DomainError && error.code === ERROR_CODES.VALIDATION_FAILED,
    );
  });
});
