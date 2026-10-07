import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const requiredWorkspaces = [
  "@devdock/contracts",
  "@devdock/daemon",
  "@devdock/platform",
  "@devdock/storage",
  "@devdock/web",
];

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

function runVerifier(root, npmCli) {
  return spawnSync(
    process.execPath,
    [join(root, "scripts", "verify-package-reproducibility.mjs")],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, npm_execpath: npmCli },
      windowsHide: true,
    },
  );
}

test("fresh repack accepts current inputs and rejects a stale promoted artifact", async () => {
  const npmCli = process.env.npm_execpath;
  assert.equal(typeof npmCli, "string");
  assert.equal(isAbsolute(npmCli), true);

  const root = await mkdtemp(join(tmpdir(), "devdock repack café-東京-"));
  try {
    await Promise.all([mkdir(join(root, "scripts")), mkdir(join(root, "artifacts"))]);
    await Promise.all(
      ["verify-package-artifact.mjs", "verify-package-reproducibility.mjs"].map((name) =>
        copyFile(join(sourceRoot, "scripts", name), join(root, "scripts", name)),
      ),
    );
    await Promise.all([
      writeFile(
        join(root, "package.json"),
        `${JSON.stringify(
          {
            name: "devdock-repack-fixture",
            version: "1.2.3",
            private: true,
            files: ["README.md"],
          },
          null,
          2,
        )}\n`,
      ),
      writeFile(join(root, "README.md"), "# Reproducible fixture\n"),
    ]);

    const report = runNpmPack(root, npmCli);
    const artifactPath = join(root, "artifacts", report.filename);
    const artifact = await readFile(artifactPath);
    const sha1 = createHash("sha1").update(artifact).digest("hex");
    const sha256 = createHash("sha256").update(artifact).digest("hex");
    const integrity = `sha512-${createHash("sha512").update(artifact).digest("base64")}`;
    const checksumFilename = `${report.filename}.sha256`;
    await Promise.all([
      writeFile(
        join(root, "artifacts", "package-latest.json"),
        `${JSON.stringify(
          {
            schemaVersion: 2,
            generatedAt: "2030-02-03T00:00:00.000Z",
            package: {
              name: report.name,
              version: report.version,
              filename: report.filename,
              checksumFilename,
              sizeBytes: artifact.byteLength,
              unpackedSizeBytes: report.unpackedSize,
              entryCount: report.entryCount,
              sha1,
              sha256,
              integrity,
              bundled: requiredWorkspaces,
              reproducibility: { packRuns: 2, byteForByte: true },
            },
          },
          null,
          2,
        )}\n`,
      ),
      writeFile(join(root, "artifacts", checksumFilename), `${sha256}  ${report.filename}\n`),
    ]);

    const current = runVerifier(root, npmCli);
    assert.equal(current.status, 0, current.stderr);
    assert.match(current.stdout, /"type":"package-reproducibility-verified"/u);

    await writeFile(join(root, "README.md"), "# Changed after packaging\n");
    const stale = runVerifier(root, npmCli);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /does not match a fresh npm pack/u);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
