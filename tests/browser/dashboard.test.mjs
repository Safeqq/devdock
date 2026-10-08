import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { createLocalApiServer } from "../../apps/daemon/dist/local-api.js";
import { ProjectRegistry } from "../../apps/daemon/dist/project-registry.js";
import { ServiceRuntimeManager } from "../../apps/daemon/dist/service-runtime-manager.js";
import {
  createPlatformProcessAdapter,
  NpmLauncher,
  productionProcessControlAvailable,
} from "../../packages/platform/dist/index.js";
import { RegistryDatabase } from "../../packages/storage/dist/index.js";

const httpFixture = fileURLToPath(new URL("../fixtures/http-server.mjs", import.meta.url));

function cleanupRoot(path, prefix) {
  const root = resolve(path);
  assert.equal(dirname(root), resolve(tmpdir()));
  assert.ok(basename(root).startsWith(prefix));
  return root;
}

// Reports each finished phase immediately: diagnostics emitted before a test timeout are
// still printed, so a slow CI runner shows the last step that completed.
function stepTimer(t) {
  let last = performance.now();
  return (label) => {
    const now = performance.now();
    t.diagnostic(`step ${label}: ${Math.round(now - last)} ms`);
    last = now;
  };
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
  throw new Error(`Endpoint stayed open after browser Stop: ${url}`);
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

async function browserExecutable() {
  const override = process.env.DEVDOCK_TEST_BROWSER;
  const candidates = override
    ? [override]
    : process.platform === "win32"
      ? [
          process.env["ProgramFiles(x86)"] &&
            join(
              process.env["ProgramFiles(x86)"],
              "Microsoft",
              "Edge",
              "Application",
              "msedge.exe",
            ),
          process.env.ProgramFiles &&
            join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          ]
        : ["/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium"];
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate)) continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next installed browser.
    }
  }
  throw new Error(
    "No supported system browser found; set DEVDOCK_TEST_BROWSER to an absolute Edge/Chrome path",
  );
}

