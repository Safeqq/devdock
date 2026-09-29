import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { type RunSnapshot, RunSnapshotSchema } from "@devdock/contracts";
import type {
  ManagedProcessHandle,
  OwnershipInspection,
  ProcessAdapter,
  SpawnRequest,
  StopRequestResult,
  WaitForExitResult,
} from "@devdock/platform";

type Exited = Extract<WaitForExitResult, { kind: "exited" }>;
type RequestBase = Omit<SpawnRequest, "runId">;

export type StartOutcome =
  | { kind: "started" | "existing"; snapshot: RunSnapshot }
  | { kind: "failed" | "rejected"; snapshot: RunSnapshot; reason: string };

export type StopOutcome =
  | { kind: "stopped" | "already_stopped"; snapshot: RunSnapshot | null }
  | { kind: "incomplete"; snapshot: RunSnapshot; reason: string };

export interface SupervisorInspection {
  snapshot: RunSnapshot | null;
  ownership: OwnershipInspection | null;
}

export interface SingleServiceSupervisorOptions {
  readonly serviceId?: string;
  readonly graceTimeoutMs?: number;
  readonly forceTimeoutMs?: number;
  readonly onSnapshot?: (snapshot: RunSnapshot) => void;
  readonly onSnapshotError?: (error: unknown) => void;
}

