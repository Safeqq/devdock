import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const artifactDirectory = join(repositoryRoot, "artifacts");
const artifactVerifierPath = fileURLToPath(
  new URL("./verify-package-artifact.mjs", import.meta.url),
);
const outputLimitBytes = 4 * 1_024 * 1_024;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function sanitize(message) {
  return message.split(repositoryRoot).join("<repository>").split(tmpdir()).join("<temporary>");
}

function packageStagingRoot(path) {
  const root = resolve(path);
  if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("devdock-repack-")) {
    throw new Error("Package repack staging root failed its safety check");
  }
  return root;
}

function runArtifactVerifier() {
  const result = spawnSync(process.execPath, [artifactVerifierPath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: outputLimitBytes,
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Existing package artifact verification failed");
  }
}

function createFreshPack(npmCli, destination) {
  const result = spawnSync(
    process.execPath,
    [
      npmCli,
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      destination,
      repositoryRoot,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: outputLimitBytes,
      timeout: 180_000,
      windowsHide: true,
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Fresh npm pack exited with code ${String(result.status)} and signal ${String(result.signal)}: ${result.stderr.slice(-4_096)}`,
    );
  }
  const reports = JSON.parse(result.stdout);
  requireCondition(
    Array.isArray(reports) && reports.length === 1,
    "Fresh npm pack returned multiple reports",
  );
  return reports[0];
}

async function main() {
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined || !isAbsolute(npmCli)) {
    throw new Error("Run package reproducibility verification through npm");
  }

  runArtifactVerifier();
  const evidence = JSON.parse(
    await readFile(join(artifactDirectory, "package-latest.json"), "utf8"),
  );
  const artifactPath = join(artifactDirectory, evidence.package.filename);
  const expectedArtifact = await readFile(artifactPath);
  const stagingRoot = packageStagingRoot(await mkdtemp(join(tmpdir(), "devdock-repack-")));
  try {
    const destination = join(stagingRoot, "fresh");
    await mkdir(destination);
    const freshReport = createFreshPack(npmCli, destination);
    requireCondition(
      freshReport.filename === evidence.package.filename,
      "Fresh npm pack produced an unexpected filename",
    );
    const freshArtifact = await readFile(join(destination, freshReport.filename));
    const expectedSha256 = createHash("sha256").update(expectedArtifact).digest("hex");
    const freshSha256 = createHash("sha256").update(freshArtifact).digest("hex");
    requireCondition(
      expectedArtifact.equals(freshArtifact),
      `Existing artifact does not match a fresh npm pack: ${expectedSha256} != ${freshSha256}`,
    );

    process.stdout.write(
      `${JSON.stringify({
        type: "package-reproducibility-verified",
        artifact: relative(repositoryRoot, artifactPath).split(sep).join("/"),
        bytes: expectedArtifact.byteLength,
        sha256: expectedSha256,
      })}\n`,
    );
  } finally {
    await rm(stagingRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((error) => {
  const message =
    error instanceof Error ? error.message : "Package reproducibility verification failed";
  process.stderr.write(`${sanitize(message)}\n`);
  process.exitCode = 1;
});
