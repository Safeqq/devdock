import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const artifactDirectory = join(repositoryRoot, "artifacts");
const requiredWorkspaces = [
  "@devdock/contracts",
  "@devdock/daemon",
  "@devdock/platform",
  "@devdock/storage",
  "@devdock/web",
];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const packageMetadata = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  const reportPath = join(artifactDirectory, "package-latest.json");
  const reportText = await readFile(reportPath, "utf8");
  const report = JSON.parse(reportText);
  requireCondition(report?.schemaVersion === 2, "Package evidence schema is not supported");
  requireCondition(report.package?.name === packageMetadata.name, "Package evidence name is stale");
  requireCondition(
    report.package?.version === packageMetadata.version,
    "Package evidence version is stale",
  );
  const expectedFilename = `${packageMetadata.name}-${packageMetadata.version}.tgz`;
  requireCondition(
    report.package?.filename === expectedFilename,
    "Package evidence filename is stale",
  );
  requireCondition(
    report.package?.checksumFilename === `${expectedFilename}.sha256`,
    "Package evidence checksum filename is stale",
  );
  requireCondition(
    Number.isInteger(report.package?.entryCount) && report.package.entryCount > 0,
    "Package evidence entry count is invalid",
  );
  requireCondition(
    Number.isInteger(report.package?.unpackedSizeBytes) && report.package.unpackedSizeBytes > 0,
    "Package evidence unpacked size is invalid",
  );
  requireCondition(
    Array.isArray(report.package?.bundled),
    "Package evidence bundled list is invalid",
  );
  requireCondition(
    Number.isInteger(report.package?.reproducibility?.packRuns) &&
      report.package.reproducibility.packRuns >= 2 &&
      report.package.reproducibility.byteForByte === true,
    "Package evidence does not prove repeatable byte-for-byte packing",
  );
  for (const workspace of requiredWorkspaces) {
    requireCondition(
      report.package.bundled.includes(workspace),
      `Package evidence is missing bundled ${workspace}`,
    );
  }
  requireCondition(
    !reportText.includes(repositoryRoot),
    "Package evidence contains the absolute repository path",
  );

  const artifactPath = join(artifactDirectory, expectedFilename);
  const artifact = await readFile(artifactPath);
  requireCondition(
    report.package.sizeBytes === artifact.byteLength,
    "Package evidence size is stale",
  );
  const sha1 = createHash("sha1").update(artifact).digest("hex");
  const sha256 = createHash("sha256").update(artifact).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(artifact).digest("base64")}`;
  requireCondition(report.package.sha1 === sha1, "Package evidence SHA-1 does not match");
  requireCondition(report.package.sha256 === sha256, "Package evidence SHA-256 does not match");
  requireCondition(
    report.package.integrity === integrity,
    "Package evidence SHA-512 integrity does not match",
  );

  const checksumPath = join(artifactDirectory, report.package.checksumFilename);
  const checksum = await readFile(checksumPath, "utf8");
  requireCondition(
    checksum === `${sha256}  ${expectedFilename}\n`,
    "Package SHA-256 checksum file does not match",
  );

  process.stdout.write(
    `${JSON.stringify({
      type: "package-artifact-verified",
      artifact: relative(repositoryRoot, artifactPath).split(sep).join("/"),
      checksum: relative(repositoryRoot, checksumPath).split(sep).join("/"),
      report: relative(repositoryRoot, reportPath).split(sep).join("/"),
      bytes: artifact.byteLength,
      entryCount: report.package.entryCount,
      sha256,
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Package verification failed"}\n`,
  );
  process.exitCode = 1;
});
