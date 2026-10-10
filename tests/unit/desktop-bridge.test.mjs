import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { DesktopBridge } from "../../apps/daemon/dist/desktop-bridge.js";

function fakes() {
  const services = new Map([
    ["svc-dev", { id: "svc-dev", projectId: "p-shop", displayName: "dev" }],
    ["svc-api", { id: "svc-api", projectId: "p-shop", displayName: "api" }],
    ["svc-blog", { id: "svc-blog", projectId: "p-blog", displayName: "serve" }],
  ]);
  const projects = new Map([
    ["p-shop", { id: "p-shop", displayName: "toko-online" }],
    ["p-blog", { id: "p-blog", displayName: "blog" }],
  ]);
  let listener = null;
  const stopped = [];
  const busyGroups = new Set(["g-full"]);
  return {
    stopped,
    publish: (snapshot) => listener?.(snapshot),
    registry: {
      getService(id) {
        const service = services.get(id);
        if (service === undefined)
          throw Object.assign(new Error("gone"), { code: "SERVICE_NOT_FOUND" });
        return service;
      },
      getProject: (id) => projects.get(id),
      listProjects: () => [...projects.values()],
      listProfiles: (projectId) => (projectId === "p-shop" ? [{ id: "g-full" }] : []),
    },
    runtime: {
      subscribeAll(next) {
        listener = next;
        return () => {
          listener = null;
        };
      },
      async stop(serviceId) {
        stopped.push(serviceId);
      },
    },
    profileRuntime: {
      busy: (id) => busyGroups.has(id),
      async stop(id) {
        stopped.push(`group:${id}`);
        busyGroups.delete(id);
      },
    },
  };
}

function snapshot(serviceId, processState, extra = {}) {
  return {
    runId: `${serviceId}-run`,
    serviceId,
    processState,
    readinessState: "unknown",
    reconciliationState: "known",
    startedAt: new Date().toISOString(),
    ...extra,
  };
}

test("desktop bridge sends one summary per change, grouped by project", async () => {
  const world = fakes();
  const events = [];
  const bridge = new DesktopBridge({ ...world, emit: (event) => events.push(event) });
  await nextTurn();
  assert.deepEqual(events, [{ type: "runtime-summary", active: 0, projects: [] }]);

  world.publish(snapshot("svc-dev", "starting"));
  world.publish(snapshot("svc-dev", "running"));
  world.publish(snapshot("svc-api", "running"));
  world.publish(snapshot("svc-blog", "running"));
  await nextTurn();
  assert.deepEqual(events.slice(1), [
    {
      type: "runtime-summary",
      active: 3,
      projects: [
        { name: "blog", active: 1 },
        { name: "toko-online", active: 2 },
      ],
    },
  ]);

  // A ready update that keeps the same count does not repeat the summary.
  world.publish(snapshot("svc-dev", "running", { readinessState: "ready" }));
  await nextTurn();
  assert.equal(events.length, 2);

  // Unknown ownership is not counted as running.
  world.publish(snapshot("svc-blog", "stopping", { reconciliationState: "unknown" }));
  await nextTurn();
  assert.equal(events.at(-1).active, 2);
  bridge.close();
});

test("desktop bridge alerts once for a failed run and never for a requested stop", async () => {
  const world = fakes();
  const events = [];
  const bridge = new DesktopBridge({ ...world, emit: (event) => events.push(event) });
  world.publish(snapshot("svc-dev", "stopped"));
  world.publish(snapshot("svc-api", "failed", { failureReason: "READINESS_TIMEOUT" }));
  world.publish(snapshot("svc-api", "failed", { failureReason: "READINESS_TIMEOUT" }));
  world.publish(snapshot("svc-dev", "failed", { runId: "second", exitCode: 1 }));
  await nextTurn();
  const alerts = events.filter((event) => event.type === "script-alert");
  assert.deepEqual(alerts, [
    {
      type: "script-alert",
      title: "api didn't answer in time",
      body: "toko-online · DevDock stopped it. Open DevDock to see its output.",
    },
    {
      type: "script-alert",
      title: "dev stopped with an error",
      body: "toko-online · Open DevDock to see its output.",
    },
  ]);
  bridge.close();
});

test("stop all stops running groups first, then every active script", async () => {
  const world = fakes();
  const bridge = new DesktopBridge({ ...world, emit: () => {} });
  world.publish(snapshot("svc-dev", "running"));
  world.publish(snapshot("svc-blog", "running"));
  world.publish(snapshot("svc-api", "exited"));
  await bridge.stopAll();
  assert.deepEqual(world.stopped, ["group:g-full", "svc-dev", "svc-blog"]);
  bridge.close();
});
