import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { ServiceRuntimeManager } from "../../apps/daemon/dist/service-runtime-manager.js";

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(message);
}

function fakeRestartScheduler() {
  const tasks = [];
  return {
    tasks,
    schedule(callback, delayMs) {
      const task = { callback, delayMs, cancelled: false };
      tasks.push(task);
      return { cancel: () => (task.cancelled = true) };
    },
    runNext() {
      const task = tasks.find((candidate) => !candidate.cancelled && !candidate.ran);
      assert.ok(task, "Expected a pending restart timer");
      task.ran = true;
      task.callback();
    },
    pending() {
      return tasks.filter((task) => !task.cancelled && !task.ran);
    },
  };
}

function controlledAdapter() {
  const runs = [];
  return {
    runs,
    adapter: {
      async start(request) {
        let resolveExit;
        const exit = new Promise((resolve) => {
          resolveExit = resolve;
        });
        const run = { result: null, resolveExit, exit };
        runs.push(run);
        return {
          runId: request.runId,
          pid: 5_000 + runs.length,
          identity: `owned-${runs.length}`,
          ownership: {},
          gracefulStop: { supported: true },
          stdout: Readable.from([]),
          stderr: Readable.from([]),
          testRun: run,
        };
      },
      async inspectOwnership(handle) {
        return handle.testRun.result === null ? "owned" : "exited";
      },
      async requestGracefulStop(handle) {
        if (handle.testRun.result === null) {
          handle.testRun.result = { kind: "exited", code: 0, signal: null };
          handle.testRun.resolveExit(handle.testRun.result);
        }
        return "requested";
      },
      async terminateOwnedTree() {
        return "unsupported";
      },
      async waitForExit(handle, timeoutMs) {
        if (handle.testRun.result !== null) return handle.testRun.result;
        if (timeoutMs !== undefined) return { kind: "timeout" };
        return handle.testRun.exit;
      },
    },
    crash(index) {
      const run = runs[index];
      assert.ok(run);
      run.result = { kind: "exited", code: 1, signal: null };
      run.resolveExit(run.result);
    },
  };
}

