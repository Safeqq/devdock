import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function runVerifier(root) {
  return spawnSync(process.execPath, [join(root, "scripts", "verify-package-artifact.mjs")], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
}

test("package evidence verifies intact bytes and rejects a same-size tampered artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "devdock evidence café-東京-"));
  try {
    await Promise.all([mkdir(join(root, "scripts")), mkdir(join(root, "artifacts"))]);
    await copyFile(
      join(sourceRoot, "scripts", "verify-package-artifact.mjs"),
      join(root, "scripts", "verify-package-artifact.mjs"),
    );
    const filename = "devdock-1.2.3.tgz";
    const checksumFilename = `${filename}.sha256`;
    const artifact = Buffer.from("devdock package fixture", "utf8");
    const sha1 = createHash("sha1").update(artifact).digest("hex");
    const sha256 = createHash("sha256").update(artifact).digest("hex");
    const integrity = `sha512-${createHash("sha512").update(artifact).digest("base64")}`;
    await Promise.all([
      writeFile(
        join(root, "package.json"),
        `${JSON.stringify({ name: "devdock", version: "1.2.3", private: true }, null, 2)}\n`,
      ),
      writeFile(join(root, "artifacts", filename), artifact),
      writeFile(join(root, "artifacts", checksumFilename), `${sha256}  ${filename}\n`),
      writeFile(
        join(root, "artifacts", "package-latest.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            generatedAt: "2030-02-03T00:00:00.000Z",
            package: {
              name: "devdock",
              version: "1.2.3",
              filename,
              checksumFilename,
              sizeBytes: artifact.byteLength,
              unpackedSizeBytes: 42,
              entryCount: 1,
              sha1,
              sha256,
              integrity,
              bundled: requiredWorkspaces,
            },
          },
          null,
          2,
        )}\n`,
      ),
    ]);

    const valid = runVerifier(root);
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /"type":"package-artifact-verified"/u);
    assert.match(valid.stdout, new RegExp(sha256, "u"));

    const tampered = Buffer.from(artifact);
    tampered[0] ^= 1;
    await writeFile(join(root, "artifacts", filename), tampered);
    const invalid = runVerifier(root);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /SHA-1 does not match/u);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
