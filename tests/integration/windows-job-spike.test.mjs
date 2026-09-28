import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const jobHelper = fileURLToPath(new URL("../fixtures/windows-job-spike.ps1", import.meta.url));
const orphanParent = fileURLToPath(new URL("../fixtures/job-orphan-parent.mjs", import.meta.url));
const outputFlood = fileURLToPath(new URL("../fixtures/job-output-flood.mjs", import.meta.url));
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
    next(type, timeoutMs = 8_000) {
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

function waitForExit(child, timeoutMs = 5_000) {
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
  throw new Error("Orphan fixture did not write its ready file");
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
  throw new Error(`Orphan endpoint stayed open after job handle closed: ${url}`);
}

async function waitForForwardedOutput(events, expected, timeoutMs = 5_000) {
  const chunks = { stdout: [], stderr: [] };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = await events.next("job-output", deadline - Date.now());
    assert.ok(event.stream === "stdout" || event.stream === "stderr");
    assert.equal(typeof event.data, "string");
    chunks[event.stream].push(Buffer.from(event.data, "base64"));
    const output = {
      stdout: Buffer.concat(chunks.stdout).toString("utf8"),
      stderr: Buffer.concat(chunks.stderr).toString("utf8"),
    };
    if (output.stdout.includes(expected.stdout) && output.stderr.includes(expected.stderr)) {
      return output;
    }
  }
  throw new Error("Timed out waiting for forwarded stdout and stderr");
}

