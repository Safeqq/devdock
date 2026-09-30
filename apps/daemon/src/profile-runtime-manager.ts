import { randomUUID } from "node:crypto";
import {
  type ProfileConfig,
  type ProfileOperationSnapshot,
  ProfileOperationSnapshotSchema,
  type ProfileServiceOperation,
} from "@devdock/contracts";
import { profileStartOrder } from "./profile-graph.js";
import type { ProjectRegistry } from "./project-registry.js";
import type { ServiceRuntimeManager, ServiceStartupResult } from "./service-runtime-manager.js";
import type {
  StartOutcome,
  StopOutcome,
  SupervisorInspection,
} from "./single-service-supervisor.js";

interface ProfileServiceRuntime {
  start(serviceId: string): Promise<StartOutcome>;
  stop(serviceId: string): Promise<StopOutcome>;
  status(serviceId: string): Promise<SupervisorInspection>;
  waitForStartup(
    serviceId: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<ServiceStartupResult>;
}

interface ServiceLease {
  readonly runId: string;
  readonly managedByProfiles: boolean;
  readonly consumers: Set<string>;
}

interface ActiveProfileOperation {
  readonly profile: ProfileConfig;
  readonly order: readonly string[];
  readonly controller: AbortController;
  snapshot: ProfileOperationSnapshot;
  stopRequested: boolean;
}

export type ProfileStartOutcome =
  | { kind: "started"; snapshot: ProfileOperationSnapshot }
  | { kind: "existing"; snapshot: ProfileOperationSnapshot };

export type ProfileStopOutcome =
  | { kind: "stopped"; snapshot: ProfileOperationSnapshot }
  | { kind: "already_stopped"; snapshot: ProfileOperationSnapshot | null };

function reasonFrom(caught: unknown): string {
  if (
    typeof caught === "object" &&
    caught !== null &&
    "code" in caught &&
    typeof caught.code === "string"
  ) {
    return caught.code.slice(0, 512);
  }
  return "PROFILE_START_FAILED";
}

function active(snapshot: ProfileOperationSnapshot): boolean {
  return (
    snapshot.state === "starting" || snapshot.state === "ready" || snapshot.state === "stopping"
  );
}

function clone(snapshot: ProfileOperationSnapshot): ProfileOperationSnapshot {
  return {
    ...snapshot,
    services: snapshot.services.map((service) => ({ ...service })),
  };
}

export class ProfileRuntimeManager {
  readonly #registry: ProjectRegistry;
  readonly #runtime: ProfileServiceRuntime;
  readonly #operations = new Map<string, ActiveProfileOperation>();
  readonly #leases = new Map<string, ServiceLease>();
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: {
    registry: ProjectRegistry;
    runtime: ServiceRuntimeManager | ProfileServiceRuntime;
  }) {
    this.#registry = options.registry;
    this.#runtime = options.runtime;
  }

