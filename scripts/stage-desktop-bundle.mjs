// Prepares the files the Windows installer carries next to the desktop shell:
//   runtime/  the official Node.js distribution (node.exe, npm, and its LICENSE), pinned by version
//             and SHA-256 in apps/desktop/runtime.json and to the toolchain in .node-version
//   engine/   the verified DevDock CLI package (artifacts/devdock-<version>.tgz from
//             `npm run package:local`), installed offline with its bundled dependencies
// The shell runs runtime/node.exe with engine/node_modules/devdock/bin/devdock.mjs. When a project
// finds no Node.js on PATH, the daemon falls back to this runtime and its npm.
// Usage (Windows): node scripts/stage-desktop-bundle.mjs
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const stage = join(root, "apps", "desktop", "src-tauri", "bundle-input");
const cacheDirectory = join(root, ".tools");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    fail(`${executable} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

if (process.platform !== "win32") fail("The desktop bundle is built on Windows only for now.");

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const runtime = JSON.parse(await readFile(join(root, "apps", "desktop", "runtime.json"), "utf8"));
const pinnedNode = (await readFile(join(root, ".node-version"), "utf8")).trim();
if (runtime.node.version !== pinnedNode) {
  fail(
    `apps/desktop/runtime.json bundles Node ${runtime.node.version}, but .node-version pins ${pinnedNode}`,
  );
}

const tarball = join(root, "artifacts", `devdock-${manifest.version}.tgz`);
if (!existsSync(tarball)) fail(`Missing ${tarball}; run npm run package:local first.`);

// The runtime archive comes from the cache when its hash matches, otherwise from nodejs.org.
await mkdir(cacheDirectory, { recursive: true });
const archivePath = join(cacheDirectory, runtime.node.archive);
let archive = existsSync(archivePath) ? await readFile(archivePath) : null;
if (archive === null || sha256(archive) !== runtime.node.sha256) {
  const response = await fetch(runtime.node.url);
  if (!response.ok) fail(`Downloading ${runtime.node.url} failed with HTTP ${response.status}`);
  archive = Buffer.from(await response.arrayBuffer());
  if (sha256(archive) !== runtime.node.sha256) {
    fail(`${runtime.node.archive} does not match the SHA-256 pinned in apps/desktop/runtime.json`);
  }
  await writeFile(archivePath, archive);
}

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });

// Windows' bundled tar (bsdtar) reads zip archives.
const extracted = await mkdtemp(join(stage, "extract-"));
run(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), [
  "-xf",
  archivePath,
  "-C",
  extracted,
]);
const [distribution] = await readdir(extracted);
if (distribution === undefined) fail("The Node.js archive was empty");
await rename(join(extracted, distribution), join(stage, "runtime"));
await rm(extracted, { recursive: true, force: true });

// The tarball bundles all of its production dependencies, so this install reads no registry.
const engine = join(stage, "engine");
await mkdir(engine);
run(process.execPath, [
  process.env.npm_execpath ?? join(stage, "runtime", "node_modules", "npm", "bin", "npm-cli.js"),
  "install",
  "--prefix",
  engine,
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--no-save",
  "--omit=dev",
  "--offline",
  tarball,
]);
const entry = join(engine, "node_modules", "devdock", "bin", "devdock.mjs");
if (!existsSync(entry)) fail(`The engine entry point is missing: ${entry}`);
for (const leftover of ["package.json", "package-lock.json"]) {
  await rm(join(engine, leftover), { force: true });
}

const nodeVersion = run(join(stage, "runtime", "node.exe"), ["--version"]).trim();
if (nodeVersion !== `v${pinnedNode}`) fail(`Bundled node.exe reports ${nodeVersion}`);

console.log(
  JSON.stringify({
    type: "desktop-bundle-staged",
    stage: "apps/desktop/src-tauri/bundle-input",
    node: nodeVersion,
    nodeArchiveSha256: runtime.node.sha256,
    engineTarball: `artifacts/devdock-${manifest.version}.tgz`,
    engineTarballSha256: sha256(await readFile(tarball)),
  }),
);
