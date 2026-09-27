import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../apps/daemon/dist/cli.js", import.meta.url));

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("CLI did not exit before timeout"));
    }, timeoutMs);
    function onExit(code, signal) {
      clearTimeout(timer);
      resolve({ code, signal });
    }
    child.once("exit", onExit);
  });
}

function createEventReader(child) {
  const lines = createInterface({ input: child.stdout });
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
    next(type, timeoutMs = 3_000) {
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
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("CLI output closed"));
      }
      waiters.length = 0;
      lines.close();
    },
  };
}

test("Windows fixture CLI starts, inspects, and stops its process", {
  skip: process.platform !== "win32" ? "Windows adapter only" : false,
  timeout: 15_000,
}, async () => {
  const child = spawn(process.execPath, [cli], { stdio: ["pipe", "pipe", "pipe"] });
  const events = createEventReader(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4_096);
  });

  try {
    await events.next("ready");
    child.stdin.write("start\n");
    const started = await events.next("started");
    assert.equal(started.existing, false);
    assert.ok(started.runId);
    assert.ok(started.pid > 0);

    const listening = await events.next("listening");
    assert.ok(listening.port > 0);
    const url = `http://127.0.0.1:${listening.port}/ready`;
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    assert.equal(response.status, 200);

    child.stdin.write("inspect\n");
    const inspection = await events.next("inspection");
    assert.equal(inspection.status, "owned");
    assert.equal(inspection.runId, started.runId);
    assert.equal(inspection.pid, started.pid);

    child.stdin.write("stop\n");
    const stopped = await events.next("stopped");
    assert.equal(stopped.runId, started.runId);
    assert.equal(stopped.code, 0, stderr);
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1_000) }));

    child.stdin.write("inspect\nexit\n");
    const afterStop = await events.next("inspection");
    assert.equal(afterStop.status, "stopped");
    child.stdin.end();
    const result = await waitForExit(child, 3_000);
    assert.equal(result.code, 0, stderr);
  } finally {
    if (!hasExited(child)) {
      if (child.stdin.writable) child.stdin.write("exit\n");
      try {
        await waitForExit(child, 3_000);
      } catch {
        child.kill("SIGKILL");
        await waitForExit(child, 2_000);
      }
    }
    events.close();
  }
});
