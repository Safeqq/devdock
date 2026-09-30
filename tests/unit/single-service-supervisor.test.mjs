import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { SingleServiceSupervisor } from "../../apps/daemon/dist/single-service-supervisor.js";

class FakeAdapter {
  records = [];
  failNextStart = false;
  stopMode = "close";
  fallbackCalls = 0;
  gracefulCalls = 0;
  ownershipUnknown = false;

  async start(request) {
    if (this.failNextStart) {
      this.failNextStart = false;
      throw new Error("fake spawn failure");
    }
    const handle = {
      runId: request.runId,
      pid: 1000 + this.records.length,
      identity: `owned-${this.records.length}`,
      ownership: {},
      gracefulStop: { supported: true },
      stdout: Readable.from([]),
      stderr: Readable.from([]),
    };
    let resolveClose;
    const closed = new Promise((resolve) => {
      resolveClose = resolve;
    });
    this.records.push({ handle, closed, resolveClose, result: null });
    return handle;
  }

  record(handle) {
    const record = this.records.find((candidate) => candidate.handle === handle);
    assert.ok(record, "handle must belong to the fake adapter");
    return record;
  }

  close(handle, code = 0) {
    const record = this.record(handle);
    record.result = { kind: "exited", code, signal: null };
    record.resolveClose(record.result);
  }

  async inspectOwnership(handle) {
    if (this.ownershipUnknown) return "unknown";
    return this.record(handle).result === null ? "owned" : "exited";
  }

  async requestGracefulStop(handle) {
    this.gracefulCalls += 1;
    if (this.stopMode === "unsupported") return "unsupported";
    if (this.stopMode === "never") return "requested";
    this.close(handle);
    return "requested";
  }

  async terminateOwnedTree() {
    this.fallbackCalls += 1;
    return "unsupported";
  }

  async waitForExit(handle, timeoutMs) {
    const record = this.record(handle);
    if (record.result !== null) return record.result;
    if (timeoutMs !== undefined) return { kind: "timeout" };
    return record.closed;
  }
}

function supervisor(adapter, options = {}) {
  return new SingleServiceSupervisor(
    adapter,
    {
      executable: "fixture",
      args: [],
      canonicalCwd: ".",
      env: {},
    },
    { graceTimeoutMs: 10, forceTimeoutMs: 10, ...options },
  );
}

test("concurrent start keeps one owned run, restart waits for close and assigns a new ID", async () => {
  const adapter = new FakeAdapter();
  const subject = supervisor(adapter);
  const [first, second] = await Promise.all([subject.start(), subject.start()]);
  assert.equal(first.kind, "started");
  assert.equal(second.kind, "existing");
  assert.equal(adapter.records.length, 1);
  assert.equal(first.snapshot.runId, second.snapshot.runId);

  const restarted = await subject.restart();
  assert.equal(restarted.kind, "started");
  assert.equal(adapter.records.length, 2);
  assert.notEqual(restarted.snapshot.runId, first.snapshot.runId);
  assert.equal(adapter.records[0].result.kind, "exited");
  assert.equal(subject.snapshot().runId, restarted.snapshot.runId);
  assert.equal((await subject.stop()).kind, "stopped");
});

test("spawn failure is recorded and a later start gets a fresh run ID", async () => {
  const adapter = new FakeAdapter();
  adapter.failNextStart = true;
  const subject = supervisor(adapter);
  const failed = await subject.start();
  assert.equal(failed.kind, "failed");
  assert.equal(failed.snapshot.processState, "failed");
  assert.equal(failed.snapshot.failureReason, "SPAWN_ERROR");
  assert.ok(failed.snapshot.endedAt);

  const started = await subject.start();
  assert.equal(started.kind, "started");
  assert.notEqual(started.snapshot.runId, failed.snapshot.runId);
  assert.equal((await subject.stop()).kind, "stopped");
});

test("unconfirmed stop blocks replacement until the old process closes", async () => {
  const adapter = new FakeAdapter();
  adapter.stopMode = "unsupported";
  const subject = supervisor(adapter);
  const first = await subject.start();
  const incomplete = await subject.restart();
  assert.equal(incomplete.kind, "incomplete");
  assert.equal(incomplete.reason, "TREE_STOP_UNSUPPORTED");
  assert.equal((await subject.start()).kind, "rejected");
  assert.equal(adapter.records.length, 1);

  adapter.close(adapter.records[0].handle);
  const second = await subject.start();
  assert.equal(second.kind, "started");
  assert.notEqual(second.snapshot.runId, first.snapshot.runId);
  adapter.stopMode = "close";
  assert.equal((await subject.stop()).kind, "stopped");
});

