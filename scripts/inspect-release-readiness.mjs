import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const artifactsDirectory = join(repositoryRoot, "artifacts");
const versionCheckPath = fileURLToPath(new URL("./check-workspace-versions.mjs", import.meta.url));
const artifactCheckPath = fileURLToPath(new URL("./verify-package-artifact.mjs", import.meta.url));
const reproducibilityCheckPath = fileURLToPath(
  new URL("./verify-package-reproducibility.mjs", import.meta.url),
);
const sbomCheckPath = fileURLToPath(new URL("./verify-sbom.mjs", import.meta.url));
const targets = new Set(["local", "repository", "npm"]);
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/u;

class UsageError extends Error {}

function usage() {
  return `Usage: node scripts/inspect-release-readiness.mjs [--target local|repository|npm] [--strict]

Inspect release metadata and artifacts without publishing anything. The report is
written to ignored artifacts/release-readiness-latest.json. --strict exits with
code 1 when blockers remain.
`;
}

function parseArguments(arguments_) {
  if (arguments_.length === 1 && (arguments_[0] === "--help" || arguments_[0] === "-h")) {
    return { help: true };
  }
  let target = "local";
  let strict = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--strict") {
      if (strict) throw new UsageError(usage());
      strict = true;
    } else if (argument === "--target") {
      if (index + 1 >= arguments_.length) throw new UsageError(usage());
      target = arguments_[index + 1];
      index += 1;
    } else {
      throw new UsageError(usage());
    }
  }
  if (!targets.has(target)) throw new UsageError(`Unknown release target: ${target}\n\n${usage()}`);
  return { help: false, target, strict };
}

function sanitize(message) {
  return message.split(repositoryRoot).join("<repository>").split(tmpdir()).join("<temporary>");
}

function runCheck(path) {
  const result = spawnSync(process.execPath, [path], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error !== undefined) return { passed: false, details: sanitize(result.error.message) };
  const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return { passed: result.status === 0, details: sanitize(details) };
}

function findWorkspaceManifests(rootManifest) {
  if (!Array.isArray(rootManifest.workspaces)) return [];
  const manifests = [];
  for (const pattern of rootManifest.workspaces) {
    if (typeof pattern !== "string" || !pattern.endsWith("/*")) continue;
    const parent = join(repositoryRoot, pattern.slice(0, -2));
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(parent, entry.name, "package.json");
      if (existsSync(path)) manifests.push({ path, value: JSON.parse(readFileSync(path, "utf8")) });
    }
  }
  return manifests.sort((left, right) => left.path.localeCompare(right.path));
}

function repositoryMetadataPresent(repository) {
  if (typeof repository === "string") return repository.trim().length > 0;
  return (
    repository !== null &&
    typeof repository === "object" &&
    typeof repository.url === "string" &&
    repository.url.trim().length > 0
  );
}

function inspectChangelog(version) {
  const path = join(repositoryRoot, "CHANGELOG.md");
  if (!existsSync(path)) {
    return { heading: false, unreleasedEmpty: false, message: "CHANGELOG.md is missing" };
  }
  const contents = readFileSync(path, "utf8");
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const heading = new RegExp(`^## ${escapedVersion} - \\d{4}-\\d{2}-\\d{2}$`, "mu").test(contents);
  const unreleased = /^## Unreleased[ \t]*\r?$/gmu.exec(contents);
  if (unreleased === null) {
    return { heading, unreleasedEmpty: false, message: "Unreleased heading is missing" };
  }
  const afterUnreleased = contents.slice(unreleased.index + unreleased[0].length);
  const nextRelease = /^## [^\r\n]+/mu.exec(afterUnreleased);
  const pending =
    nextRelease === null ? afterUnreleased : afterUnreleased.slice(0, nextRelease.index);
  return {
    heading,
    unreleasedEmpty: pending.trim().length === 0,
    message: heading
      ? "Changelog release heading matches"
      : `Changelog has no ${version} release heading`,
  };
}

function addCheck(checks, id, passed, success, failure) {
  checks.push({ id, status: passed ? "pass" : "blocker", message: passed ? success : failure });
}

