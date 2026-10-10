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

test("release version update previews safely and writes metadata, changelog, and README together", async () => {
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
      copyFile(
        join(sourceRoot, "scripts", "desktop-version-files.mjs"),
        join(root, "scripts", "desktop-version-files.mjs"),
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
        "Build artifacts/devdock-0.0.0.tgz, inspect artifacts/devdock-0.0.0.cdx.json, and verify artifacts/devdock-0.0.0.licenses.json.\n",
      ),
      writeFile(
        join(root, "CHANGELOG.md"),
        "# Changelog\n\n## Unreleased\n\n### Added\n\n- Tested release preparation.\n",
      ),
    ]);

    const invalid = runScript(root, "set-workspace-version.mjs", ["01.2.3"]);
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /Invalid release version/u);

    const invalidDate = runScript(root, "set-workspace-version.mjs", [
      "1.2.3-rc.1",
      "--date",
      "2030-02-30",
    ]);
    assert.equal(invalidDate.status, 2);
    assert.match(invalidDate.stderr, /Invalid release date/u);

    const preview = runScript(root, "set-workspace-version.mjs", [
      "1.2.3-rc.1",
      "--date",
      "2030-02-03",
    ]);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /Release preview: 0\.0\.0 -> 1\.2\.3-rc\.1 \(2030-02-03\)/u);
    assert.match(preview.stdout, /No files written/u);
    assert.equal(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version, "0.0.0");
    assert.equal(
      (await readFile(join(root, "CHANGELOG.md"), "utf8")).includes("## 1.2.3-rc.1"),
      false,
    );

    const write = runScript(root, "set-workspace-version.mjs", [
      "1.2.3-rc.1",
      "--date",
      "2030-02-03",
      "--write",
    ]);
    assert.equal(write.status, 0, write.stderr);
    assert.match(write.stdout, /Release version updated/u);

    const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const daemonManifest = JSON.parse(
      await readFile(join(root, "apps", "daemon", "package.json"), "utf8"),
    );
    const contractsManifest = JSON.parse(
      await readFile(join(root, "packages", "contracts", "package.json"), "utf8"),
    );
    const lockfile = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
    const readme = await readFile(join(root, "README.md"), "utf8");
    const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");

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
    assert.equal(readme.includes("devdock-0.0.0"), false);
    assert.equal(readme.match(/devdock-1\.2\.3-rc\.1/gu)?.length, 3);
    assert.match(readme, /devdock-1\.2\.3-rc\.1\.tgz/u);
    assert.match(readme, /devdock-1\.2\.3-rc\.1\.cdx\.json/u);
    assert.match(readme, /devdock-1\.2\.3-rc\.1\.licenses\.json/u);
    assert.match(changelog, /## Unreleased\n\n## 1\.2\.3-rc\.1 - 2030-02-03/u);
    assert.equal(changelog.match(/^## Unreleased$/gmu)?.length, 1);
    assert.equal(changelog.match(/^## 1\.2\.3-rc\.1 - 2030-02-03$/gmu)?.length, 1);

    const check = runScript(root, "check-workspace-versions.mjs", []);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /3 manifests, package-lock\.json use 1\.2\.3-rc\.1/u);

    const emptyUnreleased = runScript(root, "set-workspace-version.mjs", [
      "1.2.4",
      "--date",
      "2030-02-04",
    ]);
    assert.equal(emptyUnreleased.status, 1);
    assert.match(emptyUnreleased.stderr, /Unreleased section is empty/u);
    assert.equal(
      JSON.parse(await readFile(join(root, "package.json"), "utf8")).version,
      "1.2.3-rc.1",
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("release version update keeps the desktop crate and Tauri config in step", async () => {
  const root = await mkdtemp(join(tmpdir(), "devdock version desktop-"));
  const crate = join(root, "apps", "desktop", "src-tauri");
  const cargoToml = [
    "[package]",
    'name = "devdock-desktop"',
    'version = "0.0.0"',
    'edition = "2021"',
    "",
    "[dependencies]",
    'serde_json = { version = "1" }',
    "",
  ].join("\n");
  const cargoLock = [
    "version = 4",
    "",
    "[[package]]",
    'name = "serde_json"',
    'version = "1.0.0"',
    "",
    "[[package]]",
    'name = "devdock-desktop"',
    'version = "0.0.0"',
    "dependencies = [",
    ' "serde_json",',
    "]",
    "",
  ].join("\n");
  const tauriConf = [
    "{",
    '  "productName": "DevDock",',
    '  "version": "0.0.0",',
    '  "bundle": { "targets": ["nsis"], "windows": { "nsis": { "version": "keep" } } }',
    "}",
    "",
  ].join("\n");
  try {
    await Promise.all([mkdir(join(root, "scripts")), mkdir(crate, { recursive: true })]);
    await Promise.all([
      ...[
        "check-workspace-versions.mjs",
        "set-workspace-version.mjs",
        "desktop-version-files.mjs",
      ].map((script) =>
        copyFile(join(sourceRoot, "scripts", script), join(root, "scripts", script)),
      ),
      writeFile(
        join(root, "package.json"),
        json({ name: "devdock", version: "0.0.0", private: true, workspaces: ["apps/*"] }),
      ),
      writeFile(
        join(root, "package-lock.json"),
        json({
          name: "devdock",
          version: "0.0.0",
          lockfileVersion: 3,
          packages: { "": { name: "devdock", version: "0.0.0" } },
        }),
      ),
      writeFile(join(root, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n- Desktop.\n"),
      writeFile(join(crate, "Cargo.toml"), cargoToml),
      writeFile(join(crate, "Cargo.lock"), cargoLock),
      writeFile(join(crate, "tauri.conf.json"), tauriConf),
    ]);

    const preview = runScript(root, "set-workspace-version.mjs", ["0.2.0", "--date", "2030-01-01"]);
    assert.equal(preview.status, 0, preview.stderr);
    for (const file of ["Cargo.toml", "Cargo.lock", "tauri.conf.json"]) {
      assert.ok(preview.stdout.includes(`apps/desktop/src-tauri/${file}`), file);
    }

    const write = runScript(root, "set-workspace-version.mjs", [
      "0.2.0",
      "--date",
      "2030-01-01",
      "--write",
    ]);
    assert.equal(write.status, 0, write.stderr);
    // Only the release version changes; formatting and other versions stay as written.
    assert.equal(
      await readFile(join(crate, "Cargo.toml"), "utf8"),
      cargoToml.replace('version = "0.0.0"', 'version = "0.2.0"'),
    );
    assert.equal(
      await readFile(join(crate, "Cargo.lock"), "utf8"),
      cargoLock.replace(
        'name = "devdock-desktop"\nversion = "0.0.0"',
        'name = "devdock-desktop"\nversion = "0.2.0"',
      ),
    );
    assert.equal(
      await readFile(join(crate, "tauri.conf.json"), "utf8"),
      tauriConf.replace('"version": "0.0.0"', '"version": "0.2.0"'),
    );
    const check = runScript(root, "check-workspace-versions.mjs", []);
    assert.equal(check.status, 0, check.stderr);
    assert.ok(check.stdout.includes("and 3 desktop files use 0.2.0"), check.stdout);

    await writeFile(join(crate, "tauri.conf.json"), tauriConf.replace("0.0.0", "0.1.9"));
    const drift = runScript(root, "check-workspace-versions.mjs", []);
    assert.equal(drift.status, 1);
    assert.ok(
      drift.stderr.includes('tauri.conf.json: version must match root "0.2.0", found "0.1.9"'),
      drift.stderr,
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
