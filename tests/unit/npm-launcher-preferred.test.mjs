import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { NpmLauncher } from "../../packages/platform/dist/index.js";

const nodeName = process.platform === "win32" ? "node.exe" : "node";
const pathKey = process.platform === "win32" ? "Path" : "PATH";

async function fakeNode(directory, { withNpm }) {
  await mkdir(directory, { recursive: true });
  const executable = join(directory, nodeName);
  await writeFile(executable, "");
  await chmod(executable, 0o755);
  if (withNpm) {
    const npmBin = join(directory, "node_modules", "npm", "bin");
    await mkdir(npmBin, { recursive: true });
    await writeFile(join(npmBin, "npm-cli.js"), "");
  }
  return executable;
}

test("preferred launcher uses the first PATH Node.js that has npm beside it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devdock-node-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A shim without npm comes first and must be skipped, like a version-manager stub.
  await fakeNode(join(root, "shim"), { withNpm: false });
  const installed = await fakeNode(join(root, "installed node"), { withNpm: true });
  await fakeNode(join(root, "later"), { withNpm: true });
  const pathValue = [
    "relative-dir",
    "",
    join(root, "missing"),
    join(root, "shim"),
    `"${join(root, "installed node")}"`,
    join(root, "later"),
  ].join(delimiter);

  const launcher = await NpmLauncher.locatePreferred({ [pathKey]: pathValue });

  assert.equal(launcher.nodeSource, "path");
  assert.equal(launcher.nodeExecutable, await realpath(installed));
  const plan = launcher.plan("dev", root, { [pathKey]: pathValue });
  assert.equal(plan.executable, await realpath(installed));
});

test("preferred launcher falls back to the daemon Node.js when PATH has none", async () => {
  const launcher = await NpmLauncher.locatePreferred({ [pathKey]: "" });

  assert.equal(launcher.nodeSource, "daemon");
  assert.equal(launcher.nodeExecutable, await realpath(process.execPath));
});

test("explicit launcher location reports the daemon source", async () => {
  const launcher = await NpmLauncher.locate();

  assert.equal(launcher.nodeSource, "daemon");
});
