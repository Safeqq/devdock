import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    assert.deepEqual((await detail.json()).services, []);
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
      }),
    );
    assert.equal(selected.status, 201);
    const { service } = await selected.json();
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
      404,
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