export class SingleServiceSupervisor {
  readonly #adapter: ProcessAdapter;
  readonly #request: RequestBase;
  readonly #serviceId: string;
  readonly #graceTimeoutMs: number;
  readonly #forceTimeoutMs: number;
  readonly #onSnapshot: ((snapshot: RunSnapshot) => void) | undefined;
  readonly #onSnapshotError: ((error: unknown) => void) | undefined;
  #handle: ManagedProcessHandle | undefined;
  #latestStreams: { runId: string; stdout: Readable; stderr: Readable } | undefined;
  #snapshot: RunSnapshot | null = null;
  #stopRequestedRunId: string | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    adapter: ProcessAdapter,
    request: RequestBase,
    options: SingleServiceSupervisorOptions = {},
  ) {
    this.#adapter = adapter;
    this.#request = { ...request, args: [...request.args], env: { ...request.env } };
    this.#serviceId = options.serviceId ?? "fixture";
    this.#graceTimeoutMs = options.graceTimeoutMs ?? 3_000;
    this.#forceTimeoutMs = options.forceTimeoutMs ?? 2_000;
    this.#onSnapshot = options.onSnapshot;
    this.#onSnapshotError = options.onSnapshotError;
    if (
      !Number.isSafeInteger(this.#graceTimeoutMs) ||
      this.#graceTimeoutMs <= 0 ||
      !Number.isSafeInteger(this.#forceTimeoutMs) ||
      this.#forceTimeoutMs <= 0
    ) {
      throw new RangeError("Stop timeouts must be positive integers");
    }
  }

  snapshot(): RunSnapshot | null {
    return this.#snapshot === null ? null : { ...this.#snapshot };
  }

  streamsFor(runId: string): { stdout: Readable; stderr: Readable } | null {
    const streams = this.#latestStreams;
    if (streams === undefined || streams.runId !== runId) return null;
    return { stdout: streams.stdout, stderr: streams.stderr };
  }

  async inspect(): Promise<SupervisorInspection> {
    return this.#serialize(() => this.#inspectLocked());
  }

  async #inspectLocked(): Promise<SupervisorInspection> {
    const handle = this.#handle;
    if (handle === undefined) return { snapshot: this.snapshot(), ownership: null };
    try {
      const ownership = await this.#adapter.inspectOwnership(handle);
      if (ownership === "unknown") this.#markUnknown(handle, "OWNERSHIP_UNKNOWN");
      if (ownership === "exited") {
        const result = await this.#wait(handle, 0);
        if (result.kind === "exited") {
          this.#applyClose(handle, result);
          return { snapshot: this.snapshot(), ownership: "exited" };
        }
      }
      return { snapshot: this.snapshot(), ownership };
    } catch {
      if (this.#handle === handle && this.#snapshot?.runId === handle.runId) {
        this.#markUnknown(handle, "OWNERSHIP_UNKNOWN");
      }
      return { snapshot: this.snapshot(), ownership: "unknown" };
    }
  }

  start(): Promise<StartOutcome> {
    return this.#serialize(() => this.#startLocked());
  }

  stop(): Promise<StopOutcome> {
    return this.#serialize(() => this.#stopLocked());
  }

  restart(): Promise<StartOutcome | Extract<StopOutcome, { kind: "incomplete" }>> {
    return this.#serialize(async () => {
      const stopped = await this.#stopLocked();
      if (stopped.kind === "incomplete") return stopped;
      return this.#startLocked();
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #set(snapshot: RunSnapshot): RunSnapshot {
    const validated = RunSnapshotSchema.parse(snapshot);
    this.#snapshot = validated;
    try {
      this.#onSnapshot?.({ ...validated });
    } catch (error) {
      try {
        this.#onSnapshotError?.(error);
      } catch {
        // Reporting a history-write failure must not release or lose the live process handle.
      }
    }
    return { ...validated };
  }

  async #startLocked(): Promise<StartOutcome> {
    const handle = this.#handle;
    const current = this.#snapshot;
    if (handle !== undefined && current !== null) {
      let ownership: OwnershipInspection;
      try {
        ownership = await this.#adapter.inspectOwnership(handle);
      } catch {
        ownership = "unknown";
      }

      if (ownership === "unknown") {
        const snapshot = this.#markUnknown(handle, "OWNERSHIP_UNKNOWN");
        return { kind: "rejected", snapshot, reason: "OWNERSHIP_UNKNOWN" };
      }
      if (ownership === "exited") {
        const result = await this.#wait(handle, 0);
        if (result.kind === "exited") {
          this.#applyClose(handle, result);
        } else {
          const snapshot = this.#set({
            ...current,
            processState: "stopping",
            failureReason: "CLEANUP_PENDING",
          });
          return { kind: "rejected", snapshot, reason: "CLEANUP_PENDING" };
        }
      } else if (current.processState === "running" || current.processState === "starting") {
        return { kind: "existing", snapshot: { ...current } };
      } else {
        return { kind: "rejected", snapshot: { ...current }, reason: "STOP_INCOMPLETE" };
      }
    }

    const previous = this.#snapshot;
    if (previous?.reconciliationState === "unknown") {
      return { kind: "rejected", snapshot: { ...previous }, reason: "OWNERSHIP_UNKNOWN" };
    }

    const runId = randomUUID();
    const starting = this.#set({
      runId,
      serviceId: this.#serviceId,
      processState: "starting",
      readinessState: "unknown",
      reconciliationState: "known",
      startedAt: new Date().toISOString(),
    });
    this.#stopRequestedRunId = undefined;

    let spawned: ManagedProcessHandle;
    try {
      spawned = await this.#adapter.start({ ...this.#request, runId });
    } catch {
      const snapshot = this.#set({
        ...starting,
        processState: "failed",
        endedAt: new Date().toISOString(),
        failureReason: "SPAWN_ERROR",
      });
      return { kind: "failed", snapshot, reason: "SPAWN_ERROR" };
    }

    this.#handle = spawned;
    this.#latestStreams = {
      runId: spawned.runId,
      stdout: spawned.stdout,
      stderr: spawned.stderr,
    };
    if (spawned.runId !== runId) {
      const snapshot = this.#set({
        ...starting,
        processState: "stopping",
        reconciliationState: "unknown",
        pid: spawned.pid,
        failureReason: "RUN_ID_MISMATCH",
      });
      return { kind: "rejected", snapshot, reason: "RUN_ID_MISMATCH" };
    }

    const snapshot = this.#set({ ...starting, processState: "running", pid: spawned.pid });
    this.#watch(spawned);
    return { kind: "started", snapshot };
  }

  async #stopLocked(): Promise<StopOutcome> {
    const handle = this.#handle;
    const current = this.#snapshot;
    if (handle === undefined || current === null) {
      return { kind: "already_stopped", snapshot: this.snapshot() };
    }
    if (current.runId !== handle.runId) {
      return this.#incomplete(handle, "RUN_ID_MISMATCH", true);
    }

    let initialOwnership: OwnershipInspection;
    try {
      initialOwnership = await this.#adapter.inspectOwnership(handle);
    } catch {
      initialOwnership = "unknown";
    }
    if (initialOwnership === "unknown") {
      return this.#incomplete(handle, "OWNERSHIP_UNKNOWN", true);
    }

    this.#set({ ...current, processState: "stopping" });
    let request: StopRequestResult;
    try {
      request = await this.#adapter.requestGracefulStop(handle);
    } catch {
      request = "ownership_unknown";
    }
    if (request === "ownership_unknown") {
      return this.#incomplete(handle, "OWNERSHIP_UNKNOWN", true);
    }

    if (request === "requested" || request === "already_exited") {
      if (request === "requested") this.#stopRequestedRunId = handle.runId;
      const result = await this.#wait(handle, this.#graceTimeoutMs);
      if (result.kind === "exited") {
        const snapshot = this.#applyClose(handle, result);
        return { kind: "stopped", snapshot };
      }
      if (result.kind === "unknown") {
        return this.#incomplete(handle, "EXIT_OBSERVATION_UNKNOWN", true);
      }
    }

    let ownership: OwnershipInspection;
    try {
      ownership = await this.#adapter.inspectOwnership(handle);
    } catch {
      ownership = "unknown";
    }
    if (ownership === "unknown") return this.#incomplete(handle, "OWNERSHIP_UNKNOWN", true);

    if (ownership === "owned") {
      let fallback: StopRequestResult;
      try {
        fallback = await this.#adapter.terminateOwnedTree(handle);
      } catch {
        fallback = "ownership_unknown";
      }
      if (fallback === "ownership_unknown") {
        return this.#incomplete(handle, "OWNERSHIP_UNKNOWN", true);
      }
      if (fallback === "unsupported") {
        return this.#incomplete(handle, "TREE_STOP_UNSUPPORTED");
      }
      if (fallback === "requested") this.#stopRequestedRunId = handle.runId;
    }

    const result = await this.#wait(handle, this.#forceTimeoutMs);
    if (result.kind === "exited") {
      const snapshot = this.#applyClose(handle, result);
      return { kind: "stopped", snapshot };
    }
    return this.#incomplete(handle, "STOP_TIMEOUT", result.kind === "unknown");
  }

  async #wait(handle: ManagedProcessHandle, timeoutMs?: number): Promise<WaitForExitResult> {
    try {
      return await this.#adapter.waitForExit(handle, timeoutMs);
    } catch {
      return { kind: "unknown", reason: "ADAPTER_WAIT_ERROR" };
    }
  }

  #incomplete(handle: ManagedProcessHandle, reason: string, unknown = false): StopOutcome {
    const current = this.#snapshot;
    if (current === null || this.#handle !== handle) {
      return { kind: "already_stopped", snapshot: this.snapshot() };
    }
    const snapshot = this.#set({
      ...current,
      processState: "stopping",
      reconciliationState: unknown ? "unknown" : current.reconciliationState,
      failureReason: reason,
    });
    return { kind: "incomplete", snapshot, reason };
  }

  #markUnknown(handle: ManagedProcessHandle, reason: string): RunSnapshot {
    const current = this.#snapshot;
    if (current === null || this.#handle !== handle) {
      throw new Error("Cannot mark an inactive run unknown");
    }
    return this.#set({
      ...current,
      processState: "stopping",
      reconciliationState: "unknown",
      failureReason: reason,
    });
  }

  #applyClose(handle: ManagedProcessHandle, result: Exited): RunSnapshot {
    const current = this.#snapshot;
    if (current === null || this.#handle !== handle || current.runId !== handle.runId) {
      throw new Error("Cannot close an inactive run");
    }
    const stopped = this.#stopRequestedRunId === handle.runId;
    const processState = stopped ? "stopped" : result.code === 0 ? "exited" : "failed";
    this.#handle = undefined;
    this.#stopRequestedRunId = undefined;
    const next: RunSnapshot = {
      ...current,
      processState,
      readinessState: "unknown",
      reconciliationState: "known",
      endedAt: new Date().toISOString(),
      exitCode: result.code,
    };
    if (processState === "failed") next.failureReason = "PROCESS_EXITED_WITH_FAILURE";
    else delete next.failureReason;
    return this.#set(next);
  }

  #watch(handle: ManagedProcessHandle): void {
    const task = async () => {
      const result = await this.#wait(handle);
      await this.#serialize(async () => {
        if (this.#handle !== handle || this.#snapshot?.runId !== handle.runId) return;
        if (result.kind === "exited") this.#applyClose(handle, result);
        else this.#markUnknown(handle, "EXIT_OBSERVATION_UNKNOWN");
      });
    };
    void task().catch(() => {
      if (this.#handle === handle && this.#snapshot?.runId === handle.runId) {
        this.#markUnknown(handle, "MONITOR_ERROR");
      }
    });
  }
}
