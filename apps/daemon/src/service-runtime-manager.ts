import { randomUUID } from "node:crypto";
import type { ReadinessProbe, RunSnapshot, ServiceConfig } from "@devdock/contracts";
import {
  type NpmLauncher,
  type ProcessAdapter,
  probeLoopbackReadiness,
  type ReadinessProbeResult,
  type ReadinessProbeTarget,
} from "@devdock/platform";
import type { ProjectRegistry } from "./project-registry.js";
import { RunLogBuffer } from "./run-log-buffer.js";
import {
  SingleServiceSupervisor,
  type StartOutcome,
  type StopOutcome,
  type SupervisorInspection,
} from "./single-service-supervisor.js";

const MAX_RETAINED_RUN_LOGS = 50;

interface ManagedServiceRuntime {
  readonly supervisor: SingleServiceSupervisor;
}

interface ActiveReadinessProbe {
  readonly runId: string;
  readonly controller: AbortController;
}

type ReadinessProbeRunner = (
  target: ReadinessProbeTarget,
  signal?: AbortSignal,
) => Promise<ReadinessProbeResult>;

export interface RestartTimer {
  cancel(): void;
}

export type RestartScheduler = (callback: () => void, delayMs: number) => RestartTimer;

interface PendingRestart {
  readonly runId: string;
  readonly attempt: number;
  readonly timer: RestartTimer;
}

function defaultRestartScheduler(callback: () => void, delayMs: number): RestartTimer {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}

export interface ServiceRuntimeManagerOptions {
  readonly registry: ProjectRegistry;
  readonly launcher: NpmLauncher;
  readonly adapterFactory: () => ProcessAdapter;
  readonly daemonSessionId?: string;
  readonly readinessProbe?: ReadinessProbeRunner;
  readonly restartScheduler?: RestartScheduler;
}

export type ServiceStartupResult =
  | { kind: "ready"; snapshot: RunSnapshot }
  | { kind: "failed"; snapshot: RunSnapshot | null; reason: string }
  | { kind: "aborted" };

function replaceable(snapshot: RunSnapshot | null): boolean {
  return (
    snapshot === null ||
    (snapshot.reconciliationState === "known" &&
      (snapshot.processState === "stopped" ||
        snapshot.processState === "exited" ||
        snapshot.processState === "failed"))
  );
}

function activeRunId(runtime: ManagedServiceRuntime): string | null {
  const snapshot = runtime.supervisor.snapshot();
  if (
    snapshot === null ||
    snapshot.processState === "stopped" ||
    snapshot.processState === "exited" ||
    snapshot.processState === "failed"
  ) {
    return null;
  }
  return snapshot.runId;
}

function needsReconciliation(snapshot: RunSnapshot | null): snapshot is RunSnapshot {
  return (
    snapshot !== null &&
    (snapshot.reconciliationState === "unknown" ||
      snapshot.processState === "starting" ||
      snapshot.processState === "running" ||
      snapshot.processState === "stopping")
  );
}

export class ServiceRuntimeManager {
  readonly #registry: ProjectRegistry;
  readonly #launcher: NpmLauncher;
  readonly #adapterFactory: () => ProcessAdapter;
  readonly #readinessProbe: ReadinessProbeRunner;
  readonly #restartScheduler: RestartScheduler;
  readonly #daemonSessionId: string;
  readonly #runtimes = new Map<string, ManagedServiceRuntime>();
  readonly #tails = new Map<string, Promise<void>>();
  readonly #logBuffers = new Map<string, RunLogBuffer>();
  readonly #logOrder: string[] = [];
  readonly #readinessProbes = new Map<string, ActiveReadinessProbe>();
  readonly #pendingRestarts = new Map<string, PendingRestart>();
  readonly #restartAttempts = new Map<string, number>();
  readonly #snapshotSubscribers = new Map<string, Set<(snapshot: RunSnapshot) => void>>();
  #closed = false;

  constructor(options: ServiceRuntimeManagerOptions) {
    this.#registry = options.registry;
    this.#launcher = options.launcher;
    this.#adapterFactory = options.adapterFactory;
    this.#readinessProbe = options.readinessProbe ?? probeLoopbackReadiness;
    this.#restartScheduler = options.restartScheduler ?? defaultRestartScheduler;
    this.#daemonSessionId = options.daemonSessionId ?? randomUUID();
    this.#reconcilePersistedHistory();
  }

  get logBuffers(): ReadonlyMap<string, RunLogBuffer> {
    return this.#logBuffers;
  }

