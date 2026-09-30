import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { DomainError, ERROR_CODES } from "../domain/errors.js";

const leaseSchema = z.object({
  leaseId: z.string().min(1),
  projectRoot: z.string().min(1),
  ownerId: z.string().min(1),
  acquiredAt: z.string().min(1),
  expiresAt: z.string().min(1),
});

export type ProjectLease = z.infer<typeof leaseSchema>;

export interface ProjectLeaseStore {
  acquire(projectRoot: string, ownerId: string, ttlMs: number): Promise<ProjectLease>;
  assert(projectRoot: string, leaseId: string): Promise<void>;
  renew(lease: ProjectLease, ttlMs: number): Promise<ProjectLease>;
  release(lease: ProjectLease): Promise<void>;
}

export class InMemoryProjectLeaseStore implements ProjectLeaseStore {
  private readonly leases = new Map<string, ProjectLease>();

  async acquire(projectRoot: string, ownerId: string, ttlMs: number): Promise<ProjectLease> {
    const existing = this.leases.get(projectRoot);
    if (existing !== undefined && !this.isExpired(existing)) {
      throw new DomainError(ERROR_CODES.PROJECT_BUSY, "The project is already leased.", {
        projectRoot,
        ownerId: existing.ownerId,
        expiresAt: existing.expiresAt,
      });
    }
    const lease = this.createLease(projectRoot, ownerId, ttlMs);
    this.leases.set(projectRoot, lease);
    return lease;
  }

  async assert(projectRoot: string, leaseId: string): Promise<void> {
    const current = this.leases.get(projectRoot);
    if (current === undefined) {
      throw new DomainError(ERROR_CODES.LEASE_NOT_FOUND, "The project lease was not found.");
    }
    if (this.isExpired(current)) {
      throw new DomainError(ERROR_CODES.LEASE_EXPIRED, "The project lease has expired.");
    }
    if (current.leaseId !== leaseId) {
      throw new DomainError(ERROR_CODES.LEASE_INVALID, "The project lease owner is invalid.");
    }
  }

  async release(lease: ProjectLease): Promise<void> {
    await this.assert(lease.projectRoot, lease.leaseId);
    this.leases.delete(lease.projectRoot);
  }

  async renew(lease: ProjectLease, ttlMs: number): Promise<ProjectLease> {
    await this.assert(lease.projectRoot, lease.leaseId);
    const renewed = this.createLease(lease.projectRoot, lease.ownerId, ttlMs, lease.leaseId, lease.acquiredAt);
    this.leases.set(lease.projectRoot, renewed);
    return renewed;
  }

  private createLease(
    projectRoot: string,
    ownerId: string,
    ttlMs: number,
    leaseId = "lease_" + randomUUID().replaceAll("-", "").slice(0, 20),
    acquiredAt = new Date().toISOString(),
  ): ProjectLease {
    const acquiredDate = new Date();
    return {
      leaseId,
      projectRoot,
      ownerId,
      acquiredAt,
      expiresAt: new Date(acquiredDate.getTime() + Math.max(1, ttlMs)).toISOString(),
    };
  }

  private isExpired(lease: ProjectLease): boolean {
    return Date.parse(lease.expiresAt) <= Date.now();
  }
}

export class FileProjectLeaseStore implements ProjectLeaseStore {
  private readonly baseDirectory: string;

  constructor(
    baseDirectory =
      process.env.GODOT_SAFE_CHANGE_STATE_DIR ?? path.join(os.homedir(), ".godot-safe-change-mcp"),
  ) {
    this.baseDirectory = baseDirectory;
  }

  async acquire(projectRoot: string, ownerId: string, ttlMs: number): Promise<ProjectLease> {
    await mkdir(this.baseDirectory, { recursive: true });
    const filePath = this.filePath(projectRoot);
    const lease = this.createLease(projectRoot, ownerId, ttlMs);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(filePath, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(lease) + "\n", "utf8");
        } finally {
          await handle.close();
        }
        return lease;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
          throw error;
        }
        const existing = await this.readLease(filePath);
        if (existing !== null && !this.isExpired(existing)) {
          throw new DomainError(ERROR_CODES.PROJECT_BUSY, "The project is already leased.", {
            projectRoot,
            ownerId: existing.ownerId,
            expiresAt: existing.expiresAt,
          });
        }
        await unlink(filePath).catch(() => undefined);
      }
    }
    throw new DomainError(ERROR_CODES.PROJECT_BUSY, "The project lease could not be acquired.");
  }

  async assert(projectRoot: string, leaseId: string): Promise<void> {
    const current = await this.readLease(this.filePath(projectRoot));
    if (current === null) {
      throw new DomainError(ERROR_CODES.LEASE_NOT_FOUND, "The project lease was not found.");
    }
    if (this.isExpired(current)) {
      throw new DomainError(ERROR_CODES.LEASE_EXPIRED, "The project lease has expired.");
    }
    if (current.leaseId !== leaseId) {
      throw new DomainError(ERROR_CODES.LEASE_INVALID, "The project lease owner is invalid.");
    }
  }

  async release(lease: ProjectLease): Promise<void> {
    await this.assert(lease.projectRoot, lease.leaseId);
    await unlink(this.filePath(lease.projectRoot)).catch(() => undefined);
  }

  async renew(lease: ProjectLease, ttlMs: number): Promise<ProjectLease> {
    await this.assert(lease.projectRoot, lease.leaseId);
    const renewed = this.createLease(lease.projectRoot, lease.ownerId, ttlMs, lease.leaseId, lease.acquiredAt);
    const target = this.filePath(lease.projectRoot);
    const temporary = target + ".renew.tmp";
    await writeFile(temporary, JSON.stringify(renewed) + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
    return renewed;
  }

  private async readLease(filePath: string): Promise<ProjectLease | null> {
    try {
      return leaseSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
    } catch {
      return null;
    }
  }

  private filePath(projectRoot: string): string {
    const key = createHash("sha256").update(projectRoot).digest("hex").slice(0, 32);
    return path.join(this.baseDirectory, "lease-" + key + ".json");
  }

  private createLease(
    projectRoot: string,
    ownerId: string,
    ttlMs: number,
    leaseId = "lease_" + randomUUID().replaceAll("-", "").slice(0, 20),
    acquiredAt = new Date().toISOString(),
  ): ProjectLease {
    const acquiredDate = new Date();
    return {
      leaseId,
      projectRoot,
      ownerId,
      acquiredAt,
      expiresAt: new Date(acquiredDate.getTime() + Math.max(1, ttlMs)).toISOString(),
    };
  }

  private isExpired(lease: ProjectLease): boolean {
    return Date.parse(lease.expiresAt) <= Date.now();
  }
}
