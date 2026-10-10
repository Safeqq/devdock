// Installs the Windows desktop installer silently into a temporary folder, runs the installed app
// the way a user would (no Node.js on PATH, no repository files), and uninstalls it while it is
// still running. Checks that the bundled runtime and engine are used, a real npm script runs and
// stops through the installed engine, the uninstaller stops the app and its scripts first, the
// program files are removed, and the user's data is kept. The per-user default install folder,
// %LOCALAPPDATA%DevDock, is also DevDock's data folder, so the check installs the same way under a
// temporary LOCALAPPDATA instead of touching the real one.
// Usage: node scripts/verify-desktop-installer.mjs [path-to-setup.exe]
// Without a path it checks the installer `npm run desktop:bundle` built for the current version.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

if (process.platform !== "win32") {
  console.error("The installer check runs on Windows only.");
  process.exit(2);
}
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
const installer = resolve(
  process.argv[2] ??
    join(
      repositoryRoot,
      "apps/desktop/src-tauri/target/release/bundle/nsis",
      `DevDock_${version}_x64-setup.exe`,
    ),
);
if (!existsSync(installer)) {
  console.error(`Installer not found: ${installer}
Run npm run desktop:bundle first.`);
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
  assert.fail(message);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
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

const workRoot = await mkdtemp(join(tmpdir(), "devdock installer check-"));
const dataRoot = join(workRoot, "Local App Data");
const installDirectory = join(dataRoot, "DevDock");
await mkdir(dataRoot);
const installerBytes = statSync(installer).size;
let app;
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
  for (const path of [
    appPath,
    join(installDirectory, "uninstall.exe"),
    bundledNode,
    join(installDirectory, "runtime", "node_modules", "npm", "bin", "npm-cli.js"),
    join(installDirectory, "runtime", "LICENSE"),
    join(installDirectory, "engine", "node_modules", "devdock", "bin", "devdock.mjs"),
  ]) {
    assert.ok(existsSync(path), `missing ${path}`);
  }
  check(
    "silent per-user install places the app, Node.js runtime, and engine",
    `${(installerBytes / 1024 / 1024).toFixed(1)} MiB installer, ${executables[0]}`,
  );

  // PATH without any Node.js, as on a computer that never installed it.
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const debugPort = 9400 + Math.floor(Math.random() * 400);
  app = spawn(appPath, [], {
    env: {
      SystemRoot: systemRoot,
      windir: systemRoot,
      ComSpec: join(systemRoot, "System32", "cmd.exe"),
      PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
      TEMP: process.env.TEMP ?? tmpdir(),
      TMP: process.env.TMP ?? tmpdir(),
      USERPROFILE: process.env.USERPROFILE ?? dataRoot,
      APPDATA: join(dataRoot, "Roaming"),
      LOCALAPPDATA: dataRoot,
      Path: [join(systemRoot, "System32"), systemRoot].join(delimiter),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
    },
    stdio: "ignore",
  });
  const started = Date.now();
  for (;;) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, {
        timeout: 2_000,
      });
      break;
    } catch {
      assert.equal(app.exitCode, null, "installed app exited before its window opened");
      assert.ok(Date.now() - started < 60_000, "WebView2 DevTools endpoint did not open");
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
  check("installed app opens its window and signs in", `${Date.now() - started} ms`);

  const sidecars = processesUnder(installDirectory).filter((entry) =>
    entry.path.toLowerCase().endsWith("\\runtime\\node.exe"),
  );
  assert.equal(sidecars.length, 1, JSON.stringify(sidecars));
  const system = await page.evaluate(async () => (await fetch("/api/system")).json());
  assert.equal(system.projectNode.source, "daemon");
  assert.equal(system.projectNode.version, `v${process.versions.node}`);
  check("the engine runs on the bundled Node.js, which projects use when PATH has none");

  const servicePort = await freePort();
  const projectPath = join(workRoot, "installed check project");
  await mkdir(projectPath);
  await writeFile(
    join(projectPath, "package.json"),
    JSON.stringify({ name: "installed-check", private: true, scripts: { dev: "node server.mjs" } }),
  );
  await writeFile(
    join(projectPath, "server.mjs"),
    `import { createServer } from "node:http";
createServer((request, response) => response.end("installed ok")).listen(${servicePort}, "127.0.0.1", () => {
  console.log("  Local: http://localhost:${servicePort}/");
});
`,
  );
  const run = await page.evaluate(
    async ({ projectPath }) => {
      const { csrfToken } = await (await fetch("/api/session")).json();
      const post = async (path, body) =>
        (
          await fetch(path, {
            method: "POST",
            headers: { "content-type": "application/json", "x-devdock-csrf": csrfToken },
            body: JSON.stringify(body),
          })
        ).json();
      const { project } = await post("/api/projects", { path: projectPath });
      const { service } = await post(`/api/projects/${project.id}/services`, {
        scriptName: "dev",
      });
      await post(`/api/services/${service.id}/start`, {});
      let status;
      for (let attempt = 0; attempt < 150; attempt += 1) {
        status = await (await fetch(`/api/services/${service.id}/status`)).json();
        if (status.appUrl || status.snapshot?.processState === "failed") break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
      }
      return status;
    },
    { projectPath },
  );
  assert.equal(run.snapshot?.processState, "running", JSON.stringify(run.snapshot));
  assert.equal(run.appUrl, `http://localhost:${servicePort}/`);
  assert.equal(await (await fetch(`http://127.0.0.1:${servicePort}/`)).text(), "installed ok");
  check("an npm script runs through the bundled npm and the installed engine");
  await browser.close();
  browser = undefined;

  // Uninstall while the app and its script are still running.
  execFileSync(join(installDirectory, "uninstall.exe"), ["/S"], { stdio: "ignore" });
  await waitFor(() => app.exitCode !== null, 60_000, "the uninstaller left DevDock running");
  assert.equal(app.exitCode, 0, "DevDock did not quit cleanly during uninstall");
  await waitFor(
    () =>
      fetch(`http://127.0.0.1:${servicePort}/`, { signal: AbortSignal.timeout(500) }).then(
        () => false,
        () => true,
      ),
    15_000,
    "the running script outlived the uninstall",
  );
  check("uninstalling quits the running app, which stops its scripts first");

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
    checks: results.length,
    installerBytes,
  }),
);
