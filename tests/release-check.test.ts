import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const repositoryRoot = process.cwd();
const scriptPath = path.join(repositoryRoot, "scripts", "release-check.mjs");
const manifestPath = path.join(repositoryRoot, "docs", "releases", "v1.1.0.json");

function runReleaseCheck(args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

async function writeTemporaryManifest(mutator: (manifest: Record<string, unknown>) => void) {
  const directory = await mkdtemp(path.join(tmpdir(), "godot-release-check-"));
  const temporaryPath = path.join(directory, "release.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  mutator(manifest);
  await writeFile(temporaryPath, JSON.stringify(manifest), "utf8");
  return { directory, temporaryPath };
}

test("accepts the published release record and reports its evidence", () => {
  const result = runReleaseCheck([]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("Release artifact check passed: v1.1.0"));
  assert.ok(result.stdout.includes("37037985489"));
});

test("rejects a manifest whose tag or CI run belongs to another release", async () => {
  const temporary = await writeTemporaryManifest((manifest) => {
    manifest.tag = "v9.9.9";
    manifest.ciRunUrl = "https://github.com/other/project/actions/runs/42";
  });
  try {
    const result = runReleaseCheck(["--manifest", temporary.temporaryPath]);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes("tag must be v1.1.0"));
    assert.ok(result.stderr.includes("ciRunUrl must point to this repository"));
  } finally {
    await rm(temporary.directory, { recursive: true, force: true });
  }
});

test("rejects a release record that is not the expected release head", () => {
  const result = runReleaseCheck(["--head", "0000000000000000000000000000000000000000"]);
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("commit does not match the expected release head"));
});

test("rejects missing starter or demo links instead of silently publishing incomplete onboarding", async () => {
  const temporary = await writeTemporaryManifest((manifest) => {
    manifest.artifacts = {
      starter: "examples/missing/README.md",
      demo: "docs/assets/missing.gif",
    };
  });
  try {
    const result = runReleaseCheck(["--manifest", temporary.temporaryPath]);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes("release artifact starter does not exist"));
    assert.ok(result.stderr.includes("release artifact demo does not exist"));
  } finally {
    await rm(temporary.directory, { recursive: true, force: true });
  }
});
