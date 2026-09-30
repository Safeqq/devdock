import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ProfileRuntimeManager } from "../../apps/daemon/dist/profile-runtime-manager.js";

function runSnapshot(serviceId, runId, processState = "running") {
  return {
    runId,
    serviceId,
    processState,
    readinessState: processState === "running" ? "ready" : "unknown",
    reconciliationState: "known",
    startedAt: new Date().toISOString(),
    ...(processState === "running" ? { pid: 100 } : { endedAt: new Date().toISOString() }),
  };
}

function fakeRegistry(profiles) {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  return {
    getProfile(id) {
      const profile = byId.get(id);
      if (profile === undefined) throw new Error("PROFILE_NOT_FOUND");
      return profile;
    },
    async runnableProfile(id) {
      return this.getProfile(id);
    },
  };
}

function fakeRuntime({ preExisting = [], fail = [] } = {}) {
  const running = new Map(preExisting.map((serviceId) => [serviceId, randomUUID()]));
  const failed = new Set(fail);
  const starts = [];
  const stops = [];
  return {
    starts,
    stops,
    async start(serviceId) {
      starts.push(serviceId);
      const current = running.get(serviceId);
      if (current !== undefined) {
        return { kind: "existing", snapshot: runSnapshot(serviceId, current) };
      }
      const runId = randomUUID();
      if (failed.has(serviceId)) {
        return {
          kind: "failed",
          snapshot: {
            ...runSnapshot(serviceId, runId, "failed"),
            failureReason: "SPAWN_ERROR",
          },
          reason: "SPAWN_ERROR",
        };
      }
      running.set(serviceId, runId);
      return { kind: "started", snapshot: runSnapshot(serviceId, runId) };
    },
    async waitForStartup(serviceId, runId) {
      return running.get(serviceId) === runId
        ? { kind: "ready", snapshot: runSnapshot(serviceId, runId) }
        : { kind: "failed", snapshot: null, reason: "RUN_CHANGED" };
    },
    async status(serviceId) {
      const runId = running.get(serviceId);
      return runId === undefined
        ? { snapshot: null, ownership: null }
        : { snapshot: runSnapshot(serviceId, runId), ownership: "owned" };
    },
    async stop(serviceId) {
      const runId = running.get(serviceId);
      if (runId === undefined) return { kind: "already_stopped", snapshot: null };
      running.delete(serviceId);
      stops.push(serviceId);
      return { kind: "stopped", snapshot: runSnapshot(serviceId, runId, "stopped") };
    },
  };
}

async function waitForState(manager, profileId, state) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { snapshot } = await manager.status(profileId);
    if (snapshot?.state === state) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Profile did not reach ${state}`);
}

test("profile startup is topological and rolls back only newly started services", async () => {
  const projectId = randomUUID();
  const database = randomUUID();
  const api = randomUUID();
  const web = randomUUID();
  const profile = {
    id: randomUUID(),
    projectId,
    displayName: "Full stack",
    services: [
      { serviceId: web, dependsOn: [api] },
      { serviceId: api, dependsOn: [database] },
      { serviceId: database, dependsOn: [] },
    ],
  };
  const runtime = fakeRuntime({ preExisting: [database], fail: [web] });
  const manager = new ProfileRuntimeManager({
    registry: fakeRegistry([profile]),
    runtime,
  });
  try {
    const started = await manager.start(profile.id);
    assert.equal(started.kind, "started");
    const degraded = await waitForState(manager, profile.id, "degraded");
    assert.deepEqual(runtime.starts, [database, api, web]);
    assert.deepEqual(runtime.stops, [api]);
    assert.equal(
      degraded.services.find((service) => service.serviceId === database).state,
      "preserved",
    );
    assert.equal(
      degraded.services.find((service) => service.serviceId === api).state,
      "rolled_back",
    );
    assert.equal(degraded.services.find((service) => service.serviceId === web).state, "failed");
  } finally {
    await manager.close();
  }
});

test("shared profile lease stops a managed service only after the final consumer releases it", async () => {
  const projectId = randomUUID();
  const shared = randomUUID();
  const app = randomUUID();
  const first = {
    id: randomUUID(),
    projectId,
    displayName: "Backend only",
    services: [{ serviceId: shared, dependsOn: [] }],
  };
  const second = {
    id: randomUUID(),
    projectId,
    displayName: "Full stack",
    services: [
      { serviceId: shared, dependsOn: [] },
      { serviceId: app, dependsOn: [shared] },
    ],
  };
  const runtime = fakeRuntime();
  const manager = new ProfileRuntimeManager({
    registry: fakeRegistry([first, second]),
    runtime,
  });
  try {
    await manager.start(first.id);
    await waitForState(manager, first.id, "ready");
    await manager.start(second.id);
    await waitForState(manager, second.id, "ready");

    await manager.stop(first.id);
    assert.deepEqual(runtime.stops, []);
    const firstStopped = (await manager.status(first.id)).snapshot;
    assert.equal(firstStopped.services[0].state, "preserved");

    await manager.stop(second.id);
    assert.deepEqual(runtime.stops, [app, shared]);
  } finally {
    await manager.close();
  }
});

test("Stop cancels an in-flight profile startup and rolls back its owned run", async () => {
  const projectId = randomUUID();
  const serviceId = randomUUID();
  const profile = {
    id: randomUUID(),
    projectId,
    displayName: "Cancelable",
    services: [{ serviceId, dependsOn: [] }],
  };
  const runId = randomUUID();
  let waiting = false;
  let running = true;
  let stopCount = 0;
  const runtime = {
    async start() {
      return { kind: "started", snapshot: runSnapshot(serviceId, runId) };
    },
    waitForStartup(_serviceId, _runId, signal) {
      waiting = true;
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true });
      });
    },
    async status() {
      return running
        ? { snapshot: runSnapshot(serviceId, runId), ownership: "owned" }
        : { snapshot: runSnapshot(serviceId, runId, "stopped"), ownership: null };
    },
    async stop() {
      running = false;
      stopCount += 1;
      return { kind: "stopped", snapshot: runSnapshot(serviceId, runId, "stopped") };
    },
  };
  const manager = new ProfileRuntimeManager({
    registry: fakeRegistry([profile]),
    runtime,
  });
  try {
    await manager.start(profile.id);
    for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(waiting, true);
    const stopped = await manager.stop(profile.id);
    assert.equal(stopped.kind, "stopped");
    assert.equal(stopped.snapshot.state, "stopped");
    assert.equal(stopCount, 1);
  } finally {
    await manager.close();
  }
});
