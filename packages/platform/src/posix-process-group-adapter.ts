import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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

const GROUP_POLL_INTERVAL_MS = 25;

type GroupPresence = "present" | "absent" | "unknown";

interface OwnedProcessGroup {
  readonly child: ChildProcess;
  readonly processGroupId: number;
  readonly ownership: object;
  readonly stdout: BoundedOutputSink;
  readonly stderr: BoundedOutputSink;
  readonly terminalPromise: Promise<WaitForExitResult>;
  readonly resolveTerminal: (result: WaitForExitResult) => void;
  rootExit?: Extract<WaitForExitResult, { kind: "exited" }>;
  terminal?: WaitForExitResult;
  monitor?: NodeJS.Timeout;
}

function errorCode(caught: unknown): string | null {
  return caught !== null &&
    typeof caught === "object" &&
    "code" in caught &&
    typeof caught.code === "string"
    ? caught.code
    : null;
}

function groupPresence(processGroupId: number): GroupPresence {
  try {
    process.kill(-processGroupId, 0);
    return "present";
  } catch (caught) {
    const code = errorCode(caught);
    if (code === "ESRCH") return "absent";
    return "unknown";
  }
}

export class PosixProcessGroupAdapter implements ProcessAdapter {
  readonly #owned = new WeakMap<ManagedProcessHandle, OwnedProcessGroup>();

  async start(request: SpawnRequest): Promise<ManagedProcessHandle> {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      throw new Error("PosixProcessGroupAdapter requires macOS or Linux");
    }
    const child = spawn(request.executable, [...request.args], {
      cwd: request.canonicalCwd,
      env: request.env,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid === undefined || child.stdout === null || child.stderr === null) {
      child.kill();
      throw new Error("Spawn did not return a POSIX process group leader");
    }
    const stdout = createBoundedOutputSink("adapter");
    const stderr = createBoundedOutputSink("adapter");
    let resolveTerminal!: (result: WaitForExitResult) => void;
    const terminalPromise = new Promise<WaitForExitResult>((resolve) => {
      resolveTerminal = resolve;
    });
    const owned: OwnedProcessGroup = {
      child,
      processGroupId: child.pid,
      ownership: Object.freeze({}),
      stdout,
      stderr,
      terminalPromise,
      resolveTerminal,
    };
    child.stdout.on("data", (chunk: Buffer) => appendBoundedOutput(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => appendBoundedOutput(stderr, chunk));
    child.once("close", (code, signal) => {
      owned.rootExit = { kind: "exited", code, signal };
      this.#checkCompletion(owned);
    });
    child.once("error", (error) => {
      this.#markTerminal(owned, {
        kind: "unknown",
        reason: `POSIX process emitted an error: ${error.message}`,
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          child.off("error", onError);
          resolve();
        };
        const onError = (error: Error) => {
          child.off("spawn", onSpawn);
          reject(error);
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
    } catch (caught) {
      endBoundedOutput(stdout);
      endBoundedOutput(stderr);
      throw caught;
    }

    const handle: ManagedProcessHandle = Object.freeze({
      runId: request.runId,
      pid: child.pid,
      identity: randomUUID(),
      ownership: owned.ownership,
      gracefulStop: { supported: true as const },
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    this.#owned.set(handle, owned);
    return handle;
  }

  async inspectOwnership(handle: ManagedProcessHandle): Promise<OwnershipInspection> {
    const owned = this.#owned.get(handle);
    if (owned === undefined || owned.ownership !== handle.ownership) return "unknown";
    if (owned.terminal?.kind === "exited") return "exited";
    if (owned.terminal?.kind === "unknown") return "unknown";
    const presence = groupPresence(owned.processGroupId);
    if (presence === "present") return "owned";
    if (presence === "unknown") {
      this.#markTerminal(owned, {
        kind: "unknown",
        reason: "POSIX process-group ownership could not be inspected",
      });
      return "unknown";
    }
    if (owned.rootExit !== undefined) {
      this.#markTerminal(owned, owned.rootExit);
      return "exited";
    }
    return "owned";
  }

  async requestGracefulStop(handle: ManagedProcessHandle): Promise<StopRequestResult> {
    return this.#signalOwnedGroup(handle, "SIGTERM");
  }

  async terminateOwnedTree(handle: ManagedProcessHandle): Promise<StopRequestResult> {
    return this.#signalOwnedGroup(handle, "SIGKILL");
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
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        owned.terminalPromise,
        new Promise<WaitForExitResult>((resolve) => {
          timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #signalOwnedGroup(
    handle: ManagedProcessHandle,
    signal: Extract<NodeJS.Signals, "SIGTERM" | "SIGKILL">,
  ): Promise<StopRequestResult> {
    const owned = this.#owned.get(handle);
    const ownership = await this.inspectOwnership(handle);
    if (owned === undefined || ownership === "unknown") return "ownership_unknown";
    if (ownership === "exited") return "already_exited";
    try {
      process.kill(-owned.processGroupId, signal);
      return "requested";
    } catch (caught) {
      const code = errorCode(caught);
      if (code === "ESRCH") {
        this.#checkCompletion(owned);
        return "already_exited";
      }
      this.#markTerminal(owned, {
        kind: "unknown",
        reason: `POSIX process group could not receive ${signal}`,
      });
      return "ownership_unknown";
    }
  }

  #checkCompletion(owned: OwnedProcessGroup): void {
    if (owned.terminal !== undefined || owned.rootExit === undefined) return;
    const presence = groupPresence(owned.processGroupId);
    if (presence === "absent") {
      this.#markTerminal(owned, owned.rootExit);
      return;
    }
    if (presence === "unknown") {
      this.#markTerminal(owned, {
        kind: "unknown",
        reason: "POSIX process-group completion could not be inspected",
      });
      return;
    }
    owned.monitor = setTimeout(() => this.#checkCompletion(owned), GROUP_POLL_INTERVAL_MS);
    owned.monitor.unref();
  }

  #markTerminal(owned: OwnedProcessGroup, result: WaitForExitResult): void {
    if (owned.terminal !== undefined) return;
    owned.terminal = result;
    if (owned.monitor !== undefined) clearTimeout(owned.monitor);
    endBoundedOutput(owned.stdout);
    endBoundedOutput(owned.stderr);
    owned.resolveTerminal(result);
  }
}
