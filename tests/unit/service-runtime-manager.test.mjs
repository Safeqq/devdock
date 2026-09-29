import assert from "node:assert/strict";
import { test } from "node:test";
import { ServiceRuntimeManager } from "../../apps/daemon/dist/service-runtime-manager.js";

test("historical active run becomes unknown and cannot authorize start or stop", async () => {
  const serviceId = "service-one";
  let stored = {
    runId: "run-from-old-daemon",
    serviceId,
    processState: "running",
    readinessState: "unknown",
    reconciliationState: "known",
    pid: 4321,
    startedAt: new Date().toISOString(),
  };
  let adapterCreations = 0;
  const registry = {
    getService(id) {
      assert.equal(id, serviceId);
      return { id };
    },
    latestRun(id) {
      assert.equal(id, serviceId);
      return { ...stored };
    },
    saveRunSnapshot(snapshot) {
      stored = { ...snapshot };
      return snapshot;
    },
    async launchPlan() {
      throw new Error("Historical unknown run must block launch planning");
    },
  };
  const runtime = new ServiceRuntimeManager({
    registry,
    launcher: {},
    adapterFactory: () => {
      adapterCreations += 1;
      throw new Error("Historical unknown run must block adapter creation");
    },
  });

  const status = await runtime.status(serviceId);
  assert.equal(status.snapshot.processState, "stopping");
  assert.equal(status.snapshot.reconciliationState, "unknown");
  assert.equal(status.snapshot.failureReason, "DAEMON_RESTART_OWNERSHIP_UNKNOWN");
  assert.equal(status.ownership, "unknown");

  const start = await runtime.start(serviceId);
  assert.equal(start.kind, "rejected");
  assert.equal(start.reason, "OWNERSHIP_UNKNOWN");
  const stop = await runtime.stop(serviceId);
  assert.equal(stop.kind, "incomplete");
  assert.equal(stop.reason, "OWNERSHIP_UNKNOWN");
  assert.equal(adapterCreations, 0);
});
