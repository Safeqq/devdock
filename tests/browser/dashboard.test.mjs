import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { after, before, test } from "node:test";
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

// Chrome's first launch on a fresh Ubuntu runner took 22 s, plus 8 s for its first context
// (workflow 37820516272), while later launches took under 3 s. Both tests share one browser
// launched and warmed here, outside their own budgets; each test still gets fresh contexts.
// Warming only a context left the first page at 11.5 s (workflow 37879194878), so the warm-up
// opens a page as well.
let browser;
let browserStartupMs;
before(
  async () => {
    const started = performance.now();
    browser = await chromium.launch({
      executablePath: await browserExecutable(),
      headless: true,
      timeout: 120_000,
    });
    const warmup = await browser.newContext();
    await warmup.newPage();
    await warmup.close();
    browserStartupMs = Math.round(performance.now() - started);
  },
  { timeout: 150_000 },
);
after(() => browser?.close());

async function pairBrowser(page, api) {
  await page.getByRole("heading", { name: "Pair this browser" }).waitFor();
  await page.getByLabel("Pairing code").fill(api.pairingCode);
  await page.getByRole("button", { name: "Pair browser" }).click();
}

// Adds a project through the "Add a project" dialog the way a first-time user would.
async function addProject(page, projectPath, name) {
  await page.getByLabel("Project folder").fill(projectPath);
  await page.getByRole("button", { name: "Look inside" }).click();
  await page.getByRole("heading", { name: "Add this project?" }).waitFor();
  await page.getByLabel("Name shown in DevDock").fill(name);
  await page.getByRole("button", { name: "Add project" }).click();
  await page.getByRole("heading", { name, level: 1 }).waitFor();
}

