import { randomUUID } from "node:crypto";
import type { RunSnapshot } from "@devdock/contracts";
import type { NpmLauncher, ProcessAdapter } from "@devdock/platform";
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

export interface ServiceRuntimeManagerOptions {
  readonly registry: ProjectRegistry;
  readonly launcher: NpmLauncher;
  readonly adapterFactory: () => ProcessAdapter;
  readonly daemonSessionId?: string;
}

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
  readonly #daemonSessionId: string;
  readonly #runtimes = new Map<string, ManagedServiceRuntime>();
  readonly #tails = new Map<string, Promise<void>>();
  readonly #logBuffers = new Map<string, RunLogBuffer>();
  readonly #logOrder: string[] = [];
  #closed = false;

  constructor(options: ServiceRuntimeManagerOptions) {
    this.#registry = options.registry;
    this.#launcher = options.launcher;
    this.#adapterFactory = options.adapterFactory;
    this.#daemonSessionId = options.daemonSessionId ?? randomUUID();
  }

  get logBuffers(): ReadonlyMap<string, RunLogBuffer> {
    return this.#logBuffers;
  }

  start(serviceId: string): Promise<StartOutcome> {
    return this.#serialize(serviceId, async () => {
      if (this.#closed) throw new Error("Service runtime manager is closed");
      let runtime = this.#runtimes.get(serviceId);
      if (runtime === undefined) {
        const historical = this.#historicalSnapshot(serviceId);
        if (needsReconciliation(historical)) {
          return { kind: "rejected", snapshot: historical, reason: "OWNERSHIP_UNKNOWN" };
        }
      }
      if (runtime === undefined || replaceable(runtime.supervisor.snapshot())) {
        const plan = await this.#registry.launchPlan(serviceId, this.#launcher);
        runtime = {
          supervisor: new SingleServiceSupervisor(this.#adapterFactory(), plan, {
            serviceId,
            onSnapshot: (snapshot) => this.#persist(snapshot),
            onSnapshotError: () => {
              process.stderr.write(
                `Could not persist lifecycle history for service ${serviceId}\n`,
              );
            },
          }),
        };
        this.#runtimes.set(serviceId, runtime);
      }

      const outcome = await runtime.supervisor.start();
      if (outcome.kind === "started" || outcome.kind === "existing") {
        this.#capture(runtime, outcome.snapshot.runId);
      }
      return outcome;
    });
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

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
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
    this.#evictLogs();
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
    this.#registry.saveRunSnapshot(snapshot);
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
      if (runId !== undefined) this.#logBuffers.delete(runId);
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
