import { spawn, spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function cleanupRoot(path) {
  const root = resolve(path);
  if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("devdock-clean-setup-")) {
    throw new Error("Clean-setup temporary root failed its safety check");
  }
  return root;
}

function repositoryFiles() {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repositoryRoot, encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(`Could not enumerate repository files: ${result.stderr.trim()}`);
  }
  return result.stdout.split("\0").filter(Boolean);
}

async function copyRepository(destination) {
  const files = repositoryFiles();
  for (const repositoryPath of files) {
    if (isAbsolute(repositoryPath) || repositoryPath.split(/[\\/]/u).includes("..")) {
      throw new Error(`Repository file path is unsafe: ${repositoryPath}`);
    }
    const source = resolve(repositoryRoot, repositoryPath);
    if (relative(repositoryRoot, source).startsWith("..")) {
      throw new Error(`Repository file escaped its root: ${repositoryPath}`);
    }
    const metadata = await lstat(source);
    if (!metadata.isFile()) {
      throw new Error(`Clean setup only supports repository files: ${repositoryPath}`);
    }
    const target = join(destination, ...repositoryPath.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  return files.length;
}

async function terminateOwnedCommand(child) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await new Promise((resolveTermination) => {
      const termination = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      termination.once("exit", resolveTermination);
      termination.once("error", resolveTermination);
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (caught) {
    if (caught?.code !== "ESRCH") throw caught;
  }
}

async function runNpm(npmCli, cwd, args, timeoutMs) {
  const startedAt = performance.now();
  const child = spawn(process.execPath, [npmCli, ...args], {
    cwd,
    env: process.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void terminateOwnedCommand(child);
  }, timeoutMs);
  try {
    const result = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    if (timedOut) throw new Error(`npm ${args.join(" ")} exceeded ${timeoutMs} ms`);
    if (result.code !== 0) {
      throw new Error(
        `npm ${args.join(" ")} exited with code ${String(result.code)} and signal ${String(result.signal)}`,
      );
    }
    return performance.now() - startedAt;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined || !isAbsolute(npmCli)) {
    throw new Error("Run clean setup through npm so npm_execpath is available");
  }
  const tempRoot = cleanupRoot(await mkdtemp(join(tmpdir(), "devdock-clean-setup-")));
  const checkout = join(tempRoot, "fresh checkout café spaces");
  try {
    await mkdir(checkout);
    const fileCount = await copyRepository(checkout);
    const installMs = await runNpm(npmCli, checkout, ["ci", "--no-audit", "--no-fund"], 300_000);
    const toolchainMs = await runNpm(npmCli, checkout, ["run", "check:toolchain"], 30_000);
    const versionsMs = await runNpm(npmCli, checkout, ["run", "check:versions"], 30_000);
    const buildMs = await runNpm(npmCli, checkout, ["run", "build"], 180_000);
    process.stdout.write(
      `${JSON.stringify({
        type: "clean-setup-complete",
        fileCount,
        node: process.version,
        installMs: Number(installMs.toFixed(2)),
        toolchainMs: Number(toolchainMs.toFixed(2)),
        versionsMs: Number(versionsMs.toFixed(2)),
        buildMs: Number(buildMs.toFixed(2)),
      })}\n`,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((caught) => {
  process.stderr.write(`${caught instanceof Error ? caught.stack : "Clean setup failed"}\n`);
  process.exitCode = 1;
});