test("browser pairs, previews a folder, and manages settings without executing a script", {
  timeout: 35_000,
}, async (t) => {
  t.diagnostic(`shared browser startup: ${browserStartupMs} ms`);
  const step = stepTimer(t);
  const tempRoot = await mkdtemp(join(tmpdir(), "devdock-browser-"));
  const safeRoot = cleanupRoot(tempRoot, "devdock-browser-");
  const projectPath = join(tempRoot, "browser café & [project]");
  const markerPath = join(projectPath, "marker.out");
  let store;
  let api;
  const contexts = [];
  try {
    await mkdir(projectPath);
    await writeFile(
      join(projectPath, "package.json"),
      JSON.stringify({
        name: "browser-fixture",
        scripts: { dev: "node marker.mjs", build: "node marker.mjs --build" },
      }),
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
    const context = await browser.newContext();
    contexts.push(context);
    // Below the test timeout so a stuck step fails with its locator instead of a bare timeout.
    context.setDefaultTimeout(15_000);
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    step("browser context");

    await page.goto(origin);
    assert.equal((await fetch(`${origin}/api/projects`)).status, 401);
    await pairBrowser(page, api);
    await page.getByRole("heading", { name: "Welcome to DevDock" }).waitFor();
    // The bundled typefaces load from the dashboard's own origin; a CSP that blocks them leaves
    // their faces in the "error" state.
    const fontStates = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts]
        .filter((face) => face.family.replaceAll('"', "") === "Libre Caslon Display")
        .map((face) => face.status);
    });
    assert.deepEqual(fontStates, ["loaded"]);
    step("pair");

    await page.getByRole("button", { name: "Choose a project folder" }).click();
    await page.getByLabel("Project folder").fill(join(tempRoot, "missing"));
    await page.getByRole("button", { name: "Look inside" }).click();
    await page.getByRole("alert").getByText("does not exist", { exact: false }).waitFor();
    await page.getByLabel("Project folder").fill(projectPath);
    await page.getByRole("button", { name: "Look inside" }).click();
    const found = page.getByRole("list", { name: "Scripts found" });
    await found.getByText("Development server").waitFor();
    await found.getByText("Builds your app for release").waitFor();
    await page.getByText("Nothing runs until you press Start").waitFor();
    await page.getByLabel("Name shown in DevDock").fill("Browser Fixture");
    await page.getByRole("button", { name: "Add project" }).click();
    await page.getByRole("heading", { name: "Browser Fixture", level: 1 }).waitFor();
    await page.getByText("Running scripts isn't available on this system").waitFor();
    const devCard = page.getByRole("article", { name: "dev script" });
    await devCard.getByText("Development server · keeps running").waitFor();
    await devCard.getByText("node marker.mjs", { exact: true }).waitFor();
    step("register project");

    await devCard.getByRole("button", { name: "Settings for dev" }).click();
    const settings = page.getByRole("dialog", { name: "dev" });
    await settings.getByLabel("Port", { exact: true }).fill("4300");
    await settings.getByLabel("Files to load").fill(".env.browser");
    await settings.getByLabel("Variables it needs").fill("BROWSER_TOKEN");
    await settings.getByLabel("Restart attempts").fill("2");
    await settings.getByText("Restart it, up to").click();
    await settings.getByRole("button", { name: "Save" }).click();
    await page.getByText("Saved settings for dev.").waitFor();
    step("save settings");

    await devCard.getByRole("button", { name: "Settings for dev" }).click();
    assert.equal(await settings.getByLabel("Port", { exact: true }).inputValue(), "4300");
    await settings.getByRole("button", { name: "Check port and environment" }).click();
    const checks = settings.getByRole("list", { name: "Check results" });
    await checks.getByText("BROWSER_TOKEN", { exact: true }).waitFor();
    await checks.getByText("Present", { exact: true }).waitFor();
    assert.equal((await settings.textContent()).includes("browser-secret-must-not-render"), false);
    await settings.getByRole("button", { name: "Close" }).click();
    step("diagnostics");

    await page.getByRole("button", { name: "New group" }).click();
    const groupDialog = page.getByRole("dialog", { name: "New group" });
    await groupDialog.getByLabel("Group name").fill("Backend Only");
    await groupDialog.locator("label.pick").filter({ hasText: "dev" }).locator("input").check();
    await groupDialog.getByRole("button", { name: "Create group" }).click();
    const groupCard = page.getByRole("article", { name: "Backend Only group" });
    await groupCard.getByText("Not running", { exact: true }).waitFor();
    step("create group");

    await page.getByRole("button", { name: "Project options" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("menuitem", { name: "Export settings" }).click(),
    ]);
    assert.equal(download.suggestedFilename(), "devdock-configuration.json");
    const downloadedPath = await download.path();
    assert.ok(downloadedPath);
    const exportedText = await readFile(downloadedPath, "utf8");
    assert.equal(exportedText.includes("browser-secret-must-not-render"), false);
    assert.equal(exportedText.includes(projectPath), false);
    const exported = JSON.parse(exportedText);
    assert.equal(exported.format, "devdock.project-configuration");
    assert.equal(exported.services[0].scriptName, "dev");
    assert.equal(exported.services[0].expectedPort, 4300);
    assert.deepEqual(exported.services[0].envFiles, [".env.browser"]);
    assert.deepEqual(exported.services[0].requiredEnvKeys, ["BROWSER_TOKEN"]);
    assert.deepEqual(exported.services[0].restartPolicy, {
      kind: "on_failure",
      maxAttempts: 2,
      initialBackoffMs: 1000,
      maxBackoffMs: 10000,
    });
    assert.deepEqual(exported.profiles[0].services, [{ serviceRef: "service-1", dependsOn: [] }]);
    step("export");
    await assert.rejects(access(markerPath));

    await page.reload();
    await page.getByRole("heading", { name: "Browser Fixture", level: 1 }).waitFor();
    const unpairedContext = await browser.newContext();
    contexts.push(unpairedContext);
    const unpairedPage = await unpairedContext.newPage();
    await unpairedPage.goto(origin);
    await unpairedPage.getByRole("heading", { name: "Pair this browser" }).waitFor();
    step("reload and unpaired context");

    await page.getByRole("button", { name: "Project options" }).click();
    await page.getByRole("menuitem", { name: "Remove from DevDock" }).click();
    await page.getByText("Your files stay exactly where they are.").waitFor();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByRole("heading", { name: "Welcome to DevDock" }).waitFor();
    step("remove");
    await access(join(projectPath, "package.json"));
    await assert.rejects(access(markerPath));
    assert.deepEqual(pageErrors, []);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await api?.close();
    store?.close();
    await rm(safeRoot, { recursive: true, force: true });
  }
});

