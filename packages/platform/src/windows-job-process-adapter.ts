import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  appendBoundedOutput,
  type BoundedOutputSink,
  createBoundedOutputSink,
  endBoundedOutput,
} from "./bounded-output.js";
import type {
  ManagedProcessHandle,
  OwnershipInspection,
  ProcessAdapter,
  SpawnRequest,
  StopRequestResult,
  WaitForExitResult,
} from "./process-adapter.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const MAX_PROTOCOL_LINE_LENGTH = 16 * 1_024;
const helperAsset = fileURLToPath(new URL("../assets/windows-job-helper.ps1", import.meta.url));

export interface WindowsJobProcessAdapterOptions {
  readonly powershellPath?: string;
  readonly helperPath?: string;
  readonly startupTimeoutMs?: number;
  readonly helperEnvironment?: NodeJS.ProcessEnv;
}

interface OwnedJob {
  readonly helper: ChildProcessWithoutNullStreams;
  readonly protocol: ReadLineInterface;
  readonly stdout: BoundedOutputSink;
  readonly stderr: BoundedOutputSink;
  readonly ownership: object;
  readonly terminalPromise: Promise<WaitForExitResult>;
  readonly resolveTerminal: (result: WaitForExitResult) => void;
  readyPid?: number;
  resolveReady: (pid: number) => void;
  rejectReady: (error: Error) => void;
  terminal?: WaitForExitResult;
  helperError: string;
  stopRequested: boolean;
}

function terminalResult(code: number): WaitForExitResult {
  return { kind: "exited", code, signal: null };
}

function validUint32(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0xffff_ffff;
}

