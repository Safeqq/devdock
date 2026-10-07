import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const versionCheckPath = fileURLToPath(new URL("./check-workspace-versions.mjs", import.meta.url));
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/u;
const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

class UsageError extends Error {}

function usage() {
  return `Usage: node scripts/set-workspace-version.mjs <version> [--date YYYY-MM-DD] [--write]

Preview a consistent DevDock release version and changelog update. Files are only
changed when --write is present. The date defaults to the current UTC date.
`;
}

function isValidDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date;
}

function parseArguments(arguments_) {
  if (arguments_.length === 1 && (arguments_[0] === "--help" || arguments_[0] === "-h")) {
    return { help: true };
  }
  let write = false;
  let date;
  let version;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--write") {
      if (write) throw new UsageError(usage());
      write = true;
    } else if (argument === "--date") {
      if (date !== undefined || index + 1 >= arguments_.length) throw new UsageError(usage());
      date = arguments_[index + 1];
      index += 1;
    } else if (argument.startsWith("-") || version !== undefined) {
      throw new UsageError(usage());
    } else {
      version = argument;
    }
  }
  if (version === undefined) throw new UsageError(usage());
  if (!semverPattern.test(version)) {
    throw new UsageError(`Invalid release version: ${version}\n\n${usage()}`);
  }
  date ??= new Date().toISOString().slice(0, 10);
  if (!isValidDate(date)) throw new UsageError(`Invalid release date: ${date}\n\n${usage()}`);
  return { help: false, version, write, date };
}

function readJsonRecord(path) {
  const original = readFileSync(path, "utf8");
  return { path, original, value: JSON.parse(original) };
}

function toRepositoryPath(path) {
  return relative(repositoryRoot, path).split(sep).join("/");
}

function findWorkspaceDirectories(workspacePatterns) {
  const directories = [];
  for (const pattern of workspacePatterns) {
    if (typeof pattern !== "string" || !pattern.endsWith("/*")) {
      throw new Error(`Unsupported workspace pattern: ${JSON.stringify(pattern)}`);
    }
    const parent = join(repositoryRoot, pattern.slice(0, -2));
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(parent, entry.name);
      if (existsSync(join(directory, "package.json"))) directories.push(directory);
    }
  }
  return directories.sort((left, right) => left.localeCompare(right));
}

function runVersionCheck() {
  const result = spawnSync(process.execPath, [versionCheckPath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`Workspace version check failed${details.length > 0 ? `:\n${details}` : ""}`);
  }
}