test("desktop shell pairing code signs the window in without the pairing form", {
  timeout: 35_000,
}, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "devdock-browser-desktop-"));
  const safeRoot = cleanupRoot(tempRoot, "devdock-browser-desktop-");
  let store;
  let api;
  const contexts = [];
  try {
    store = await RegistryDatabase.open(join(tempRoot, "data", "registry.sqlite"));
    api = createLocalApiServer({
      registry: new ProjectRegistry(store),
      launcher: await NpmLauncher.locate(),
      webRoot: fileURLToPath(new URL("../../apps/web/dist/", import.meta.url)),
    });
    const origin = await api.listen(0);
    const injectCode = (code) => {
      window.__DEVDOCK_DESKTOP__ = { pairingCode: code };
    };

    const context = await browser.newContext();
    contexts.push(context);
    context.setDefaultTimeout(15_000);
    await context.addInitScript(injectCode, api.pairingCode);
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(origin);
    await page.getByRole("heading", { name: "Welcome to DevDock" }).waitFor();
    assert.equal(await page.getByLabel("Pairing code").count(), 0);
    assert.equal(await page.evaluate(() => window.__DEVDOCK_DESKTOP__?.pairingCode), undefined);
    // The init script injects the used code again on reload; the session cookie keeps the
    // window signed in and the stale code is never submitted.
    await page.reload();
    await page.getByRole("heading", { name: "Welcome to DevDock" }).waitFor();

    const rejected = await browser.newContext();
    contexts.push(rejected);
    rejected.setDefaultTimeout(15_000);
    await rejected.addInitScript(injectCode, "not-the-current-code");
    const fallbackPage = await rejected.newPage();
    await fallbackPage.goto(origin);
    await fallbackPage.getByRole("heading", { name: "Pair this browser" }).waitFor();
    assert.deepEqual(pageErrors, []);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await api?.close();
    store?.close();
    await rm(safeRoot, { recursive: true, force: true });
  }
});

