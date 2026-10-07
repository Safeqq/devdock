import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeCycloneDx } from "../../scripts/sbom-utils.mjs";

const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function runVerifier(root) {
  return spawnSync(process.execPath, [join(root, "scripts", "verify-sbom.mjs")], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
}

test("SBOM evidence rejects stale lockfiles, package artifacts, and document bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "devdock sbom evidence café-東京-"));
  try {
    await Promise.all([mkdir(join(root, "scripts")), mkdir(join(root, "artifacts"))]);
    await Promise.all(
      ["sbom-utils.mjs", "verify-sbom.mjs"].map((name) =>
        copyFile(join(sourceRoot, "scripts", name), join(root, "scripts", name)),
      ),
    );

    const manifest = { name: "devdock", version: "1.2.3" };
    const packageEvidence = {
      schemaVersion: 2,
      package: {
        name: "devdock",
        version: "1.2.3",
        filename: "devdock-1.2.3.tgz",
        sha256: "a".repeat(64),
        bundled: ["dependency"],
      },
    };
    const lockfileText = json({ name: "devdock", version: "1.2.3", lockfileVersion: 3 });
    const document = normalizeCycloneDx(
      {
        $schema: "http://cyclonedx.org/schema/bom-1.5.schema.json",
        bomFormat: "CycloneDX",
        specVersion: "1.5",
        serialNumber: "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        version: 1,
        metadata: {
          timestamp: "2030-02-03T00:00:00.000Z",
          component: {
            "bom-ref": "devdock@1.2.3",
            type: "application",
            name: "devdock",
            version: "1.2.3",
          },
        },
        components: [
          {
            "bom-ref": "dependency@4.5.6",
            type: "library",
            name: "dependency",
            version: "4.5.6",
            purl: "pkg:npm/dependency@4.5.6",
          },
        ],
        dependencies: [
          { ref: "devdock@1.2.3", dependsOn: ["dependency@4.5.6"] },
          { ref: "dependency@4.5.6", dependsOn: [] },
        ],
      },
      manifest,
    );
    const contents = json(document);
    const filename = "devdock-1.2.3.cdx.json";
    const checksumFilename = `${filename}.sha256`;
    const sha256 = createHash("sha256").update(contents, "utf8").digest("hex");
    const evidence = {
      schemaVersion: 1,
      sbom: {
        format: "CycloneDX",
        specVersion: "1.5",
        serialNumber: document.serialNumber,
        filename,
        checksumFilename,
        sizeBytes: Buffer.byteLength(contents, "utf8"),
        sha256,
        componentCount: 1,
        dependencyCount: 2,
        uniquePackageCount: 1,
        packageArtifactSha256: packageEvidence.package.sha256,
        sourceLockSha256: createHash("sha256").update(lockfileText, "utf8").digest("hex"),
        packageLockOnly: true,
        omittedDependencyTypes: ["dev"],
      },
    };
    const lockfilePath = join(root, "package-lock.json");
    const packageEvidencePath = join(root, "artifacts", "package-latest.json");
    const sbomPath = join(root, "artifacts", filename);
    await Promise.all([
      writeFile(join(root, "package.json"), json(manifest)),
      writeFile(lockfilePath, lockfileText),
      writeFile(packageEvidencePath, json(packageEvidence)),
      writeFile(join(root, "artifacts", "sbom-latest.json"), json(evidence)),
      writeFile(sbomPath, contents),
      writeFile(join(root, "artifacts", checksumFilename), `${sha256}  ${filename}\n`),
    ]);

    const valid = runVerifier(root);
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /"type":"sbom-verified"/u);

    await writeFile(lockfilePath, `${lockfileText}\n`);
    const staleLockfile = runVerifier(root);
    assert.equal(staleLockfile.status, 1);
    assert.match(staleLockfile.stderr, /stale package lockfile/u);

    await writeFile(lockfilePath, lockfileText);
    packageEvidence.package.sha256 = "b".repeat(64);
    await writeFile(packageEvidencePath, json(packageEvidence));
    const stalePackage = runVerifier(root);
    assert.equal(stalePackage.status, 1);
    assert.match(stalePackage.stderr, /stale package artifact/u);

    packageEvidence.package.sha256 = evidence.sbom.packageArtifactSha256;
    await writeFile(packageEvidencePath, json(packageEvidence));
    await writeFile(sbomPath, `${contents} `);
    const changedDocument = runVerifier(root);
    assert.equal(changedDocument.status, 1);
    assert.match(changedDocument.stderr, /size evidence is stale/u);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