test("browser pairs and manages project configuration without executing a script", {
  // Ubuntu CI routinely needs 23-31 s for this test; 35 s left too little margin.
  timeout: 60_000,
}, async (t) => {
  const step = stepTimer(t);
  const tempRoot = await mkdtemp(join(tmpdir(), "devdock-browser-"));
  const safeRoot = cleanupRoot(tempRoot, "devdock-browser-");
  const projectPath = join(tempRoot, "browser café & [project]");
  const markerPath = join(projectPath, "marker.out");
  let store;
  let api;
  let browser;
  try {
    await mkdir(projectPath);
    await writeFile(
      join(projectPath, "package.json"),
      JSON.stringify({ name: "browser-fixture", scripts: { dev: "node marker.mjs" } }),
    );
    await writeFile(
      join(projectPath, "marker.mjs"),
      "import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./marker.out', import.meta.url), 'ran');",
    );
    await writeFile(
      join(projectPath, ".env.browser"),
      "BROWSER_TOKEN=browser-secret-must-not-render\n",
    );
    store = await RegistryDatabase.open(join(tempRoot, "data", "registry.sqlite"));
    api = createLocalApiServer({
      registry: new ProjectRegistry(store),
      launcher: await NpmLauncher.locate(),
      webRoot: fileURLToPath(new URL("../../apps/web/dist/", import.meta.url)),
    });
    const origin = await api.listen(0);
    step("setup");
    browser = await chromium.launch({ executablePath: await browserExecutable(), headless: true });
    step("browser launch");
    const context = await browser.newContext();
    // Below the test timeout so a stuck step fails with its locator instead of a bare timeout.
    context.setDefaultTimeout(15_000);
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    step("browser context");

    await page.goto(origin);
    await page.getByRole("heading", { name: "Pair this browser" }).waitFor();
    assert.equal((await fetch(`${origin}/api/projects`)).status, 401);
    await page.getByLabel("Pairing code").fill(api.pairingCode);
    await page.getByRole("button", { name: "Pair browser" }).click();
    await page.getByRole("heading", { name: "Projects" }).waitFor();
    step("pair");
    await page.getByLabel("Folder path").fill(projectPath);
    await page.getByLabel("Display name (optional)").fill("Browser Fixture");
    await page.getByRole("button", { name: "Add project" }).click();
    await page.getByRole("heading", { name: "Browser Fixture" }).waitFor();
    step("register project");
    await page.getByLabel("App port (optional)").fill("4300");
    await page.getByLabel("Environment files (optional)").fill(".env.browser");
    await page.getByLabel("Required environment keys (optional)").fill("BROWSER_TOKEN");
    await page.getByLabel("Automatic restart").selectOption("on_failure");
    await page.getByLabel("Maximum attempts").fill("2");
    await page.getByLabel("Initial backoff (ms)").fill("250");
    await page.getByLabel("Maximum backoff (ms)").fill("1000");
    await page.getByRole("button", { name: "Add service" }).click();
    await page.getByRole("heading", { name: "dev" }).waitFor();
    step("add service");
    const profileForm = page.locator("form.profile-form");
    await profileForm.getByLabel("Profile name").fill("Backend Only");
    await profileForm.getByLabel("dev", { exact: true }).check();
    await profileForm.getByRole("button", { name: "Create profile" }).click();
    const profileCard = page.locator("article.profile-card").filter({ hasText: "Backend Only" });
    await profileCard.getByRole("heading", { name: "Backend Only" }).waitFor();
    await profileCard.locator(".state-pill").getByText("Idle", { exact: true }).waitFor();
    step("create profile");
    const serviceCard = page.locator("article.service-card").filter({ hasText: "npm run dev" });
    await serviceCard.getByText("restart up to 2 times", { exact: false }).waitFor();
    await serviceCard.getByRole("button", { name: "Run dev diagnostics" }).click();
    const diagnostics = serviceCard.getByRole("region", { name: "dev diagnostics" });
    await diagnostics.getByRole("list", { name: "Required environment keys" }).waitFor();
    await diagnostics.getByText("BROWSER_TOKEN", { exact: true }).waitFor();
    await diagnostics.getByText("Present", { exact: true }).waitFor();
    assert.equal(
      (await diagnostics.textContent()).includes("browser-secret-must-not-render"),
      false,
    );
    step("diagnostics");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Export configuration" }).click(),
    ]);
    assert.equal(download.suggestedFilename(), "devdock-configuration.json");
    const downloadedPath = await download.path();
    assert.ok(downloadedPath);
    const exportedText = await readFile(downloadedPath, "utf8");
    assert.equal(exportedText.includes("browser-secret-must-not-render"), false);
    assert.equal(exportedText.includes(projectPath), false);
    const exported = JSON.parse(exportedText);
    assert.equal(exported.format, "devdock.project-configuration");
    assert.deepEqual(exported.services[0].envFiles, [".env.browser"]);
    assert.deepEqual(exported.services[0].requiredEnvKeys, ["BROWSER_TOKEN"]);
    assert.deepEqual(exported.profiles[0].services, [{ serviceRef: "service-1", dependsOn: [] }]);
    step("export");
    await page.getByRole("button", { name: "View command" }).click();
    await page.locator(".preview pre").getByText(/"cwd"/u).waitFor();
    await page.getByRole("button", { name: "Prepare Open App" }).click();
    const openApp = page.getByRole("link", { name: /Open App/u });
    await openApp.waitFor();
    assert.equal(await openApp.getAttribute("href"), "http://127.0.0.1:4300/");
    step("preview and open app");
    await assert.rejects(access(markerPath));

    await page.reload();
    await page.getByRole("heading", { name: "Browser Fixture" }).waitFor();
    const unpairedPage = await (await browser.newContext()).newPage();
    await unpairedPage.goto(origin);
    await unpairedPage.getByRole("heading", { name: "Pair this browser" }).waitFor();
    step("reload and unpaired context");
    await page.getByRole("button", { name: "Archive" }).click();
    await page.getByText("No projects yet.").waitFor();
    step("archive");
    await access(join(projectPath, "package.json"));
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    await api?.close();
    store?.close();
    await rm(safeRoot, { recursive: true, force: true });
  }
});