test("browser starts, follows output, survives tab close, and stops an npm script", {
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
  const contexts = [];
  try {
    const expectedPort = await availablePort();
    await mkdir(projectPath);
    await writeFile(
      join(projectPath, "package.json"),
      JSON.stringify({
        name: "browser-lifecycle-fixture",
        private: true,
        scripts: { serve: "node server.mjs", check: "node check.mjs" },
      }),
      "utf8",
    );
    await writeFile(
      join(projectPath, "server.mjs"),
      `await import(${JSON.stringify(pathToFileURL(httpFixture).href)});\nawait new Promise((resolve) => setTimeout(resolve, 250));\nfor (let index = 1; index <= 650; index += 1) {\n  console.log(\`flood-\${index}\`);\n  if (index % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0));\n}\nconsole.log(JSON.stringify({ type: "browser-log-ready", port: ${expectedPort} }));\n`,
      "utf8",
    );
    await writeFile(
      join(projectPath, "check.mjs"),
      "console.error('1 check failed'); process.exitCode = 3;\n",
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
    const context = await browser.newContext();
    contexts.push(context);
    context.setDefaultTimeout(15_000);
    const pageErrors = [];
    let page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(origin);
    await pairBrowser(page, api);
    await page.getByRole("button", { name: "Choose a project folder" }).click();
    await addProject(page, projectPath, "Runtime Browser Fixture");
    await page.getByText("Quick start:").waitFor();

    let serveCard = page.getByRole("article", { name: "serve script" });
    await serveCard.getByText("Recommended", { exact: true }).waitFor();
    await serveCard.getByRole("button", { name: "Settings for serve" }).click();
    const settings = page.getByRole("dialog", { name: "serve" });
    await settings.getByLabel("Port", { exact: true }).fill(String(expectedPort));
    await settings.getByText("When this page loads:").click();
    await settings.getByLabel("Page that shows it is ready").fill("/ready");
    await settings.getByLabel("Seconds to wait before giving up").fill("5");
    await settings.getByLabel("Files to load").fill(".env.lifecycle");
    await settings.getByRole("button", { name: "Save" }).click();
    await page.getByText("Saved settings for serve.").waitFor();

    await serveCard.getByRole("button", { name: "Start serve" }).click();
    await serveCard.getByText("Running · Ready", { exact: true }).waitFor({ timeout: 20_000 });
    assert.equal(await page.getByText("Quick start:").count(), 0);
    const openLink = serveCard.getByRole("link", { name: "Open serve in your browser" });
    assert.equal(await openLink.getAttribute("href"), `http://127.0.0.1:${expectedPort}/`);
    const output = page.getByRole("list", { name: "serve output" });
    const readyLine = output.getByText(/"type":"browser-log-ready"/u);
    // A slow runner can require several bounded SSE reconnects while replaying the burst.
    await readyLine.waitFor({ timeout: 30_000 });
    await output.getByText("flood-1", { exact: true }).waitFor();
    const ready = JSON.parse(await readyLine.textContent());
    assert.equal(ready.port, expectedPort);
    const serviceUrl = `http://127.0.0.1:${expectedPort}/ready`;
    assert.equal((await fetch(serviceUrl)).status, 200);
    await page
      .getByRole("navigation")
      .getByText("1 running", { exact: true })
      .waitFor({ timeout: 10_000 });

    await page.close();
    assert.equal((await fetch(serviceUrl)).status, 200);

    page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(origin);
    await page.getByRole("heading", { name: "Runtime Browser Fixture", level: 1 }).waitFor();
    serveCard = page.getByRole("article", { name: "serve script" });
    await serveCard.getByText("Running · Ready", { exact: true }).waitFor();
    await page
      .getByRole("list", { name: "serve output" })
      .getByText(/"type":"browser-log-ready"/u)
      .waitFor({ timeout: 30_000 });
    await serveCard.getByRole("button", { name: "Stop serve" }).click();
    await serveCard.getByText("Not running", { exact: true }).waitFor();
    await page.getByText("Stopped.", { exact: true }).waitFor();
    await waitForEndpointToClose(serviceUrl);

    const checkCard = page.getByRole("article", { name: "check script" });
    await checkCard.getByRole("button", { name: "Run check" }).click();
    await checkCard.getByText(/^Failed ·/u).waitFor();
    await checkCard.getByText("Stopped with an error (exit code 3).", { exact: false }).waitFor();
    await page.getByRole("list", { name: "check output" }).getByText("1 check failed").waitFor();

    await page.getByRole("button", { name: "New group" }).click();
    const groupDialog = page.getByRole("dialog", { name: "New group" });
    await groupDialog.getByLabel("Group name").fill("Backend Only");
    await groupDialog.locator("label.pick").filter({ hasText: "serve" }).locator("input").check();
    await groupDialog.getByRole("button", { name: "Create group" }).click();
    const groupCard = page.getByRole("article", { name: "Backend Only group" });
    await groupCard.getByRole("button", { name: "Start group: Backend Only" }).click();
    await groupCard.getByText("Running · Ready", { exact: true }).waitFor({ timeout: 20_000 });
    assert.equal((await fetch(serviceUrl)).status, 200);
    await groupCard.getByRole("button", { name: "Stop group: Backend Only" }).click();
    await groupCard.getByText("Not running", { exact: true }).waitFor();
    await waitForEndpointToClose(serviceUrl);

    const project = registry.listProjects()[0];
    assert.ok(project);
    const service = registry.listServices(project.id).find((entry) => entry.scriptName === "serve");
    assert.ok(service);
    assert.equal(store.listRuns(service.id).at(-1).processState, "stopped");
    assert.deepEqual(pageErrors, []);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await api?.close();
    store?.close();
    await rm(safeRoot, { recursive: true, force: true });
  }
});
