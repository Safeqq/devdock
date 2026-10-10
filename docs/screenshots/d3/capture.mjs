// Captures the real D3 desktop UI, served by the real daemon, for review next to the mockups in
// docs/mockups/d3. A throwaway sample project (dev server, build, failing test, lint) is created in
// the temp folder and removed afterwards. The window size matches the desktop app.
// Run from the repository root on Windows after `npm run build`: node docs/screenshots/d3/capture.mjs
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createLocalApiServer } from "../../../apps/daemon/dist/local-api.js";
import { ProjectRegistry } from "../../../apps/daemon/dist/project-registry.js";
import { ServiceRuntimeManager } from "../../../apps/daemon/dist/service-runtime-manager.js";
import {
  createPlatformProcessAdapter,
  NpmLauncher,
} from "../../../packages/platform/dist/index.js";
import { RegistryDatabase } from "../../../packages/storage/dist/index.js";

const here = (name) => fileURLToPath(new URL(name, import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function edge() {
  const candidates = [
    process.env.DEVDOCK_TEST_BROWSER,
    process.env["ProgramFiles(x86)"] &&
      join(process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.ProgramFiles &&
      join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next installed browser.
    }
  }
  throw new Error("No Edge installation found");
}

const root = await mkdtemp(join(tmpdir(), "devdock-d3-capture-"));
const project = join(root, "toko-online");
const port = await freePort();
await mkdir(project);
await writeFile(
  join(project, "package.json"),
  JSON.stringify({
    name: "toko-online",
    scripts: {
      dev: "node dev.mjs",
      build: "node build.mjs",
      test: "node test.mjs",
      lint: "node lint.mjs",
      postinstall: "node lint.mjs",
    },
  }),
);
await writeFile(
  join(project, "dev.mjs"),
  `import { createServer } from "node:http";
createServer((_request, response) => response.end("toko-online")).listen(${port}, "127.0.0.1", () => {
  console.log("  VITE v8.3.0  ready in 412 ms");
  console.log("  \\u001b[32m➜\\u001b[39m  Local:   \\u001b[36mhttp://localhost:${port}/\\u001b[39m");
});
setInterval(() => console.log("hmr update /src/App.tsx"), 2000);
`,
);
await writeFile(join(project, "build.mjs"), "console.log('building…'); setTimeout(() => {}, 1200);");
await writeFile(
  join(project, "test.mjs"),
  "console.log('running 12 tests'); console.error('FAIL cart.test.ts > adds an item'); process.exitCode = 1;",
);
await writeFile(join(project, "lint.mjs"), "console.log('no problems');");

const store = await RegistryDatabase.open(join(root, "data", "registry.sqlite"));
const registry = new ProjectRegistry(store);
const launcher = await NpmLauncher.locatePreferred();
const runtime = new ServiceRuntimeManager({
  registry,
  launcher,
  adapterFactory: () => createPlatformProcessAdapter(),
});
const api = createLocalApiServer({
  registry,
  launcher,
  runtime,
  webRoot: here("../../../apps/web/dist/"),
});
const origin = await api.listen(0);
const browser = await chromium.launch({ executablePath: await edge(), headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  context.setDefaultTimeout(20_000);
  // Signs in the way the desktop shell does, so no pairing form appears.
  await context.addInitScript((code) => {
    window.__DEVDOCK_DESKTOP__ = { pairingCode: code };
  }, api.pairingCode);
  const page = await context.newPage();
  const shot = (name) => page.screenshot({ path: here(`./${name}.png`) });

  await page.goto(origin);
  await page.getByRole("heading", { name: "Welcome to DevDock" }).waitFor();
  await shot("welcome");
  await page.getByRole("button", { name: "Choose a project folder" }).click();
  await page.getByLabel("Project folder").fill(project);
  await page.getByRole("button", { name: "Look inside" }).click();
  await page.getByRole("heading", { name: "Add this project?" }).waitFor();
  await shot("add");
  await page.getByRole("button", { name: "Add project" }).click();
  await page.getByRole("heading", { name: "toko-online", level: 1 }).waitFor();
  await delay(400);
  await shot("first");

  await page.getByRole("button", { name: "Start dev" }).click();
  await page.getByText("Running · Ready", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Run build" }).click();
  await page.getByRole("button", { name: "Run test" }).click();
  await page.getByText(/^Failed ·/u).waitFor();
  await page.getByText(/^Finished ·/u).waitFor();
  await page.getByRole("tab", { name: "dev" }).click();
  await delay(2_500);
  await shot("project");

  await page.getByRole("button", { name: "Settings for dev" }).click();
  await page.locator("#settings-title").waitFor();
  await delay(300);
  await shot("settings");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "New group" }).click();
  const dialog = page.getByRole("dialog", { name: "New group" });
  await dialog.getByLabel("Group name").fill("Full stack");
  await dialog.locator("label.pick").filter({ hasText: "build" }).locator("input").check();
  await dialog.locator("label.pick").filter({ hasText: "dev" }).locator("input").check();
  await delay(200);
  await shot("group");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Stop dev" }).click();
  await page.getByText("Not running", { exact: true }).first().waitFor();
} finally {
  await browser.close();
  await api.close();
  store.close();
  await rm(root, { recursive: true, force: true });
}
console.log("captured welcome, add, first, project, settings, and group");
