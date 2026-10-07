import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const outputLimitBytes = 4 * 1_024 * 1_024;
const requiredRootPaths = ["CHANGELOG.md", "README.md", "bin/devdock.mjs", "package.json"];
const requiredWorkspaces = [
  "@devdock/contracts",
  "@devdock/daemon",
  "@devdock/platform",
  "@devdock/storage",
  "@devdock/web",
];

function appendBounded(current, chunk, streamName, child) {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") > outputLimitBytes) {
    child.kill("SIGKILL");
    throw new Error(`npm pack ${streamName} exceeded ${outputLimitBytes} bytes`);
  }
  return next;
}

function runNpmPack(npmCli, artifactDirectory) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        npmCli,
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        artifactDirectory,
        repositoryRoot,
      ],
      {
        cwd: repositoryRoot,
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    let outputError;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      outputError = new Error("npm pack exceeded 180000 ms");
    }, 180_000);
    child.stdout.on("data", (chunk) => {
      try {
        stdout = appendBounded(stdout, chunk, "stdout", child);
      } catch (error) {
        outputError = error;
      }
    });
    child.stderr.on("data", (chunk) => {
      try {
        stderr = appendBounded(stderr, chunk, "stderr", child);
      } catch (error) {
        outputError = error;
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (outputError !== undefined) {
        reject(outputError);
      } else if (code !== 0) {
        reject(
          new Error(
            `npm pack exited with code ${String(code)} and signal ${String(signal)}: ${stderr.slice(-4_096)}`,
          ),
        );
      } else {
        resolve(stdout);
      }
    });
  });
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function packageStagingRoot(path) {
  const root = resolve(path);
  if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("devdock-package-")) {
    throw new Error("Package staging root failed its safety check");
  }
  return root;
}

function auditPackReport(report, packageMetadata) {
  requireCondition(
    report !== null && typeof report === "object",
    "npm pack report is not an object",
  );
  requireCondition(
    report.name === packageMetadata.name,
    "npm pack reported the wrong package name",
  );
  requireCondition(
    report.version === packageMetadata.version,
    "npm pack reported the wrong version",
  );
  requireCondition(
    report.filename === `${packageMetadata.name}-${packageMetadata.version}.tgz`,
    "npm pack reported an unexpected filename",
  );
  requireCondition(Array.isArray(report.files), "npm pack report does not contain a file list");
  requireCondition(
    report.entryCount === report.files.length,
    "npm pack entry count is inconsistent",
  );
  requireCondition(
    Array.isArray(report.bundled),
    "npm pack report does not contain bundled packages",
  );

  const packedPaths = report.files.map((file) => file.path);
  for (const path of requiredRootPaths) {
    requireCondition(packedPaths.includes(path), `Package is missing ${path}`);
  }
  const forbiddenRootPath =
    /^(?:AGENT\.md|package-lock\.json|tsconfig\.json|biome\.json|\.env(?:\.|$)|\.(?:github|tools)\/|(?:apps|artifacts|docs|packages|scripts|tests)\/)/;
  requireCondition(
    packedPaths.every((path) => !forbiddenRootPath.test(path)),
    "Package contains root development files",
  );
  requireCondition(
    packedPaths.every((path) => !/^node_modules\/@devdock\/[^/]+\/(?:src|tests)\//u.test(path)),
    "Package contains internal workspace source or tests",
  );
  for (const workspace of requiredWorkspaces) {
    requireCondition(report.bundled.includes(workspace), `Package is missing bundled ${workspace}`);
  }
}

async function createPackageAttempt(npmCli, destination, packageMetadata) {
  await mkdir(destination, { recursive: true });
  const output = await runNpmPack(npmCli, destination);
  const reports = JSON.parse(output);
  requireCondition(
    Array.isArray(reports) && reports.length === 1,
    "npm pack returned multiple reports",
  );
  const [report] = reports;
  auditPackReport(report, packageMetadata);

  const artifact = await readFile(join(destination, report.filename));
  const sha1 = createHash("sha1").update(artifact).digest("hex");
  const sha256 = createHash("sha256").update(artifact).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(artifact).digest("base64")}`;
  requireCondition(report.size === artifact.byteLength, "npm pack size does not match the tarball");
  requireCondition(report.shasum === sha1, "npm pack SHA-1 does not match the tarball");
  requireCondition(
    report.integrity === integrity,
    "npm pack SHA-512 integrity does not match the tarball",
  );
  return { artifact, integrity, report, sha1, sha256 };
}

async function main() {
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined || !isAbsolute(npmCli)) {
    throw new Error("Run local packaging through npm so npm_execpath is available");
  }

  const packageMetadata = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  const artifactDirectory = join(repositoryRoot, "artifacts");
  await mkdir(artifactDirectory, { recursive: true });
  const stagingRoot = packageStagingRoot(await mkdtemp(join(tmpdir(), "devdock-package-")));
  try {
    const first = await createPackageAttempt(npmCli, join(stagingRoot, "first"), packageMetadata);
    const second = await createPackageAttempt(npmCli, join(stagingRoot, "second"), packageMetadata);
    requireCondition(
      first.artifact.equals(second.artifact),
      `Repeated npm pack output differs: ${first.sha256} != ${second.sha256}`,
    );

    const { artifact, integrity, report, sha1, sha256 } = first;
    const npmVersion = /^npm\/([^\s]+)/u.exec(process.env.npm_config_user_agent ?? "")?.[1] ?? null;
    const evidence = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      package: {
        name: report.name,
        version: report.version,
        filename: report.filename,
        checksumFilename: `${report.filename}.sha256`,
        sizeBytes: artifact.byteLength,
        unpackedSizeBytes: report.unpackedSize,
        entryCount: report.entryCount,
        sha1,
        sha256,
        integrity,
        bundled: [...report.bundled].sort(),
        reproducibility: {
          packRuns: 2,
          byteForByte: true,
        },
      },
      environment: {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
        npm: npmVersion,
      },
    };
    const artifactPath = join(artifactDirectory, report.filename);
    const reportPath = join(artifactDirectory, "package-latest.json");
    const checksumPath = join(artifactDirectory, evidence.package.checksumFilename);
    await Promise.all([
      writeFile(artifactPath, artifact),
      writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8"),
      writeFile(checksumPath, `${sha256}  ${report.filename}\n`, "utf8"),
    ]);

    process.stdout.write(
      `${JSON.stringify({
        type: "local-package-complete",
        artifact: relative(repositoryRoot, artifactPath).split(sep).join("/"),
        checksum: relative(repositoryRoot, checksumPath).split(sep).join("/"),
        report: relative(repositoryRoot, reportPath).split(sep).join("/"),
        bytes: evidence.package.sizeBytes,
        entryCount: evidence.package.entryCount,
        sha256,
        reproduciblePackRuns: evidence.package.reproducibility.packRuns,
      })}\n`,
    );
  } finally {
    await rm(stagingRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Local packaging failed"}\n`);
  process.exitCode = 1;
});