  // The loopback address a run printed in its output, while its log is still retained.
  appUrl(runId: string): string | null {
    return this.#logBuffers.get(runId)?.appUrl ?? null;
  }

  start(serviceId: string): Promise<StartOutcome> {
    this.#cancelPendingRestart(serviceId);
    this.#restartAttempts.delete(serviceId);
    return this.#serialize(serviceId, () => this.#startLocked(serviceId));
  }

  async #startLocked(serviceId: string): Promise<StartOutcome> {
    if (this.#closed) throw new Error("Service runtime manager is closed");
    const service = this.#registry.getService(serviceId);
    let runtime = this.#runtimes.get(serviceId);
    if (runtime === undefined) {
      const historical = this.#historicalSnapshot(serviceId);
      if (needsReconciliation(historical)) {
        return { kind: "rejected", snapshot: historical, reason: "OWNERSHIP_UNKNOWN" };
      }
    }
    if (runtime === undefined || replaceable(runtime.supervisor.snapshot())) {
      const plan = await this.#registry.launchPlan(serviceId, this.#launcher);
      let managed: ManagedServiceRuntime;
      const supervisor = new SingleServiceSupervisor(this.#adapterFactory(), plan, {
        serviceId,
        onSnapshot: (snapshot) => this.#handleSnapshot(service, managed, snapshot),
        onSnapshotError: () => {
          process.stderr.write(`Could not persist lifecycle history for service ${serviceId}\n`);
        },
      });
      managed = { supervisor };
      runtime = managed;
      this.#runtimes.set(serviceId, runtime);
    }