function updateInternalDependencies(manifest, workspaceNames, currentVersion, nextVersion) {
  for (const section of dependencySections) {
    const dependencies = manifest[section];
    if (dependencies === undefined) continue;
    for (const [name, requestedVersion] of Object.entries(dependencies)) {
      if (!workspaceNames.has(name)) continue;
      if (requestedVersion !== currentVersion) {
        throw new Error(
          `${section}.${name} must be ${currentVersion} before the version can be changed`,
        );
      }
      dependencies[name] = nextVersion;
    }
  }
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function prepareChangelog(contents, version, date) {
  const unreleasedHeadings = [...contents.matchAll(/^## Unreleased[ \t]*\r?$/gmu)];
  if (unreleasedHeadings.length !== 1) {
    throw new Error("CHANGELOG.md must contain exactly one level-two Unreleased heading");
  }
  const versionHeading = `## ${version}`;
  if (
    contents
      .split(/\r?\n/u)
      .some((line) => line === versionHeading || line.startsWith(`${versionHeading} - `))
  ) {
    throw new Error(`CHANGELOG.md already contains a ${version} release heading`);
  }
  const [unreleased] = unreleasedHeadings;
  const headingEnd = unreleased.index + unreleased[0].length;
  const afterUnreleased = contents.slice(headingEnd);
  const nextRelease = /^## [^\r\n]+/mu.exec(afterUnreleased);
  const unreleasedContents =
    nextRelease === null ? afterUnreleased : afterUnreleased.slice(0, nextRelease.index);
  if (unreleasedContents.trim().length === 0) {
    throw new Error("CHANGELOG.md Unreleased section is empty");
  }
  return `${contents.slice(0, headingEnd)}\n\n## ${version} - ${date}${afterUnreleased}`;
}

async function writeChanges(changes) {
  const written = [];
  try {
    for (const change of changes) {
      await writeFile(change.path, change.next, "utf8");
      written.push(change);
    }
    runVersionCheck();
  } catch (error) {
    const rollbackErrors = [];
    for (const change of written.reverse()) {
      try {
        await writeFile(change.path, change.original, "utf8");
      } catch (rollbackError) {
        rollbackErrors.push(`${toRepositoryPath(change.path)}: ${rollbackError.message}`);
      }
    }
    const suffix =
      rollbackErrors.length === 0
        ? "All written files were restored."
        : `Rollback also failed:\n${rollbackErrors.join("\n")}`;
    throw new Error(`${error.message}\n${suffix}`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  runVersionCheck();
  const rootRecord = readJsonRecord(join(repositoryRoot, "package.json"));
  const currentVersion = rootRecord.value.version;
  if (!semverPattern.test(currentVersion)) {
    throw new Error(`Current package version is not supported SemVer: ${currentVersion}`);
  }
  if (options.version === currentVersion) {
    throw new UsageError(`DevDock already uses version ${currentVersion}`);
  }

  const workspacePatterns = rootRecord.value.workspaces;
  if (!Array.isArray(workspacePatterns) || workspacePatterns.length === 0) {
    throw new Error("package.json must define at least one workspace pattern");
  }
  const manifestRecords = [rootRecord];
  for (const directory of findWorkspaceDirectories(workspacePatterns)) {
    manifestRecords.push(readJsonRecord(join(directory, "package.json")));
  }
  const workspaceNames = new Set(manifestRecords.map((record) => record.value.name));

  for (const record of manifestRecords) {
    if (record.value.version !== currentVersion) {
      throw new Error(`${toRepositoryPath(record.path)} does not use ${currentVersion}`);
    }
    record.value.version = options.version;
    updateInternalDependencies(record.value, workspaceNames, currentVersion, options.version);
  }

  const lockRecord = readJsonRecord(join(repositoryRoot, "package-lock.json"));
  if (lockRecord.value.version !== currentVersion) {
    throw new Error(`package-lock.json does not use ${currentVersion}`);
  }
  lockRecord.value.version = options.version;
  for (const record of manifestRecords) {
    const lockPath = record === rootRecord ? "" : toRepositoryPath(dirname(record.path));
    const lockedManifest = lockRecord.value.packages?.[lockPath];
    if (lockedManifest === undefined) {
      throw new Error(`package-lock.json is missing workspace entry ${JSON.stringify(lockPath)}`);
    }
    if (lockedManifest.version !== currentVersion) {
      throw new Error(`package-lock.json workspace ${JSON.stringify(lockPath)} is out of sync`);
    }
    lockedManifest.version = options.version;
    updateInternalDependencies(lockedManifest, workspaceNames, currentVersion, options.version);
  }

  const changes = [...manifestRecords, lockRecord].map((record) => ({
    path: record.path,
    original: record.original,
    next: serializeJson(record.value),
  }));
  const readmePath = join(repositoryRoot, "README.md");
  if (existsSync(readmePath)) {
    const original = readFileSync(readmePath, "utf8");
    const next = original.replaceAll(`devdock-${currentVersion}`, `devdock-${options.version}`);
    if (next !== original) changes.push({ path: readmePath, original, next });
  }
  const changelogPath = join(repositoryRoot, "CHANGELOG.md");
  if (!existsSync(changelogPath)) throw new Error("CHANGELOG.md is required for a release version");
  const changelog = readFileSync(changelogPath, "utf8");
  changes.push({
    path: changelogPath,
    original: changelog,
    next: prepareChangelog(changelog, options.version, options.date),
  });

  const changedPaths = changes.map((change) => toRepositoryPath(change.path));
  if (!options.write) {
    process.stdout.write(
      `Release preview: ${currentVersion} -> ${options.version} (${options.date})\n${changedPaths.map((path) => `- ${path}`).join("\n")}\nNo files written. Re-run with --write to apply this release version.\n`,
    );
    return;
  }

  await writeChanges(changes);
  process.stdout.write(
    `Release version updated: ${currentVersion} -> ${options.version} (${options.date})\n${changedPaths.map((path) => `- ${path}`).join("\n")}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
});
