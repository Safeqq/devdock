import { realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { SpawnRequest } from "./process-adapter.js";

type LaunchPlan = Omit<SpawnRequest, "runId">;

export class NpmLauncherError extends Error {
  constructor(
    readonly code: "NPM_CLI_NOT_FOUND" | "SCRIPT_NAME_INVALID" | "CWD_INVALID",
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

export class NpmLauncher {
  readonly #nodeExecutable: string;
  readonly #npmCliPath: string;

  private constructor(nodeExecutable: string, npmCliPath: string) {
    this.#nodeExecutable = nodeExecutable;
    this.#npmCliPath = npmCliPath;
  }

  static async locate(nodeExecutable = process.execPath): Promise<NpmLauncher> {
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
        if ((await stat(canonical)).isFile()) return new NpmLauncher(executable, canonical);
      } catch {
        // Try the next distribution layout.
      }
    }
    throw new NpmLauncherError(
      "NPM_CLI_NOT_FOUND",
      "The pinned Node.js installation has no npm CLI",
    );
  }

  plan(
    scriptName: string,
    canonicalCwd: string,
    sourceEnv: NodeJS.ProcessEnv = process.env,
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
      const value = sourceEnv[key];
      if (value !== undefined) env[key] = value;
    }
    const pathKey = process.platform === "win32" && sourceEnv.Path !== undefined ? "Path" : "PATH";
    env[pathKey] = [dirname(this.#nodeExecutable), sourceEnv[pathKey] ?? sourceEnv.PATH ?? ""]
      .filter((part) => part !== "")
      .join(delimiter);
    return {
      executable: this.#nodeExecutable,
      args: [this.#npmCliPath, "run", scriptName],
      canonicalCwd,
      env,
    };
  }
}
