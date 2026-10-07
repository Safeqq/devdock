import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
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
  const [manifestText, lockfileText, packageEvidenceText, sbomEvidenceText, evidenceText] =
    await Promise.all([
      readFile(join(repositoryRoot, "package.json"), "utf8"),
      readFile(join(repositoryRoot, "package-lock.json"), "utf8"),
      readFile(join(artifactDirectory, "package-latest.json"), "utf8"),
      readFile(join(artifactDirectory, "sbom-latest.json"), "utf8"),
      readFile(join(artifactDirectory, "licenses-latest.json"), "utf8"),
    ]);
  const manifest = JSON.parse(manifestText);
  const lockfile = JSON.parse(lockfileText);
  const packageEvidence = JSON.parse(packageEvidenceText);
  const sbomEvidence = JSON.parse(sbomEvidenceText);
  const evidence = JSON.parse(evidenceText);
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
  requireCondition(
    evidence?.schemaVersion === licenseEvidenceSchemaVersion,
    "License inventory evidence schema is not supported",
  );

  const sourceSbomFilename = sbomFilename(packageEvidence.package.filename);
  const filename = licenseInventoryFilename(packageEvidence.package.filename);
  requireCondition(
    evidence.licenseInventory?.filename === filename,
    "License inventory evidence filename is stale",
  );
  requireCondition(
    evidence.licenseInventory?.checksumFilename === `${filename}.sha256`,
    "License inventory checksum filename is stale",
  );
  requireCondition(
    evidence.licenseInventory?.sourceSbomFilename === sourceSbomFilename &&
      sbomEvidence.sbom?.filename === sourceSbomFilename,
    "License inventory source SBOM filename is stale",
  );
  requireCondition(
    evidence.licenseInventory?.packageArtifactSha256 === packageEvidence.package.sha256 &&
      sbomEvidence.sbom?.packageArtifactSha256 === packageEvidence.package.sha256,
    "License inventory refers to a stale package artifact",
  );
  const lockfileSha256 = createHash("sha256").update(lockfileText, "utf8").digest("hex");
  requireCondition(
    sbomEvidence.sbom?.sourceLockSha256 === lockfileSha256,
    "License inventory source SBOM refers to a stale package lockfile",
  );

  const sourceSbomText = await readFile(join(artifactDirectory, sourceSbomFilename), "utf8");
  const sourceSbomSha256 = createHash("sha256").update(sourceSbomText, "utf8").digest("hex");
  requireCondition(
    evidence.licenseInventory?.sourceSbomSha256 === sourceSbomSha256 &&
      sbomEvidence.sbom?.sha256 === sourceSbomSha256,
    "License inventory source SBOM hash is stale",
  );
  const document = JSON.parse(sourceSbomText);
  validateCycloneDx(document, manifest, packageEvidence, [repositoryRoot, homedir(), tmpdir()]);
  validateCycloneDxLockfileProvenance(document, lockfile);
  const expected = createLicenseInventory(
    document,
    manifest,
    internalPackageNamesFromLockfile(lockfile),
  );

  const inventoryPath = join(artifactDirectory, filename);
  const contents = await readFile(inventoryPath, "utf8");
  const inventory = JSON.parse(contents);
  requireCondition(
    isDeepStrictEqual(inventory, expected),
    "License inventory does not match the current SBOM and package metadata",
  );
  for (const [key, value] of Object.entries(expected.summary)) {
    requireCondition(
      evidence.licenseInventory?.[key] === value,
      `License inventory ${key} evidence is stale`,
    );
  }
  requireCondition(
    evidence.licenseInventory?.sizeBytes === Buffer.byteLength(contents, "utf8"),
    "License inventory size evidence is stale",
  );
  const sha256 = createHash("sha256").update(contents, "utf8").digest("hex");
  requireCondition(
    evidence.licenseInventory?.sha256 === sha256,
    "License inventory SHA-256 evidence does not match",
  );
  const checksum = await readFile(
    join(artifactDirectory, evidence.licenseInventory.checksumFilename),
    "utf8",
  );
  requireCondition(
    checksum === `${sha256}  ${filename}\n`,
    "License inventory checksum file does not match",
  );
  requireCondition(
    !evidenceText.includes(repositoryRoot) &&
      !evidenceText.includes(homedir()) &&
      !evidenceText.includes(tmpdir()),
    "License inventory evidence contains an absolute local path",
  );

  process.stdout.write(
    `${JSON.stringify({
      type: "license-inventory-verified",
      inventory: relative(repositoryRoot, inventoryPath).split(sep).join("/"),
      thirdPartyComponents: expected.summary.thirdPartyComponentCount,
      uniqueThirdPartyPackages: expected.summary.uniqueThirdPartyPackageCount,
      internalComponents: expected.summary.internalComponentCount,
      uniqueLicenseDeclarations: expected.summary.uniqueLicenseDeclarationCount,
      sha256,
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "License inventory verification failed"}\n`,
  );
  process.exitCode = 1;
});
