import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

    const duplicateResponse = await call(
      origin,
      `/api/services/${service.id}/start`,
      mutation(origin, cookie, csrfToken, {}),
    );
    assert.equal(duplicateResponse.status, 200);
    const duplicate = (await duplicateResponse.json()).outcome;
    assert.equal(duplicate.kind, "existing");
    assert.equal(duplicate.snapshot.runId, started.snapshot.runId);

    const status = await call(origin, `/api/services/${service.id}/status`, {
      headers: { cookie },
    });
    assert.equal(status.status, 200);
    const inspected = await status.json();
    assert.equal(inspected.snapshot.runId, started.snapshot.runId);
    assert.equal(inspected.ownership, "owned");

    const events = await fetch(`${origin}/api/events?runId=${started.snapshot.runId}`, {
      headers: { cookie },
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(events.status, 200);
    reader = events.body.getReader();
    const ready = await waitForListeningLog(reader);
    const serviceUrl = `http://127.0.0.1:${ready.port}/ready`;
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
    assert.equal(final.ownership, null);
    assert.equal(store.listRuns(service.id).at(-1).processState, "stopped");
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
