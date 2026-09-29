import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RunLogBuffer } from "../../apps/daemon/dist/run-log-buffer.js";
import { SingleServiceSupervisor } from "../../apps/daemon/dist/single-service-supervisor.js";
import { NpmLauncher, WindowsJobProcessAdapter } from "../../packages/platform/dist/index.js";

const naturalExit = fileURLToPath(new URL("../fixtures/job-natural-exit.mjs", import.meta.url));
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
    next(type, timeoutMs = 5_000) {
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

function waitForProcessExit(child, timeoutMs = 5_000) {
  if (hasExited(child)) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("Process did not exit before timeout"));
    }, timeoutMs);
    function onExit(code) {
      clearTimeout(timer);
      resolve(code);
    }
    child.once("exit", onExit);
  });
}

async function waitForFile(path, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return JSON.parse(await readFile(path, "utf8"));
    } catch (caught) {
      if (caught?.code !== "ENOENT") throw caught;
    }
    await delay(40);
  }
  throw new Error("Fixture did not write its ready file");
}

async function waitForEndpointToClose(url, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(500) });
    } catch (caught) {
      if (caught?.name === "TimeoutError") continue;
      return;
    }
    await delay(50);
  }
  throw new Error(`Endpoint stayed open after forced tree stop: ${url}`);
}

async function launchEnvironment(readyFile, cwd) {
  const launcher = await NpmLauncher.locate();
  return {
    ...launcher.plan("devdock-job-adapter", cwd).env,
    DEVDOCK_READY_FILE: readyFile,
  };
}

function tempCleanupRoot(path) {
  const cleanupRoot = resolve(path);
  assert.equal(dirname(cleanupRoot), resolve(tmpdir()));
  assert.ok(basename(cleanupRoot).startsWith("devdock-job-adapter-"));
  return cleanupRoot;
}

test("WindowsJobProcessAdapter force-stops an npm script tree and preserves a sentinel", {
  skip: process.platform !== "win32" ? "Requires native Windows Job Objects" : false,
  timeout: 30_000,
}, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "devdock-job-adapter-"));
  const cleanupRoot = tempCleanupRoot(tempRoot);
  const projectPath = join(tempRoot, "project café & [npm]");
  await mkdir(projectPath);
  await writeFile(
    join(projectPath, "package.json"),
    JSON.stringify({
      name: "devdock-windows-job-fixture",
      private: true,
      scripts: { "serve:job": "node server.mjs" },
    }),
    "utf8",
  );
  await writeFile(
    join(projectPath, "server.mjs"),
    `await import(${JSON.stringify(pathToFileURL(httpFixture).href)});\n`,
    "utf8",
  );
  const sentinel = spawn(process.execPath, [httpFixture], {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  const sentinelEvents = eventReader(sentinel.stdout);
  let supervisor;
  let npmEvents;
  try {
    const sentinelReady = await sentinelEvents.next("listening");
    const sentinelUrl = `http://127.0.0.1:${sentinelReady.port}/ready`;
    assert.equal((await fetch(sentinelUrl)).status, 200);

    const launcher = await NpmLauncher.locate();
    const plan = launcher.plan("serve:job", await realpath(projectPath));
    supervisor = new SingleServiceSupervisor(new WindowsJobProcessAdapter(), plan, {
      graceTimeoutMs: 100,
      forceTimeoutMs: 5_000,
    });
    const started = await supervisor.start();
    assert.equal(started.kind, "started");
    const streams = supervisor.streamsFor(started.snapshot.runId);
    assert.ok(streams);
    const logs = new RunLogBuffer("windows-adapter-test", started.snapshot.runId);
    logs.capture(streams.stdout, streams.stderr);
    npmEvents = eventReader(streams.stdout);

    const serviceReady = await npmEvents.next("listening", 8_000);
    const serviceUrl = `http://127.0.0.1:${serviceReady.port}/ready`;
    assert.equal((await fetch(serviceUrl)).status, 200);
    assert.equal((await supervisor.inspect()).ownership, "owned");

    const stopped = await supervisor.stop();
    assert.equal(stopped.kind, "stopped");
    assert.equal(stopped.snapshot.exitCode, 1);
    await waitForEndpointToClose(serviceUrl);
    assert.equal((await fetch(sentinelUrl)).status, 200);
    assert.equal(hasExited(sentinel), false);
    assert.ok(logs.replay().events.some(({ text }) => text.includes('"type":"listening"')));
  } finally {
    if (supervisor) await supervisor.stop();
    npmEvents?.close();
    if (!hasExited(sentinel)) {
      if (sentinel.connected) sentinel.send({ type: "shutdown" });
      try {
        assert.equal(await waitForProcessExit(sentinel, 3_000), 0);
      } catch {
        sentinel.kill();
        await waitForProcessExit(sentinel, 2_000);
      }
    }
    sentinelEvents.close();
    await rm(cleanupRoot, { recursive: true, force: true });
  }
});

test("WindowsJobProcessAdapter reports natural exit after both streams end", {
  skip: process.platform !== "win32" ? "Requires native Windows Job Objects" : false,
  timeout: 15_000,
}, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "devdock-job-adapter-"));
  const cleanupRoot = tempCleanupRoot(tempRoot);
  const readyFile = join(tempRoot, "ready.json");
  try {
    const adapter = new WindowsJobProcessAdapter();
    const handle = await adapter.start({
      runId: randomUUID(),
      executable: process.execPath,
      args: [naturalExit],
      canonicalCwd: dirname(naturalExit),
      env: await launchEnvironment(readyFile, dirname(naturalExit)),
    });
    const logs = new RunLogBuffer("windows-adapter-test", handle.runId);
    logs.capture(handle.stdout, handle.stderr);
    const ready = await waitForFile(readyFile);
    assert.equal(ready.pid, handle.pid);

    assert.deepEqual(await adapter.waitForExit(handle, 5_000), {
      kind: "exited",
      code: 7,
      signal: null,
    });
    assert.equal(await adapter.inspectOwnership(handle), "exited");
    assert.equal(await adapter.terminateOwnedTree(handle), "already_exited");
    assert.ok(logs.replay().events.some(({ text }) => text === "natural stdout: café"));
    assert.ok(logs.replay().events.some(({ text }) => text === "natural stderr: expected failure"));
  } finally {
    await rm(cleanupRoot, { recursive: true, force: true });
  }
});