    const outcome = await runtime.supervisor.start();
    if (outcome.kind === "started" || outcome.kind === "existing") {
      this.#capture(runtime, outcome.snapshot.runId);
    }
    if (outcome.kind === "started" && service.readiness !== undefined) {
      const checking = await runtime.supervisor.setReadiness(outcome.snapshot.runId, "checking");
      if (checking !== null) {
        this.#beginReadinessProbe(service, runtime, checking.runId);
        return { ...outcome, snapshot: checking };
      }
    }
    return outcome;
  }

  status(serviceId: string): Promise<SupervisorInspection> {
    return this.#serialize(serviceId, async () => {
      const runtime = this.#runtimes.get(serviceId);
      if (runtime === undefined) {
        const snapshot = this.#historicalSnapshot(serviceId);
        return {
          snapshot,
          ownership: needsReconciliation(snapshot) ? "unknown" : null,
        };
      }
      const inspection = await runtime.supervisor.inspect();
      return inspection;
    });
  }

  stop(serviceId: string): Promise<StopOutcome> {
    this.#cancelPendingRestart(serviceId);
    this.#restartAttempts.delete(serviceId);
    this.#cancelReadinessProbe(serviceId);
    return this.#serialize(serviceId, async () => {
      const runtime = this.#runtimes.get(serviceId);
      if (runtime === undefined) {
        const snapshot = this.#historicalSnapshot(serviceId);
        if (needsReconciliation(snapshot)) {
          return { kind: "incomplete", snapshot, reason: "OWNERSHIP_UNKNOWN" };
        }
        return { kind: "already_stopped", snapshot };
      }
      const outcome = await runtime.supervisor.stop();
      this.#evictLogs();
      return outcome;
    });
  }

  subscribe(serviceId: string, listener: (snapshot: RunSnapshot) => void): () => void {
    if (this.#closed) throw new Error("Service runtime manager is closed");
    const subscribers = this.#snapshotSubscribers.get(serviceId) ?? new Set();
    subscribers.add(listener);
    this.#snapshotSubscribers.set(serviceId, subscribers);
    return () => {
      subscribers.delete(listener);
      if (subscribers.size === 0) this.#snapshotSubscribers.delete(serviceId);
    };
  }

  waitForStartup(
    serviceId: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<ServiceStartupResult> {
    const service = this.#registry.getService(serviceId);
    if (signal?.aborted) return Promise.resolve({ kind: "aborted" });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: ServiceStartupResult) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        const subscribers = this.#snapshotSubscribers.get(serviceId);
        subscribers?.delete(observe);
        if (subscribers?.size === 0) this.#snapshotSubscribers.delete(serviceId);
        resolve(result);
      };
      const evaluate = (snapshot: RunSnapshot | null) => {
        if (snapshot === null || snapshot.runId !== runId) {
          finish({ kind: "failed", snapshot, reason: "RUN_CHANGED" });
          return;
        }
        if (
          snapshot.processState === "running" &&
          (service.readiness === undefined || snapshot.readinessState === "ready")
        ) {
          finish({ kind: "ready", snapshot });
          return;
        }
        if (
          snapshot.reconciliationState === "unknown" ||
          snapshot.processState === "stopped" ||
          snapshot.processState === "stopping" ||
          snapshot.processState === "exited" ||
          snapshot.processState === "failed" ||
          snapshot.readinessState === "unhealthy"
        ) {
          finish({
            kind: "failed",
            snapshot,
            reason: snapshot.failureReason ?? "STARTUP_FAILED",
          });
        }
      };
      const observe = (snapshot: RunSnapshot) => evaluate(snapshot);
      const abort = () => finish({ kind: "aborted" });
      const subscribers = this.#snapshotSubscribers.get(serviceId) ?? new Set();
      subscribers.add(observe);
      this.#snapshotSubscribers.set(serviceId, subscribers);
      signal?.addEventListener("abort", abort, { once: true });
      void this.status(serviceId)
        .then(({ snapshot }) => evaluate(snapshot))
        .catch(() => finish({ kind: "failed", snapshot: null, reason: "STATUS_ERROR" }));
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const serviceId of this.#pendingRestarts.keys()) {
      this.#cancelPendingRestart(serviceId);
    }
    this.#restartAttempts.clear();
    for (const serviceId of this.#readinessProbes.keys()) {
      this.#cancelReadinessProbe(serviceId);
    }
    const serviceIds = [...this.#runtimes.keys()];
    await Promise.allSettled(
      serviceIds.map((serviceId) =>
        this.#serialize(serviceId, async () => {
          const runtime = this.#runtimes.get(serviceId);
          if (runtime === undefined) return;
          await runtime.supervisor.stop();
        }),
      ),
    );
    for (const logs of this.#logBuffers.values()) logs.dispose();
    this.#logBuffers.clear();
    this.#logOrder.length = 0;
    this.#snapshotSubscribers.clear();
  }

  #capture(runtime: ManagedServiceRuntime, runId: string): void {
    if (this.#logBuffers.has(runId)) return;
    const streams = runtime.supervisor.streamsFor(runId);
    if (streams === null) throw new Error("Managed run streams are unavailable");
    const logs = new RunLogBuffer(this.#daemonSessionId, runId);
    logs.capture(streams.stdout, streams.stderr);
    this.#logBuffers.set(runId, logs);
    this.#logOrder.push(runId);
    this.#evictLogs();
  }

  #persist(snapshot: RunSnapshot): void {
    try {
      this.#registry.saveRunSnapshot(snapshot);
    } finally {
      for (const subscriber of this.#snapshotSubscribers.get(snapshot.serviceId) ?? []) {
        try {
          subscriber({ ...snapshot });
        } catch {
          // A profile observer cannot interrupt lifecycle persistence or another observer.
        }
      }
    }
  }

  #handleSnapshot(
    service: ServiceConfig,
    runtime: ManagedServiceRuntime,
    snapshot: RunSnapshot,
  ): void {
    this.#persist(snapshot);
    if (
      this.#closed ||
      this.#runtimes.get(service.id) !== runtime ||
      runtime.supervisor.snapshot()?.runId !== snapshot.runId ||
      snapshot.reconciliationState !== "known" ||
      snapshot.processState !== "failed" ||
      service.restartPolicy?.kind !== "on_failure"
    ) {
      return;
    }
    this.#scheduleRestart(service, runtime, snapshot.runId);
  }

  #scheduleRestart(service: ServiceConfig, runtime: ManagedServiceRuntime, runId: string): void {
    if (service.restartPolicy?.kind !== "on_failure") return;
    const current = this.#pendingRestarts.get(service.id);
    if (current?.runId === runId) return;
    if (current !== undefined) this.#cancelPendingRestart(service.id);
    const attempt = (this.#restartAttempts.get(service.id) ?? 0) + 1;
    if (attempt > service.restartPolicy.maxAttempts) return;
    const delayMs = Math.min(
      service.restartPolicy.initialBackoffMs * 2 ** (attempt - 1),
      service.restartPolicy.maxBackoffMs,
    );
    const timer = this.#restartScheduler(() => {
      const pending = this.#pendingRestarts.get(service.id);
      if (pending?.runId !== runId || pending.attempt !== attempt) return;
      this.#pendingRestarts.delete(service.id);
      this.#restartAttempts.set(service.id, attempt);
      void this.#serialize(service.id, async () => {
        if (this.#closed || this.#runtimes.get(service.id) !== runtime) return;
        const currentSnapshot = runtime.supervisor.snapshot();
        if (
          currentSnapshot?.runId !== runId ||
          currentSnapshot.reconciliationState !== "known" ||
          currentSnapshot.processState !== "failed"
        ) {
          return;
        }
        try {
          const outcome = await this.#startLocked(service.id);
          if (outcome.kind === "failed") {
            this.#scheduleRestart(
              service,
              this.#runtimes.get(service.id) ?? runtime,
              outcome.snapshot.runId,
            );
          }
        } catch {
          this.#scheduleRestart(service, runtime, runId);
        }
      });
    }, delayMs);
    this.#pendingRestarts.set(service.id, { runId, attempt, timer });
  }

  #cancelPendingRestart(serviceId: string): void {
    const pending = this.#pendingRestarts.get(serviceId);
    if (pending === undefined) return;
    this.#pendingRestarts.delete(serviceId);
    pending.timer.cancel();
  }

  #beginReadinessProbe(
    service: ServiceConfig,
    runtime: ManagedServiceRuntime,
    runId: string,
  ): void {
    const readiness = service.readiness;
    if (readiness === undefined || service.expectedPort === undefined) {
      throw new Error("A readiness probe requires an expected port");
    }
    this.#cancelReadinessProbe(service.id);
    const active: ActiveReadinessProbe = { runId, controller: new AbortController() };
    this.#readinessProbes.set(service.id, active);
    const target = this.#readinessTarget(readiness, service.expectedPort);
    const task = async () => {
      let result: ReadinessProbeResult;
      try {
        result = await this.#readinessProbe(target, active.controller.signal);
      } catch {
        result = active.controller.signal.aborted
          ? { kind: "aborted" }
          : { kind: "unhealthy", reason: "timeout" };
      }
      if (result.kind === "aborted") return;
      await this.#serialize(service.id, async () => {
        if (
          active.controller.signal.aborted ||
          this.#readinessProbes.get(service.id) !== active ||
          this.#runtimes.get(service.id) !== runtime
        ) {
          return;
        }
        if (result.kind === "ready") {
          await runtime.supervisor.setReadiness(runId, "ready");
        } else {
          await runtime.supervisor.failReadiness(runId, "READINESS_TIMEOUT");
        }
      });
    };
    void task()
      .catch(() => {
        // The probe result is reflected through validated snapshots; no task rejection escapes.
      })
      .finally(() => {
        if (this.#readinessProbes.get(service.id) === active) {
          this.#readinessProbes.delete(service.id);
        }
      });
  }

  #readinessTarget(readiness: ReadinessProbe, port: number): ReadinessProbeTarget {
    return readiness.kind === "tcp"
      ? { kind: "tcp", port, timeoutMs: readiness.timeoutMs }
      : { kind: "http", port, path: readiness.path, timeoutMs: readiness.timeoutMs };
  }

  #cancelReadinessProbe(serviceId: string): void {
    const active = this.#readinessProbes.get(serviceId);
    if (active === undefined) return;
    this.#readinessProbes.delete(serviceId);
    active.controller.abort();
  }

  #historicalSnapshot(serviceId: string): RunSnapshot | null {
    const snapshot = this.#registry.latestRun(serviceId);
    if (!needsReconciliation(snapshot) || snapshot.reconciliationState === "unknown") {
      return snapshot;
    }
    const reconciled: RunSnapshot = {
      ...snapshot,
      processState: "stopping",
      reconciliationState: "unknown",
      failureReason: "DAEMON_RESTART_OWNERSHIP_UNKNOWN",
    };
    this.#persist(reconciled);
    return reconciled;
  }

  #reconcilePersistedHistory(): void {
    for (const project of this.#registry.listProjects(true)) {
      for (const service of this.#registry.listServices(project.id)) {
        this.#historicalSnapshot(service.id);
      }
    }
  }

  #evictLogs(): void {
    if (this.#logBuffers.size <= MAX_RETAINED_RUN_LOGS) return;
    const active = new Set<string>();
    for (const runtime of this.#runtimes.values()) {
      const runId = activeRunId(runtime);
      if (runId !== null) active.add(runId);
    }
    while (this.#logBuffers.size > MAX_RETAINED_RUN_LOGS) {
      const index = this.#logOrder.findIndex((runId) => !active.has(runId));
      if (index === -1) return;
      const [runId] = this.#logOrder.splice(index, 1);
      if (runId !== undefined) {
        this.#logBuffers.get(runId)?.dispose();
        this.#logBuffers.delete(runId);
      }
    }
  }

  #serialize<T>(serviceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(serviceId) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(serviceId, tail);
    void tail.then(() => {
      if (this.#tails.get(serviceId) === tail) this.#tails.delete(serviceId);
    });
    return result;
  }
}
