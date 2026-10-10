// Installs the Windows desktop installer silently, runs what it installed the way a user would (no
// Node.js on PATH, no repository files), and uninstalls it. Checks that the bundled runtime and
// engine are used, a real npm script runs through the installed engine, the program files are
// removed, and the user's data is kept. The per-user default install folder,
// %LOCALAPPDATA%\DevDock, is also DevDock's data folder, so the check installs the same way under a
// temporary LOCALAPPDATA instead of touching the real one.
//
// Modes (CI runs the last two, because the WebView2 DevTools port this check drives the page
// through does not open on the GitHub windows-2025 runner, although the app itself starts there):
//   default        opens the installed app's window, drives it over the DevTools protocol, runs a
//                  script, and uninstalls while the app and its script run (the quit hook)
//   --engine-only  starts the installed engine on the bundled Node.js with the same command line
//                  the app uses, runs a script, checks --quit, and uninstalls
//   --shell-only   starts the installed app, waits for its startup trace to report the main
//                  window and its engine, then uninstalls while it runs
// Usage: node scripts/verify-desktop-installer.mjs [--engine-only | --shell-only] [path-to-setup.exe]
// Without a path it checks the installer `npm run desktop:bundle` built for the current version.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

if (process.platform !== "win32") {
  console.error("The installer check runs on Windows only.");
  process.exit(2);
}
const arguments_ = process.argv.slice(2);
const engineOnly = arguments_.includes("--engine-only");
const shellOnly = arguments_.includes("--shell-only");
const installerArgument = arguments_.find((argument) => !argument.startsWith("--"));
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
const installer = resolve(
  installerArgument ??
    join(
      repositoryRoot,
      "apps/desktop/src-tauri/target/release/bundle/nsis",
      `DevDock_${version}_x64-setup.exe`,
    ),
);
if (!existsSync(installer)) {
  console.error(`Installer not found: ${installer}\nRun npm run desktop:bundle first.`);
  process.exit(2);
}

const results = [];
const check = (name, detail = "") => {
  results.push({ name, detail });
  console.log(`ok - ${name}${detail ? ` (${detail})` : ""}`);
};

function powershell(script) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  }).trim();
}

// Processes whose executable lives in the install folder, so the check never touches unrelated
// Node.js or DevDock processes.
function processesUnder(folder) {
  const prefix = `${folder.replaceAll("'", "''")}\\*`;
  const output = powershell(
    `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${prefix}' } | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }`,
  );
  return output === ""
    ? []
    : output.split(/\r?\n/u).map((line) => {
        const [pid, path] = line.split("|");
        return { pid: Number(pid), path };
      });
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(250);
  }
  assert.fail(typeof message === "function" ? message() : message);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function portClosed(port) {
  return fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }).then(
    () => false,
    () => true,
  );
}

// A running DevDock would receive this launch through the single-instance lock.
assert.equal(
  powershell(
    "@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -in @('DevDock', 'devdock-desktop') }).Count",
  ),
  "0",
  "Quit any running DevDock before checking the installer",
);
// The check must never install over a real DevDock or into the user's real data folder.
const realDefault = join(
  process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Local"),
  "DevDock",
  "uninstall.exe",
);
assert.equal(existsSync(realDefault), false, `DevDock is installed for this user: ${realDefault}`);

// The long form of the temporary folder: a runner's TEMP can use 8.3 short names (RUNNER~1),
// which would not match the long paths Windows reports for the processes started from it.
const workRoot = realpathSync.native(await mkdtemp(join(tmpdir(), "devdock installer check-")));
const dataRoot = join(workRoot, "Local App Data");
const installDirectory = join(dataRoot, "DevDock");
await mkdir(dataRoot);
const installerBytes = statSync(installer).size;

