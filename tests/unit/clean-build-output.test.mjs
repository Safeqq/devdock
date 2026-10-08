import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cleanScript = fileURLToPath(new URL("../../scripts/clean-build-output.mjs", import.meta.url));

function runClean(cwd) {
  return spawnSync(process.execPath, [cleanScript], { cwd, encoding: "utf8", windowsHide: true });
}

test("clean build output removes stale compiled files from the workspace dist", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "devdock-clean-"));
  t.after(() => rm(workspace, { force: true, recursive: true }));
  await writeFile(join(workspace, "package.json"), "{}\n");
  await mkdir(join(workspace, "dist", "nested"), { recursive: true });
  await writeFile(join(workspace, "dist", "removed-source.js"), "export {};\n");
  await writeFile(join(workspace, "dist", "nested", "removed-source.d.ts"), "export {};\n");
  await writeFile(join(workspace, "kept.txt"), "kept\n");

  const result = runClean(workspace);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(workspace, "dist")), false);
  assert.equal(existsSync(join(workspace, "kept.txt")), true);
  assert.equal(runClean(workspace).status, 0, "a missing dist is not an error");
});

test("clean build output refuses a directory that is not a package", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "devdock-clean-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  await mkdir(join(directory, "dist"));
  await writeFile(join(directory, "dist", "unrelated.js"), "export {};\n");

  const result = runClean(directory);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /no package\.json/);
  assert.equal(existsSync(join(directory, "dist", "unrelated.js")), true);
});
