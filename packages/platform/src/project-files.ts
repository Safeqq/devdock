import type { BigIntStats } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type ProjectFileErrorCode =
  | "PATH_INVALID"
  | "NETWORK_PATH_UNSUPPORTED"
  | "DIRECTORY_UNREADABLE"
  | "DIRECTORY_REQUIRED"
  | "CWD_OUTSIDE_PROJECT"
  | "PACKAGE_NOT_FOUND"
  | "PACKAGE_UNREADABLE"
  | "PACKAGE_TOO_LARGE"
  | "PACKAGE_JSON_INVALID"
  | "PACKAGE_SCRIPTS_INVALID";

export class ProjectFileError extends Error {
  constructor(
    readonly code: ProjectFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectFileError";
  }
}

export interface ResolvedDirectory {
  displayPath: string;
  canonicalPath: string;
  identityKey: string | null;
}

export interface DiscoveredPackage {
  cwd: Pick<ResolvedDirectory, "displayPath" | "canonicalPath">;
  packageName?: string;
  scriptNames: string[];
  // Scripts in package.json order, with the command text each one runs.
  scripts: { name: string; command: string }[];
}

function rejectNetworkPath(path: string): void {
  if (process.platform === "win32" && path.startsWith("\\\\")) {
    throw new ProjectFileError(
      "NETWORK_PATH_UNSUPPORTED",
      "UNC and extended network paths are not supported for project directories",
    );
  }
}

function within(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
}

async function directory(path: string): Promise<ResolvedDirectory> {
  if (typeof path !== "string" || path.trim() === "") {
    throw new ProjectFileError("PATH_INVALID", "Project directory must be a non-empty path");
  }
  const displayPath = resolve(path);
  rejectNetworkPath(displayPath);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(displayPath);
  } catch {
    throw new ProjectFileError(
      "DIRECTORY_UNREADABLE",
      "Project directory does not exist or is unreadable",
    );
  }
  rejectNetworkPath(canonicalPath);
  let details: BigIntStats;
  try {
    details = await stat(canonicalPath, { bigint: true });
  } catch {
    throw new ProjectFileError(
      "DIRECTORY_UNREADABLE",
      "Project directory does not exist or is unreadable",
    );
  }
  if (!details.isDirectory()) {
    throw new ProjectFileError("DIRECTORY_REQUIRED", "Project path must be a directory");
  }
  return {
    displayPath,
    canonicalPath,
    identityKey: details.ino > 0n ? `${details.dev}:${details.ino}` : null,
  };
}

export function isInsideProject(root: string, target: string): boolean {
  return within(root, target);
}

export async function resolveProjectDirectory(path: string): Promise<ResolvedDirectory> {
  return directory(path);
}

export async function resolveServiceDirectory(
  project: Pick<ResolvedDirectory, "displayPath" | "canonicalPath">,
  cwd = ".",
): Promise<ResolvedDirectory> {
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw new ProjectFileError("PATH_INVALID", "Service cwd must be a non-empty path");
  }
  const resolved = await directory(resolve(project.displayPath, cwd));
  if (!within(project.canonicalPath, resolved.canonicalPath)) {
    throw new ProjectFileError("CWD_OUTSIDE_PROJECT", "Service cwd must stay inside the project");
  }
  return resolved;
}

export async function discoverPackageScripts(
  project: Pick<ResolvedDirectory, "displayPath" | "canonicalPath">,
  cwd = ".",
): Promise<DiscoveredPackage> {
  const resolvedCwd = await resolveServiceDirectory(project, cwd);
  const packagePath = join(resolvedCwd.canonicalPath, "package.json");
  let canonicalPackagePath: string;
  try {
    canonicalPackagePath = await realpath(packagePath);
  } catch {
    throw new ProjectFileError("PACKAGE_NOT_FOUND", "No package.json exists in the selected cwd");
  }
  if (!within(project.canonicalPath, canonicalPackagePath)) {
    throw new ProjectFileError("CWD_OUTSIDE_PROJECT", "package.json must stay inside the project");
  }
  let contents: string;
  try {
    const details = await stat(canonicalPackagePath);
    if (!details.isFile()) {
      throw new ProjectFileError("PACKAGE_UNREADABLE", "package.json is not a regular file");
    }
    if (details.size > 1_048_576) {
      throw new ProjectFileError(
        "PACKAGE_TOO_LARGE",
        "package.json exceeds the 1 MiB discovery limit",
      );
    }
    contents = await readFile(canonicalPackagePath, "utf8");
  } catch (error) {
    if (error instanceof ProjectFileError) throw error;
    throw new ProjectFileError("PACKAGE_UNREADABLE", "package.json cannot be read");
  }
  if (Buffer.byteLength(contents, "utf8") > 1_048_576) {
    throw new ProjectFileError(
      "PACKAGE_TOO_LARGE",
      "package.json exceeds the 1 MiB discovery limit",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new ProjectFileError("PACKAGE_JSON_INVALID", "package.json contains invalid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProjectFileError("PACKAGE_JSON_INVALID", "package.json must contain a JSON object");
  }
  const packageData = parsed as Record<string, unknown>;
  const scripts = packageData.scripts;
  if (
    scripts !== undefined &&
    (scripts === null || typeof scripts !== "object" || Array.isArray(scripts))
  ) {
    throw new ProjectFileError("PACKAGE_SCRIPTS_INVALID", "package.json scripts must be an object");
  }
  const declared = scripts === undefined ? [] : Object.keys(scripts);
  const scriptNames = [...declared].sort();
  for (const name of scriptNames) {
    if (typeof (scripts as Record<string, unknown>)[name] !== "string") {
      throw new ProjectFileError(
        "PACKAGE_SCRIPTS_INVALID",
        "package.json scripts must contain strings",
      );
    }
  }
  const packageName = packageData.name;
  return {
    cwd: { displayPath: resolvedCwd.displayPath, canonicalPath: resolvedCwd.canonicalPath },
    ...(typeof packageName === "string" ? { packageName } : {}),
    scriptNames,
    scripts: declared.map((name) => ({
      name,
      command: (scripts as Record<string, string>)[name] as string,
    })),
  };
}
