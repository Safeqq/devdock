import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SingleServiceSupervisor } from "../../apps/daemon/dist/single-service-supervisor.js";
import {
  PosixFixtureProcessAdapter,
  WindowsFixtureProcessAdapter,
} from "../../packages/platform/dist/index.js";

const treeFixture = fileURLToPath(new URL("../fixtures/tree-parent.mjs", import.meta.url));
const httpFixture = fileURLToPath(new URL("../fixtures/http-server.mjs", import.meta.url));

function eventReader(stream) {
  const lines = createInterface({ input: stream });
  const backlog = [];
  const waiters = [];
  lines.on("line", (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    const index = waiters.findIndex((waiter) => waiter.type === event.type);
    if (index === -1) {
      backlog.push(event);
      return;
    }
    const [waiter] = waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(event);
  });
  return {
    next(type, timeoutMs = 4_000) {
      const index = backlog.findIndex((event) => event.type === type);
      if (index !== -1) return Promise.resolve(backlog.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = {
          type,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            reject(new Error(`Timed out waiting for ${type}`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    close() {
      for (const waiter of waiters) clearTimeout(waiter.timer);
      lines.close();
    },
  };
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("Sentinel did not exit before timeout"));
    }, timeoutMs);
    function onExit(code) {
      clearTimeout(timer);
      resolve(code);
    }
    child.once("exit", onExit);
  });
}

test("owned fixture tree stops while an external Node sentinel stays alive", {
  skip: !["win32", "darwin", "linux"].includes(process.platform)
    ? "No fixture adapter for this platform"
    : false,
  timeout: 20_000,
}, async () => {
  const sentinel = spawn(process.execPath, [httpFixture], {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  const sentinelEvents = eventReader(sentinel.stdout);
  let treeEvents;
  let supervisor;
  try {
    const sentinelReady = await sentinelEvents.next("listening");
    const sentinelUrl = `http://127.0.0.1:${sentinelReady.port}/ready`;
    assert.equal((await fetch(sentinelUrl, { signal: AbortSignal.timeout(3_000) })).status, 200);

    const adapter =
      process.platform === "win32"
        ? new WindowsFixtureProcessAdapter()
        : new PosixFixtureProcessAdapter();
    supervisor = new SingleServiceSupervisor(adapter, {
      executable: process.execPath,
      args: [treeFixture],
      canonicalCwd: await realpath(dirname(treeFixture)),
      env: { PORT: "0" },
    });
    const started = await supervisor.start();
    assert.equal(started.kind, "started");
    const streams = supervisor.streamsFor(started.snapshot.runId);
    assert.ok(streams);
    treeEvents = eventReader(streams.stdout);
    streams.stderr.resume();
    const treeReady = await treeEvents.next("tree-listening");
    assert.equal(treeReady.parentPid, started.snapshot.pid);
    assert.ok(treeReady.childPid > 0);
    assert.notEqual(treeReady.childPid, sentinel.pid);
    const treeUrl = `http://127.0.0.1:${treeReady.port}/ready`;
    assert.equal((await fetch(treeUrl, { signal: AbortSignal.timeout(3_000) })).status, 200);

    const stopped = await supervisor.stop();
    assert.equal(stopped.kind, "stopped");
    assert.equal(stopped.snapshot.runId, started.snapshot.runId);
    assert.equal(stopped.snapshot.exitCode, 0);
    const childClosed = await treeEvents.next("tree-child-closed");
    assert.equal(childClosed.childPid, treeReady.childPid);
    assert.equal(childClosed.code, 0);
    await assert.rejects(fetch(treeUrl, { signal: AbortSignal.timeout(1_000) }));
    assert.equal((await fetch(sentinelUrl, { signal: AbortSignal.timeout(3_000) })).status, 200);
    assert.equal(hasExited(sentinel), false);
  } finally {
    if (supervisor) await supervisor.stop();
    if (!hasExited(sentinel)) {
      if (sentinel.connected) sentinel.send({ type: "shutdown" });
      try {
        assert.equal(await waitForExit(sentinel, 3_000), 0);
      } catch {
        sentinel.kill("SIGKILL");
        await waitForExit(sentinel, 2_000);
      }
    }
    treeEvents?.close();
    sentinelEvents.close();
  }
});