test("browser starts, follows logs, survives tab close, and stops an npm service", {
  skip: !productionProcessControlAvailable()
    ? "No production process adapter for this platform"
    : false,
  timeout: 90_000,
}, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "devdock-browser-lifecycle-"));
  const safeRoot = cleanupRoot(tempRoot, "devdock-browser-lifecycle-");
  const projectPath = join(tempRoot, "runtime café & [browser]");
  let store;
  let api;
  let browser;
  try {
    const expectedPort = await availablePort();
    await mkdir(projectPath);
    await writeFile(
      join(projectPath, "package.json"),
      JSON.stringify({
        name: "browser-lifecycle-fixture",
        private: true,
        scripts: { serve: "node server.mjs" },
      }),
      "utf8",
    );
    await writeFile(
      join(projectPath, "server.mjs"),
      `await import(${JSON.stringify(pathToFileURL(httpFixture).href)});\nawait new Promise((resolve) => setTimeout(resolve, 250));\nfor (let index = 1; index <= 650; index += 1) {\n  console.log(\`flood-\${index}\`);\n  if (index % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0));\n}\nconsole.log(JSON.stringify({ type: "browser-log-ready", port: ${expectedPort} }));\n`,
      "utf8",
    );
    await writeFile(join(projectPath, ".env.lifecycle"), `PORT=${expectedPort}\n`, "utf8");

    store = await RegistryDatabase.open(join(tempRoot, "data", "registry.sqlite"));
    const registry = new ProjectRegistry(store);
    const launcher = await NpmLauncher.locate();
    const runtime = new ServiceRuntimeManager({
      registry,
      launcher,
      adapterFactory: () => createPlatformProcessAdapter(),
      daemonSessionId: "browser-lifecycle-test",
    });
    api = createLocalApiServer({
      registry,
      launcher,
      runtime,
      webRoot: fileURLToPath(new URL("../../apps/web/dist/", import.meta.url)),
    });
    const origin = await api.listen(0);
    browser = await chromium.launch({ executablePath: await browserExecutable(), headless: true });
    const context = await browser.newContext();
    const pageErrors = [];
    let page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(origin);
    await page.getByLabel("Pairing code").fill(api.pairingCode);
    await page.getByRole("button", { name: "Pair browser" }).click();
    await page.getByRole("heading", { name: "Projects" }).waitFor();
    await page.getByLabel("Folder path").fill(projectPath);
    await page.getByLabel("Display name (optional)").fill("Runtime Browser Fixture");
    await page.getByRole("button", { name: "Add project" }).click();
    await page.getByRole("heading", { name: "Runtime Browser Fixture" }).waitFor();
    await page.getByLabel("App port (optional)").fill(String(expectedPort));
    await page.getByLabel("Readiness probe").selectOption("http");
    await page.getByLabel("Readiness timeout (ms)").fill("5000");
    await page.getByLabel("HTTP readiness path").fill("/ready");
    await page.getByLabel("Environment files (optional)").fill(".env.lifecycle");
    await page.getByRole("button", { name: "Add service" }).click();

    let serviceCard = page.locator("article.service-card").filter({ hasText: "npm run serve" });
    await serviceCard.getByRole("heading", { name: "serve", exact: true }).waitFor();
    await serviceCard.getByRole("button", { name: "Start serve" }).click();
    await serviceCard.locator(".status-chip").getByText("Running", { exact: true }).waitFor();
    await serviceCard.locator(".runtime-facts").getByText("Ready", { exact: true }).waitFor();
    const readyLine = serviceCard
      .getByRole("list", { name: "serve logs" })
      .locator("code")
      .filter({ hasText: '"type":"browser-log-ready"' });
    // A slow runner can require several bounded SSE reconnects while replaying the burst.
    await readyLine.waitFor({ timeout: 30_000 });
    const ready = JSON.parse(await readyLine.last().textContent());
    await serviceCard.locator(".log-lines li").nth(499).waitFor();
    assert.equal(await serviceCard.locator(".log-lines li").count(), 500);
    assert.equal(ready.port, expectedPort);
    const serviceUrl = `http://127.0.0.1:${expectedPort}/ready`;
    assert.equal((await fetch(serviceUrl)).status, 200);

    await page.close();
    assert.equal((await fetch(serviceUrl)).status, 200);

    page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(origin);
    await page.getByRole("heading", { name: "Runtime Browser Fixture" }).waitFor();
    serviceCard = page.locator("article.service-card").filter({ hasText: "npm run serve" });
    await serviceCard.locator(".status-chip").getByText("Running", { exact: true }).waitFor();
    await serviceCard.getByRole("button", { name: "View runtime" }).click();
    await serviceCard
      .getByRole("list", { name: "serve logs" })
      .getByText(/"type":"browser-log-ready"/u)
      .waitFor();
    await serviceCard.getByRole("button", { name: "Stop serve" }).click();
    await serviceCard.locator(".status-chip").getByText("Stopped", { exact: true }).waitFor();
    await waitForEndpointToClose(serviceUrl);

    const profileForm = page.locator("form.profile-form");
    await profileForm.getByLabel("Profile name").fill("Backend Only");
    await profileForm.getByLabel("serve", { exact: true }).check();
    await profileForm.getByRole("button", { name: "Create profile" }).click();
    const profileCard = page.locator("article.profile-card").filter({ hasText: "Backend Only" });
    await profileCard.getByRole("button", { name: "Start profile" }).click();
    await profileCard.locator(".state-pill").getByText("Ready", { exact: true }).waitFor({
      timeout: 10_000,
    });
    assert.equal((await fetch(serviceUrl)).status, 200);
    await profileCard.getByRole("button", { name: "Stop profile" }).click();
    await profileCard.locator(".state-pill").getByText("Stopped", { exact: true }).waitFor();
    await waitForEndpointToClose(serviceUrl);

    const project = registry.listProjects()[0];
    assert.ok(project);
    const service = registry.listServices(project.id)[0];
    assert.ok(service);
    assert.equal(store.listRuns(service.id).at(-1).processState, "stopped");
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    await api?.close();
    store?.close();
    await rm(safeRoot, { recursive: true, force: true });
  }
});
