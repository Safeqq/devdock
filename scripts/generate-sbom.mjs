import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeCycloneDx,
  requireCondition,
  sbomEvidenceSchemaVersion,
  sbomFilename,
  validateCycloneDx,
} from "./sbom-utils.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const artifactDirectory = join(repositoryRoot, "artifacts");
const outputLimitBytes = 8 * 1_024 * 1_024;

function generateWithNpm(npmCli) {
  const result = spawnSync(
    process.execPath,
    [
      npmCli,
      "sbom",
      "--package-lock-only",
      "--omit=dev",
      "--sbom-format=cyclonedx",
      "--sbom-type=application",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: outputLimitBytes,
      timeout: 60_000,
      windowsHide: true,
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `npm sbom exited with code ${String(result.status)} and signal ${String(result.signal)}: ${result.stderr.slice(-4_096)}`,
    );
  }
  return JSON.parse(result.stdout);
}

async function main() {
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined || !isAbsolute(npmCli)) {
    throw new Error("Run SBOM generation through npm");
  }
  const [manifestText, lockfileText, packageEvidenceText] = await Promise.all([
    readFile(join(repositoryRoot, "package.json"), "utf8"),
    readFile(join(repositoryRoot, "package-lock.json"), "utf8"),
    readFile(join(artifactDirectory, "package-latest.json"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const packageEvidence = JSON.parse(packageEvidenceText);
  requireCondition(packageEvidence?.schemaVersion === 2, "Package evidence is not current");
  requireCondition(
    packageEvidence.package?.name === manifest.name,
    "Package evidence name is stale",
  );
  requireCondition(
    packageEvidence.package?.version === manifest.version,
    "Package evidence version is stale",
  );

  const generated = generateWithNpm(npmCli);
  const normalized = normalizeCycloneDx(generated, manifest);
  const inventory = validateCycloneDx(normalized, manifest, packageEvidence, [
    repositoryRoot,
    homedir(),
    tmpdir(),
  ]);
  const contents = `${JSON.stringify(normalized, null, 2)}\n`;
  const sha256 = createHash("sha256").update(contents, "utf8").digest("hex");
  const lockfileSha256 = createHash("sha256").update(lockfileText, "utf8").digest("hex");
  const filename = sbomFilename(packageEvidence.package.filename);
  const checksumFilename = `${filename}.sha256`;
  const evidence = {
    schemaVersion: sbomEvidenceSchemaVersion,
    generatedAt: new Date().toISOString(),
    sbom: {
      format: normalized.bomFormat,
      specVersion: normalized.specVersion,
      serialNumber: normalized.serialNumber,
      filename,
      checksumFilename,
      sizeBytes: Buffer.byteLength(contents, "utf8"),
      sha256,
      componentCount: inventory.componentCount,
      dependencyCount: inventory.dependencyCount,
      uniquePackageCount: inventory.uniquePackageCount,
      packageArtifactSha256: packageEvidence.package.sha256,
      sourceLockSha256: lockfileSha256,
      packageLockOnly: true,
      omittedDependencyTypes: ["dev"],
    },
    environment: {
      node: process.version,
      npm: /^npm\/([^\s]+)/u.exec(process.env.npm_config_user_agent ?? "")?.[1] ?? null,
    },
  };
  const sbomPath = join(artifactDirectory, filename);
  const reportPath = join(artifactDirectory, "sbom-latest.json");
  const checksumPath = join(artifactDirectory, checksumFilename);
  await Promise.all([
    writeFile(sbomPath, contents, "utf8"),
    writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8"),
    writeFile(checksumPath, `${sha256}  ${filename}\n`, "utf8"),
  ]);
  process.stdout.write(
    `${JSON.stringify({
      type: "sbom-generated",
      sbom: relative(repositoryRoot, sbomPath).split(sep).join("/"),
      report: relative(repositoryRoot, reportPath).split(sep).join("/"),
      checksum: relative(repositoryRoot, checksumPath).split(sep).join("/"),
      components: inventory.componentCount,
      uniquePackages: inventory.uniquePackageCount,
      sha256,
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "SBOM generation failed"}\n`);
  process.exitCode = 1;
});
