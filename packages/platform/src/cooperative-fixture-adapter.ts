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

abstract class CooperativeFixtureProcessAdapter implements ProcessAdapter {
  readonly #owned = new WeakMap<ManagedProcessHandle, OwnedFixture>();
  readonly #supportedPlatforms: readonly NodeJS.Platform[];

  protected constructor(supportedPlatforms: readonly NodeJS.Platform[]) {
    this.#supportedPlatforms = supportedPlatforms;
  }

  async start(request: SpawnRequest): Promise<ManagedProcessHandle> {
    if (!this.#supportedPlatforms.includes(process.platform)) {
      throw new Error(`The fixture adapter requires ${this.#supportedPlatforms.join(" or ")}`);
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
    const ownership = await this.inspectOwnership(handle);
    if (ownership === "unknown") return "ownership_unknown";
    if (ownership === "exited") return "already_exited";
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

  async waitForExit(handle: ManagedProcessHandle, timeoutMs?: number): Promise<WaitForExitResult> {
    const owned = this.#owned.get(handle);
    if (owned === undefined)
      return { kind: "unknown", reason: "Handle is not owned by this adapter" };
    if (owned.closed !== undefined) return { kind: "exited", ...owned.closed };

    return new Promise((resolve) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              owned.child.off("close", onClose);
              resolve(
                owned.error === undefined
                  ? { kind: "timeout" }
                  : { kind: "unknown", reason: "Child process emitted an error" },
              );
            }, timeoutMs);
      const onClose = (code: number | null, signal: string | null) => {
        if (timer !== undefined) clearTimeout(timer);
        resolve({ kind: "exited", code, signal });
      };
      owned.child.once("close", onClose);
    });
  }
}

export class WindowsFixtureProcessAdapter extends CooperativeFixtureProcessAdapter {
  constructor() {
    super(["win32"]);
  }
}

export class PosixFixtureProcessAdapter extends CooperativeFixtureProcessAdapter {
  constructor() {
    super(["darwin", "linux"]);
  }
}
