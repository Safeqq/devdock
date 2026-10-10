import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  crateLicenseTexts,
  enginePackages,
  renderNotices,
  shippedCrates,
  standardLicensesIn,
} from "../../scripts/desktop-notices.mjs";

function crate(id, directory, extra = {}) {
  return {
    id,
    name: id,
    version: "1.0.0",
    license: "MIT",
    authors: [],
    manifest_path: join(directory, "Cargo.toml"),
    ...extra,
  };
}

const standardText = (license) =>
  `${license} TEXT\n\nCopyright (c) <year> <copyright holders>\n\nbody of ${license}\n`;

test("only crates the shell links are noticed, not build or dev dependencies", () => {
  const metadata = {
    packages: [
      crate("app", "/app"),
      crate("runtime-dep", "/runtime"),
      crate("nested-dep", "/nested"),
      crate("build-only", "/build"),
      crate("dev-only", "/dev"),
    ],
    resolve: {
      root: "app",
      nodes: [
        {
          id: "app",
          deps: [
            { pkg: "runtime-dep", dep_kinds: [{ kind: null }] },
            { pkg: "build-only", dep_kinds: [{ kind: "build" }] },
            { pkg: "dev-only", dep_kinds: [{ kind: "dev" }] },
          ],
        },
        { id: "runtime-dep", deps: [{ pkg: "nested-dep", dep_kinds: [{ kind: null }] }] },
        { id: "nested-dep", deps: [] },
        { id: "build-only", deps: [] },
        { id: "dev-only", deps: [] },
      ],
    },
  };
  assert.deepEqual(
    shippedCrates(metadata).map((entry) => entry.name),
    ["nested-dep", "runtime-dep"],
  );
});

test("standard licenses are read from old and new license expressions", () => {
  assert.deepEqual(standardLicensesIn("MIT OR Apache-2.0"), ["MIT", "Apache-2.0"]);
  assert.deepEqual(standardLicensesIn("MIT/Apache-2.0"), ["MIT", "Apache-2.0"]);
  assert.deepEqual(standardLicensesIn("(MIT OR Apache-2.0) AND Unicode-3.0"), [
    "MIT",
    "Apache-2.0",
  ]);
  assert.deepEqual(standardLicensesIn("Unicode-3.0"), []);
  assert.deepEqual(standardLicensesIn(null), []);
});

test("a crate's own license files win; otherwise standard texts name its authors", async () => {
  const root = await mkdtemp(join(tmpdir(), "devdock-notices-"));
  try {
    const own = join(root, "own");
    const bare = join(root, "bare");
    await Promise.all([mkdir(own), mkdir(bare)]);
    await Promise.all([
      writeFile(join(own, "LICENSE-MIT"), "Copyright (c) Own Author\n"),
      writeFile(join(own, "NOTICE"), "Own notice\n"),
      writeFile(join(own, "lib.rs"), "fn main() {}\n"),
    ]);
    assert.deepEqual(
      crateLicenseTexts(
        {
          name: "own",
          version: "1.0.0",
          license: "MIT",
          authors: [],
          directory: own,
          licenseFile: null,
        },
        standardText,
      ),
      ["Copyright (c) Own Author", "Own notice"],
    );

    const texts = crateLicenseTexts(
      {
        name: "bare",
        version: "2.0.0",
        license: "MIT OR Apache-2.0",
        authors: ["Ada Lovelace <ada@example.com>", "Grace Hopper"],
        repository: null,
        directory: bare,
        licenseFile: null,
      },
      standardText,
    );
    assert.equal(texts.length, 2);
    assert.match(texts[0], /^MIT TEXT/u);
    assert.match(texts[0], /Copyright \(c\) Ada Lovelace, Grace Hopper/u);
    assert.doesNotMatch(texts[0], /ada@example\.com|<year>/u);
    assert.match(texts[1], /^Apache-2\.0 TEXT/u);

    const anonymous = crateLicenseTexts(
      {
        name: "anon",
        version: "1.0.0",
        license: "MIT",
        authors: [],
        repository: "https://example.com/anon",
        directory: bare,
        licenseFile: null,
      },
      standardText,
    );
    assert.match(
      anonymous[0],
      /Copyright \(c\) the anon authors \(https:\/\/example\.com\/anon\)/u,
    );

    assert.throws(
      () =>
        crateLicenseTexts(
          {
            name: "odd",
            version: "1.0.0",
            license: "LicenseRef-Custom",
            authors: [],
            directory: bare,
            licenseFile: null,
          },
          standardText,
        ),
      /odd 1\.0\.0 ships no license file/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("engine packages are found in scoped and nested node_modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "devdock-notices-npm-"));
  try {
    const modules = join(root, "node_modules");
    const write = async (path, manifest) => {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "package.json"), JSON.stringify(manifest));
    };
    await write(join(modules, "plain"), { name: "plain", version: "1.0.0", license: "MIT" });
    await write(join(modules, "@scope", "pkg"), {
      name: "@scope/pkg",
      version: "2.0.0",
      license: { type: "ISC" },
    });
    await write(join(modules, "plain", "node_modules", "inner"), {
      name: "inner",
      version: "3.0.0",
    });
    assert.deepEqual(enginePackages(modules), [
      { name: "@scope/pkg", version: "2.0.0", license: "ISC" },
      { name: "inner", version: "3.0.0", license: null },
      { name: "plain", version: "1.0.0", license: "MIT" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("identical license texts are printed once with every crate that uses them", () => {
  const notices = renderNotices({
    version: "9.9.9",
    nodeVersion: "v24.21.0",
    packages: [{ name: "plain", version: "1.0.0", license: "MIT" }],
    crates: [
      { name: "a", version: "1.0.0", license: "MIT", texts: ["SHARED"] },
      { name: "b", version: "2.0.0", license: "MIT", texts: ["SHARED", "B ONLY"] },
    ],
  });
  assert.match(notices, /^DevDock 9\.9\.9 - third-party notices/u);
  assert.match(notices, /Node\.js v24\.21\.0/u);
  assert.match(notices, /plain 1\.0\.0: MIT/u);
  assert.equal(notices.match(/SHARED/gu)?.length, 1);
  assert.match(notices, /Used by: a 1\.0\.0, b 2\.0\.0\r\n-+\r\n\r\nSHARED/u);
  assert.match(notices, /Used by: b 2\.0\.0\r\n-+\r\n\r\nB ONLY/u);
  assert.ok(notices.includes("\r\n"));
});
