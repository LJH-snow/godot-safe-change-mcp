import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
let consumerRoot = await mkdtemp(path.join(tmpdir(), "godot-safe-change-package-"));
let extractedPackageRoot;
let tarballPath;

try {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--ignore-scripts"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }),
  );
  tarballPath = path.join(repositoryRoot, packed[0].filename);

  const install = spawnSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], {
    cwd: consumerRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (install.status !== 0) {
    if (!`${install.stdout}\n${install.stderr}`.includes("EALLOWSCRIPTS")) {
      throw new Error(`Package installation failed.\n${install.stdout}\n${install.stderr}`);
    }
    await rm(consumerRoot, { recursive: true, force: true });
    consumerRoot = await mkdtemp(path.join(repositoryRoot, ".package-smoke-"));
    execFileSync("tar", ["-xzf", tarballPath, "-C", consumerRoot]);
    extractedPackageRoot = path.join(consumerRoot, "package");
  }

  const installedRoot = extractedPackageRoot ?? path.join(consumerRoot, "node_modules", packageJson.name);
  const requiredFiles = [
    "package.json",
    "bin/mcp-server.mjs",
    ".mcp-use/build/index.js",
    "godot-plugin/plugin.gd",
    "godot-plugin/plugin.cfg",
  ];
  await Promise.all(requiredFiles.map((file) => access(path.join(installedRoot, file))));
  const installedPackage = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8"));
  if (installedPackage.name !== packageJson.name || installedPackage.version !== packageJson.version) {
    throw new Error("Installed package metadata does not match the source package.");
  }
  const bundle = await import(pathToFileURL(path.join(installedRoot, ".mcp-use/build/index.js")).href);
  if (bundle.default === undefined) {
    throw new Error("The packaged MCP bundle does not expose a default server.");
  }
  console.log(`Package smoke passed: ${packageJson.name}@${packageJson.version}`);
} finally {
  await rm(consumerRoot, { recursive: true, force: true });
  if (tarballPath !== undefined) {
    await rm(tarballPath, { force: true });
  }
}