function addSkipped(checks, id, message) {
  checks.push({ id, status: "skipped", message });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  const workspaces = findWorkspaceManifests(manifest);
  const checks = [];
  addCheck(
    checks,
    "version-semver",
    typeof manifest.version === "string" && semverPattern.test(manifest.version),
    `Version ${manifest.version} is valid SemVer`,
    `Version ${String(manifest.version)} is not supported SemVer`,
  );
  addCheck(
    checks,
    "version-placeholder",
    manifest.version !== "0.0.0",
    `Version ${manifest.version} is a release version`,
    "Version 0.0.0 is still the development placeholder",
  );

  const versions = runCheck(versionCheckPath);
  addCheck(
    checks,
    "workspace-versions",
    versions.passed,
    "Workspace manifests, internal pins, and lockfile are synchronized",
    versions.details || "Workspace version check failed",
  );
  const privateWorkspace = workspaces.find((workspace) => workspace.value.private !== true);
  const privateWorkspacePath =
    privateWorkspace === undefined
      ? ""
      : relative(repositoryRoot, privateWorkspace.path).split(sep).join("/");
  addCheck(
    checks,
    "internal-workspaces-private",
    privateWorkspace === undefined,
    "All internal workspaces remain private",
    `${privateWorkspacePath} must remain private`,
  );

  const changelog = inspectChangelog(String(manifest.version));
  addCheck(checks, "changelog-version", changelog.heading, changelog.message, changelog.message);
  addCheck(
    checks,
    "changelog-unreleased",
    changelog.unreleasedEmpty,
    "Unreleased changelog content has been promoted",
    "Unreleased changelog content is still pending",
  );

  const artifact = runCheck(artifactCheckPath);
  addCheck(
    checks,
    "artifact-evidence",
    artifact.passed,
    "Tarball, evidence report, and checksum match the current manifest",
    artifact.details || "Artifact verification failed",
  );
  const reproducibility = runCheck(reproducibilityCheckPath);
  addCheck(
    checks,
    "artifact-current",
    reproducibility.passed,
    "Promoted artifact matches a fresh npm pack byte for byte",
    reproducibility.details || "Fresh package comparison failed",
  );
  const sbom = runCheck(sbomCheckPath);
  addCheck(
    checks,
    "sbom-evidence",
    sbom.passed,
    "Production SBOM matches the package artifact and current lockfile",
    sbom.details || "SBOM verification failed",
  );

  const publicTarget = options.target === "repository" || options.target === "npm";
  if (publicTarget) {
    const licenseMetadata =
      typeof manifest.license === "string" &&
      manifest.license.trim().length > 0 &&
      manifest.license !== "UNLICENSED";
    addCheck(
      checks,
      "license-metadata",
      licenseMetadata,
      `Package license metadata is ${manifest.license}`,
      "Package license metadata has not been selected",
    );
    const licenseFile = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md"].find(
      (name) => existsSync(join(repositoryRoot, name)),
    );
    addCheck(
      checks,
      "license-file",
      licenseFile !== undefined,
      `License text is recorded in ${licenseFile}`,
      "A license file has not been selected",
    );
    addCheck(
      checks,
      "repository-metadata",
      repositoryMetadataPresent(manifest.repository),
      "Package repository metadata is present",
      "Package repository metadata is missing",
    );
  } else {
    addSkipped(checks, "license-metadata", "Local target does not require public license metadata");
    addSkipped(checks, "license-file", "Local target does not require a public license file");
    addSkipped(checks, "repository-metadata", "Local target does not require repository metadata");
  }

  if (options.target === "npm") {
    addCheck(
      checks,
      "root-package-private",
      manifest.private !== true,
      "Root package is publishable",
      "Root package is private and npm publication is blocked",
    );
  } else {
    addSkipped(
      checks,
      "root-package-private",
      `${options.target} target may keep the root package private`,
    );
  }

  const blockers = checks.filter((check) => check.status === "blocker");
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: options.target,
    version: manifest.version,
    ready: blockers.length === 0,
    checks,
  };
  await mkdir(artifactsDirectory, { recursive: true });
  const reportPath = join(artifactsDirectory, "release-readiness-latest.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  process.stdout.write(
    `Release readiness (${options.target}): ${report.ready ? "READY" : "BLOCKED"}\n`,
  );
  for (const check of checks) {
    process.stdout.write(`${check.status.toUpperCase()} ${check.id}: ${check.message}\n`);
  }
  process.stdout.write("Report: artifacts/release-readiness-latest.json\n");
  if (options.strict && !report.ready) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
});
