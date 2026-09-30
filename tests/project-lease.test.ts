import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import { DomainError, ERROR_CODES } from "../src/domain/errors.js";
import { FileProjectLeaseStore } from "../src/infrastructure/project-lease-store.js";

let stateDirectory: string;

before(async () => {
  stateDirectory = await mkdtemp(path.join(tmpdir(), "godot-safe-change-lease-"));
});

after(async () => {
  await rm(stateDirectory, { recursive: true, force: true });
});

test("allows one owner and rejects a concurrent owner", async () => {
  const store = new FileProjectLeaseStore(stateDirectory);
  const first = await store.acquire("/tmp/project", "owner-a", 10000);

  await assert.rejects(
    () => store.acquire("/tmp/project", "owner-b", 10000),
    (error: unknown) => error instanceof DomainError && error.code === ERROR_CODES.PROJECT_BUSY,
  );

  await store.release(first);
  const second = await store.acquire("/tmp/project", "owner-b", 10000);
  assert.equal(second.ownerId, "owner-b");
  await store.release(second);
});

test("reclaims an expired lease", async () => {
  const store = new FileProjectLeaseStore(stateDirectory);
  await store.acquire("/tmp/expired-project", "owner-a", 10);
  await new Promise((resolve) => setTimeout(resolve, 25));

  const reclaimed = await store.acquire("/tmp/expired-project", "owner-b", 10000);
  assert.equal(reclaimed.ownerId, "owner-b");
  await store.release(reclaimed);
});
