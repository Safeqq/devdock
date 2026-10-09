// Launches the DevDock desktop shell on Windows with an isolated data directory, drives its real
// WebView2 window over the DevTools protocol, and checks pairing, permissions, navigation, a real
// service lifecycle through the sidecar's Job Object adapter, session renewal, the tray lifecycle
// (close to tray, second launch, --quit), and the error window when another DevDock holds the data. Usage: node scripts/verify-desktop-shell.mjs <path-to-devdock-desktop.exe>
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

if (process.platform !== "win32") {
  console.error("The desktop shell check currently runs on Windows only.");
  process.exit(2);
}
const executable = process.argv[2];
if (!executable) {
  console.error("Usage: node scripts/verify-desktop-shell.mjs <path-to-devdock-desktop.exe>");
  process.exit(2);
}
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const debugPort = 9300 + Math.floor(Math.random() * 500);
const dataRoot = await mkdtemp(join(tmpdir(), "devdock-desktop-check-"));
const results = [];
const check = (name, detail = "") => {
  results.push({ name, detail });
  console.log(`ok - ${name}${detail ? ` (${detail})` : ""}`);
};

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

// Reports whether the process shows its DevDock window. Hiding to the tray only makes the window
// invisible, and WebView2 keeps reporting the page as visible, so this asks Windows directly about
// top-level "Tauri Window" windows titled DevDock (other helper windows are ignored).
function hasVisibleWindow(pid) {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DevDockWindowCheck {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder text, int max);
  public static bool Visible(uint target) {
    bool found = false;
    EnumWindows((hWnd, l) => {
      uint pid; GetWindowThreadProcessId(hWnd, out pid);
      var title = new StringBuilder(64); GetWindowText(hWnd, title, 64);
      var cls = new StringBuilder(64); GetClassName(hWnd, cls, 64);
      if (pid == target && cls.ToString() == "Tauri Window" && title.ToString() == "DevDock" && IsWindowVisible(hWnd)) found = true;
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
[DevDockWindowCheck]::Visible(${pid})`;
  return (
    execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
    }).trim() === "True"
  );
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (caught) {
    return caught?.code === "EPERM";
  }
}

// Lists node.exe processes started from this repository's daemon entry, so the check can prove
// the sidecar is gone without touching unrelated Node.js processes.
function sidecarPids() {
  const output = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*registry-api-cli.js*' } | ForEach-Object { $_.ProcessId }",
    ],
    { encoding: "utf8" },
  );
  return output.split(/\s+/u).filter(Boolean).map(Number);
}

const daemonEntry = join(repositoryRoot, "apps", "daemon", "dist", "registry-api-cli.js");
const isolatedEnvironment = {
  ...process.env,
  LOCALAPPDATA: dataRoot,
  HOME: dataRoot,
  DEVDOCK_SIDECAR_NODE: process.execPath,
  DEVDOCK_SIDECAR_ENTRY: daemonEntry,
};

function launch(args, port) {
  return spawn(resolve(executable), args, {
    env: {
      ...isolatedEnvironment,
      ...(port === undefined
        ? {}
        : { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
}

async function waitForExit(child, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && Date.now() < deadline) await delay(200);
  assert.notEqual(child.exitCode, null, description);
  return child.exitCode;
}

async function connect(port, child) {
  const started = Date.now();
  for (;;) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2_000 });
    } catch {
      if (child.exitCode !== null) throw new Error("desktop shell exited before its window opened");
      if (Date.now() - started > 60_000) throw new Error("WebView2 DevTools endpoint did not open");
      await delay(500);
    }
  }
}

async function findPage(connection, matches) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const page = connection
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => matches(candidate.url()));
    if (page) return page;
    await delay(250);
  }
  return undefined;
}

const before = new Set(sidecarPids());
const app = launch([], debugPort);
let appStderr = "";
app.stderr.on("data", (chunk) => {
  appStderr = (appStderr + chunk).slice(-8_000);
});
let browser;
try {
  const started = Date.now();
  browser = await connect(debugPort, app);
  const page = await findPage(browser, (url) => url.startsWith("http://127.0.0.1:"));
  assert.ok(page, "the main window did not load the daemon dashboard");
  const origin = new URL(page.url()).origin;
  check("window loads the daemon dashboard", origin);

  await page.getByRole("heading", { name: "Projects" }).waitFor({ timeout: 20_000 });
  assert.equal(await page.getByLabel("Pairing code").count(), 0);
  check(
    "window pairs automatically without the pairing form",
    `${Date.now() - started} ms after launch`,
  );
  assert.equal(await page.evaluate(() => window.__DEVDOCK_DESKTOP__?.pairingCode), undefined);
  check("injected pairing code is removed from the page");

  const sidecars = sidecarPids().filter((pid) => !before.has(pid));
  assert.equal(sidecars.length, 1, `expected one new sidecar, found ${sidecars.join(",")}`);
  check("one daemon sidecar is running", `pid ${sidecars[0]}`);

  assert.equal(await page.evaluate(() => typeof window.__TAURI__?.core?.invoke), "function");
  const denied = await page.evaluate(() =>
    window.__TAURI__.core.invoke("plugin:dialog|save", { options: {} }).then(
      () => "allowed",
      (error) => String(error),
    ),
  );
  assert.match(denied, /not allowed/iu);
  check("commands outside the granted permissions are refused", denied);

  // dialog:open is granted: start it, confirm a native folder dialog appears, then cancel it.
  await page.evaluate(() => {
    window.__dialogResult = window.__TAURI__.core
      .invoke("plugin:dialog|open", { options: { directory: true, title: "DevDock check" } })
      .then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error: String(error) }),
      );
  });
  let dialogClosed = "";
  for (let attempt = 0; attempt < 40 && !dialogClosed; attempt += 1) {
    await delay(250);
    dialogClosed = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Add-Type -AssemblyName UIAutomationClient; $root = [System.Windows.Automation.AutomationElement]::RootElement; $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${app.pid}); $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond) | Where-Object { $_.Current.Name -eq 'DevDock check' }; foreach ($w in $windows) { ($w.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)).Close(); 'closed' }`,
      ],
      { encoding: "utf8" },
    ).trim();
  }
  assert.equal(dialogClosed.includes("closed"), true, "the native folder dialog did not appear");
  const dialogResult = await page.evaluate(() => window.__dialogResult);
  assert.deepEqual(dialogResult, { ok: true, value: null });
  check("granted folder dialog opens natively and returns null when cancelled");

  await page.evaluate(() => {
    window.location.href = "https://example.com/";
  });
  await delay(1_500);
  assert.equal(new URL(page.url()).origin, origin);
  check("navigation away from the daemon origin is blocked");

  // A real npm service started through the window's own session proves the Job Object helper
  // works when the daemon runs as a console-less sidecar.
  const servicePort = await freePort();
  const projectPath = join(dataRoot, "desktop check project");
  await mkdir(projectPath);
  await writeFile(
    join(projectPath, "package.json"),
    JSON.stringify({ name: "desktop-check", private: true, scripts: { serve: "node server.mjs" } }),
  );
  await writeFile(
    join(projectPath, "server.mjs"),
    `import { createServer } from "node:http";
createServer((request, response) => response.end("desktop ok")).listen(${servicePort}, "127.0.0.1");
`,
  );
  const serviceState = await page.evaluate(
    async ({ projectPath, servicePort }) => {
      const session = await (await fetch("/api/session")).json();
      const post = async (path, body) => {
        const response = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json", "x-devdock-csrf": session.csrfToken },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      };
      const project = await post("/api/projects", {
        path: projectPath,
        displayName: "Desktop check",
      });
      const projectId = project.body.id ?? project.body.project?.id;
      const service = await post(`/api/projects/${projectId}/services`, {
        scriptName: "serve",
        expectedPort: servicePort,
        readiness: { kind: "http", path: "/", timeoutMs: 15000 },
      });
      const serviceId = service.body.id ?? service.body.service?.id;
      const start = await post(`/api/services/${serviceId}/start`, {});
      let snapshot;
      for (let attempt = 0; attempt < 150; attempt += 1) {
        snapshot = (await (await fetch(`/api/services/${serviceId}/status`)).json()).snapshot;
        if (snapshot?.readinessState === "ready" || snapshot?.processState === "failed") break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
      }
      return { serviceId, startStatus: start.status, snapshot };
    },
    { projectPath, servicePort },
  );
  assert.equal(serviceState.startStatus, 202);
  assert.equal(
    serviceState.snapshot?.processState,
    "running",
    JSON.stringify(serviceState.snapshot),
  );
  assert.equal(serviceState.snapshot?.readinessState, "ready");
  const served = await (await fetch(`http://127.0.0.1:${servicePort}/`)).text();
  assert.equal(served, "desktop ok");
  check("a project service starts and becomes ready through the sidecar", `port ${servicePort}`);
  const stopStatus = await page.evaluate(async (serviceId) => {
    const session = await (await fetch("/api/session")).json();
    const response = await fetch(`/api/services/${serviceId}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-devdock-csrf": session.csrfToken },
      body: "{}",
    });
    return response.status;
  }, serviceState.serviceId);
  assert.equal(stopStatus, 200);
  const serviceClosed = await fetch(`http://127.0.0.1:${servicePort}/`, {
    signal: AbortSignal.timeout(1_000),
  }).then(
    () => false,
    () => true,
  );
  assert.equal(serviceClosed, true);
  check("stopping the service closes its whole process tree");

  // Session renewal: another client pairs with a fresh code, which replaces the window's session.
  const freshCode = await page.evaluate(() => window.__TAURI__.core.invoke("request_pairing_code"));
  const takeover = await fetch(`${origin}/api/pair`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ code: freshCode }),
  });
  assert.equal(takeover.status, 200);
  await page.reload();
  await page.getByRole("heading", { name: "Projects" }).waitFor({ timeout: 20_000 });
  assert.equal(await page.getByLabel("Pairing code").count(), 0);
  check("the window signs back in by itself after its session is replaced");

  execFileSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `(Get-Process -Id ${app.pid}).CloseMainWindow() | Out-Null`,
  ]);
  await delay(2_000);
  assert.equal(app.exitCode, null, "closing the window must not quit DevDock");
  assert.equal(processAlive(sidecars[0]), true);
  assert.equal(hasVisibleWindow(app.pid), false, "the window is still visible");
  check("closing the window keeps DevDock and its daemon running in the tray");

  const second = launch([]);
  assert.equal(await waitForExit(second, 20_000, "a second launch did not exit"), 0);
  const shownDeadline = Date.now() + 10_000;
  while (!hasVisibleWindow(app.pid) && Date.now() < shownDeadline) await delay(250);
  assert.equal(hasVisibleWindow(app.pid), true, "the second launch did not show the window");
  assert.deepEqual(
    sidecarPids().filter((pid) => !before.has(pid)),
    sidecars,
  );
  check("a second launch shows the existing window instead of starting another DevDock");

  const quit = launch(["--quit"]);
  assert.equal(await waitForExit(quit, 20_000, "the --quit launch did not exit"), 0);
  const quitCode = await waitForExit(app, 30_000, "--quit did not stop the running app");
  check("--quit stops the running app", `exit code ${quitCode}`);
  const goneDeadline = Date.now() + 15_000;
  while (processAlive(sidecars[0]) && Date.now() < goneDeadline) await delay(200);
  assert.equal(processAlive(sidecars[0]), false, "the daemon sidecar kept running");
  check("the daemon sidecar stops with the app");
  const refused = await fetch(origin, { signal: AbortSignal.timeout(1_000) }).then(
    () => false,
    () => true,
  );
  assert.equal(refused, true);
  check("the dashboard endpoint is closed");
  await browser.close().catch(() => {});
  browser = undefined;

  // The engine stops unexpectedly: the error window offers Try again, which restarts the app.
  const crashPort = debugPort + 2;
  const crashing = launch([], crashPort);
  browser = await connect(crashPort, crashing);
  const crashPage = await findPage(browser, (url) => url.startsWith("http://127.0.0.1:"));
  assert.ok(crashPage, "the restarted test app did not load the dashboard");
  await crashPage.getByRole("heading", { name: "Projects" }).waitFor({ timeout: 20_000 });
  const [crashSidecar] = sidecarPids().filter((pid) => !before.has(pid));
  assert.ok(crashSidecar, "no sidecar for the crash scenario");
  process.kill(crashSidecar);
  const crashError = await findPage(browser, (url) => url.includes("error.html"));
  assert.ok(crashError, "the error window did not open after the engine stopped");
  await crashError.locator("#message").waitFor();
  assert.match(await crashError.locator("#message").textContent(), /stopped unexpectedly/u);
  check("an engine that stops unexpectedly shows the error window");
  await crashError.locator("#retry").click();
  await waitForExit(crashing, 20_000, "Try again did not end the old app process");
  await browser.close().catch(() => {});
  browser = await connect(crashPort, { exitCode: null });
  const retriedPage = await findPage(browser, (url) => url.startsWith("http://127.0.0.1:"));
  assert.ok(retriedPage, "the restarted app did not load the dashboard");
  await retriedPage.getByRole("heading", { name: "Projects" }).waitFor({ timeout: 20_000 });
  const retriedSidecars = sidecarPids().filter((pid) => !before.has(pid));
  assert.equal(retriedSidecars.length, 1);
  check("Try again restarts DevDock with a new engine and signs in", `pid ${retriedSidecars[0]}`);
  await browser.close().catch(() => {});
  browser = undefined;
  const retriedQuit = launch(["--quit"]);
  assert.equal(await waitForExit(retriedQuit, 20_000, "--quit after retry did not exit"), 0);
  const retriedDeadline = Date.now() + 20_000;
  while (processAlive(retriedSidecars[0]) && Date.now() < retriedDeadline) await delay(200);
  assert.equal(
    processAlive(retriedSidecars[0]),
    false,
    "the restarted app kept its engine running",
  );

  // Another DevDock (here the CLI daemon) already holds the data directory.
  const cli = spawn(process.execPath, [daemonEntry], {
    env: { ...isolatedEnvironment, DEVDOCK_CONTROL: "stdin", DEVDOCK_PORT: "0" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  try {
    await new Promise((resolveReady, rejectReady) => {
      let output = "";
      cli.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("registry-api-ready")) resolveReady();
      });
      cli.once("exit", () => rejectReady(new Error("CLI daemon exited before it was ready")));
    });
    const errorPort = debugPort + 1;
    const blocked = launch([], errorPort);
    browser = await connect(errorPort, blocked);
    const errorPage = await findPage(browser, (url) => url.includes("error.html"));
    assert.ok(errorPage, "the error window did not open");
    await errorPage.locator("#message").waitFor();
    const message = await errorPage.locator("#message").textContent();
    assert.match(message, /already using this data directory/u);
    check("a locked data directory shows the error window", message);
    await errorPage.locator("#close").click();
    const blockedCode = await waitForExit(
      blocked,
      20_000,
      "Close on the error window did not exit",
    );
    check("Close on the error window exits the app", `exit code ${blockedCode}`);
  } finally {
    cli.stdin.end();
    await waitForExit(cli, 20_000, "the CLI daemon did not stop").catch(() => cli.kill());
  }
  console.log(JSON.stringify({ type: "desktop-shell-verified", checks: results.length }));
} finally {
  await browser?.close().catch(() => {});
  if (app.exitCode === null) app.kill();
  await rm(dataRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(
    () => {},
  );
}
