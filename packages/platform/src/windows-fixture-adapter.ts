import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  ManagedProcessHandle,
  OwnershipInspection,
  ProcessAdapter,
  SpawnRequest,
  StopRequestResult,
  WaitForExitResult,
} from "./process-adapter.js";

interface OwnedFixture {
  child: ChildProcess;
  closed?: { code: number | null; signal: string | null };
  error?: Error;
}

export class WindowsFixtureProcessAdapter implements ProcessAdapter {
  readonly #owned = new WeakMap<ManagedProcessHandle, OwnedFixture>();

  async start(request: SpawnRequest): Promise<ManagedProcessHandle> {
    if (process.platform !== "win32") {
      throw new Error("The Windows fixture adapter requires native Windows");
    }

    const child = spawn(request.executable, [...request.args], {
      cwd: request.canonicalCwd,
      env: request.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const owned: OwnedFixture = { child };
    child.once("close", (code, signal) => {
      owned.closed = { code, signal };
    });
    // Spawn failures can arrive after spawn() returns; retain the error for inspection.
    child.on("error", (error) => {
      owned.error = error;
    });

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

    if (child.pid === undefined || child.stdout === null || child.stderr === null) {
      throw new Error("Spawn did not return a managed fixture process");
    }

    const handle: ManagedProcessHandle = Object.freeze({
      runId: request.runId,
      pid: child.pid,
      identity: randomUUID(),
      ownership: Object.freeze({}),
      gracefulStop: { supported: true as const },
      stdout: child.stdout,
      stderr: child.stderr,
    });
    this.#owned.set(handle, owned);
    return handle;
  }

  async inspectOwnership(handle: ManagedProcessHandle): Promise<OwnershipInspection> {
    const owned = this.#owned.get(handle);
    if (owned === undefined) return "unknown";
    if (owned.error !== undefined && owned.closed === undefined) return "unknown";
    if (
      owned.closed !== undefined ||
      owned.child.exitCode !== null ||
      owned.child.signalCode !== null
    ) {
      return "exited";
    }
    return "owned";
  }

  async requestGracefulStop(handle: ManagedProcessHandle): Promise<StopRequestResult> {
    const owned = this.#owned.get(handle);
    if (owned === undefined) return "ownership_unknown";
    if ((await this.inspectOwnership(handle)) === "exited") return "already_exited";
    if (!owned.child.connected) return "unsupported";

    try {
      await new Promise<void>((resolve, reject) => {
        owned.child.send({ type: "shutdown" }, (error) => (error ? reject(error) : resolve()));
      });
      return "requested";
    } catch {
      return "ownership_unknown";
    }
  }

  async terminateOwnedTree(handle: ManagedProcessHandle): Promise<StopRequestResult> {
    if (!this.#owned.has(handle)) return "ownership_unknown";
    // A Node child handle alone does not prove ownership of its descendants on Windows.
    return "unsupported";
  }

  async waitForExit(handle: ManagedProcessHandle, timeoutMs: number): Promise<WaitForExitResult> {
    const owned = this.#owned.get(handle);
    if (owned === undefined)
      return { kind: "unknown", reason: "Handle is not owned by this adapter" };
    if (owned.closed !== undefined) return { kind: "exited", ...owned.closed };

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        owned.child.off("close", onClose);
        resolve(
          owned.error === undefined
            ? { kind: "timeout" }
            : { kind: "unknown", reason: "Child process emitted an error" },
        );
      }, timeoutMs);
      const onClose = (code: number | null, signal: string | null) => {
        clearTimeout(timer);
        resolve({ kind: "exited", code, signal });
      };
      owned.child.once("close", onClose);
    });
  }
}