// The user's environment with a temporary profile folder and a PATH without any folder that holds
// a Node.js executable, as on a computer that never installed Node.js.
const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
const pathValue = Object.entries(process.env).find(([key]) => key.toLowerCase() === "path")?.[1];
const userEnvironment = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(path|localappdata|appdata|npm_.*|node_.*)$/iu.test(key),
    ),
  ),
  APPDATA: join(dataRoot, "Roaming"),
  LOCALAPPDATA: dataRoot,
  Path: (pathValue ?? join(systemRoot, "System32"))
    .split(delimiter)
    .filter((entry) => entry !== "" && !existsSync(join(entry, "node.exe")))
    .join(delimiter),
};

let app;
let engine;
let browser;
try {
  // NSIS reads /D only as the last argument and unquoted, even with spaces. Node quotes
  // arguments that contain spaces, so PowerShell's Start-Process passes them as written.
  powershell(
    `Start-Process -FilePath '${installer.replaceAll("'", "''")}' -ArgumentList '/S', '/D=${installDirectory.replaceAll("'", "''")}' -Wait`,
  );
  if (existsSync(realDefault)) {
    assert.fail(`The installer ignored /D and installed into ${realDefault}; uninstall it there.`);
  }
  const executables = readdirSync(installDirectory).filter(
    (name) => name.toLowerCase().endsWith(".exe") && !/^uninstall/iu.test(name),
  );
  assert.equal(executables.length, 1, `install folder has ${executables.join(", ")}`);
  const appPath = join(installDirectory, executables[0]);
  const bundledNode = join(installDirectory, "runtime", "node.exe");
  const engineEntry = join(
    installDirectory,
    "engine",
    "node_modules",
    "devdock",
    "bin",
    "devdock.mjs",
  );
  for (const path of [
    appPath,
    join(installDirectory, "uninstall.exe"),
    bundledNode,
    join(installDirectory, "runtime", "node_modules", "npm", "bin", "npm-cli.js"),
    join(installDirectory, "runtime", "LICENSE"),
    join(installDirectory, "LICENSE.txt"),
    join(installDirectory, "THIRD-PARTY-NOTICES.txt"),
    engineEntry,
  ]) {
    assert.ok(existsSync(path), `missing ${path}`);
  }
  check(
    "silent per-user install places the app, Node.js runtime, and engine",
    `${(installerBytes / 1024 / 1024).toFixed(1)} MiB installer, ${executables[0]}`,
  );

  if (shellOnly) {
    const shellLog = join(workRoot, "shell.log");
    app = spawn(appPath, [], {
      env: { ...userEnvironment, DEVDOCK_SHELL_LOG: shellLog },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const trace = () => (existsSync(shellLog) ? readFileSync(shellLog, "utf8") : "");
    await waitFor(
      () => trace().includes("main window created"),
      60_000,
      () => `the installed app did not create its window: ${trace()}`,
    );
    assert.ok(trace().includes("engine ready at http://127.0.0.1:"), trace());
    assert.equal(powershell(`(Get-Process -Id ${app.pid}).MainWindowTitle`), "DevDock");
    const engines = processesUnder(installDirectory).filter((entry) =>
      entry.path.toLowerCase().endsWith("\\runtime\\node.exe"),
    );
    assert.equal(engines.length, 1, JSON.stringify(engines));
    check(
      "installed app starts its engine and shows its window",
      trace().trim().split(/\r?\n/u).at(-1),
    );

    execFileSync(join(installDirectory, "uninstall.exe"), ["/S"], { stdio: "ignore" });
    await waitFor(() => app.exitCode !== null, 60_000, "the uninstaller left DevDock running");
    assert.equal(app.exitCode, 0, "DevDock did not quit cleanly during uninstall");
    await waitFor(
      () => processesUnder(installDirectory).length === 0,
      30_000,
      "the engine outlived the uninstall",
    );
    check("uninstalling quits the running app and its engine");
  } else {
    // `get` and `post` reach the engine's API with a signed-in session, through the app's window or
    // directly.
    let client;
    if (engineOnly) {
      // The same command line the app's shell runs (see Launch in sidecar.rs).
      engine = spawn(bundledNode, [engineEntry], {
        env: { ...userEnvironment, DEVDOCK_CONTROL: "stdin", DEVDOCK_PORT: "0" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let engineStderr = "";
      engine.stderr.on("data", (chunk) => {
        engineStderr = (engineStderr + chunk).slice(-8_000);
      });
      let ready;
      createInterface({ input: engine.stdout }).on("line", (line) => {
        try {
          const event = JSON.parse(line);
          if (event.type === "registry-api-ready") ready = event;
        } catch {
          // Not an event line.
        }
      });
      await waitFor(
        () => ready !== undefined,
        60_000,
        () => `the installed engine did not start: ${engineStderr}`,
      );
      const { origin } = ready;
      const paired = await fetch(`${origin}/api/pair`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ code: ready.pairingCode }),
      });
      assert.equal(paired.status, 200);
      const cookie = paired.headers.get("set-cookie").split(";")[0];
      const { csrfToken } = await paired.json();
      client = {
        get: async (path) => (await fetch(`${origin}${path}`, { headers: { cookie } })).json(),
        post: async (path, body) =>
          (
            await fetch(`${origin}${path}`, {
              method: "POST",
              headers: {
                origin,
                cookie,
                "x-devdock-csrf": csrfToken,
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            })
          ).json(),
      };
      check("the installed engine starts on the bundled Node.js and pairs");
    } else {
      const debugPort = 9400 + Math.floor(Math.random() * 400);
      const shellLog = join(workRoot, "shell.log");
      app = spawn(appPath, [], {
        env: {
          ...userEnvironment,
          DEVDOCK_SHELL_LOG: shellLog,
          WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let appStderr = "";
      app.stderr.on("data", (chunk) => {
        appStderr = (appStderr + chunk).slice(-8_000);
      });
      // What a stuck app shows: its startup trace, its top-level windows (a modal error dialog would
      // appear here), and the processes running from the install folder.
      const diagnostics = () =>
        JSON.stringify(
          {
            exitCode: app.exitCode,
            stderr: appStderr,
            shellLog: existsSync(shellLog) ? readFileSync(shellLog, "utf8") : null,
            windows: powershell(
              `Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.Id -eq ${app.pid} -or $_.ProcessName -like 'msedgewebview2*') } | ForEach-Object { "$($_.ProcessName) $($_.Id): $($_.MainWindowTitle)" }`,
            ),
            processes: processesUnder(installDirectory),
          },
          null,
          2,
        );
      const started = Date.now();
      for (;;) {
        try {
          browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, {
            timeout: 2_000,
          });
          break;
        } catch {
          assert.equal(app.exitCode, null, `installed app exited early: ${diagnostics()}`);
          assert.ok(
            Date.now() - started < 90_000,
            `WebView2 DevTools endpoint did not open: ${diagnostics()}`,
          );
          await delay(500);
        }
      }
      let page;
      await waitFor(
        () => {
          page = browser
            .contexts()
            .flatMap((context) => context.pages())
            .find((candidate) => candidate.url().startsWith("http://127.0.0.1:"));
          return page !== undefined;
        },
        20_000,
        "the installed app did not load its dashboard",
      );
      await page.getByRole("heading", { name: "Welcome to DevDock" }).waitFor({ timeout: 30_000 });
      client = {
        get: (path) => page.evaluate(async (path) => (await fetch(path)).json(), path),
        post: (path, body) =>
          page.evaluate(
            async ([path, body]) => {
              const { csrfToken } = await (await fetch("/api/session")).json();
              const response = await fetch(path, {
                method: "POST",
                headers: { "content-type": "application/json", "x-devdock-csrf": csrfToken },
                body: JSON.stringify(body),
              });
              return response.json();
            },
            [path, body],
          ),
      };
      check("installed app opens its window and signs in", `${Date.now() - started} ms`);
    }

    const engines = processesUnder(installDirectory).filter((entry) =>
      entry.path.toLowerCase().endsWith("\\runtime\\node.exe"),
    );
    assert.equal(engines.length, 1, JSON.stringify(engines));
    const system = await client.get("/api/system");
    assert.equal(system.projectNode.source, "daemon");
    assert.equal(system.projectNode.version, `v${process.versions.node}`);
    check("projects use the bundled Node.js when PATH has none");

    const servicePort = await freePort();
    const projectPath = join(workRoot, "installed check project");
    await mkdir(projectPath);
    await writeFile(
      join(projectPath, "package.json"),
      JSON.stringify({
        name: "installed-check",
        private: true,
        scripts: { dev: "node server.mjs" },
      }),
    );
    await writeFile(
      join(projectPath, "server.mjs"),
      `import { createServer } from "node:http";
createServer((request, response) => response.end("installed ok")).listen(${servicePort}, "127.0.0.1", () => {
  console.log("  Local: http://localhost:${servicePort}/");
});
`,
    );
    const { project } = await client.post("/api/projects", { path: projectPath });
    const { service } = await client.post(`/api/projects/${project.id}/services`, {
      scriptName: "dev",
    });
    await client.post(`/api/services/${service.id}/start`, {});
    let status;
    await waitFor(
      async () => {
        status = await client.get(`/api/services/${service.id}/status`);
        return status.appUrl != null || status.snapshot?.processState === "failed";
      },
      30_000,
      () => `the script did not start: ${JSON.stringify(status)}`,
    );
    assert.equal(status.snapshot?.processState, "running", JSON.stringify(status.snapshot));
    assert.equal(status.appUrl, `http://localhost:${servicePort}/`);
    assert.equal(await (await fetch(`http://127.0.0.1:${servicePort}/`)).text(), "installed ok");
    check("an npm script runs through the bundled npm and the installed engine");

    if (engineOnly) {
      // Closing the control pipe is how the app's shell stops the engine.
      engine.stdin.end();
      await waitFor(() => engine.exitCode !== null, 30_000, "the engine did not stop");
      assert.equal(engine.exitCode, 0);
      await waitFor(() => portClosed(servicePort), 15_000, "the script outlived the engine");
      check("closing the engine's control pipe stops it and its scripts");

      // With no DevDock running, --quit (which the uninstaller sends first) exits at once.
      const quit = spawn(appPath, ["--quit"], { env: userEnvironment, stdio: "ignore" });
      await waitFor(() => quit.exitCode !== null, 30_000, "devdock-desktop --quit did not exit");
      assert.equal(quit.exitCode, 0);
      check("the installed app handles --quit");
      execFileSync(join(installDirectory, "uninstall.exe"), ["/S"], { stdio: "ignore" });
    } else {
      await browser.close();
      browser = undefined;
      // Uninstall while the app and its script are still running.
      execFileSync(join(installDirectory, "uninstall.exe"), ["/S"], { stdio: "ignore" });
      await waitFor(() => app.exitCode !== null, 60_000, "the uninstaller left DevDock running");
      assert.equal(app.exitCode, 0, "DevDock did not quit cleanly during uninstall");
      await waitFor(() => portClosed(servicePort), 15_000, "the script outlived the uninstall");
      check("uninstalling quits the running app, which stops its scripts first");
    }
  }

  await waitFor(
    () => !existsSync(appPath) && !existsSync(join(installDirectory, "engine")),
    60_000,
    "the uninstaller left program files behind",
  );
  assert.deepEqual(processesUnder(installDirectory), []);
  assert.ok(existsSync(join(installDirectory, "registry.sqlite")), "user data was removed");
  check("program files are removed and the user's DevDock data is kept");
} finally {
  await browser?.close().catch(() => {});
  if (app !== undefined && app.exitCode === null) app.kill();
  if (engine !== undefined && engine.exitCode === null) engine.kill();
  for (const entry of processesUnder(installDirectory)) {
    try {
      process.kill(entry.pid);
    } catch {
      // Already gone.
    }
  }
  await rm(workRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

console.log(
  JSON.stringify({
    type: "desktop-installer-verified",
    mode: engineOnly ? "engine-only" : shellOnly ? "shell-only" : "window",
    checks: results.length,
    installerBytes,
  }),
);
