import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createLocalApiServer } from "../../apps/daemon/dist/local-api.js";
import { ProjectRegistry } from "../../apps/daemon/dist/project-registry.js";
import { ServiceRuntimeManager } from "../../apps/daemon/dist/service-runtime-manager.js";
import {
  createPlatformProcessAdapter,
  NpmLauncher,
  productionProcessControlAvailable,
} from "../../packages/platform/dist/index.js";
import { RegistryDatabase } from "../../packages/storage/dist/index.js";

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

async function pair(origin, api) {
  const paired = await call(origin, "/api/pair", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ code: api.pairingCode }),
  });
  assert.equal(paired.status, 200);
  const cookie = paired.headers.get("set-cookie").split(";")[0];
  const { csrfToken } = await paired.json();
  return { cookie, csrfToken };
}

async function availablePort() {
  const reservation = createServer();
  await new Promise((resolveListen, reject) => {
    reservation.once("error", reject);
    reservation.listen({ host: "127.0.0.1", port: 0 }, resolveListen);
  });
  const { port } = reservation.address();
  await new Promise((resolveClose) => reservation.close(resolveClose));
  return port;
}

test("folder inspection, script commands, and settings updates never run a script", {
  timeout: 15_000,
}, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "devdock-desktop-ui-api-"));
  const projectPath = join(tempRoot, "toko café & [ui]");
  const markerPath = join(projectPath, "marker.out");
  let store;
  let api;
  try {
    await mkdir(projectPath);
    await writeFile(
      join(projectPath, "package.json"),
      JSON.stringify({
        name: "ui-fixture",
        scripts: { dev: "node marker.mjs", build: "node marker.mjs --build", "--bad": "x" },
      }),
    );
    await writeFile(
      join(projectPath, "marker.mjs"),
      "import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./marker.out', import.meta.url), 'ran');",
    );
    store = await RegistryDatabase.open(join(tempRoot, "data", "registry.sqlite"));
    const registry = new ProjectRegistry(store);
    api = createLocalApiServer({ registry, launcher: await NpmLauncher.locate() });
    const origin = await api.listen(0);
    const { cookie, csrfToken } = await pair(origin, api);

    assert.equal(
      (
        await call(origin, "/api/folders/inspect", {
          method: "POST",
          headers: { origin, cookie, "content-type": "application/json" },
          body: JSON.stringify({ path: projectPath }),
        })
      ).status,
      403,
    );
    const inspected = await call(
      origin,
      "/api/folders/inspect",
      mutation(origin, cookie, csrfToken, { path: projectPath }),
    );
    assert.equal(inspected.status, 200);
    const inspection = await inspected.json();
    assert.equal(inspection.folder.suggestedName, "toko café & [ui]");
    assert.deepEqual(inspection.discovery.scripts, [
      { name: "dev", command: "node marker.mjs" },
      { name: "build", command: "node marker.mjs --build" },
    ]);
    assert.equal(inspection.discovery.unsupportedScriptCount, 1);
    assert.deepEqual(registry.listProjects(), []);

    const missing = await call(
      origin,
      "/api/folders/inspect",
      mutation(origin, cookie, csrfToken, { path: tempRoot }),
    );
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "PACKAGE_NOT_FOUND");

    const registered = await call(
      origin,
      "/api/projects",
      mutation(origin, cookie, csrfToken, { path: projectPath }),
    );
    const { project } = await registered.json();
    const selected = await call(
      origin,
      `/api/projects/${project.id}/services`,
      mutation(origin, cookie, csrfToken, { scriptName: "dev" }),
    );
    const { service } = await selected.json();

    const invalid = await call(
      origin,
      `/api/services/${service.id}/settings`,
      mutation(origin, cookie, csrfToken, {
        readiness: { kind: "tcp", timeoutMs: 5_000 },
      }),
    );
    assert.equal(invalid.status, 400);
    const escaping = await call(
      origin,
      `/api/services/${service.id}/settings`,
      mutation(origin, cookie, csrfToken, { envFiles: ["../outside.env"] }),
    );
    assert.equal(escaping.status, 400);
    const updated = await call(
      origin,
      `/api/services/${service.id}/settings`,
      mutation(origin, cookie, csrfToken, {
        expectedPort: 5_173,
        readiness: { kind: "http", path: "/health", timeoutMs: 30_000 },
        restartPolicy: {
          kind: "on_failure",
          maxAttempts: 2,
          initialBackoffMs: 1_000,
          maxBackoffMs: 10_000,
        },
        envFiles: [".env.local"],
        requiredEnvKeys: ["API_KEY"],
      }),
    );
    assert.equal(updated.status, 200);
    const { service: saved } = await updated.json();
    assert.equal(saved.id, service.id);
    assert.equal(saved.scriptName, "dev");
    assert.equal(saved.expectedPort, 5_173);
    assert.deepEqual(saved.readiness, { kind: "http", path: "/health", timeoutMs: 30_000 });
    assert.deepEqual(registry.getService(service.id), saved);

    const cleared = await call(
      origin,
      `/api/services/${service.id}/settings`,
      mutation(origin, cookie, csrfToken, {}),
    );
    assert.equal(cleared.status, 200);
    const reloaded = registry.getService(service.id);
    assert.equal(reloaded.expectedPort, undefined);
    assert.equal(reloaded.readiness, undefined);
    assert.deepEqual(reloaded.restartPolicy, { kind: "off" });
    assert.deepEqual(reloaded.envFiles, []);

    const summary = await call(origin, "/api/runtime/summary", { headers: { cookie } });
    assert.equal(summary.status, 200);
    assert.deepEqual(await summary.json(), {
      projects: [{ projectId: project.id, active: 0, failed: 0 }],
    });
    assert.equal((await call(origin, "/api/system")).status, 401);
    const system = await call(origin, "/api/system", { headers: { cookie } });
    assert.equal(system.status, 200);
    const { projectNode } = await system.json();
    assert.equal(projectNode.source, "daemon");
    assert.equal(projectNode.version, process.version);

    await assert.rejects(access(markerPath));
  } finally {
    await api?.close();
    store?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("a running script's printed address drives status, summary, and Open App", {
  skip: !productionProcessControlAvailable()
    ? "No production process adapter for this platform"
    : false,
  timeout: 45_000,
}, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "devdock-desktop-ui-url-"));
  const projectPath = join(tempRoot, "printed url");
  let store;
  let api;
  try {
    const port = await availablePort();
    await mkdir(projectPath);
    await writeFile(
      join(projectPath, "package.json"),
      JSON.stringify({ name: "url-fixture", private: true, scripts: { dev: "node server.mjs" } }),
    );
    // Prints its address the way Vite does, colour codes included, then keeps serving.
    await writeFile(
      join(projectPath, "server.mjs"),
      [
        "import { createServer } from 'node:http';",
        `const server = createServer((_request, response) => response.end('ok'));`,
        `server.listen(${port}, '127.0.0.1', () => {`,
        `  console.log('  \\u001b[32m➜\\u001b[39m  Local:   \\u001b[36mhttp://localhost:\\u001b[1m${port}\\u001b[22m/\\u001b[39m');`,
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    store = await RegistryDatabase.open(join(tempRoot, "data", "registry.sqlite"));
    const registry = new ProjectRegistry(store);
    const launcher = await NpmLauncher.locate();
    const runtime = new ServiceRuntimeManager({
      registry,
      launcher,
      adapterFactory: () => createPlatformProcessAdapter(),
    });
    api = createLocalApiServer({ registry, launcher, runtime });
    const origin = await api.listen(0);
    const { cookie, csrfToken } = await pair(origin, api);
    const { project } = await (
      await call(
        origin,
        "/api/projects",
        mutation(origin, cookie, csrfToken, { path: projectPath }),
      )
    ).json();
    const { service } = await (
      await call(
        origin,
        `/api/projects/${project.id}/services`,
        mutation(origin, cookie, csrfToken, { scriptName: "dev" }),
      )
    ).json();
    const unconfigured = await call(origin, `/api/services/${service.id}/open-app`, {
      headers: { cookie },
    });
    assert.equal(unconfigured.status, 409);

    const started = await call(
      origin,
      `/api/services/${service.id}/start`,
      mutation(origin, cookie, csrfToken, {}),
    );
    assert.equal(started.status, 202);
    let status;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      status = await (
        await call(origin, `/api/services/${service.id}/status`, { headers: { cookie } })
      ).json();
      if (status.appUrl) break;
      await delay(100);
    }
    assert.equal(status.appUrl, `http://localhost:${port}/`);
    const summary = await (
      await call(origin, "/api/runtime/summary", { headers: { cookie } })
    ).json();
    assert.deepEqual(summary.projects, [{ projectId: project.id, active: 1, failed: 0 }]);
    const openApp = await call(origin, `/api/services/${service.id}/open-app`, {
      headers: { cookie },
    });
    assert.equal((await openApp.json()).url, `http://localhost:${port}/`);

    // A configured port that disagrees with the printed address wins.
    await call(
      origin,
      `/api/services/${service.id}/settings`,
      mutation(origin, cookie, csrfToken, { expectedPort: port + 1 }),
    );
    const configured = await call(origin, `/api/services/${service.id}/open-app`, {
      headers: { cookie },
    });
    assert.equal((await configured.json()).url, `http://127.0.0.1:${port + 1}/`);

    const stopped = await call(
      origin,
      `/api/services/${service.id}/stop`,
      mutation(origin, cookie, csrfToken, {}),
    );
    assert.equal(stopped.status, 200);
  } finally {
    await api?.close();
    store?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
