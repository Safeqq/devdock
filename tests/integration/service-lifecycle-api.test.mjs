import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLocalApiServer } from "../../apps/daemon/dist/local-api.js";
import { ProjectRegistry } from "../../apps/daemon/dist/project-registry.js";
import { ServiceRuntimeManager } from "../../apps/daemon/dist/service-runtime-manager.js";
import { NpmLauncher, WindowsJobProcessAdapter } from "../../packages/platform/dist/index.js";
import { RegistryDatabase } from "../../packages/storage/dist/index.js";

const httpFixture = fileURLToPath(new URL("../fixtures/http-server.mjs", import.meta.url));

async function call(origin, path, options = {}) {
  return fetch(`${origin}${path}`, { signal: AbortSignal.timeout(5_000), ...options });
}

function mutation(origin, cookie, csrf, body) {
  return {
    method: "POST",
    headers: {
      origin,
      cookie,
      "x-devdock-csrf": csrf,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

async function nextSseFrame(reader, state) {
  while (true) {
    const end = state.text.indexOf("\n\n");
    if (end !== -1) {
      const block = state.text.slice(0, end);
      state.text = state.text.slice(end + 2);
      if (block.startsWith(":")) continue;
      const fields = Object.fromEntries(
        block
          .split("\n")
          .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]),
      );
      return { type: fields.event, data: JSON.parse(fields.data) };
    }
    const chunk = await reader.read();
    if (chunk.done) throw new Error("SSE stream closed before service readiness");
    state.text += state.decoder.decode(chunk.value, { stream: true });
  }
}

async function waitForListeningLog(reader) {
  const state = { text: "", decoder: new TextDecoder() };
  for (let eventCount = 0; eventCount < 30; eventCount += 1) {
    const frame = await nextSseFrame(reader, state);
    if (frame.type !== "log" || frame.data.stream !== "stdout") continue;
    try {
      const event = JSON.parse(frame.data.text);
      if (event.type === "listening" && Number.isInteger(event.port)) return event;
    } catch {
      // npm writes informational lines before the service's JSON readiness event.
    }
  }
  throw new Error("Service readiness log was not observed");
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
  throw new Error(`Endpoint stayed open after service stop: ${url}`);
}

async function availablePort() {
  const reservation = createServer();
  await new Promise((resolveListen, reject) => {
    reservation.once("error", reject);
    reservation.listen({ host: "127.0.0.1", port: 0 }, resolveListen);
  });
  const address = reservation.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  await new Promise((resolveClose, reject) => {
    reservation.close((error) => (error ? reject(error) : resolveClose()));
  });
  return address.port;
}

async function waitForStatus(origin, serviceId, cookie, predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await call(origin, `/api/services/${serviceId}/status`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    const status = await response.json();
    if (predicate(status)) return status;
    await delay(50);
  }
  throw new Error(`Service status did not reach the expected state: ${serviceId}`);
}

async function waitForProfileStatus(origin, profileId, cookie, predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await call(origin, `/api/profiles/${profileId}/status`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    const status = await response.json();
    if (predicate(status)) return status;
    await delay(50);
  }
  throw new Error(`Profile status did not reach the expected state: ${profileId}`);
}

function cleanupRoot(path) {
  const root = resolve(path);
  assert.equal(dirname(root), resolve(tmpdir()));
  assert.ok(basename(root).startsWith("devdock-lifecycle-api-"));
  return root;
}

test("authenticated service lifecycle API starts, streams, inspects, and stops an npm tree", {
  skip: process.platform !== "win32" ? "Requires native Windows Job Objects" : false,
  timeout: 30_000,
}, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "devdock-lifecycle-api-"));
  const safeRoot = cleanupRoot(tempRoot);
  const projectPath = join(tempRoot, "project café & [lifecycle]");
  let store;
  let api;
  let reader;
  try {
    const expectedPort = await availablePort();
    let profileOwnedPort = await availablePort();
    while (profileOwnedPort === expectedPort) profileOwnedPort = await availablePort();
    await mkdir(projectPath);
    await writeFile(
      join(projectPath, "package.json"),
      JSON.stringify({
        name: "devdock-lifecycle-api-fixture",
        private: true,
        scripts: { serve: "node server.mjs" },
      }),
      "utf8",
    );
    await writeFile(join(projectPath, ".env.lifecycle"), `PORT=${expectedPort}\n`, "utf8");
    await writeFile(join(projectPath, ".env.profile-owned"), `PORT=${profileOwnedPort}\n`, "utf8");
    await writeFile(
      join(projectPath, "server.mjs"),
      `await import(${JSON.stringify(pathToFileURL(httpFixture).href)});\n`,
      "utf8",
    );

    store = await RegistryDatabase.open(join(tempRoot, "data", "registry.sqlite"));
    const registry = new ProjectRegistry(store);
    const project = await registry.registerProject(projectPath);
    const service = await registry.selectService(project.id, "serve", {
      displayName: "Lifecycle server",
      expectedPort,
      readiness: { kind: "http", path: "/ready", timeoutMs: 5_000 },
      envFiles: [".env.lifecycle"],
    });
    const launcher = await NpmLauncher.locate();
    const runtime = new ServiceRuntimeManager({
      registry,
      launcher,
      adapterFactory: () => new WindowsJobProcessAdapter(),
      daemonSessionId: "lifecycle-api-test",
    });
    api = createLocalApiServer({ registry, launcher, runtime });
    const origin = await api.listen(0);

    assert.equal((await call(origin, `/api/services/${service.id}/status`)).status, 401);
    const paired = await call(origin, "/api/pair", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ code: api.pairingCode }),
    });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get("set-cookie").split(";")[0];
    const { csrfToken } = await paired.json();

    const initial = await call(origin, `/api/services/${service.id}/status`, {
      headers: { cookie },
    });
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), { snapshot: null, ownership: null });
    assert.equal(
      (
        await call(origin, `/api/services/${service.id}/start`, {
          method: "POST",
          headers: { origin, cookie, "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          origin,
          `/api/services/${service.id}/start`,
          mutation(origin, cookie, csrfToken, { command: "node arbitrary.js" }),
        )
      ).status,
      400,
    );

    const startedResponse = await call(
      origin,
      `/api/services/${service.id}/start`,
      mutation(origin, cookie, csrfToken, {}),
    );
    assert.equal(startedResponse.status, 202);
    const started = (await startedResponse.json()).outcome;
    assert.equal(started.kind, "started");
    assert.equal(started.snapshot.serviceId, service.id);
    assert.equal(started.snapshot.processState, "running");
    assert.equal(started.snapshot.readinessState, "checking");

    const duplicateResponse = await call(
      origin,
      `/api/services/${service.id}/start`,
      mutation(origin, cookie, csrfToken, {}),
    );
    assert.equal(duplicateResponse.status, 200);
    const duplicate = (await duplicateResponse.json()).outcome;
    assert.equal(duplicate.kind, "existing");
    assert.equal(duplicate.snapshot.runId, started.snapshot.runId);

    const inspected = await waitForStatus(
      origin,
      service.id,
      cookie,
      (status) => status.snapshot?.readinessState === "ready",
    );
    assert.equal(inspected.snapshot.runId, started.snapshot.runId);
    assert.equal(inspected.snapshot.processState, "running");
    assert.equal(inspected.snapshot.readinessState, "ready");
    assert.equal(inspected.ownership, "owned");

    const events = await fetch(`${origin}/api/events?runId=${started.snapshot.runId}`, {
      headers: { cookie },
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(events.status, 200);
    reader = events.body.getReader();
    const ready = await waitForListeningLog(reader);
    assert.equal(ready.port, expectedPort);
    const serviceUrl = `http://127.0.0.1:${expectedPort}/ready`;
    assert.equal((await fetch(serviceUrl)).status, 200);

    const activeArchive = await call(
      origin,
      `/api/projects/${project.id}/archive`,
      mutation(origin, cookie, csrfToken, {}),
    );
    assert.equal(activeArchive.status, 409);
    assert.equal((await activeArchive.json()).error.code, "PROJECT_HAS_ACTIVE_SERVICES");

    const stoppedResponse = await call(
      origin,
      `/api/services/${service.id}/stop`,
      mutation(origin, cookie, csrfToken, {}),
    );
    assert.equal(stoppedResponse.status, 200);
    const stopped = (await stoppedResponse.json()).outcome;
    assert.equal(stopped.kind, "stopped");
    assert.equal(stopped.snapshot.runId, started.snapshot.runId);
    assert.equal(stopped.snapshot.serviceId, service.id);
    assert.equal(stopped.snapshot.processState, "stopped");
    await waitForEndpointToClose(serviceUrl);

    const finalStatus = await call(origin, `/api/services/${service.id}/status`, {
      headers: { cookie },
    });
    assert.equal(finalStatus.status, 200);
    const final = await finalStatus.json();
    assert.equal(final.snapshot.processState, "stopped");
    assert.equal(final.snapshot.readinessState, "unknown");
    assert.equal(final.ownership, null);
    assert.equal(store.listRuns(service.id).at(-1).processState, "stopped");

    const failingService = await registry.selectService(project.id, "serve", {
      displayName: "Unhealthy lifecycle server",
      expectedPort,
      readiness: { kind: "http", path: "/not-ready", timeoutMs: 350 },
      envFiles: [".env.lifecycle"],
    });
    const failingStart = await call(
      origin,
      `/api/services/${failingService.id}/start`,
      mutation(origin, cookie, csrfToken, {}),
    );
    assert.equal(failingStart.status, 202);
    assert.equal((await failingStart.json()).outcome.snapshot.readinessState, "checking");
    const unhealthy = await waitForStatus(
      origin,
      failingService.id,
      cookie,
      (status) => status.snapshot?.processState === "failed",
    );
    assert.equal(unhealthy.snapshot.readinessState, "unhealthy");
    assert.equal(unhealthy.snapshot.failureReason, "READINESS_TIMEOUT");
    assert.equal(unhealthy.ownership, null);
    await waitForEndpointToClose(serviceUrl);
    assert.equal(store.listRuns(failingService.id).at(-1).readinessState, "unhealthy");

    const preExistingStart = await call(
      origin,
      `/api/services/${service.id}/start`,
      mutation(origin, cookie, csrfToken, {}),
    );
    assert.equal(preExistingStart.status, 202);
    await waitForStatus(
      origin,
      service.id,
      cookie,
      (status) => status.snapshot?.readinessState === "ready",
    );
    const profileOwnedService = await registry.selectService(project.id, "serve", {
      displayName: "Profile-owned API",
      expectedPort: profileOwnedPort,
      readiness: { kind: "http", path: "/ready", timeoutMs: 5_000 },
      envFiles: [".env.profile-owned"],
    });
    const profileResponse = await call(
      origin,
      `/api/projects/${project.id}/profiles`,
      mutation(origin, cookie, csrfToken, {
        displayName: "Full Stack",
        services: [
          { serviceId: service.id, dependsOn: [] },
          { serviceId: profileOwnedService.id, dependsOn: [service.id] },
          { serviceId: failingService.id, dependsOn: [profileOwnedService.id] },
        ],
      }),
    );
    assert.equal(profileResponse.status, 201);
    const { profile } = await profileResponse.json();
    const profileStart = await call(
      origin,
      `/api/profiles/${profile.id}/start`,
      mutation(origin, cookie, csrfToken, {}),
    );
    assert.equal(profileStart.status, 202);
    assert.equal((await profileStart.json()).outcome.snapshot.state, "starting");
    const degraded = await waitForProfileStatus(
      origin,
      profile.id,
      cookie,
      (status) => status.snapshot?.state === "degraded",
    );
    const profileStates = Object.fromEntries(
      degraded.snapshot.services.map((entry) => [entry.serviceId, entry.state]),
    );
    assert.equal(profileStates[service.id], "preserved");
    assert.equal(profileStates[profileOwnedService.id], "rolled_back");
    assert.equal(profileStates[failingService.id], "failed");
    assert.equal((await fetch(serviceUrl)).status, 200);
    await waitForEndpointToClose(`http://127.0.0.1:${profileOwnedPort}/ready`);
    const preExistingStatus = await waitForStatus(
      origin,
      service.id,
      cookie,
      (status) => status.snapshot?.readinessState === "ready",
    );
    assert.equal(preExistingStatus.ownership, "owned");
    assert.equal(
      (
        await call(
          origin,
          `/api/services/${service.id}/stop`,
          mutation(origin, cookie, csrfToken, {}),
        )
      ).status,
      200,
    );
    await waitForEndpointToClose(serviceUrl);
    assert.equal(
      (
        await call(
          origin,
          `/api/projects/${project.id}/archive`,
          mutation(origin, cookie, csrfToken, {}),
        )
      ).status,
      200,
    );
  } finally {
    await reader?.cancel();
    await api?.close();
    store?.close();
    await rm(safeRoot, { recursive: true, force: true });
  }
});
