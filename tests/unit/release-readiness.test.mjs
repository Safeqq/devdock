import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const bundledWorkspaceNames = [
  "@devdock/contracts",
  "@devdock/daemon",
  "@devdock/platform",
  "@devdock/storage",
  "@devdock/web",
];

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function runInspector(root, arguments_) {
  return spawnSync(
    process.execPath,
    [join(root, "scripts", "inspect-release-readiness.mjs"), ...arguments_],
    { cwd: root, encoding: "utf8", env: process.env, windowsHide: true },
  );
}

function runNpmPack(root, npmCli) {
  const result = spawnSync(
    process.execPath,
    [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", "artifacts", root],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  const reports = JSON.parse(result.stdout);
  assert.equal(reports.length, 1);
  return reports[0];
}

function normalizeLockfile(root, npmCli) {
  const result = spawnSync(
    process.execPath,
    [npmCli, "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
}

function runSbomGenerator(root, npmCli) {
  const result = spawnSync(process.execPath, [join(root, "scripts", "generate-sbom.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, npm_execpath: npmCli },
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
}

test("release readiness passes complete npm metadata and reports strict blockers", async () => {
  const npmCli = process.env.npm_execpath;
  assert.equal(typeof npmCli, "string");
  assert.equal(isAbsolute(npmCli), true);

  const root = await mkdtemp(join(tmpdir(), "devdock readiness café-東京-"));
  try {
    await Promise.all([
      mkdir(join(root, "scripts")),
      mkdir(join(root, "apps", "daemon"), { recursive: true }),
      mkdir(join(root, "apps", "web"), { recursive: true }),
      mkdir(join(root, "packages", "contracts"), { recursive: true }),
      mkdir(join(root, "packages", "platform"), { recursive: true }),
      mkdir(join(root, "packages", "storage"), { recursive: true }),
      mkdir(join(root, "artifacts")),
    ]);
    await Promise.all(
      [
        "check-workspace-versions.mjs",
        "generate-sbom.mjs",
        "inspect-release-readiness.mjs",
        "sbom-utils.mjs",
        "verify-package-artifact.mjs",
        "verify-package-reproducibility.mjs",
        "verify-sbom.mjs",
      ].map((name) => copyFile(join(sourceRoot, "scripts", name), join(root, "scripts", name))),
    );

    const rootManifest = {
      name: "devdock",
      version: "1.2.3",
      private: false,
      license: "MIT",
      repository: { type: "git", url: "https://example.invalid/devdock.git" },
      files: ["CHANGELOG.md"],
      workspaces: ["apps/*", "packages/*"],
      dependencies: { "@devdock/daemon": "1.2.3" },
    };
    await Promise.all([
      writeFile(join(root, "package.json"), json(rootManifest)),
      writeFile(
        join(root, "apps", "daemon", "package.json"),
        json({
          name: "@devdock/daemon",
          version: "1.2.3",
          private: true,
          dependencies: {
            "@devdock/contracts": "1.2.3",
            "@devdock/platform": "1.2.3",
            "@devdock/storage": "1.2.3",
            "@devdock/web": "1.2.3",
          },
        }),
      ),
      writeFile(
        join(root, "apps", "web", "package.json"),
        json({ name: "@devdock/web", version: "1.2.3", private: true }),
      ),
      writeFile(
        join(root, "packages", "contracts", "package.json"),
        json({ name: "@devdock/contracts", version: "1.2.3", private: true }),
      ),
      writeFile(
        join(root, "packages", "platform", "package.json"),
        json({ name: "@devdock/platform", version: "1.2.3", private: true }),
      ),
      writeFile(
        join(root, "packages", "storage", "package.json"),
        json({ name: "@devdock/storage", version: "1.2.3", private: true }),
      ),
      writeFile(
        join(root, "package-lock.json"),
        json({
          name: "devdock",
          version: "1.2.3",
          lockfileVersion: 3,
          packages: {
            "": {
              name: "devdock",
              version: "1.2.3",
              dependencies: { "@devdock/daemon": "1.2.3" },
            },
            "apps/daemon": {
              name: "@devdock/daemon",
              version: "1.2.3",
              dependencies: {
                "@devdock/contracts": "1.2.3",
                "@devdock/platform": "1.2.3",
                "@devdock/storage": "1.2.3",
                "@devdock/web": "1.2.3",
              },
            },
            "apps/web": { name: "@devdock/web", version: "1.2.3" },
            "node_modules/@devdock/contracts": {
              resolved: "packages/contracts",
              link: true,
            },
            "node_modules/@devdock/daemon": { resolved: "apps/daemon", link: true },
            "node_modules/@devdock/platform": {
              resolved: "packages/platform",
              link: true,
            },
            "node_modules/@devdock/storage": { resolved: "packages/storage", link: true },
            "node_modules/@devdock/web": { resolved: "apps/web", link: true },
            "packages/contracts": { name: "@devdock/contracts", version: "1.2.3" },
            "packages/platform": { name: "@devdock/platform", version: "1.2.3" },
            "packages/storage": { name: "@devdock/storage", version: "1.2.3" },
          },
        }),
      ),
      writeFile(
        join(root, "CHANGELOG.md"),
        "# Changelog\n\n## Unreleased\n\n## 1.2.3 - 2030-02-03\n\n### Added\n\n- Release.\n",
      ),
      writeFile(join(root, "LICENSE"), "MIT fixture license\n"),
    ]);

    normalizeLockfile(root, npmCli);
    const packReport = runNpmPack(root, npmCli);
    const filename = packReport.filename;
    const checksumFilename = `${filename}.sha256`;
    const artifact = await readFile(join(root, "artifacts", filename));
    const sha1 = createHash("sha1").update(artifact).digest("hex");
    const sha256 = createHash("sha256").update(artifact).digest("hex");
    const integrity = `sha512-${createHash("sha512").update(artifact).digest("base64")}`;
    await Promise.all([
      writeFile(join(root, "artifacts", checksumFilename), `${sha256}  ${filename}\n`),
      writeFile(
        join(root, "artifacts", "package-latest.json"),
        json({
          schemaVersion: 2,
          package: {
            name: "devdock",
            version: "1.2.3",
            filename,
            checksumFilename,
            sizeBytes: artifact.byteLength,
            unpackedSizeBytes: packReport.unpackedSize,
            entryCount: packReport.entryCount,
            sha1,
            sha256,
            integrity,
            bundled: bundledWorkspaceNames,
            reproducibility: { packRuns: 2, byteForByte: true },
          },
        }),
      ),
    ]);
    runSbomGenerator(root, npmCli);

    const ready = runInspector(root, ["--target", "npm", "--strict"]);
    assert.equal(ready.status, 0, ready.stderr);
    assert.match(ready.stdout, /Release readiness \(npm\): READY/u);
    const readyReport = JSON.parse(
      await readFile(join(root, "artifacts", "release-readiness-latest.json"), "utf8"),
    );
    assert.equal(readyReport.ready, true);
    assert.equal(
      readyReport.checks.some((check) => check.status === "blocker"),
      false,
    );

    rootManifest.private = true;
    await Promise.all([
      writeFile(join(root, "package.json"), json(rootManifest)),
      unlink(join(root, "LICENSE")),
    ]);
    const blocked = runInspector(root, ["--target", "npm"]);
    assert.equal(blocked.status, 0, blocked.stderr);
    assert.match(blocked.stdout, /Release readiness \(npm\): BLOCKED/u);
    const blockedReport = JSON.parse(
      await readFile(join(root, "artifacts", "release-readiness-latest.json"), "utf8"),
    );
    const blockers = blockedReport.checks
      .filter((check) => check.status === "blocker")
      .map((check) => check.id);
    assert.equal(blockers.includes("license-file"), true);
    assert.equal(blockers.includes("root-package-private"), true);

    const strict = runInspector(root, ["--target", "npm", "--strict"]);
    assert.equal(strict.status, 1);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