function restartRegistry(serviceId, restartPolicy) {
  let latest = null;
  return {
    listProjects() {
      return [{ id: "project-restart" }];
    },
    listServices() {
      return [{ id: serviceId }];
    },
    getService() {
      return { id: serviceId, restartPolicy };
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
}

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
    listProjects() {
      return [{ id: "project-one" }];
    },
    listServices() {
      return [{ id: serviceId }];
    },
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

  assert.equal(stored.reconciliationState, "unknown");
  assert.equal(stored.failureReason, "DAEMON_RESTART_OWNERSHIP_UNKNOWN");

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
    listProjects() {
      return [{ id: "project-one" }];
    },
    listServices() {
      return [{ id: serviceId }];
    },
    getService(id) {
      assert.equal(id, serviceId);
      return {
        id: serviceId,
        expectedPort: 4_300,
        readiness: { kind: "tcp", timeoutMs: 60_000 },
        restartPolicy: { kind: "off" },
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

test("failure restart policy uses bounded exponential backoff", async () => {
  const serviceId = "service-restart";
  const scheduler = fakeRestartScheduler();
  const process = controlledAdapter();
  const runtime = new ServiceRuntimeManager({
    registry: restartRegistry(serviceId, {
      kind: "on_failure",
      maxAttempts: 2,
      initialBackoffMs: 100,
      maxBackoffMs: 150,
    }),
    launcher: {},
    adapterFactory: () => process.adapter,
    restartScheduler: scheduler.schedule,
  });
  try {
    await runtime.start(serviceId);
    process.crash(0);
    await waitUntil(() => scheduler.pending().length === 1, "First restart was not scheduled");
    assert.equal(scheduler.pending()[0].delayMs, 100);
    scheduler.runNext();
    await waitUntil(() => process.runs.length === 2, "First restart did not run");

    process.crash(1);
    await waitUntil(() => scheduler.pending().length === 1, "Second restart was not scheduled");
    assert.equal(scheduler.pending()[0].delayMs, 150);
    scheduler.runNext();
    await waitUntil(() => process.runs.length === 3, "Second restart did not run");

    process.crash(2);
    await waitUntil(
      () => runtime.logBuffers.size === 3,
      "Final failed run was not observed before checking the limit",
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(scheduler.pending().length, 0);
  } finally {
    await runtime.close();
  }
});

test("Stop cancels a pending automatic restart", async () => {
  const serviceId = "service-stop-restart";
  const scheduler = fakeRestartScheduler();
  const process = controlledAdapter();
  const runtime = new ServiceRuntimeManager({
    registry: restartRegistry(serviceId, {
      kind: "on_failure",
      maxAttempts: 3,
      initialBackoffMs: 100,
      maxBackoffMs: 1_000,
    }),
    launcher: {},
    adapterFactory: () => process.adapter,
    restartScheduler: scheduler.schedule,
  });
  try {
    await runtime.start(serviceId);
    process.crash(0);
    await waitUntil(() => scheduler.pending().length === 1, "Restart was not scheduled");

    await runtime.stop(serviceId);

    assert.equal(scheduler.pending().length, 0);
    assert.equal(process.runs.length, 1);
  } finally {
    await runtime.close();
  }
});

test("restart policy stays off unless explicitly enabled", async () => {
  const serviceId = "service-no-restart";
  const scheduler = fakeRestartScheduler();
  const process = controlledAdapter();
  const runtime = new ServiceRuntimeManager({
    registry: restartRegistry(serviceId, { kind: "off" }),
    launcher: {},
    adapterFactory: () => process.adapter,
    restartScheduler: scheduler.schedule,
  });
  try {
    await runtime.start(serviceId);
    process.crash(0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(scheduler.tasks.length, 0);
    assert.equal(process.runs.length, 1);
  } finally {
    await runtime.close();
  }
});

test("manager close stops an owned run and disposes its log buffer", async () => {
  const serviceId = "service-close";
  const process = controlledAdapter();
  const runtime = new ServiceRuntimeManager({
    registry: restartRegistry(serviceId, { kind: "off" }),
    launcher: {},
    adapterFactory: () => process.adapter,
  });
  const started = await runtime.start(serviceId);
  const logs = runtime.logBuffers.get(started.snapshot.runId);
  assert.ok(logs);

  await runtime.close();

  assert.equal(process.runs[0].result.code, 0);
  assert.equal(runtime.logBuffers.size, 0);
  assert.throws(() => logs.push("stdout", "late output\n"), /ended/);
});

test("manager close cancels a pending automatic restart", async () => {
  const serviceId = "service-close-restart";
  const scheduler = fakeRestartScheduler();
  const process = controlledAdapter();
  const runtime = new ServiceRuntimeManager({
    registry: restartRegistry(serviceId, {
      kind: "on_failure",
      maxAttempts: 3,
      initialBackoffMs: 100,
      maxBackoffMs: 1_000,
    }),
    launcher: {},
    adapterFactory: () => process.adapter,
    restartScheduler: scheduler.schedule,
  });
  await runtime.start(serviceId);
  process.crash(0);
  await waitUntil(() => scheduler.pending().length === 1, "Restart was not scheduled");

  await runtime.close();

  assert.equal(scheduler.pending().length, 0);
  assert.equal(process.runs.length, 1);
});

test("a leftover run is marked stopped only on request, and then can start again", async () => {
  const serviceId = "service-leftover";
  const registry = restartRegistry(serviceId, { kind: "off" });
  registry.saveRunSnapshot({
    runId: "run-from-crashed-daemon",
    serviceId,
    processState: "running",
    readinessState: "ready",
    reconciliationState: "known",
    pid: 4321,
    startedAt: new Date().toISOString(),
  });
  const process = controlledAdapter();
  const runtime = new ServiceRuntimeManager({
    registry,
    launcher: {},
    adapterFactory: () => process.adapter,
  });
  const seen = [];
  runtime.subscribeAll((snapshot) => seen.push(snapshot));

  assert.equal(runtime.holds(serviceId), false);
  assert.equal((await runtime.start(serviceId)).kind, "rejected");
  await assert.rejects(runtime.forget(serviceId), { code: "SERVICE_ACTIVE" });

  const marked = await runtime.markStopped(serviceId);
  assert.equal(marked.processState, "stopped");
  assert.equal(marked.reconciliationState, "known");
  assert.equal(marked.failureReason, "MARKED_STOPPED_BY_USER");
  assert.equal(marked.pid, 4321);
  assert.equal(registry.latestRun(serviceId).failureReason, "MARKED_STOPPED_BY_USER");
  assert.equal(seen.at(-1).runId, "run-from-crashed-daemon");
  await assert.rejects(runtime.markStopped(serviceId), { code: "RUN_NOT_UNKNOWN" });

  const started = await runtime.start(serviceId);
  assert.equal(started.kind, "started");
  assert.equal(runtime.holds(serviceId), true);
  await assert.rejects(runtime.markStopped(serviceId), { code: "RUN_NOT_UNKNOWN" });
  await runtime.close();
});

test("forgetting a service is refused while it runs and drops its logs afterwards", async () => {
  const serviceId = "service-forget";
  const registry = restartRegistry(serviceId, { kind: "off" });
  const deleted = [];
  registry.deleteService = (id) => deleted.push(id);
  const process = controlledAdapter();
  const runtime = new ServiceRuntimeManager({
    registry,
    launcher: {},
    adapterFactory: () => process.adapter,
  });
  const started = await runtime.start(serviceId);
  assert.ok(runtime.logBuffers.has(started.snapshot.runId));

  await assert.rejects(runtime.forget(serviceId), { code: "SERVICE_ACTIVE" });
  assert.deepEqual(deleted, []);

  await runtime.stop(serviceId);
  await runtime.forget(serviceId);
  assert.deepEqual(deleted, [serviceId]);
  assert.equal(runtime.holds(serviceId), false);
  assert.equal(runtime.logBuffers.has(started.snapshot.runId), false);
  await runtime.close();
});
