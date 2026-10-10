import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createLocalApiServer } from "../../apps/daemon/dist/local-api.js";
import { ProjectRegistry } from "../../apps/daemon/dist/project-registry.js";
import { NpmLauncher } from "../../packages/platform/dist/index.js";
import { RegistryDatabase } from "../../packages/storage/dist/index.js";

async function call(origin, path, options = {}) {
  return fetch(`${origin}${path}`, { signal: AbortSignal.timeout(3_000), ...options });
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

test("authenticated project API persists selections and only previews npm execution", {
  timeout: 12_000,
}, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "devdock-project-api-"));
  const projectPath = join(tempRoot, "project café & [api]");
  const outsidePath = join(tempRoot, "outside");
  const markerPath = join(projectPath, "marker.out");
  let store;
  let api;
  try {
    await mkdir(projectPath);
    await mkdir(outsidePath);
    await writeFile(
      join(projectPath, "package.json"),
      JSON.stringify({ name: "api-fixture", scripts: { dev: "node marker.mjs" } }),
    );
    await writeFile(
      join(projectPath, "marker.mjs"),
      "import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./marker.out', import.meta.url), 'ran');",
    );
    await writeFile(
      join(projectPath, ".env.export"),
      "API_TOKEN=export-secret-must-not-leak\n",
      "utf8",
    );
    store = await RegistryDatabase.open(join(tempRoot, "data", "registry.sqlite"));
    api = createLocalApiServer({
      registry: new ProjectRegistry(store),
      launcher: await NpmLauncher.locate(),
      webRoot: fileURLToPath(new URL("../../apps/web/dist/", import.meta.url)),
    });
    const origin = await api.listen(0);
    const page = await call(origin, "/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/u);
    assert.match(page.headers.get("content-security-policy"), /script-src 'self'/u);
    assert.match(page.headers.get("content-security-policy"), /font-src 'self'/u);
    const html = await page.text();
    const asset = html.match(/src="(\/assets\/[A-Za-z0-9._-]+\.js)"/u)?.[1];
    assert.ok(asset);
    const bundle = await call(origin, asset);
    assert.equal(bundle.status, 200);
    assert.equal((await bundle.text()).includes(api.pairingCode), false);
    assert.equal((await call(origin, "/api/projects")).status, 401);
    const paired = await call(origin, "/api/pair", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ code: api.pairingCode }),
    });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get("set-cookie").split(";")[0];
    const { csrfToken } = await paired.json();

    assert.equal(
      (
        await call(origin, "/api/projects", {
          method: "POST",
          headers: { origin, cookie, "content-type": "application/json" },
          body: JSON.stringify({ path: projectPath }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          origin,
          "/api/projects",
          mutation(origin, cookie, csrfToken, {
            path: projectPath,
            command: "node arbitrary.js",
          }),
        )
      ).status,
      400,
    );
    const registered = await call(
      origin,
      "/api/projects",
      mutation(origin, cookie, csrfToken, { path: projectPath }),
    );
    assert.equal(registered.status, 201);
    const { project } = await registered.json();
    assert.equal((await call(origin, "/api/projects", { headers: { cookie } })).status, 200);
    const listed = await call(origin, "/api/projects", { headers: { cookie } });
    assert.deepEqual(
      (await listed.json()).projects.map((entry) => entry.id),
      [project.id],
    );

    const detail = await call(origin, `/api/projects/${project.id}`, { headers: { cookie } });
    assert.equal(detail.status, 200);
    const initialDetail = await detail.json();
    assert.deepEqual(initialDetail.services, []);
    assert.deepEqual(initialDetail.profiles, []);
    const scripts = await call(origin, `/api/projects/${project.id}/scripts`, {
      headers: { cookie },
    });
    assert.equal(scripts.status, 200);
    assert.deepEqual((await scripts.json()).discovery.scriptNames, ["dev"]);
    assert.equal(
      (
        await call(origin, `/api/projects/${project.id}/scripts?cwd=../outside`, {
          headers: { cookie },
        })
      ).status,
      400,
    );

    assert.equal(
      (
        await call(
          origin,
          `/api/projects/${project.id}/services`,
          mutation(origin, cookie, csrfToken, { scriptName: "dev", expectedPort: 70_000 }),
        )
      ).status,
      400,
    );

    const selected = await call(
      origin,
      `/api/projects/${project.id}/services`,
      mutation(origin, cookie, csrfToken, {
        scriptName: "dev",
        displayName: "Dev server",
        expectedPort: 4_300,
        readiness: { kind: "http", path: "/ready", timeoutMs: 5_000 },
        restartPolicy: {
          kind: "on_failure",
          maxAttempts: 2,
          initialBackoffMs: 250,
          maxBackoffMs: 1_000,
        },
        envFiles: [".env.export"],
        requiredEnvKeys: ["API_TOKEN"],
      }),
    );
    assert.equal(selected.status, 201);
    const { service } = await selected.json();
    const secondarySelection = await call(
      origin,
      `/api/projects/${project.id}/services`,
      mutation(origin, cookie, csrfToken, {
        scriptName: "dev",
        displayName: "Worker",
      }),
    );
    assert.equal(secondarySelection.status, 201);
    const { service: worker } = await secondarySelection.json();
    const cycle = await call(
      origin,
      `/api/projects/${project.id}/profiles`,
      mutation(origin, cookie, csrfToken, {
        displayName: "Cycle",
        services: [
          { serviceId: service.id, dependsOn: [worker.id] },
          { serviceId: worker.id, dependsOn: [service.id] },
        ],
      }),
    );
    assert.equal(cycle.status, 400);
    const cycleError = await cycle.json();
    assert.equal(cycleError.error.code, "PROFILE_CYCLE");
    assert.match(cycleError.error.message, /Dev server -> Worker -> Dev server/u);
    const profileResponse = await call(
      origin,
      `/api/projects/${project.id}/profiles`,
      mutation(origin, cookie, csrfToken, {
        displayName: "Backend Only",
        services: [{ serviceId: service.id, dependsOn: [] }],
      }),
    );
    assert.equal(profileResponse.status, 201);
    const { profile } = await profileResponse.json();
    assert.equal(profile.displayName, "Backend Only");
    assert.equal((await call(origin, `/api/projects/${project.id}/export`)).status, 401);
    const exportedResponse = await call(origin, `/api/projects/${project.id}/export`, {
      headers: { cookie },
    });
    assert.equal(exportedResponse.status, 200);
    assert.equal(
      exportedResponse.headers.get("content-disposition"),
      'attachment; filename="devdock-configuration.json"',
    );
    const exportedText = await exportedResponse.text();
    assert.equal(exportedText.includes("export-secret-must-not-leak"), false);
    assert.equal(exportedText.includes(projectPath), false);
    assert.deepEqual(JSON.parse(exportedText), {
      format: "devdock.project-configuration",
      schemaVersion: 1,
      project: { displayName: project.displayName },
      services: [
        {
          serviceRef: "service-1",
          displayName: "Dev server",
          scriptName: "dev",
          cwd: [],
          expectedPort: 4_300,
          readiness: { kind: "http", path: "/ready", timeoutMs: 5_000 },
          restartPolicy: {
            kind: "on_failure",
            maxAttempts: 2,
            initialBackoffMs: 250,
            maxBackoffMs: 1_000,
          },
          envFiles: [".env.export"],
          requiredEnvKeys: ["API_TOKEN"],
        },
        {
          serviceRef: "service-2",
          displayName: "Worker",
          scriptName: "dev",
          cwd: [],
          restartPolicy: { kind: "off" },
          envFiles: [],
          requiredEnvKeys: [],
        },
      ],
      profiles: [
        {
          displayName: "Backend Only",
          services: [{ serviceRef: "service-1", dependsOn: [] }],
        },
      ],
    });
    assert.equal(
      (await call(origin, `/api/profiles/${profile.id}/status`, { headers: { cookie } })).status,
      501,
    );
    const configuredDetail = await call(origin, `/api/projects/${project.id}`, {
      headers: { cookie },
    });
    assert.deepEqual(
      (await configuredDetail.json()).profiles.map((entry) => entry.id),
      [profile.id],
    );
    const preview = await call(origin, `/api/services/${service.id}/preview`, {
      headers: { cookie },
    });
    assert.equal(preview.status, 200);
    const { command } = await preview.json();
    assert.equal(command.cwd, project.path.canonicalPath);
    assert.deepEqual(command.args.slice(-2), ["run", "dev"]);
    assert.equal("env" in command, false);
    const openApp = await call(origin, `/api/services/${service.id}/open-app`, {
      headers: { cookie },
    });
    assert.equal(openApp.status, 200);
    assert.equal((await openApp.json()).url, "http://127.0.0.1:4300/");
    await assert.rejects(access(markerPath));
    assert.equal(
      (
        await call(
          origin,
          `/api/services/${service.id}/start`,
          mutation(origin, cookie, csrfToken, {}),
        )
      ).status,
      501,
    );

    const archived = await call(
      origin,
      `/api/projects/${project.id}/archive`,
      mutation(origin, cookie, csrfToken, {}),
    );
    assert.equal(archived.status, 200);
    const active = await call(origin, "/api/projects", { headers: { cookie } });
    assert.deepEqual((await active.json()).projects, []);
    assert.equal(
      (await call(origin, `/api/services/${service.id}/preview`, { headers: { cookie } })).status,
      409,
    );
    assert.equal(
      (await call(origin, `/api/services/${service.id}/open-app`, { headers: { cookie } })).status,
      409,
    );
    assert.equal(
      JSON.parse(await readFile(join(projectPath, "package.json"), "utf8")).name,
      "api-fixture",
    );
  } finally {
    await api?.close();
    store?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("service diagnostics report port and key presence without exposing environment values", {
  timeout: 12_000,
}, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "devdock-diagnostics-api-"));
  const projectPath = join(tempRoot, "diagnostics project");
  const sentinel = createServer((_request, response) => response.end("sentinel"));
  let store;
  let api;
  try {
    await mkdir(projectPath);
    await writeFile(
      join(projectPath, "package.json"),
      JSON.stringify({ name: "diagnostics-fixture", scripts: { dev: "node server.mjs" } }),
    );
    await writeFile(join(projectPath, "server.mjs"), "process.exit(0);\n");
    await writeFile(
      join(projectPath, ".env.diagnostics"),
      "API_TOKEN=diagnostic-secret-must-not-leak\n",
    );
    await new Promise((resolveListen, reject) => {
      sentinel.once("error", reject);
      sentinel.listen({ host: "127.0.0.1", port: 0 }, resolveListen);
    });
    const address = sentinel.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");

    store = await RegistryDatabase.open(join(tempRoot, "data", "registry.sqlite"));
    const registry = new ProjectRegistry(store);
    api = createLocalApiServer({ registry, launcher: await NpmLauncher.locate() });
    const origin = await api.listen(0);
    const paired = await call(origin, "/api/pair", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ code: api.pairingCode }),
    });
    const cookie = paired.headers.get("set-cookie").split(";")[0];
    const { csrfToken } = await paired.json();
    const registered = await call(
      origin,
      "/api/projects",
      mutation(origin, cookie, csrfToken, { path: projectPath }),
    );
    const { project } = await registered.json();

    assert.equal(
      (
        await call(
          origin,
          `/api/projects/${project.id}/services`,
          mutation(origin, cookie, csrfToken, {
            scriptName: "dev",
            envFiles: ["../outside.env"],
          }),
        )
      ).status,
      400,
    );
    const selected = await call(
      origin,
      `/api/projects/${project.id}/services`,
      mutation(origin, cookie, csrfToken, {
        scriptName: "dev",
        expectedPort: address.port,
        envFiles: [".env.diagnostics"],
        requiredEnvKeys: ["API_TOKEN", "MISSING_KEY"],
      }),
    );
    assert.equal(selected.status, 201);
    const { service } = await selected.json();
    assert.equal((await call(origin, `/api/services/${service.id}/diagnostics`)).status, 401);

    const response = await call(origin, `/api/services/${service.id}/diagnostics`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    const responseText = await response.text();
    assert.equal(responseText.includes("diagnostic-secret-must-not-leak"), false);
    const diagnostics = JSON.parse(responseText);
    assert.deepEqual(diagnostics.port, { status: "in_use", port: address.port });
    assert.deepEqual(diagnostics.environment.files, [
      { path: ".env.diagnostics", status: "loaded" },
    ]);
    assert.deepEqual(diagnostics.environment.keys, [
      { name: "API_TOKEN", present: true },
      { name: "MISSING_KEY", present: false },
    ]);
    assert.equal(diagnostics.environment.allRequiredKeysPresent, false);
    assert.equal((await call(`http://127.0.0.1:${address.port}`, "/")).status, 200);
  } finally {
    await api?.close();
    store?.close();
    if (sentinel.listening) {
      await new Promise((resolveClose, reject) => {
        sentinel.close((error) => (error ? reject(error) : resolveClose()));
      });
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});
