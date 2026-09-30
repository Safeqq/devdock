import assert from "node:assert/strict";
import { Readable } from "node:stream";
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

test("Stop aborts an in-flight readiness probe before stopping the owned process", async () => {
  const serviceId = "service-readiness";
  let latest = null;
  let aborted = false;
  let closedResult = null;
  let resolveClose;
  const closed = new Promise((resolve) => {
    resolveClose = resolve;
  });
  const registry = {
    getService(id) {
      assert.equal(id, serviceId);
      return {
        id: serviceId,
        expectedPort: 4_300,
        readiness: { kind: "tcp", timeoutMs: 60_000 },
      };
    },
    latestRun() {
      return latest;
    },
    saveRunSnapshot(snapshot) {
      latest = { ...snapshot };
      return snapshot;
    },
    async launchPlan() {
      return { executable: "fixture", args: [], canonicalCwd: ".", env: {} };
    },
  };
  const adapter = {
    async start(request) {
      return {
        runId: request.runId,
        pid: 4_321,
        identity: "readiness-owned",
        ownership: {},
        gracefulStop: { supported: true },
        stdout: Readable.from([]),
        stderr: Readable.from([]),
      };
    },
    async inspectOwnership() {
      return closedResult === null ? "owned" : "exited";
    },
    async requestGracefulStop() {
      closedResult = { kind: "exited", code: 0, signal: null };
      resolveClose(closedResult);
      return "requested";
    },
    async terminateOwnedTree() {
      return "unsupported";
    },
    async waitForExit(_handle, timeoutMs) {
      if (closedResult !== null) return closedResult;
      if (timeoutMs !== undefined) return { kind: "timeout" };
      return closed;
    },
  };
  const runtime = new ServiceRuntimeManager({
    registry,
    launcher: {},
    adapterFactory: () => adapter,
    readinessProbe: (_target, signal) =>
      new Promise((resolveProbe) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolveProbe({ kind: "aborted" });
          },
          { once: true },
        );
      }),
  });

  const started = await runtime.start(serviceId);
  assert.equal(started.snapshot.processState, "running");
  assert.equal(started.snapshot.readinessState, "checking");
  const stopped = await runtime.stop(serviceId);
  assert.equal(aborted, true);
  assert.equal(stopped.snapshot.processState, "stopped");
  assert.equal(stopped.snapshot.readinessState, "unknown");
  await runtime.close();
});
