import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeCycloneDx, sbomEvidenceSchemaVersion } from "../../scripts/sbom-utils.mjs";

const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function runScript(root, name) {
  return spawnSync(process.execPath, [join(root, "scripts", name)], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
}

test("license evidence rejects stale SBOM hashes and changed inventory bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "devdock licenses café-東京-"));
  try {
    await Promise.all([mkdir(join(root, "scripts")), mkdir(join(root, "artifacts"))]);
    await Promise.all(
      [
        "generate-license-inventory.mjs",
        "license-inventory-utils.mjs",
        "sbom-utils.mjs",
        "verify-license-inventory.mjs",
      ].map((name) => copyFile(join(sourceRoot, "scripts", name), join(root, "scripts", name))),
    );

    const manifest = { name: "devdock", version: "1.2.3", private: true };
    const digest = Buffer.alloc(64, 0xab);
    const distribution = "https://registry.npmjs.org/dependency/-/dependency-4.5.6.tgz";
    const lockfile = {
      name: "devdock",
      version: "1.2.3",
      lockfileVersion: 3,
      packages: {
        "": { name: "devdock", version: "1.2.3" },
        "node_modules/@devdock/internal": { resolved: "packages/internal", link: true },
        "node_modules/dependency": {
          version: "4.5.6",
          resolved: distribution,
          integrity: `sha512-${digest.toString("base64")}`,
        },
        "packages/internal": { name: "@devdock/internal", version: "1.2.3" },
      },
    };
    const packageEvidence = {
      schemaVersion: 2,
      package: {
        name: "devdock",
        version: "1.2.3",
        filename: "devdock-1.2.3.tgz",
        sha256: "a".repeat(64),
        bundled: ["@devdock/internal", "dependency"],
      },
    };
    const document = normalizeCycloneDx(
      {
        $schema: "http://cyclonedx.org/schema/bom-1.5.schema.json",
        bomFormat: "CycloneDX",
        specVersion: "1.5",
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
            "bom-ref": "@devdock/internal@1.2.3",
            type: "library",
            name: "internal",
            version: "1.2.3",
            purl: "pkg:npm/%40devdock/internal@1.2.3",
          },
          {
            "bom-ref": "dependency@4.5.6",
            type: "library",
            name: "dependency",
            version: "4.5.6",
            purl: "pkg:npm/dependency@4.5.6",
            hashes: [{ alg: "SHA-512", content: digest.toString("hex") }],
            externalReferences: [{ type: "distribution", url: distribution }],
            licenses: [{ license: { id: "MIT" } }],
          },
        ],
        dependencies: [
          {
            ref: "devdock@1.2.3",
            dependsOn: ["@devdock/internal@1.2.3", "dependency@4.5.6"],
          },
          { ref: "@devdock/internal@1.2.3", dependsOn: [] },
          { ref: "dependency@4.5.6", dependsOn: [] },
        ],
      },
      manifest,
    );
    const lockfileText = json(lockfile);
    const sbomText = json(document);
    const sbomFilename = "devdock-1.2.3.cdx.json";
    const sbomSha256 = createHash("sha256").update(sbomText, "utf8").digest("hex");
    const sbomEvidence = {
      schemaVersion: sbomEvidenceSchemaVersion,
      sbom: {
        filename: sbomFilename,
        sha256: sbomSha256,
        packageArtifactSha256: packageEvidence.package.sha256,
        sourceLockSha256: createHash("sha256").update(lockfileText, "utf8").digest("hex"),
        lockfileComponentCount: 2,
        linkedComponentCount: 1,
        integrityVerifiedComponentCount: 1,
        distributionVerifiedComponentCount: 1,
      },
    };
    const sbomEvidencePath = join(root, "artifacts", "sbom-latest.json");
    await Promise.all([
      writeFile(join(root, "package.json"), json(manifest)),
      writeFile(join(root, "package-lock.json"), lockfileText),
      writeFile(join(root, "artifacts", "package-latest.json"), json(packageEvidence)),
      writeFile(join(root, "artifacts", sbomFilename), sbomText),
      writeFile(sbomEvidencePath, json(sbomEvidence)),
    ]);

    const generated = runScript(root, "generate-license-inventory.mjs");
    assert.equal(generated.status, 0, generated.stderr);
    const valid = runScript(root, "verify-license-inventory.mjs");
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /"type":"license-inventory-verified"/u);

    sbomEvidence.sbom.sha256 = "b".repeat(64);
    await writeFile(sbomEvidencePath, json(sbomEvidence));
    const staleSbom = runScript(root, "verify-license-inventory.mjs");
    assert.equal(staleSbom.status, 1);
    assert.match(staleSbom.stderr, /source SBOM hash is stale/u);

    sbomEvidence.sbom.sha256 = sbomSha256;
    await writeFile(sbomEvidencePath, json(sbomEvidence));
    const inventoryPath = join(root, "artifacts", "devdock-1.2.3.licenses.json");
    const inventoryText = await readFile(inventoryPath, "utf8");
    await writeFile(inventoryPath, `${inventoryText} `);
    const changedInventory = runScript(root, "verify-license-inventory.mjs");
    assert.equal(changedInventory.status, 1);
    assert.match(changedInventory.stderr, /size evidence is stale/u);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
