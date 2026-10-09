import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { SpawnRequest } from "./process-adapter.js";

type LaunchPlan = Omit<SpawnRequest, "runId">;

export class NpmLauncherError extends Error {
  constructor(
    readonly code:
      | "NPM_CLI_NOT_FOUND"
      | "SCRIPT_NAME_INVALID"
      | "CWD_INVALID"
      | "ENVIRONMENT_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "NpmLauncherError";
  }
}

const inheritedKeys = [
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOME",
  "TMP",
  "TEMP",
  "TMPDIR",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "LANG",
  "LC_ALL",
] as const;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) return true;
  }
  return false;
}

function setEnvironmentValue(
  environment: Record<string, string>,
  key: string,
  value: string,
): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || value.includes("\0")) {
    throw new NpmLauncherError("ENVIRONMENT_INVALID", "Project environment is invalid");
  }
  const matchingKey =
    process.platform === "win32"
      ? Object.keys(environment).find((candidate) => candidate.toLowerCase() === key.toLowerCase())
      : key in environment
        ? key
        : undefined;
  if (matchingKey !== undefined) delete environment[matchingKey];
  environment[key] = value;
}

function environmentValue(environment: Readonly<Record<string, string>>, key: string): string {
  if (process.platform !== "win32") return environment[key] ?? "";
  const matchingKey = Object.keys(environment).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return matchingKey === undefined ? "" : (environment[matchingKey] ?? "");
}

// Windows variable names are case-insensitive, but a copied environment object is not:
// shells such as Git Bash pass `SYSTEMROOT`, and Node.js cannot start without it.
function sourceValue(sourceEnv: NodeJS.ProcessEnv, key: string): string | undefined {
  if (process.platform !== "win32") return sourceEnv[key];
  return Object.entries(sourceEnv).find(
    ([candidate]) => candidate.toLowerCase() === key.toLowerCase(),
  )?.[1];
}

// "path" is a Node.js installation found on the user's PATH; "daemon" is the Node.js that runs
// DevDock itself, used when no usable installation is on PATH.
export type NodeSource = "path" | "daemon";

// Lists node executables in PATH order. Relative and empty entries are skipped so a project's
// working directory can never supply the interpreter.
async function nodeCandidatesOnPath(sourceEnv: NodeJS.ProcessEnv): Promise<string[]> {
  const pathValue = sourceValue(sourceEnv, process.platform === "win32" ? "Path" : "PATH") ?? "";
  const name = process.platform === "win32" ? "node.exe" : "node";
  const candidates: string[] = [];
  for (const rawEntry of pathValue.split(delimiter)) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/u, "$1");
    if (entry === "" || !isAbsolute(entry)) continue;
    const candidate = join(entry, name);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      if (process.platform !== "win32") await access(candidate, constants.X_OK);
      candidates.push(candidate);
    } catch {
      // Not present or not executable in this PATH entry.
    }
  }
  return candidates;
}

export class NpmLauncher {
  readonly #nodeExecutable: string;
  readonly #npmCliPath: string;
  readonly #nodeSource: NodeSource;

  private constructor(nodeExecutable: string, npmCliPath: string, nodeSource: NodeSource) {
    this.#nodeExecutable = nodeExecutable;
    this.#npmCliPath = npmCliPath;
    this.#nodeSource = nodeSource;
  }

  get nodeExecutable(): string {
    return this.#nodeExecutable;
  }

  get nodeSource(): NodeSource {
    return this.#nodeSource;
  }

  // Prefers the user's own Node.js and npm, so projects run with the version they expect, and
  // falls back to the daemon's Node.js. A PATH entry is used only if npm sits beside it.
  static async locatePreferred(
    sourceEnv: NodeJS.ProcessEnv = process.env,
    daemonNode = process.execPath,
  ): Promise<NpmLauncher> {
    for (const candidate of await nodeCandidatesOnPath(sourceEnv)) {
      try {
        return await NpmLauncher.locate(candidate, "path");
      } catch {
        // A shim or partial installation without npm; try the next PATH entry.
      }
    }
    return NpmLauncher.locate(daemonNode, "daemon");
  }

  static async locate(
    nodeExecutable = process.execPath,
    nodeSource: NodeSource = "daemon",
  ): Promise<NpmLauncher> {
    const executable = await realpath(nodeExecutable);
    const nodeDirectory = dirname(executable);
    const candidates = [
      join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
      resolve(nodeDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
      resolve(nodeDirectory, "..", "node_modules", "npm", "bin", "npm-cli.js"),
    ];
    for (const candidate of candidates) {
      try {
        const canonical = await realpath(candidate);
        if ((await stat(canonical)).isFile()) {
          return new NpmLauncher(executable, canonical, nodeSource);
        }
      } catch {
        // Try the next distribution layout.
      }
    }
    throw new NpmLauncherError("NPM_CLI_NOT_FOUND", "The Node.js installation has no npm CLI");
  }

  plan(
    scriptName: string,
    canonicalCwd: string,
    sourceEnv: NodeJS.ProcessEnv = process.env,
    projectEnv: Readonly<Record<string, string>> = {},
  ): LaunchPlan {
    if (
      typeof scriptName !== "string" ||
      scriptName.length === 0 ||
      scriptName.length > 128 ||
      scriptName.startsWith("-") ||
      hasControlCharacter(scriptName)
    ) {
      throw new NpmLauncherError("SCRIPT_NAME_INVALID", "Selected npm script name is invalid");
    }
    if (typeof canonicalCwd !== "string" || !isAbsolute(canonicalCwd)) {
      throw new NpmLauncherError("CWD_INVALID", "npm cwd must be a canonical absolute path");
    }
    const env: Record<string, string> = {};
    for (const key of inheritedKeys) {
      const value = sourceValue(sourceEnv, key);
      if (value !== undefined) setEnvironmentValue(env, key, value);
    }
    const pathKey = process.platform === "win32" ? "Path" : "PATH";
    setEnvironmentValue(env, pathKey, sourceValue(sourceEnv, pathKey) ?? "");
    for (const [key, value] of Object.entries(projectEnv)) {
      setEnvironmentValue(env, key, value);
    }
    const launchPath = [dirname(this.#nodeExecutable), environmentValue(env, pathKey)]
      .filter((part) => part !== "")
      .join(delimiter);
    setEnvironmentValue(env, pathKey, launchPath);
    return {
      executable: this.#nodeExecutable,
      args: [this.#npmCliPath, "run", scriptName],
      canonicalCwd,
      env,
    };
  }
}
