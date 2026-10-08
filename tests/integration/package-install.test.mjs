import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { NpmLauncher } from "../../packages/platform/dist/index.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

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

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("Process did not exit before timeout"));
    }, timeoutMs);
    function onExit(code, signal) {
      clearTimeout(timer);
      resolve({ code, signal });
    }
    child.once("exit", onExit);
  });
}

function runNode(
  args,
  options,
  timeoutMs = 120_000,
  expectedCode = 0,
  outputLimitBytes = 64 * 1_024,
) {
  // Name the script and its first argument without the temporary paths that follow.
  const command = [basename(args[0]), ...args.slice(1, 2)].join(" ");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      ...options,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs} ms: ${stderr.slice(-4_096)}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-outputLimitBytes);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-outputLimitBytes);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === expectedCode) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-4_096)}`));
    });
  });
}

function waitForReady(child, lines, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error("Installed DevDock did not become ready before timeout")),
      timeoutMs,
    );
    function finish(error, event) {
      clearTimeout(timer);
      lines.off("line", onLine);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(event);
    }
    function onLine(line) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (
        event.type === "registry-api-ready" &&
        typeof event.origin === "string" &&
        typeof event.pairingCode === "string"
      ) {
        finish(null, event);
      }
    }
    function onError(error) {
      finish(error);
    }
    function onExit(code, signal) {
      finish(new Error(`Installed DevDock exited before ready (code ${code}, signal ${signal})`));
    }
    lines.on("line", onLine);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

test("packed CLI runs from a clean local install and closes through the native OS path", {
  timeout: 300_000,
}, async (t) => {
  const step = stepTimer(t);
  const packageMetadata = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(packageMetadata.name, "devdock");
  assert.equal(typeof packageMetadata.version, "string");
  assert.notEqual(packageMetadata.version.length, 0);
  const expectedVersion = packageMetadata.version;
  const tempRoot = await mkdtemp(join(tmpdir(), "devdock package café-東京-"));
  const packageDirectory = join(tempRoot, "tarball output");
  const installDirectory = join(tempRoot, "clean install");
  const userDataRoot = join(tempRoot, "user data");
  let child;
  let lines;
  try {
    await Promise.all([mkdir(packageDirectory), mkdir(installDirectory), mkdir(userDataRoot)]);
    await writeFile(
      join(installDirectory, "package.json"),
      `${JSON.stringify(
        {
          name: "devdock-package-smoke",
          private: true,
          scripts: { "devdock:version": "devdock --version" },
        },
        null,
        2,
      )}\n`,
    );
    const launcher = await NpmLauncher.locate();
    const npmCli = launcher.plan("package:test", repositoryRoot).args[0];
    const packResult = await runNode(
      [
        npmCli,
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        packageDirectory,
        repositoryRoot,
      ],
      { cwd: repositoryRoot },
      120_000,
      0,
      512 * 1_024,
    );
    step("npm pack");
    const packReports = JSON.parse(packResult.stdout);
    assert.equal(Array.isArray(packReports), true);
    assert.equal(packReports.length, 1);
    const [packReport] = packReports;
    assert.equal(packReport.name, "devdock");
    assert.equal(packReport.version, expectedVersion);
    assert.equal(packReport.filename, `devdock-${expectedVersion}.tgz`);
    assert.equal(Array.isArray(packReport.files), true);
    assert.equal(packReport.entryCount, packReport.files.length);
    const packedPaths = packReport.files.map((file) => file.path);
    for (const requiredPath of ["CHANGELOG.md", "README.md", "bin/devdock.mjs", "package.json"]) {
      assert.equal(packedPaths.includes(requiredPath), true, `Package is missing ${requiredPath}`);
    }
    const forbiddenRootPath =
      /^(?:AGENT\.md|package-lock\.json|tsconfig\.json|biome\.json|\.env(?:\.|$)|\.(?:github|tools)\/|(?:apps|artifacts|docs|packages|scripts|tests)\/)/;
    assert.deepEqual(
      packedPaths.filter((path) => forbiddenRootPath.test(path)),
      [],
    );
    assert.equal(
      packedPaths.some((path) => /^node_modules\/@devdock\/[^/]+\/(?:src|tests)\//.test(path)),
      false,
    );
    for (const bundledWorkspace of [
      "@devdock/contracts",
      "@devdock/daemon",
      "@devdock/platform",
      "@devdock/storage",
      "@devdock/web",
    ]) {
      assert.equal(packReport.bundled.includes(bundledWorkspace), true);
    }

    const tarball = join(packageDirectory, packReport.filename);
    await access(tarball);
    await runNode(
      [
        npmCli,
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefix",
        installDirectory,
        tarball,
      ],
      { cwd: installDirectory },
    );
    step("npm install");

    const entry = join(installDirectory, "node_modules", "devdock", "bin", "devdock.mjs");
    await access(entry);
    const binDirectory = join(installDirectory, "node_modules", ".bin");
    const installedCommand = join(
      binDirectory,
      process.platform === "win32" ? "devdock.cmd" : "devdock",
    );
    if (process.platform === "win32") {
      await Promise.all([
        access(installedCommand),
        access(join(binDirectory, "devdock")),
        access(join(binDirectory, "devdock.ps1")),
      ]);
    } else {
      await access(installedCommand, fsConstants.X_OK);
    }
    const isolatedEnvironment = {
      ...process.env,
      HOME: userDataRoot,
      LOCALAPPDATA: userDataRoot,
      XDG_DATA_HOME: userDataRoot,
    };
    const databasePath =
      process.platform === "win32"
        ? join(userDataRoot, "DevDock", "registry.sqlite")
        : process.platform === "darwin"
          ? join(userDataRoot, "Library", "Application Support", "DevDock", "registry.sqlite")
          : join(userDataRoot, "devdock", "registry.sqlite");
    const versionResult = await runNode([npmCli, "run", "--silent", "devdock:version"], {
      cwd: installDirectory,
      env: isolatedEnvironment,
    });
    assert.equal(versionResult.stdout.trim(), expectedVersion);
    const helpResult = await runNode([entry, "--help"], {
      cwd: installDirectory,
      env: isolatedEnvironment,
    });
    assert.match(helpResult.stdout, /^Usage: devdock \[options\]/);
    const invalidResult = await runNode(
      [entry, "--unknown"],
      { cwd: installDirectory, env: isolatedEnvironment },
      120_000,
      2,
    );
    assert.equal(invalidResult.stdout, "");
    assert.match(invalidResult.stderr, /^Unknown option: --unknown/);
    await assert.rejects(access(databasePath), { code: "ENOENT" });
    step("version, help, and invalid option");

    // POSIX exercises npm's executable bit and shebang. Windows launches the entry directly so
    // the IPC shutdown message reaches DevDock instead of the intermediate cmd.exe process.
    const launchExecutable = process.platform === "win32" ? process.execPath : installedCommand;
    const launchArguments = process.platform === "win32" ? [entry] : [];
    child = spawn(launchExecutable, launchArguments, {
      cwd: installDirectory,
      env: {
        ...isolatedEnvironment,
        DEVDOCK_PORT: "0",
      },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    lines = createInterface({ input: child.stdout });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4_096);
    });
    const ready = await waitForReady(child, lines, 10_000);
    step("daemon ready");
    const page = await fetch(ready.origin, { signal: AbortSignal.timeout(3_000) });
    assert.equal(page.status, 200);
    assert.equal((await page.text()).includes(ready.pairingCode), false);
    const paired = await fetch(`${ready.origin}/api/pair`, {
      method: "POST",
      headers: { origin: ready.origin, "content-type": "application/json" },
      body: JSON.stringify({ code: ready.pairingCode }),
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(paired.status, 200);
    step("pair");

    if (process.platform === "win32") {
      await new Promise((resolve, reject) => {
        child.send({ type: "shutdown" }, (error) => (error ? reject(error) : resolve()));
      });
    } else {
      child.kill("SIGTERM");
    }
    const result = await waitForExit(child, 10_000);
    assert.equal(result.code, 0, stderr);
    await access(databasePath);
    step("shutdown");
  } finally {
    if (child !== undefined && !hasExited(child)) {
      child.kill("SIGKILL");
      await waitForExit(child, 3_000).catch(() => undefined);
    }
    lines?.close();
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
