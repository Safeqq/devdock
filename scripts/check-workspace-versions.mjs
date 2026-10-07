import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function readJson(path, errors) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${relative(repositoryRoot, path)}: ${error.message}`);
    return undefined;
  }
}

function toLockPath(path) {
  return relative(repositoryRoot, path).split(sep).join("/");
}

function findWorkspaceDirectories(patterns, errors) {
  const directories = [];
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || !pattern.endsWith("/*")) {
      errors.push(`package.json: unsupported workspace pattern ${JSON.stringify(pattern)}`);
      continue;
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

function validateInternalDependencies(manifest, label, versionsByName, errors) {
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const dependencies = manifest[section];
    if (dependencies === undefined) continue;
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      errors.push(`${label}: ${section} must be an object`);
      continue;
    }
    for (const [name, requestedVersion] of Object.entries(dependencies)) {
      const workspaceVersion = versionsByName.get(name);
      if (workspaceVersion !== undefined && requestedVersion !== workspaceVersion) {
        errors.push(
          `${label}: ${section}.${name} must be ${workspaceVersion}, found ${JSON.stringify(requestedVersion)}`,
        );
      }
    }
  }
}

const errors = [];
const rootManifestPath = join(repositoryRoot, "package.json");
const rootManifest = readJson(rootManifestPath, errors);

if (rootManifest === undefined) {
  process.exitCode = 1;
} else {
  const workspacePatterns = Array.isArray(rootManifest.workspaces) ? rootManifest.workspaces : [];
  if (workspacePatterns.length === 0) errors.push("package.json: workspaces must not be empty");

  const workspaceDirectories = findWorkspaceDirectories(workspacePatterns, errors);
  const manifests = [{ directory: repositoryRoot, label: "package.json", value: rootManifest }];
  for (const directory of workspaceDirectories) {
    const path = join(directory, "package.json");
    const value = readJson(path, errors);
    if (value !== undefined) {
      manifests.push({ directory, label: `${toLockPath(directory)}/package.json`, value });
    }
  }

  const expectedVersion = rootManifest.version;
  if (typeof expectedVersion !== "string" || expectedVersion.length === 0) {
    errors.push("package.json: version must be a non-empty string");
  }

  const versionsByName = new Map();
  for (const manifest of manifests) {
    const { name, version } = manifest.value;
    if (typeof name !== "string" || name.length === 0) {
      errors.push(`${manifest.label}: name must be a non-empty string`);
    } else if (versionsByName.has(name)) {
      errors.push(`${manifest.label}: duplicate workspace name ${name}`);
    } else {
      versionsByName.set(name, expectedVersion);
    }
    if (version !== expectedVersion) {
      errors.push(
        `${manifest.label}: version must match root ${JSON.stringify(expectedVersion)}, found ${JSON.stringify(version)}`,
      );
    }
  }

  for (const manifest of manifests) {
    validateInternalDependencies(manifest.value, manifest.label, versionsByName, errors);
  }

  const lockfile = readJson(join(repositoryRoot, "package-lock.json"), errors);
  if (lockfile !== undefined) {
    if (lockfile.name !== rootManifest.name) {
      errors.push(
        `package-lock.json: name must be ${JSON.stringify(rootManifest.name)}, found ${JSON.stringify(lockfile.name)}`,
      );
    }
    if (lockfile.version !== expectedVersion) {
      errors.push(
        `package-lock.json: version must be ${JSON.stringify(expectedVersion)}, found ${JSON.stringify(lockfile.version)}`,
      );
    }
    if (lockfile.packages === null || typeof lockfile.packages !== "object") {
      errors.push("package-lock.json: packages must be an object");
    } else {
      for (const manifest of manifests) {
        const lockPath =
          manifest.directory === repositoryRoot ? "" : toLockPath(manifest.directory);
        const lockedManifest = lockfile.packages[lockPath];
        if (lockedManifest === undefined) {
          errors.push(`package-lock.json: missing packages[${JSON.stringify(lockPath)}]`);
          continue;
        }
        if (lockedManifest.name !== manifest.value.name) {
          errors.push(
            `package-lock.json packages[${JSON.stringify(lockPath)}]: name must be ${JSON.stringify(manifest.value.name)}, found ${JSON.stringify(lockedManifest.name)}`,
          );
        }
        if (lockedManifest.version !== expectedVersion) {
          errors.push(
            `package-lock.json packages[${JSON.stringify(lockPath)}]: version must be ${JSON.stringify(expectedVersion)}, found ${JSON.stringify(lockedManifest.version)}`,
          );
        }
        if (lockedManifest.version !== manifest.value.version) {
          errors.push(
            `package-lock.json packages[${JSON.stringify(lockPath)}]: version does not match ${manifest.label}`,
          );
        }
        validateInternalDependencies(
          lockedManifest,
          `package-lock.json packages[${JSON.stringify(lockPath)}]`,
          versionsByName,
          errors,
        );
      }
    }
  }

  if (errors.length === 0) {
    console.log(
      `Workspace versions OK: ${manifests.length} manifests and package-lock.json use ${expectedVersion}`,
    );
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
}
