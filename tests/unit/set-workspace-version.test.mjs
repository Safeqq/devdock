import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function runScript(root, script, arguments_) {
  return spawnSync(process.execPath, [join(root, "scripts", script), ...arguments_], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
}

test("workspace version update previews safely and writes manifests, lockfile, and README together", async () => {
  const root = await mkdtemp(join(tmpdir(), "devdock version café-東京-"));
  try {
    await Promise.all([
      mkdir(join(root, "scripts")),
      mkdir(join(root, "apps", "daemon"), { recursive: true }),
      mkdir(join(root, "packages", "contracts"), { recursive: true }),
    ]);
    await Promise.all([
      copyFile(
        join(sourceRoot, "scripts", "check-workspace-versions.mjs"),
        join(root, "scripts", "check-workspace-versions.mjs"),
      ),
      copyFile(
        join(sourceRoot, "scripts", "set-workspace-version.mjs"),
        join(root, "scripts", "set-workspace-version.mjs"),
      ),
      writeFile(
        join(root, "package.json"),
        json({
          name: "devdock",
          version: "0.0.0",
          private: true,
          workspaces: ["apps/*", "packages/*"],
          dependencies: { "@devdock/daemon": "0.0.0" },
        }),
      ),
      writeFile(
        join(root, "apps", "daemon", "package.json"),
        json({
          name: "@devdock/daemon",
          version: "0.0.0",
          private: true,
          dependencies: { "@devdock/contracts": "0.0.0" },
        }),
      ),
      writeFile(
        join(root, "packages", "contracts", "package.json"),
        json({ name: "@devdock/contracts", version: "0.0.0", private: true }),
      ),
      writeFile(
        join(root, "package-lock.json"),
        json({
          name: "devdock",
          version: "0.0.0",
          lockfileVersion: 3,
          packages: {
            "": {
              name: "devdock",
              version: "0.0.0",
              dependencies: { "@devdock/daemon": "0.0.0" },
            },
            "apps/daemon": {
              name: "@devdock/daemon",
              version: "0.0.0",
              dependencies: { "@devdock/contracts": "0.0.0" },
            },
            "packages/contracts": { name: "@devdock/contracts", version: "0.0.0" },
          },
        }),
      ),
      writeFile(
        join(root, "README.md"),
        "Build artifacts/devdock-0.0.0.tgz and install artifacts/devdock-0.0.0.tgz.\n",
      ),
    ]);

    const invalid = runScript(root, "set-workspace-version.mjs", ["01.2.3"]);
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /Invalid release version/u);

    const preview = runScript(root, "set-workspace-version.mjs", ["1.2.3-rc.1"]);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /Version preview: 0\.0\.0 -> 1\.2\.3-rc\.1/u);
    assert.match(preview.stdout, /No files written/u);
    assert.equal(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version, "0.0.0");

    const write = runScript(root, "set-workspace-version.mjs", ["1.2.3-rc.1", "--write"]);
    assert.equal(write.status, 0, write.stderr);
    assert.match(write.stdout, /Workspace version updated/u);

    const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const daemonManifest = JSON.parse(
      await readFile(join(root, "apps", "daemon", "package.json"), "utf8"),
    );
    const contractsManifest = JSON.parse(
      await readFile(join(root, "packages", "contracts", "package.json"), "utf8"),
    );
    const lockfile = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
    const readme = await readFile(join(root, "README.md"), "utf8");

    assert.equal(rootManifest.version, "1.2.3-rc.1");
    assert.equal(rootManifest.dependencies["@devdock/daemon"], "1.2.3-rc.1");
    assert.equal(daemonManifest.version, "1.2.3-rc.1");
    assert.equal(daemonManifest.dependencies["@devdock/contracts"], "1.2.3-rc.1");
    assert.equal(contractsManifest.version, "1.2.3-rc.1");
    assert.equal(lockfile.version, "1.2.3-rc.1");
    assert.equal(lockfile.packages[""].version, "1.2.3-rc.1");
    assert.equal(lockfile.packages["apps/daemon"].version, "1.2.3-rc.1");
    assert.equal(lockfile.packages["packages/contracts"].version, "1.2.3-rc.1");
    assert.equal(lockfile.packages[""].dependencies["@devdock/daemon"], "1.2.3-rc.1");
    assert.equal(lockfile.packages["apps/daemon"].dependencies["@devdock/contracts"], "1.2.3-rc.1");
    assert.equal(readme.includes("devdock-0.0.0.tgz"), false);
    assert.equal(readme.match(/devdock-1\.2\.3-rc\.1\.tgz/gu)?.length, 2);

    const check = runScript(root, "check-workspace-versions.mjs", []);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /3 manifests and package-lock\.json use 1\.2\.3-rc\.1/u);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