test("Windows Job Object owns an orphaned child without touching an external sentinel", {
  skip: process.platform !== "win32" ? "Requires native Windows Job Objects" : false,
  timeout: 30_000,
}, async () => {
  const systemRoot = process.env.SystemRoot;
  assert.ok(systemRoot, "SystemRoot must identify the Windows installation");
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const tempRoot = await mkdtemp(join(tmpdir(), "devdock-job-spike-"));
  const cleanupRoot = resolve(tempRoot);
  assert.equal(dirname(cleanupRoot), resolve(tmpdir()));
  assert.ok(basename(cleanupRoot).startsWith("devdock-job-spike-"));
  const readyFile = join(tempRoot, "ready.json");
  const sentinel = spawn(process.execPath, [httpFixture], {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  const sentinelEvents = eventReader(sentinel.stdout);
  let helper;
  let helperEvents;
  let helperError = "";
  try {
    const sentinelReady = await sentinelEvents.next("listening");
    const sentinelUrl = `http://127.0.0.1:${sentinelReady.port}/ready`;
    assert.equal((await fetch(sentinelUrl)).status, 200);

    helper = spawn(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        jobHelper,
        process.execPath,
        orphanParent,
        readyFile,
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    helperEvents = eventReader(helper.stdout);
    helper.stderr.setEncoding("utf8");
    helper.stderr.on("data", (chunk) => {
      helperError += chunk;
    });
    const ready = await helperEvents.next("job-ready").catch((caught) => {
      throw new Error(`${caught.message}; helper stderr: ${helperError}`);
    });
    const forwarded = await waitForForwardedOutput(helperEvents, {
      stdout: "devdock-job-stdout: café",
      stderr: "devdock-job-stderr: warning",
    });
    assert.match(forwarded.stdout, /café/);
    const orphan = await waitForFile(readyFile);
    assert.equal(orphan.parentPid, ready.pid);
    assert.notEqual(orphan.childPid, sentinel.pid);
    assert.equal(hasExited(helper), false, `Job helper exited: ${helperError}`);
    helper.stdin.write("status\n");
    const earlyStatus = await helperEvents.next("job-status");
    assert.ok(earlyStatus.activeProcesses >= 1, `Job empty after parent exit: ${helperError}`);
    const orphanUrl = `http://127.0.0.1:${orphan.port}/ready`;
    const orphanResponse = await fetch(orphanUrl).catch((caught) => {
      throw new Error(
        `Orphan child endpoint ${orphanUrl} failed: ${caught.message}; ${helperError}`,
      );
    });
    assert.equal(orphanResponse.status, 200);

    let activeProcesses;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      helper.stdin.write("status\n");
      const status = await helperEvents.next("job-status");
      activeProcesses = status.activeProcesses;
      if (activeProcesses === 1) break;
      await delay(50);
    }
    assert.equal(activeProcesses, 1, "only the orphaned HTTP child should remain in the job");

    helper.stdin.write("stop\n");
    const stopped = await helperEvents.next("job-stopped");
    assert.equal(stopped.activeProcesses, 0);
    assert.equal(await waitForExit(helper), 0);
    await assert.rejects(fetch(orphanUrl, { signal: AbortSignal.timeout(1_000) }));
    assert.equal((await fetch(sentinelUrl)).status, 200);
    assert.equal(hasExited(sentinel), false);
  } finally {
    if (helper && !hasExited(helper)) {
      helper.stdin.write("stop\n");
      try {
        await waitForExit(helper, 5_000);
      } catch {
        helper.kill();
        await waitForExit(helper, 3_000);
      }
    }
    helperEvents?.close();
    if (!hasExited(sentinel)) {
      if (sentinel.connected) sentinel.send({ type: "shutdown" });
      try {
        assert.equal(await waitForExit(sentinel, 3_000), 0);
      } catch {
        sentinel.kill();
        await waitForExit(sentinel, 2_000);
      }
    }
    sentinelEvents.close();
    await rm(cleanupRoot, { recursive: true, force: true });
  }
});

test("Windows Job Object output forwarding stays bounded under caller backpressure", {
  skip: process.platform !== "win32" ? "Requires native Windows Job Objects" : false,
  timeout: 30_000,
}, async () => {
  const systemRoot = process.env.SystemRoot;
  assert.ok(systemRoot, "SystemRoot must identify the Windows installation");
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const tempRoot = await mkdtemp(join(tmpdir(), "devdock-job-spike-"));
  const cleanupRoot = resolve(tempRoot);
  assert.equal(dirname(cleanupRoot), resolve(tmpdir()));
  assert.ok(basename(cleanupRoot).startsWith("devdock-job-spike-"));
  const readyFile = join(tempRoot, "ready.json");
  const helper = spawn(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      jobHelper,
      process.execPath,
      outputFlood,
      readyFile,
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  const helperEvents = eventReader(helper.stdout);
  let helperError = "";
  helper.stderr.setEncoding("utf8");
  helper.stderr.on("data", (chunk) => {
    helperError = (helperError + chunk).slice(-4_096);
  });
  try {
    await helperEvents.next("job-ready").catch((caught) => {
      throw new Error(`${caught.message}; helper stderr: ${helperError}`);
    });
    helper.stdout.pause();

    const flood = await waitForFile(readyFile, 12_000);
    assert.equal(flood.bytesPerStream, 16 * 1024 * 1024);
    assert.equal(hasExited(helper), false, `Job helper exited: ${helperError}`);

    helper.stdout.resume();
    const gap = await helperEvents.next("job-output-gap", 8_000);
    assert.ok(gap.droppedBytes > 0, "backpressure should drop output beyond the bounded queue");

    helper.stdin.write("stop\n");
    const stopped = await helperEvents.next("job-stopped");
    assert.equal(stopped.activeProcesses, 0);
    assert.equal(await waitForExit(helper), 0);
  } finally {
    helper.stdout.resume();
    if (!hasExited(helper)) {
      helper.kill();
      await waitForExit(helper);
    }
    helperEvents.close();
    await rm(cleanupRoot, { recursive: true, force: true });
  }
});

test("Windows Job Object closes orphaned child when the helper dies unexpectedly", {
  skip: process.platform !== "win32" ? "Requires native Windows Job Objects" : false,
  timeout: 20_000,
}, async () => {
  const systemRoot = process.env.SystemRoot;
  assert.ok(systemRoot, "SystemRoot must identify the Windows installation");
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const tempRoot = await mkdtemp(join(tmpdir(), "devdock-job-spike-"));
  const cleanupRoot = resolve(tempRoot);
  assert.equal(dirname(cleanupRoot), resolve(tmpdir()));
  assert.ok(basename(cleanupRoot).startsWith("devdock-job-spike-"));
  const readyFile = join(tempRoot, "ready.json");
  const helper = spawn(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      jobHelper,
      process.execPath,
      orphanParent,
      readyFile,
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  const helperEvents = eventReader(helper.stdout);
  let helperError = "";
  helper.stderr.setEncoding("utf8");
  helper.stderr.on("data", (chunk) => {
    helperError += chunk;
  });
  try {
    const ready = await helperEvents.next("job-ready").catch((caught) => {
      throw new Error(`${caught.message}; helper stderr: ${helperError}`);
    });
    const orphan = await waitForFile(readyFile);
    assert.equal(orphan.parentPid, ready.pid);
    const orphanUrl = `http://127.0.0.1:${orphan.port}/ready`;
    assert.equal((await fetch(orphanUrl)).status, 200);
    assert.equal(hasExited(helper), false, `Job helper exited: ${helperError}`);

    assert.equal(helper.kill(), true);
    await waitForExit(helper);
    await waitForEndpointToClose(orphanUrl);
  } finally {
    if (!hasExited(helper)) {
      helper.kill();
      await waitForExit(helper);
    }
    helperEvents.close();
    await rm(cleanupRoot, { recursive: true, force: true });
  }
});