function defaultPowerShellPath(environment: NodeJS.ProcessEnv): string {
  const systemRoot = environment.SystemRoot ?? environment.WINDIR;
  if (systemRoot === undefined || !isAbsolute(systemRoot)) {
    throw new Error("SystemRoot must identify the Windows installation");
  }
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export class WindowsJobProcessAdapter implements ProcessAdapter {
  readonly #powershellPath: string;
  readonly #helperPath: string;
  readonly #startupTimeoutMs: number;
  readonly #helperEnvironment: NodeJS.ProcessEnv;
  readonly #owned = new WeakMap<ManagedProcessHandle, OwnedJob>();

  constructor(options: WindowsJobProcessAdapterOptions = {}) {
    this.#helperEnvironment = { ...(options.helperEnvironment ?? process.env) };
    this.#powershellPath = options.powershellPath ?? defaultPowerShellPath(this.#helperEnvironment);
    this.#helperPath = options.helperPath ?? helperAsset;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    if (!isAbsolute(this.#powershellPath) || !isAbsolute(this.#helperPath)) {
      throw new Error("Windows helper paths must be absolute");
    }
    if (!Number.isSafeInteger(this.#startupTimeoutMs) || this.#startupTimeoutMs < 1) {
      throw new RangeError("startupTimeoutMs must be a positive integer");
    }
  }

  async start(request: SpawnRequest): Promise<ManagedProcessHandle> {
    if (process.platform !== "win32") {
      throw new Error("WindowsJobProcessAdapter requires native Windows");
    }
    const helper = spawn(
      this.#powershellPath,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.#helperPath],
      {
        env: this.#helperEnvironment,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdout = createBoundedOutputSink("adapter");
    const stderr = createBoundedOutputSink("adapter");
    let resolveTerminal!: (result: WaitForExitResult) => void;
    const terminalPromise = new Promise<WaitForExitResult>((resolve) => {
      resolveTerminal = resolve;
    });
    let resolveReady!: (pid: number) => void;
    let rejectReady!: (error: Error) => void;
    const readyPromise = new Promise<number>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const protocol = createInterface({ input: helper.stdout });
    const owned: OwnedJob = {
      helper,
      protocol,
      stdout,
      stderr,
      ownership: Object.freeze({}),
      terminalPromise,
      resolveTerminal,
      resolveReady,
      rejectReady,
      helperError: "",
      stopRequested: false,
    };

    helper.stderr.setEncoding("utf8");
    helper.stderr.on("data", (chunk: string) => {
      owned.helperError = (owned.helperError + chunk).slice(-4_096);
    });
    protocol.on("line", (line) => this.#acceptProtocolLine(owned, line));
    helper.once("error", (error) => {
      owned.rejectReady(error);
      this.#markUnknown(owned, `Windows job helper error: ${error.message}`);
    });
    helper.once("close", (code) => {
      if (owned.terminal === undefined) {
        const detail = owned.helperError.trim();
        const reason = `Windows job helper exited before a terminal event (code ${code ?? "null"})${detail === "" ? "" : `: ${detail}`}`;
        owned.rejectReady(new Error(reason));
        this.#markUnknown(owned, reason);
      }
      owned.protocol.close();
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          helper.off("error", onError);
          resolve();
        };
        const onError = (error: Error) => {
          helper.off("spawn", onSpawn);
          reject(error);
        };
        helper.once("spawn", onSpawn);
        helper.once("error", onError);
      });
      const payload = Buffer.from(
        JSON.stringify({
          executable: request.executable,
          args: [...request.args],
          canonicalCwd: request.canonicalCwd,
          environment: request.env,
        }),
        "utf8",
      ).toString("base64");
      await new Promise<void>((resolve, reject) => {
        helper.stdin.write(`${JSON.stringify({ type: "launch", data: payload })}\n`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      const pid = await this.#withTimeout(
        readyPromise,
        this.#startupTimeoutMs,
        "Windows job helper did not become ready",
      );
      const handle: ManagedProcessHandle = Object.freeze({
        runId: request.runId,
        pid,
        identity: randomUUID(),
        ownership: owned.ownership,
        gracefulStop: {
          supported: false as const,
          reason: "The Windows Job Object adapter currently supports forced tree stop only",
        },
        stdout: owned.stdout.stream,
        stderr: owned.stderr.stream,
      });
      this.#owned.set(handle, owned);
      return handle;
    } catch (error) {
      if (helper.exitCode === null && helper.signalCode === null) helper.kill();
      throw error;
    }
  }

  async inspectOwnership(handle: ManagedProcessHandle): Promise<OwnershipInspection> {
    const owned = this.#owned.get(handle);
    if (owned === undefined || owned.ownership !== handle.ownership) return "unknown";
    if (owned.terminal?.kind === "exited") return "exited";
    if (owned.terminal?.kind === "unknown") return "unknown";
    if (owned.helper.exitCode !== null || owned.helper.signalCode !== null) return "unknown";
    return "owned";
  }

  async requestGracefulStop(handle: ManagedProcessHandle): Promise<StopRequestResult> {
    const ownership = await this.inspectOwnership(handle);
    if (ownership === "unknown") return "ownership_unknown";
    if (ownership === "exited") return "already_exited";
    return "unsupported";
  }

  async terminateOwnedTree(handle: ManagedProcessHandle): Promise<StopRequestResult> {
    const owned = this.#owned.get(handle);
    const ownership = await this.inspectOwnership(handle);
    if (owned === undefined || ownership === "unknown") return "ownership_unknown";
    if (ownership === "exited") return "already_exited";
    if (owned.stopRequested) return "requested";
    owned.stopRequested = true;
    try {
      await new Promise<void>((resolve, reject) => {
        owned.helper.stdin.write("stop\n", (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return "requested";
    } catch (error) {
      this.#markUnknown(
        owned,
        `Could not request Windows Job Object termination: ${error instanceof Error ? error.message : String(error)}`,
      );
      return "ownership_unknown";
    }
  }

  async waitForExit(handle: ManagedProcessHandle, timeoutMs?: number): Promise<WaitForExitResult> {
    const owned = this.#owned.get(handle);
    if (owned === undefined || owned.ownership !== handle.ownership) {
      return { kind: "unknown", reason: "Handle is not owned by this adapter" };
    }
    if (owned.terminal !== undefined) return owned.terminal;
    if (timeoutMs === undefined) return owned.terminalPromise;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      throw new RangeError("timeoutMs must be a non-negative integer");
    }
    return this.#withTimeout(owned.terminalPromise, timeoutMs, undefined, {
      kind: "timeout",
    });
  }

  #acceptProtocolLine(owned: OwnedJob, line: string): void {
    if (line.length > MAX_PROTOCOL_LINE_LENGTH) {
      this.#protocolFailure(owned, "Windows job helper emitted an oversized protocol line");
      return;
    }
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Protocol event must be an object");
      }
      event = parsed as Record<string, unknown>;
    } catch (error) {
      this.#protocolFailure(
        owned,
        `Invalid Windows job helper event: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    if (event.type === "job-ready") {
      if (!Number.isInteger(event.pid) || Number(event.pid) < 1 || owned.readyPid !== undefined) {
        this.#protocolFailure(owned, "Windows job helper emitted an invalid ready event");
        return;
      }
      owned.readyPid = Number(event.pid);
      owned.resolveReady(owned.readyPid);
      return;
    }
    if (event.type === "job-output") {
      if (
        (event.stream !== "stdout" && event.stream !== "stderr") ||
        typeof event.data !== "string" ||
        event.data.length > 8_192
      ) {
        this.#protocolFailure(owned, "Windows job helper emitted an invalid output event");
        return;
      }
      appendBoundedOutput(owned[event.stream], Buffer.from(event.data, "base64"));
      return;
    }
    if (event.type === "job-output-gap") {
      if (!Number.isSafeInteger(event.droppedBytes) || Number(event.droppedBytes) < 1) {
        this.#protocolFailure(owned, "Windows job helper emitted an invalid output gap");
        return;
      }
      appendBoundedOutput(
        owned.stderr,
        Buffer.from(`[DevDock helper dropped ${Number(event.droppedBytes)} log bytes]\n`),
      );
      return;
    }
    if (event.type === "job-exited" || event.type === "job-stopped") {
      if (event.activeProcesses !== 0 || !validUint32(event.rootExitCode)) {
        this.#protocolFailure(owned, "Windows job helper emitted an invalid terminal event");
        return;
      }
      this.#markTerminal(owned, terminalResult(event.rootExitCode));
      return;
    }
    if (event.type === "job-status") return;
    this.#protocolFailure(owned, "Windows job helper emitted an unknown event type");
  }

  #protocolFailure(owned: OwnedJob, reason: string): void {
    this.#markUnknown(owned, reason);
    if (owned.helper.exitCode === null && owned.helper.signalCode === null) owned.helper.kill();
  }

  #markUnknown(owned: OwnedJob, reason: string): void {
    if (owned.terminal !== undefined) return;
    appendBoundedOutput(owned.stderr, Buffer.from(`[DevDock helper error] ${reason}\n`));
    this.#markTerminal(owned, { kind: "unknown", reason });
  }

  #markTerminal(owned: OwnedJob, result: WaitForExitResult): void {
    if (owned.terminal !== undefined) return;
    owned.terminal = result;
    endBoundedOutput(owned.stdout);
    endBoundedOutput(owned.stderr);
    owned.resolveTerminal(result);
  }

  async #withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message?: string,
    timeoutValue?: T,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((resolve, reject) => {
          timer = setTimeout(() => {
            if (timeoutValue !== undefined) resolve(timeoutValue);
            else reject(new Error(message ?? "Operation timed out"));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