test("graceful stop timeout does not release ownership or permit restart", async () => {
  const adapter = new FakeAdapter();
  adapter.stopMode = "never";
  const subject = supervisor(adapter);
  const first = await subject.start();
  const incomplete = await subject.stop();
  assert.equal(incomplete.kind, "incomplete");
  assert.equal(incomplete.snapshot.processState, "stopping");
  assert.equal(adapter.fallbackCalls, 1);
  assert.equal((await subject.restart()).kind, "incomplete");
  assert.equal(adapter.records.length, 1);

  adapter.close(adapter.records[0].handle);
  const second = await subject.start();
  assert.notEqual(second.snapshot.runId, first.snapshot.runId);
  adapter.stopMode = "close";
  assert.equal((await subject.stop()).kind, "stopped");
});

test("unknown ownership is reflected in status and blocks a second run", async () => {
  const adapter = new FakeAdapter();
  const subject = supervisor(adapter);
  const first = await subject.start();
  adapter.ownershipUnknown = true;
  const inspection = await subject.inspect();
  assert.equal(inspection.ownership, "unknown");
  assert.equal(inspection.snapshot.processState, "stopping");
  assert.equal(inspection.snapshot.reconciliationState, "unknown");
  assert.equal((await subject.start()).kind, "rejected");
  assert.equal((await subject.stop()).kind, "incomplete");
  assert.equal(adapter.gracefulCalls, 0);
  assert.equal(adapter.records.length, 1);

  adapter.ownershipUnknown = false;
  adapter.close(adapter.records[0].handle);
  const second = await subject.start();
  assert.notEqual(second.snapshot.runId, first.snapshot.runId);
  assert.equal((await subject.stop()).kind, "stopped");
});

test("unexpected exit records the exit code and does not corrupt a newer run", async () => {
  const adapter = new FakeAdapter();
  const subject = supervisor(adapter);
  const first = await subject.start();
  adapter.close(adapter.records[0].handle, 7);
  const inspection = await subject.inspect();
  assert.equal(inspection.snapshot.processState, "failed");
  assert.equal(inspection.snapshot.exitCode, 7);
  assert.equal(inspection.snapshot.failureReason, "PROCESS_EXITED_WITH_FAILURE");
  const second = await subject.start();
  assert.equal(second.kind, "started");
  assert.notEqual(second.snapshot.runId, first.snapshot.runId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subject.snapshot().runId, second.snapshot.runId);
  assert.equal(subject.snapshot().processState, "running");
  assert.equal((await subject.stop()).kind, "stopped");
});

test("snapshot observer receives the real service ID and background terminal state", async () => {
  const adapter = new FakeAdapter();
  const snapshots = [];
  const subject = supervisor(adapter, {
    serviceId: "service-observed",
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  const started = await subject.start();
  adapter.close(adapter.records[0].handle, 9);
  await subject.inspect();

  assert.equal(started.snapshot.serviceId, "service-observed");
  assert.ok(snapshots.length >= 3);
  assert.equal(snapshots.at(-1).serviceId, "service-observed");
  assert.equal(snapshots.at(-1).processState, "failed");
  assert.equal(snapshots.at(-1).exitCode, 9);
});

test("snapshot history failure does not release the owned process", async () => {
  const adapter = new FakeAdapter();
  let observerErrors = 0;
  const subject = supervisor(adapter, {
    onSnapshot: () => {
      throw new Error("simulated history failure");
    },
    onSnapshotError: () => {
      observerErrors += 1;
    },
  });

  const started = await subject.start();
  assert.equal(started.kind, "started");
  assert.equal((await subject.inspect()).ownership, "owned");
  assert.equal((await subject.stop()).kind, "stopped");
  assert.ok(observerErrors >= 3);
});

test("readiness changes independently and a timeout fails the owned startup", async () => {
  const adapter = new FakeAdapter();
  const subject = supervisor(adapter);
  const first = await subject.start();
  assert.equal(first.snapshot.processState, "running");
  assert.equal(first.snapshot.readinessState, "unknown");
  assert.equal(
    (await subject.setReadiness(first.snapshot.runId, "checking")).processState,
    "running",
  );
  assert.equal((await subject.setReadiness(first.snapshot.runId, "ready")).readinessState, "ready");
  assert.equal((await subject.stop()).snapshot.readinessState, "unknown");

  const second = await subject.start();
  await subject.setReadiness(second.snapshot.runId, "checking");
  const failed = await subject.failReadiness(second.snapshot.runId);
  assert.equal(failed.kind, "stopped");
  assert.equal(failed.snapshot.processState, "failed");
  assert.equal(failed.snapshot.readinessState, "unhealthy");
  assert.equal(failed.snapshot.failureReason, "READINESS_TIMEOUT");
  assert.equal(adapter.records[1].result.kind, "exited");
  assert.equal(await subject.setReadiness(second.snapshot.runId, "ready"), null);
});
