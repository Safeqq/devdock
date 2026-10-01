import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";
import {
  checkLoopbackPort,
  environmentReferenceStaysInside,
  inspectEnvironmentFiles,
} from "@devdock/platform";

function cleanupRoot(path, prefix) {
  const root = resolve(path);
  assert.equal(dirname(root), resolve(tmpdir()));
  assert.ok(basename(root).startsWith(prefix));
  return root;
}

test("environment files are parsed as data in configured precedence order", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "devdock-env-diagnostics-"));
  const safeRoot = cleanupRoot(tempRoot, "devdock-env-diagnostics-");
  const serviceRoot = join(tempRoot, "service");
  try {
    await mkdir(serviceRoot);
    await writeFile(
      join(serviceRoot, ".env"),
      "API_TOKEN=first-secret\nEMPTY_VALUE=\nUNICODE_VALUE='café-東京'\n",
      "utf8",
    );
    await writeFile(join(serviceRoot, ".env.local"), "API_TOKEN=last-secret\n", "utf8");
    await writeFile(join(serviceRoot, ".env.invalid"), Buffer.from([0xff, 0xfe, 0xfd]));
    const serviceAlias = join(tempRoot, "service-alias");
    await symlink(serviceRoot, serviceAlias, process.platform === "win32" ? "junction" : "dir");

    const inspected = await inspectEnvironmentFiles(serviceAlias, [
      ".env",
      ".env.local",
      ".env.missing",
      ".env.invalid",
      "../outside.env",
    ]);
    assert.deepEqual(inspected.files, [
      { path: ".env", status: "loaded" },
      { path: ".env.local", status: "loaded" },
      { path: ".env.missing", status: "missing" },
      { path: ".env.invalid", status: "invalid" },
      { path: "../outside.env", status: "outside_cwd" },
    ]);
    assert.equal(inspected.values.API_TOKEN, "last-secret");
    assert.equal(inspected.values.EMPTY_VALUE, "");
    assert.equal(inspected.values.UNICODE_VALUE, "café-東京");
    assert.equal(environmentReferenceStaysInside(serviceRoot, ".env"), true);
    assert.equal(environmentReferenceStaysInside(serviceRoot, "../outside.env"), false);
    assert.equal(
      environmentReferenceStaysInside(
        serviceRoot,
        isAbsolute(serviceRoot) ? serviceRoot : resolve(serviceRoot),
      ),
      false,
    );
  } finally {
    await rm(safeRoot, { recursive: true, force: true });
  }
});

test("loopback port diagnostics are advisory and leave an existing listener alive", async () => {
  const sentinel = createServer((socket) => socket.end());
  await new Promise((resolveListen, reject) => {
    sentinel.once("error", reject);
    sentinel.listen({ host: "127.0.0.1", port: 0 }, resolveListen);
  });
  const address = sentinel.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const port = address.port;
  try {
    assert.equal(await checkLoopbackPort(port), "in_use");
    assert.equal(sentinel.listening, true);
  } finally {
    await new Promise((resolveClose, reject) => {
      sentinel.close((error) => (error ? reject(error) : resolveClose()));
    });
  }
  assert.equal(await checkLoopbackPort(port), "available");
});
