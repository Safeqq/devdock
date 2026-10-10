import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { productionProcessControlAvailable } from "../../packages/platform/dist/index.js";

const daemonEntry = fileURLToPath(
  new URL("../../apps/daemon/dist/registry-api-cli.js", import.meta.url),
);
const sidecarParent = fileURLToPath(new URL("../fixtures/sidecar-parent.mjs", import.meta.url));

function isolatedEnvironment(dataRoot) {
  return {
    ...process.env,
    DEVDOCK_PORT: "0",
    HOME: dataRoot,
    LOCALAPPDATA: dataRoot,
    XDG_DATA_HOME: dataRoot,
  };
}

function eventReader(stream) {
  const backlog = [];
  const waiters = [];
  createInterface({ input: stream }).on("line", (line) => {
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
    next(type, timeoutMs = 15_000) {
      const index = backlog.findIndex((event) => event.type === type);
      if (index !== -1) return Promise.resolve(backlog.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = {
          type,
          resolve,
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            reject(new Error(`Timed out waiting for ${type}`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

function waitForExit(child, timeoutMs = 15_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Process did not exit in time")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function pair(origin, code) {
  return fetch(`${origin}/api/pair`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(3_000),
  });
}

async function endpointClosed(origin, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(origin, { signal: AbortSignal.timeout(500) });
    } catch {
      return true;
    }
    await delay(100);
  }
  return false;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (caught) {
    return caught?.code === "EPERM";
  }
}

function startSidecar(env) {
  const child = spawn(process.execPath, [daemonEntry], {
    env: { ...env, DEVDOCK_CONTROL: "stdin" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stderr.resume();
  return { child, events: eventReader(child.stdout) };
}

test("sidecar control pipe issues pairing codes, locks its data directory, and stops on EOF", {
  timeout: 60_000,
}, async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "devdock-sidecar-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const env = isolatedEnvironment(dataRoot);
  const { child, events } = startSidecar(env);
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });

  const ready = await events.next("registry-api-ready");
  assert.ok(["path", "daemon"].includes(ready.projectNode.source));
  assert.equal(isAbsolute(ready.projectNode.executable), true);
  assert.equal((await pair(ready.origin, ready.pairingCode)).status, 200);
  assert.equal((await pair(ready.origin, ready.pairingCode)).status, 410);

  child.stdin.write(`${JSON.stringify({ type: "issue-pairing-code" })}\n`);
  const issued = await events.next("pairing-code");
  assert.notEqual(issued.pairingCode, ready.pairingCode);
  assert.equal((await pair(ready.origin, ready.pairingCode)).status, 401);
  assert.equal((await pair(ready.origin, issued.pairingCode)).status, 200);

  const second = startSidecar(env);
  const refused = await second.events.next("registry-api-error");
  assert.equal(refused.code, "INSTANCE_LOCKED");
  assert.equal(await waitForExit(second.child), 3);

  child.stdin.end();
  assert.equal(await waitForExit(child), 0);
  assert.equal(await endpointClosed(ready.origin), true);
});

test("sidecar shuts down when its parent process is killed", {
  timeout: 60_000,
}, async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "devdock-sidecar-parent-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const env = isolatedEnvironment(dataRoot);
  const parent = spawn(process.execPath, [sidecarParent, daemonEntry], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  parent.stderr.resume();
  let daemonPid;
  t.after(() => {
    if (parent.exitCode === null) parent.kill();
    if (daemonPid !== undefined && processAlive(daemonPid)) process.kill(daemonPid);
  });

  const started = await eventReader(parent.stdout).next("sidecar-started");
  daemonPid = started.pid;
  assert.equal(processAlive(daemonPid), true);

  parent.kill("SIGKILL");
  await waitForExit(parent);
  const deadline = Date.now() + 10_000;
  while (processAlive(daemonPid) && Date.now() < deadline) await delay(100);
  const survived = processAlive(daemonPid);
  // Stop a surviving daemon before asserting, so a regression fails cleanly instead of
  // leaving a detached process that keeps the test run open.
  if (survived) process.kill(daemonPid);
  assert.equal(survived, false, "daemon kept running after its parent was killed");
  assert.equal(await endpointClosed(started.origin), true);

  // The lock died with the daemon, so a new instance can use the same data directory.
  const { child, events } = startSidecar(env);
  await events.next("registry-api-ready");
  child.stdin.end();
  assert.equal(await waitForExit(child), 0);
});

test("sidecar reports running scripts and stops them all on request", {
  skip: productionProcessControlAvailable()
    ? false
    : "No production process adapter for this platform",
  timeout: 60_000,
}, async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "devdock-sidecar-tray-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const projectPath = join(dataRoot, "tray project");
  await mkdir(projectPath);
  await writeFile(
    join(projectPath, "package.json"),
    JSON.stringify({ name: "tray", private: true, scripts: { dev: "node keep.mjs" } }),
  );
  await writeFile(join(projectPath, "keep.mjs"), "setInterval(() => {}, 1000);\n");
  const { child, events } = startSidecar(isolatedEnvironment(dataRoot));
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });

  const ready = await events.next("registry-api-ready");
  assert.deepEqual(await events.next("runtime-summary"), {
    type: "runtime-summary",
    active: 0,
    projects: [],
  });
  const paired = await pair(ready.origin, ready.pairingCode);
  const cookie = paired.headers.get("set-cookie").split(";")[0];
  const { csrfToken } = await paired.json();
  const post = async (path, body) => {
    const response = await fetch(`${ready.origin}${path}`, {
      method: "POST",
      headers: {
        origin: ready.origin,
        cookie,
        "x-devdock-csrf": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return response.json();
  };
  const { project } = await post("/api/projects", { path: projectPath });
  const { service } = await post(`/api/projects/${project.id}/services`, { scriptName: "dev" });
  await post(`/api/services/${service.id}/start`, {});

  let summary = await events.next("runtime-summary");
  while (summary.active === 0) summary = await events.next("runtime-summary");
  assert.deepEqual(summary.projects, [{ name: "tray project", active: 1 }]);

  child.stdin.write(`${JSON.stringify({ type: "stop-all" })}\n`);
  assert.deepEqual(await events.next("runtime-summary"), {
    type: "runtime-summary",
    active: 0,
    projects: [],
  });
  const status = await (
    await fetch(`${ready.origin}/api/services/${service.id}/status`, { headers: { cookie } })
  ).json();
  assert.equal(status.snapshot.processState, "stopped");

  child.stdin.end();
  assert.equal(await waitForExit(child), 0);
});