  async start(profileId: string): Promise<ProfileStartOutcome> {
    if (this.#closed) throw new Error("Profile runtime manager is closed");
    const profile = await this.#registry.runnableProfile(profileId);
    const existing = this.#operations.get(profileId);
    if (existing !== undefined && active(existing.snapshot)) {
      return { kind: "existing", snapshot: clone(existing.snapshot) };
    }
    const order = profileStartOrder(profile);
    const operation: ActiveProfileOperation = {
      profile,
      order,
      controller: new AbortController(),
      stopRequested: false,
      snapshot: ProfileOperationSnapshotSchema.parse({
        operationId: randomUUID(),
        profileId,
        state: "starting",
        startedAt: new Date().toISOString(),
        services: order.map((serviceId) => ({
          serviceId,
          origin: "pending",
          state: "pending",
        })),
      }),
    };
    const raced = this.#operations.get(profileId);
    if (raced !== undefined && active(raced.snapshot)) {
      return { kind: "existing", snapshot: clone(raced.snapshot) };
    }
    this.#operations.set(profileId, operation);
    void this.#enqueue(() => this.#runStart(operation)).catch(() => {
      this.#finishFailure(operation, "PROFILE_START_FAILED");
    });
    return { kind: "started", snapshot: clone(operation.snapshot) };
  }

  async status(profileId: string): Promise<{ snapshot: ProfileOperationSnapshot | null }> {
    this.#registry.getProfile(profileId);
    const operation = this.#operations.get(profileId);
    return { snapshot: operation === undefined ? null : clone(operation.snapshot) };
  }

  async stop(profileId: string): Promise<ProfileStopOutcome> {
    this.#registry.getProfile(profileId);
    const operation = this.#operations.get(profileId);
    if (operation === undefined || !active(operation.snapshot)) {
      return {
        kind: "already_stopped",
        snapshot: operation === undefined ? null : clone(operation.snapshot),
      };
    }
    operation.stopRequested = true;
    operation.controller.abort();
    if (operation.snapshot.state !== "stopping") {
      this.#set(operation, { ...operation.snapshot, state: "stopping" });
    }
    await this.#enqueue(() => this.#stopOperation(operation));
    return { kind: "stopped", snapshot: clone(operation.snapshot) };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const operation of this.#operations.values()) operation.controller.abort();
    await this.#tail;
    this.#leases.clear();
  }

  async #runStart(operation: ActiveProfileOperation): Promise<void> {
    let failureReason: string | null = null;
    for (const serviceId of operation.order) {
      if (operation.controller.signal.aborted) {
        failureReason = "PROFILE_START_CANCELLED";
        break;
      }
      this.#updateService(operation, serviceId, { state: "starting" });
      let outcome: StartOutcome;
      try {
        outcome = await this.#runtime.start(serviceId);
      } catch (caught) {
        failureReason = reasonFrom(caught);
        this.#updateService(operation, serviceId, {
          state: "failed",
          reason: failureReason,
        });
        break;
      }
      if (outcome.kind === "failed" || outcome.kind === "rejected") {
        failureReason = outcome.reason;
        this.#updateService(operation, serviceId, {
          state: "failed",
          reason: failureReason,
          runId: outcome.snapshot.runId,
        });
        break;
      }
      const origin = outcome.kind === "started" ? "started" : "pre_existing";
      this.#acquire(operation, serviceId, outcome.snapshot.runId, origin === "started");
      this.#updateService(operation, serviceId, {
        origin,
        state: "starting",
        runId: outcome.snapshot.runId,
      });
      if (operation.controller.signal.aborted) {
        failureReason = "PROFILE_START_CANCELLED";
        break;
      }
      const startup = await this.#runtime.waitForStartup(
        serviceId,
        outcome.snapshot.runId,
        operation.controller.signal,
      );
      if (startup.kind === "aborted") {
        failureReason = "PROFILE_START_CANCELLED";
        break;
      }
      if (startup.kind === "failed") {
        failureReason = startup.reason;
        this.#updateService(operation, serviceId, {
          state: "failed",
          reason: startup.reason,
        });
        break;
      }
      this.#updateService(operation, serviceId, { state: "ready" });
    }

    if (failureReason === null) {
      this.#set(operation, { ...operation.snapshot, state: "ready" });
      return;
    }
    await this.#rollback(operation);
    if (operation.stopRequested || failureReason === "PROFILE_START_CANCELLED") {
      const stopped = {
        ...operation.snapshot,
        state: "stopped" as const,
        endedAt: new Date().toISOString(),
      };
      delete stopped.failureReason;
      this.#set(operation, stopped);
    } else {
      this.#finishFailure(operation, failureReason);
    }
  }

  async #rollback(operation: ActiveProfileOperation): Promise<void> {
    for (const serviceId of [...operation.order].reverse()) {
      const service = operation.snapshot.services.find((entry) => entry.serviceId === serviceId);
      if (service?.runId === undefined) continue;
      await this.#release(operation, service, "rolled_back");
    }
  }

  async #stopOperation(operation: ActiveProfileOperation): Promise<void> {
    if (operation.snapshot.state === "stopped") return;
    for (const serviceId of [...operation.order].reverse()) {
      const service = operation.snapshot.services.find((entry) => entry.serviceId === serviceId);
      if (service?.runId === undefined) continue;
      await this.#release(operation, service, "stopped");
    }
    const stopped = {
      ...operation.snapshot,
      state: "stopped" as const,
      endedAt: new Date().toISOString(),
    };
    delete stopped.failureReason;
    this.#set(operation, stopped);
  }

  #acquire(
    operation: ActiveProfileOperation,
    serviceId: string,
    runId: string,
    newlyStarted: boolean,
  ): void {
    const current = this.#leases.get(serviceId);
    const lease =
      current?.runId === runId
        ? current
        : {
            runId,
            managedByProfiles: newlyStarted,
            consumers: new Set<string>(),
          };
    lease.consumers.add(operation.snapshot.operationId);
    this.#leases.set(serviceId, lease);
  }

  async #release(
    operation: ActiveProfileOperation,
    service: ProfileServiceOperation,
    stoppedState: "rolled_back" | "stopped",
  ): Promise<void> {
    const runId = service.runId;
    if (runId === undefined) return;
    const lease = this.#leases.get(service.serviceId);
    if (lease === undefined || lease.runId !== runId) {
      if (service.state !== "failed")
        this.#updateService(operation, service.serviceId, { state: "preserved" });
      return;
    }
    lease.consumers.delete(operation.snapshot.operationId);
    if (lease.consumers.size > 0 || !lease.managedByProfiles) {
      if (lease.consumers.size === 0) this.#leases.delete(service.serviceId);
      if (service.state !== "failed")
        this.#updateService(operation, service.serviceId, { state: "preserved" });
      return;
    }
    this.#leases.delete(service.serviceId);
    let inspection: SupervisorInspection;
    try {
      inspection = await this.#runtime.status(service.serviceId);
    } catch {
      if (service.state !== "failed") {
        this.#updateService(operation, service.serviceId, {
          state: "preserved",
          reason: "ROLLBACK_STATUS_ERROR",
        });
      }
      return;
    }
    if (inspection.snapshot?.runId !== runId || inspection.ownership !== "owned") {
      if (service.state !== "failed")
        this.#updateService(operation, service.serviceId, { state: "preserved" });
      return;
    }
    let outcome: StopOutcome;
    try {
      outcome = await this.#runtime.stop(service.serviceId);
    } catch {
      if (service.state !== "failed") {
        this.#updateService(operation, service.serviceId, {
          state: "preserved",
          reason: "ROLLBACK_STOP_ERROR",
        });
      }
      return;
    }
    if (outcome.kind === "incomplete") {
      this.#updateService(operation, service.serviceId, {
        state: "preserved",
        reason: outcome.reason,
      });
    } else if (service.state !== "failed") {
      this.#updateService(operation, service.serviceId, { state: stoppedState });
    }
  }

  #finishFailure(operation: ActiveProfileOperation, reason: string): void {
    this.#set(operation, {
      ...operation.snapshot,
      state: "degraded",
      endedAt: new Date().toISOString(),
      failureReason: reason,
    });
  }

  #updateService(
    operation: ActiveProfileOperation,
    serviceId: string,
    update: Partial<ProfileServiceOperation>,
  ): void {
    this.#set(operation, {
      ...operation.snapshot,
      services: operation.snapshot.services.map((service) =>
        service.serviceId === serviceId ? { ...service, ...update } : service,
      ),
    });
  }

  #set(operation: ActiveProfileOperation, snapshot: ProfileOperationSnapshot): void {
    if (this.#operations.get(operation.profile.id) !== operation) return;
    operation.snapshot = ProfileOperationSnapshotSchema.parse(snapshot);
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
