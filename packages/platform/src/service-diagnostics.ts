import { readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseEnv } from "node:util";

const MAX_ENV_FILE_BYTES = 1_048_576;
const PORT_CHECK_TIMEOUT_MS = 1_000;
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export type EnvironmentFileStatus =
  | "loaded"
  | "missing"
  | "unreadable"
  | "invalid"
  | "too_large"
  | "outside_cwd";

export interface InspectedEnvironmentFile {
  readonly path: string;
  readonly status: EnvironmentFileStatus;
}

export interface EnvironmentInspection {
  readonly files: InspectedEnvironmentFile[];
  readonly values: Record<string, string>;
}

export type LoopbackPortStatus = "available" | "in_use" | "unknown";

function inside(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
}

function missing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function setEnvironmentValue(target: Record<string, string>, key: string, value: string): void {
  const matchingKey =
    process.platform === "win32"
      ? Object.keys(target).find((candidate) => candidate.toLowerCase() === key.toLowerCase())
      : key in target
        ? key
        : undefined;
  if (matchingKey !== undefined) delete target[matchingKey];
  target[key] = value;
}

function lexicalTarget(canonicalCwd: string, reference: string): string | null {
  if (isAbsolute(reference)) return null;
  const target = resolve(canonicalCwd, reference);
  return inside(canonicalCwd, target) ? target : null;
}

export function environmentReferenceStaysInside(canonicalCwd: string, reference: string): boolean {
  return lexicalTarget(canonicalCwd, reference) !== null;
}

export function hasEnvironmentKey(
  environment: Readonly<Record<string, string>>,
  key: string,
): boolean {
  if (process.platform !== "win32") return Object.hasOwn(environment, key);
  const expected = key.toLowerCase();
  return Object.keys(environment).some((candidate) => candidate.toLowerCase() === expected);
}

export async function inspectEnvironmentFiles(
  canonicalCwd: string,
  references: readonly string[],
): Promise<EnvironmentInspection> {
  const files: InspectedEnvironmentFile[] = [];
  const values: Record<string, string> = {};
  let inspectionRoot: string;
  try {
    inspectionRoot = await realpath(canonicalCwd);
  } catch {
    return {
      files: references.map((reference) => ({ path: reference, status: "unreadable" })),
      values,
    };
  }

  for (const reference of references) {
    const target = lexicalTarget(inspectionRoot, reference);
    if (target === null) {
      files.push({ path: reference, status: "outside_cwd" });
      continue;
    }

    let canonicalTarget: string;
    try {
      canonicalTarget = await realpath(target);
    } catch (error) {
      files.push({ path: reference, status: missing(error) ? "missing" : "unreadable" });
      continue;
    }
    if (!inside(inspectionRoot, canonicalTarget)) {
      files.push({ path: reference, status: "outside_cwd" });
      continue;
    }

    try {
      const details = await stat(canonicalTarget);
      if (!details.isFile()) {
        files.push({ path: reference, status: "invalid" });
        continue;
      }
      if (details.size > MAX_ENV_FILE_BYTES) {
        files.push({ path: reference, status: "too_large" });
        continue;
      }
      const contents = await readFile(canonicalTarget);
      if (contents.byteLength > MAX_ENV_FILE_BYTES) {
        files.push({ path: reference, status: "too_large" });
        continue;
      }
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(contents);
      const parsed = parseEnv(decoded);
      for (const [key, value] of Object.entries(parsed)) {
        if (value === undefined || !ENVIRONMENT_KEY_PATTERN.test(key)) {
          throw new Error("Environment entry is invalid");
        }
        setEnvironmentValue(values, key, value);
      }
      files.push({ path: reference, status: "loaded" });
    } catch {
      files.push({ path: reference, status: "invalid" });
    }
  }

  return { files, values };
}

export async function checkLoopbackPort(port: number): Promise<LoopbackPortStatus> {
  return new Promise((resolveStatus) => {
    const server = createServer();
    server.unref();
    let settled = false;
    const settle = (status: LoopbackPortStatus): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveStatus(status);
    };
    const timer = setTimeout(() => {
      if (server.listening) server.close();
      settle("unknown");
    }, PORT_CHECK_TIMEOUT_MS);
    timer.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      settle(error.code === "EADDRINUSE" ? "in_use" : "unknown");
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => settle(error === undefined ? "available" : "unknown"));
    });
  });
}
