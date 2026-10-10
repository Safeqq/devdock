import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLocalApiServer } from "../../apps/daemon/dist/local-api.js";
import { ProjectRegistry } from "../../apps/daemon/dist/project-registry.js";
import { ServiceRuntimeManager } from "../../apps/daemon/dist/service-runtime-manager.js";
import { NpmLauncher } from "../../packages/platform/dist/index.js";
import { RegistryDatabase } from "../../packages/storage/dist/index.js";

function call(origin, path, options = {}) {
  return fetch(`${origin}${path}`, { signal: AbortSignal.timeout(5_000), ...options });
}

function post(origin, cookie, csrf, body = {}) {
  return {
    method: "POST",
    headers: { origin, cookie, "x-devdock-csrf": csrf, "content-type": "application/json" },
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
  return { cookie, csrfToken: (await paired.json()).csrfToken };
}

async function errorCode(response) {
  return (await response.json()).error.code;
}

test("groups can be edited and deleted, settings forgotten, and a leftover run released", {
  timeout: 20_000,
}, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "devdock-desktop-gaps-"));
  const projectPath = join(tempRoot, "shop");
  let store;
  let api;
  try {
    await mkdir(projectPath);
    await writeFile(
      join(projectPath, "package.json"),
      JSON.stringify({ name: "gaps", scripts: { dev: "node dev.mjs", build: "node build.mjs" } }),
    );
    store = await RegistryDatabase.open(join(tempRoot, "data", "registry.sqlite"));
    const registry = new ProjectRegistry(store);
    const project = await registry.registerProject(projectPath);
    const dev = await registry.selectService(project.id, "dev", { expectedPort: 1 });
    const build = await registry.selectService(project.id, "build");
    const group = await registry.createProfile(project.id, "Everything", [
      { serviceId: build.id, dependsOn: [] },
      { serviceId: dev.id, dependsOn: [build.id] },
    ]);
    // A run that was active when an earlier DevDock session ended. The test process's own ID
    // stands in for a program that is still running.
    registry.saveRunSnapshot({
      runId: "8c8ad1c4-7d52-4d47-9d5c-5d8d43c7c1f7",
      serviceId: dev.id,
      processState: "running",
      readinessState: "unknown",
      reconciliationState: "known",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    const launcher = await NpmLauncher.locate();
    const runtime = new ServiceRuntimeManager({
      registry,
      launcher,
      adapterFactory: () => {
        throw new Error("Nothing in this test may be started");
      },
    });
    api = createLocalApiServer({ registry, launcher, runtime });
    const origin = await api.listen(0);
    const { cookie, csrfToken } = await pair(origin, api);
    const get = (path) => call(origin, path, { headers: { cookie } });
    const change = (path, body) => call(origin, path, post(origin, cookie, csrfToken, body));

    // Leftover hints for the unknown run; a run with a known status has none.
    const leftover = await get(`/api/services/${dev.id}/leftover`);
    assert.equal(leftover.status, 200);
    const hints = await leftover.json();
    assert.equal(hints.pid, process.pid);
    assert.equal(hints.processRunning, true);
    assert.equal(hints.port.port, 1);
    assert.equal(hints.canMarkStopped, true);
    const noLeftover = await get(`/api/services/${build.id}/leftover`);
    assert.equal(noLeftover.status, 409);
    assert.equal(await errorCode(noLeftover), "RUN_NOT_UNKNOWN");

    // Nothing that may still be running, and nothing a group starts, can be forgotten.
    const unknownDelete = await change(`/api/services/${dev.id}/delete`);
    assert.equal(unknownDelete.status, 409);
    assert.equal(await errorCode(unknownDelete), "SERVICE_ACTIVE");
    const groupedDelete = await change(`/api/services/${build.id}/delete`);
    assert.equal(groupedDelete.status, 409);
    assert.equal(await errorCode(groupedDelete), "SERVICE_IN_GROUP");

    // Mark stopped needs Origin and CSRF like every change, then releases the run.
    const withoutCsrf = await call(origin, `/api/services/${dev.id}/mark-stopped`, {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(withoutCsrf.status, 403);
    const marked = await change(`/api/services/${dev.id}/mark-stopped`);
    assert.equal(marked.status, 200);
    const { snapshot } = await marked.json();
    assert.equal(snapshot.processState, "stopped");
    assert.equal(snapshot.reconciliationState, "known");
    const status = await (await get(`/api/services/${dev.id}/status`)).json();
    assert.equal(status.snapshot.failureReason, "MARKED_STOPPED_BY_USER");
    assert.equal(status.ownership, null);
    assert.equal((await change(`/api/services/${dev.id}/mark-stopped`)).status, 409);

    // Editing a group validates like creating one.
    const cyclic = await change(`/api/profiles/${group.id}/update`, {
      displayName: "Loop",
      services: [
        { serviceId: build.id, dependsOn: [dev.id] },
        { serviceId: dev.id, dependsOn: [build.id] },
      ],
    });
    assert.equal(cyclic.status, 400);
    assert.equal(await errorCode(cyclic), "PROFILE_CYCLE");
    const updated = await change(`/api/profiles/${group.id}/update`, {
      displayName: "Just build",
      services: [{ serviceId: build.id, dependsOn: [] }],
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).profile.displayName, "Just build");

    // dev left the group and its run is settled, so its settings can be forgotten.
    const forgotten = await change(`/api/services/${dev.id}/delete`);
    assert.equal(forgotten.status, 200);
    assert.deepEqual(await forgotten.json(), { id: dev.id });
    const detail = await (await get(`/api/projects/${project.id}`)).json();
    assert.deepEqual(
      detail.services.map((service) => service.scriptName),
      ["build"],
    );
    assert.deepEqual(
      detail.profiles.map((profile) => profile.displayName),
      ["Just build"],
    );

    assert.equal((await change(`/api/profiles/${group.id}/delete`)).status, 200);
    assert.equal((await change(`/api/profiles/${group.id}/delete`)).status, 404);
    assert.equal((await change(`/api/services/${build.id}/delete`)).status, 200);
    assert.deepEqual((await (await get(`/api/projects/${project.id}`)).json()).services, []);
  } finally {
    await api?.close();
    store?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
