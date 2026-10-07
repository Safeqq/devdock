import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
  const [manifestText, lockfileText, packageEvidenceText, evidenceText] = await Promise.all([
    readFile(join(repositoryRoot, "package.json"), "utf8"),
    readFile(join(repositoryRoot, "package-lock.json"), "utf8"),
    readFile(join(artifactDirectory, "package-latest.json"), "utf8"),
    readFile(join(artifactDirectory, "sbom-latest.json"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const lockfile = JSON.parse(lockfileText);
  const packageEvidence = JSON.parse(packageEvidenceText);
  const evidence = JSON.parse(evidenceText);
  requireCondition(
    evidence?.schemaVersion === sbomEvidenceSchemaVersion,
    "SBOM evidence schema is not supported",
  );
  const filename = sbomFilename(packageEvidence.package.filename);
  requireCondition(evidence.sbom?.filename === filename, "SBOM evidence filename is stale");
  requireCondition(
    evidence.sbom?.checksumFilename === `${filename}.sha256`,
    "SBOM checksum filename is stale",
  );
  requireCondition(
    evidence.sbom?.packageArtifactSha256 === packageEvidence.package.sha256,
    "SBOM evidence refers to a stale package artifact",
  );
  const lockfileSha256 = createHash("sha256").update(lockfileText, "utf8").digest("hex");
  requireCondition(
    evidence.sbom?.sourceLockSha256 === lockfileSha256,
    "SBOM evidence refers to a stale package lockfile",
  );
  requireCondition(
    evidence.sbom?.packageLockOnly === true &&
      JSON.stringify(evidence.sbom.omittedDependencyTypes) === JSON.stringify(["dev"]),
    "SBOM dependency scope is invalid",
  );

  const sbomPath = join(artifactDirectory, filename);
  const contents = await readFile(sbomPath, "utf8");
  const document = JSON.parse(contents);
  const inventory = validateCycloneDx(document, manifest, packageEvidence, [
    repositoryRoot,
    homedir(),
    tmpdir(),
  ]);
  const provenance = validateCycloneDxLockfileProvenance(document, lockfile);
  requireCondition(evidence.sbom.format === document.bomFormat, "SBOM format evidence is stale");
  requireCondition(
    evidence.sbom.specVersion === document.specVersion,
    "SBOM version evidence is stale",
  );
  requireCondition(
    evidence.sbom.serialNumber === document.serialNumber,
    "SBOM serial number evidence is stale",
  );
  requireCondition(
    evidence.sbom.componentCount === inventory.componentCount &&
      evidence.sbom.dependencyCount === inventory.dependencyCount &&
      evidence.sbom.uniquePackageCount === inventory.uniquePackageCount,
    "SBOM inventory counts are stale",
  );
  for (const [key, value] of Object.entries(provenance)) {
    requireCondition(evidence.sbom[key] === value, `SBOM ${key} evidence is stale`);
  }
  requireCondition(
    evidence.sbom.sizeBytes === Buffer.byteLength(contents, "utf8"),
    "SBOM size evidence is stale",
  );
  const sha256 = createHash("sha256").update(contents, "utf8").digest("hex");
  requireCondition(evidence.sbom.sha256 === sha256, "SBOM SHA-256 evidence does not match");
  const checksumPath = join(artifactDirectory, evidence.sbom.checksumFilename);
  const checksum = await readFile(checksumPath, "utf8");
  requireCondition(checksum === `${sha256}  ${filename}\n`, "SBOM checksum file does not match");
  requireCondition(
    !evidenceText.includes(repositoryRoot) &&
      !evidenceText.includes(homedir()) &&
      !evidenceText.includes(tmpdir()),
    "SBOM evidence contains an absolute local path",
  );

  process.stdout.write(
    `${JSON.stringify({
      type: "sbom-verified",
      sbom: relative(repositoryRoot, sbomPath).split(sep).join("/"),
      components: inventory.componentCount,
      uniquePackages: inventory.uniquePackageCount,
      integrityVerifiedComponents: provenance.integrityVerifiedComponentCount,
      sha256,
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "SBOM verification failed"}\n`);
  process.exitCode = 1;
});
