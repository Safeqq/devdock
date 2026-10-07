import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLicenseInventory,
  internalPackageNamesFromLockfile,
  licenseEvidenceSchemaVersion,
  licenseInventoryFilename,
} from "./license-inventory-utils.mjs";
import {
  requireCondition,
  sbomEvidenceSchemaVersion,
  sbomFilename,
  validateCycloneDx,
  validateCycloneDxLockfileProvenance,
} from "./sbom-utils.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const artifactDirectory = join(repositoryRoot, "artifacts");

async function main() {
  const [manifestText, lockfileText, packageEvidenceText, sbomEvidenceText] = await Promise.all([
    readFile(join(repositoryRoot, "package.json"), "utf8"),
    readFile(join(repositoryRoot, "package-lock.json"), "utf8"),
    readFile(join(artifactDirectory, "package-latest.json"), "utf8"),
    readFile(join(artifactDirectory, "sbom-latest.json"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const lockfile = JSON.parse(lockfileText);
  const packageEvidence = JSON.parse(packageEvidenceText);
  const sbomEvidence = JSON.parse(sbomEvidenceText);
  requireCondition(packageEvidence?.schemaVersion === 2, "Package evidence is not current");
  requireCondition(
    packageEvidence.package?.name === manifest.name &&
      packageEvidence.package?.version === manifest.version,
    "Package evidence identity is stale",
  );
  requireCondition(
    sbomEvidence?.schemaVersion === sbomEvidenceSchemaVersion,
    "SBOM evidence schema is not supported",
  );
  const sourceSbomFilename = sbomFilename(packageEvidence.package.filename);
  requireCondition(
    sbomEvidence.sbom?.filename === sourceSbomFilename,
    "SBOM evidence filename is stale",
  );
  requireCondition(
    sbomEvidence.sbom?.packageArtifactSha256 === packageEvidence.package.sha256,
    "SBOM evidence refers to a stale package artifact",
  );
  const lockfileSha256 = createHash("sha256").update(lockfileText, "utf8").digest("hex");
  requireCondition(
    sbomEvidence.sbom?.sourceLockSha256 === lockfileSha256,
    "SBOM evidence refers to a stale package lockfile",
  );

  const sourceSbomText = await readFile(join(artifactDirectory, sourceSbomFilename), "utf8");
  const sourceSbomSha256 = createHash("sha256").update(sourceSbomText, "utf8").digest("hex");
  requireCondition(
    sbomEvidence.sbom?.sha256 === sourceSbomSha256,
    "SBOM evidence does not match the source document",
  );
  const document = JSON.parse(sourceSbomText);
  validateCycloneDx(document, manifest, packageEvidence, [repositoryRoot, homedir(), tmpdir()]);
  validateCycloneDxLockfileProvenance(document, lockfile);

  const internalPackageNames = internalPackageNamesFromLockfile(lockfile);
  const inventory = createLicenseInventory(document, manifest, internalPackageNames);
  const contents = `${JSON.stringify(inventory, null, 2)}\n`;
  const sha256 = createHash("sha256").update(contents, "utf8").digest("hex");
  const filename = licenseInventoryFilename(packageEvidence.package.filename);
  const checksumFilename = `${filename}.sha256`;
  const evidence = {
    schemaVersion: licenseEvidenceSchemaVersion,
    generatedAt: new Date().toISOString(),
    licenseInventory: {
      filename,
      checksumFilename,
      sizeBytes: Buffer.byteLength(contents, "utf8"),
      sha256,
      ...inventory.summary,
      sourceSbomFilename,
      sourceSbomSha256,
      packageArtifactSha256: packageEvidence.package.sha256,
    },
    environment: {
      node: process.version,
      npm: /^npm\/([^\s]+)/u.exec(process.env.npm_config_user_agent ?? "")?.[1] ?? null,
    },
  };
  const inventoryPath = join(artifactDirectory, filename);
  const reportPath = join(artifactDirectory, "licenses-latest.json");
  const checksumPath = join(artifactDirectory, checksumFilename);
  await Promise.all([
    writeFile(inventoryPath, contents, "utf8"),
    writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8"),
    writeFile(checksumPath, `${sha256}  ${filename}\n`, "utf8"),
  ]);
  process.stdout.write(
    `${JSON.stringify({
      type: "license-inventory-generated",
      inventory: relative(repositoryRoot, inventoryPath).split(sep).join("/"),
      report: relative(repositoryRoot, reportPath).split(sep).join("/"),
      checksum: relative(repositoryRoot, checksumPath).split(sep).join("/"),
      thirdPartyComponents: inventory.summary.thirdPartyComponentCount,
      internalComponents: inventory.summary.internalComponentCount,
      uniqueLicenseDeclarations: inventory.summary.uniqueLicenseDeclarationCount,
      sha256,
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "License inventory generation failed"}\n`,
  );
  process.exitCode = 1;
});
