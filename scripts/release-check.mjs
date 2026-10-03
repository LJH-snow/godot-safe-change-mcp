import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_CI_JOBS = [
  "check",
  "npm package boundary",
  "Godot 4.5.1 runtime",
  "Godot 4.7.2 runtime",
];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function repositorySlug(packageJson) {
  const repositoryUrl = typeof packageJson.repository === "object" ? packageJson.repository.url : packageJson.repository;
  if (typeof repositoryUrl !== "string") {
    return null;
  }
  const withoutGitPrefix = repositoryUrl.startsWith("git+") ? repositoryUrl.slice(4) : repositoryUrl;
  const withoutGitSuffix = withoutGitPrefix.endsWith(".git") ? withoutGitPrefix.slice(0, -4) : withoutGitPrefix;
  try {
    const parsed = new URL(withoutGitSuffix);
    if (parsed.hostname.toLowerCase() !== "github.com") {
      return null;
    }
    const parts = parsed.pathname.split("/").filter((part) => part.length > 0);
    return parts.length === 2 ? { owner: parts[0], repo: parts[1] } : null;
  } catch {
    return null;
  }
}

function isSha(value) {
  return typeof value === "string" && value.length === 40 && [...value].every((character) => "0123456789abcdefABCDEF".includes(character));
}

function isDigits(value) {
  return typeof value === "string" && value.length > 0 && [...value].every((character) => "0123456789".includes(character));
}

function hasDatedChangelogHeading(changelog, version) {
  const prefix = "## " + version + " - ";
  return changelog.split(String.fromCharCode(10)).some((line) => {
    if (!line.startsWith(prefix) || line.length !== prefix.length + 10) {
      return false;
    }
    const date = line.slice(prefix.length);
    return date[4] === "-" && date[7] === "-" && isDigits(date.slice(0, 4)) && isDigits(date.slice(5, 7)) && isDigits(date.slice(8));
  });
}

function safeArtifactPath(repositoryRoot, relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    return null;
  }
  const absolutePath = path.resolve(repositoryRoot, relativePath);
  const normalizedRoot = path.resolve(repositoryRoot) + path.sep;
  return absolutePath.startsWith(normalizedRoot) ? absolutePath : null;
}

export function validateReleaseManifest({ packageJson, packageLock, manifest, repositoryRoot, expectedHeadSha }) {
  const errors = [];
  const packageVersion = packageJson.version;
  const lockRoot = packageLock.packages?.[""];
  const slug = repositorySlug(packageJson);

  if (typeof packageVersion !== "string" || packageVersion.length === 0) {
    errors.push("package.json must define a non-empty version.");
  }
  if (lockRoot?.version !== packageVersion) {
    errors.push("package-lock.json root version does not match package.json.");
  }
  if (typeof manifest !== "object" || manifest === null) {
    errors.push("release manifest must be a JSON object.");
    return { errors };
  }

  const expectedTag = "v" + packageVersion;
  if (manifest.version !== packageVersion) {
    errors.push("release manifest version must be " + packageVersion + ".");
  }
  if (manifest.tag !== expectedTag) {
    errors.push("release manifest tag must be " + expectedTag + ".");
  }
  if (!isSha(manifest.commit)) {
    errors.push("release manifest commit must be a 40-character Git SHA.");
  }
  if (expectedHeadSha !== undefined && manifest.commit !== expectedHeadSha) {
    errors.push("release manifest commit does not match the expected release head.");
  }

  if (slug === null) {
    errors.push("package.json repository must point to a GitHub repository.");
  } else {
    const ciPrefix = "https://github.com/" + slug.owner + "/" + slug.repo + "/actions/runs/";
    const ciRunId = typeof manifest.ciRunUrl === "string" && manifest.ciRunUrl.startsWith(ciPrefix)
      ? manifest.ciRunUrl.slice(ciPrefix.length)
      : null;
    if (ciRunId === null || !isDigits(ciRunId)) {
      errors.push("release manifest ciRunUrl must point to this repository's GitHub Actions run.");
    }
  }

  if (!Array.isArray(manifest.ciJobs)) {
    errors.push("release manifest ciJobs must be an array.");
  } else {
    for (const requiredJob of REQUIRED_CI_JOBS) {
      if (!manifest.ciJobs.includes(requiredJob)) {
        errors.push("release manifest ciJobs is missing " + requiredJob + ".");
      }
    }
  }

  const artifacts = manifest.artifacts;
  if (typeof artifacts !== "object" || artifacts === null) {
    errors.push("release manifest artifacts must be an object.");
  } else {
    const publicReadmes = ["README.md", "README.en.md"];
    for (const [artifactName, artifactPath] of Object.entries(artifacts)) {
      const absolutePath = safeArtifactPath(repositoryRoot, artifactPath);
      if (absolutePath === null || !existsSync(absolutePath)) {
        errors.push("release artifact " + artifactName + " does not exist inside the repository: " + String(artifactPath) + ".");
      }
    }
    const starterPath = artifacts.starter;
    const demoPath = artifacts.demo;
    if (typeof starterPath !== "string" || typeof demoPath !== "string") {
      errors.push("release manifest artifacts must define starter and demo paths.");
    } else {
      for (const readmePath of publicReadmes) {
        const readme = readFileSync(path.join(repositoryRoot, readmePath), "utf8");
        if (!readme.includes(starterPath)) {
          errors.push(readmePath + " must link to the release starter artifact.");
        }
        if (!readme.includes(demoPath)) {
          errors.push(readmePath + " must link to the release demo artifact.");
        }
      }
    }
  }

  const changelog = readFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "utf8");
  if (typeof packageVersion === "string" && !hasDatedChangelogHeading(changelog, packageVersion)) {
    errors.push("CHANGELOG.md must contain a dated " + packageVersion + " heading.");
  }

  return {
    errors,
    version: packageVersion,
    tag: manifest.tag,
    commit: manifest.commit,
    ciRunUrl: manifest.ciRunUrl,
    ciJobs: manifest.ciJobs,
    artifacts: manifest.artifacts,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--manifest") {
      options.manifestPath = argv[index + 1];
      index += 1;
    } else if (argument === "--head") {
      options.expectedHeadSha = argv[index + 1];
      index += 1;
    } else if (argument !== undefined) {
      throw new Error("Unknown argument: " + argument);
    }
  }
  return options;
}

function run() {
  const repositoryRoot = process.cwd();
  const packageJson = readJson(path.join(repositoryRoot, "package.json"));
  const options = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(
    repositoryRoot,
    options.manifestPath ?? path.join("docs", "releases", "v" + packageJson.version + ".json"),
  );
  const result = validateReleaseManifest({
    packageJson,
    packageLock: readJson(path.join(repositoryRoot, "package-lock.json")),
    manifest: readJson(manifestPath),
    repositoryRoot,
    expectedHeadSha: options.expectedHeadSha,
  });
  if (result.errors.length > 0) {
    console.error(["Release artifact check failed:", ...result.errors.map((error) => "- " + error)].join(String.fromCharCode(10)));
    process.exitCode = 1;
    return;
  }
  console.log("Release artifact check passed: " + result.tag + " commit=" + result.commit + " ci=" + result.ciRunUrl);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run();
}
