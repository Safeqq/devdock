// Builds THIRD-PARTY-NOTICES.txt for the Windows installer. It covers what the installer adds
// beyond DevDock's own MIT code: the Rust crates compiled into the desktop shell (their own license
// files, or the standard text when a published crate has none), the Node.js runtime, the npm
// packages in the engine, and the bundled fonts. Standard texts come from apps/desktop/licenses,
// copied unchanged from SPDX license-list-data v3.27.0.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying|notice|copyright)([-._ ].*)?$/iu;
const STANDARD_LICENSES = ["MIT", "Apache-2.0", "BSD-3-Clause", "MPL-2.0"];

// Crates that end up in the shell for this target: normal dependencies reachable from the root
// package. Build-only and development dependencies are not shipped.
export function shippedCrates(metadata) {
  const packages = new Map(metadata.packages.map((entry) => [entry.id, entry]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const root = metadata.resolve.root;
  const seen = new Set();
  const pending = [root];
  while (pending.length > 0) {
    const id = pending.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dependency of nodes.get(id)?.deps ?? []) {
      if (dependency.dep_kinds.some((kind) => kind.kind === null)) pending.push(dependency.pkg);
    }
  }
  seen.delete(root);
  return [...seen]
    .map((id) => packages.get(id))
    .map((entry) => ({
      name: entry.name,
      version: entry.version,
      license: entry.license ?? null,
      authors: entry.authors ?? [],
      repository: entry.repository ?? null,
      directory: entry.manifest_path.replace(/[\\/]Cargo\.toml$/u, ""),
      licenseFile: entry.license_file ?? null,
    }))
    .sort((left, right) =>
      left.name === right.name
        ? left.version.localeCompare(right.version)
        : left.name.localeCompare(right.name),
    );
}

// The standard licenses named in a license expression, such as "MIT OR Apache-2.0" or the older
// "MIT/Apache-2.0". Each is offered when a crate ships no license file of its own.
export function standardLicensesIn(expression) {
  if (expression === null) return [];
  const identifiers = expression.split(/[\s()/]+|\bOR\b|\bAND\b/u).filter(Boolean);
  return STANDARD_LICENSES.filter((license) => identifiers.includes(license));
}

// License texts for one crate: its own files, or standard texts with its authors as the
// copyright holders.
export function crateLicenseTexts(crate, standardText) {
  const names = existsSync(crate.directory)
    ? readdirSync(crate.directory).filter((name) => LICENSE_FILE_PATTERN.test(name))
    : [];
  if (crate.licenseFile !== null && !names.includes(crate.licenseFile))
    names.push(crate.licenseFile);
  if (names.length > 0) {
    return names.sort().map((name) => readFileSync(join(crate.directory, name), "utf8").trim());
  }
  const licenses = standardLicensesIn(crate.license);
  if (licenses.length === 0) {
    throw new Error(
      `${crate.name} ${crate.version} ships no license file and its license (${crate.license}) has no standard text in apps/desktop/licenses`,
    );
  }
  const holders =
    crate.authors.length > 0
      ? crate.authors.map((author) => author.replace(/\s*<[^>]*>/u, "")).join(", ")
      : `the ${crate.name} authors${crate.repository ? ` (${crate.repository})` : ""}`;
  return licenses.map((license) =>
    standardText(license)
      .replace(/^Copyright \(c\) <year> <[^>]+>\.?\s*$/mu, `Copyright (c) ${holders}`)
      .trim(),
  );
}

// npm packages installed in the engine, from their package.json files.
export function enginePackages(nodeModules) {
  const found = new Map();
  const visit = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.name.startsWith("@")) {
        visit(path);
        continue;
      }
      const manifestPath = join(path, "package.json");
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        const license =
          typeof manifest.license === "string"
            ? manifest.license
            : (manifest.license?.type ?? null);
        found.set(`${manifest.name}@${manifest.version}`, {
          name: manifest.name,
          version: manifest.version,
          license,
        });
      }
      visit(join(path, "node_modules"));
    }
  };
  visit(nodeModules);
  return [...found.values()].sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );
}

export function renderNotices({ version, nodeVersion, packages, crates }) {
  const rule = "=".repeat(78);
  const lines = [
    `DevDock ${version} - third-party notices`,
    rule,
    "",
    "DevDock itself is released under the MIT License (LICENSE.txt in this folder).",
    "This installation also contains the following software from other authors.",
    "",
    `1. Node.js ${nodeVersion} (runtime\\). Its license, which also covers the components it`,
    "   bundles such as npm and corepack, is in runtime\\LICENSE. npm's own dependencies keep",
    "   their license files in runtime\\node_modules\\npm\\node_modules.",
    "",
    "2. npm packages in engine\\node_modules. Each package keeps its license file in its own",
    "   folder. The fonts in DevDock's interface are licensed under the SIL Open Font License",
    "   1.1; see fonts-LICENSE.txt in engine\\node_modules\\devdock\\node_modules\\@devdock\\web\\dist.",
    "",
    ...packages.map(
      (entry) => `   ${entry.name} ${entry.version}: ${entry.license ?? "license not declared"}`,
    ),
    "",
    "3. Rust crates compiled into devdock-desktop.exe. Source code for every crate, including",
    "   those under the Mozilla Public License 2.0, is available at",
    "   https://crates.io/crates/<name>/<version>.",
    "",
    ...crates.map(
      (crate) => `   ${crate.name} ${crate.version}: ${crate.license ?? "license not declared"}`,
    ),
    "",
    "4. The installer was built with NSIS (zlib license) and the nsis_tauri_utils plugin",
    "   (MIT OR Apache-2.0); neither stays on the computer after installation.",
    "",
    rule,
    "License texts of the Rust crates",
    rule,
  ];
  const textsToCrates = new Map();
  for (const crate of crates) {
    for (const text of crate.texts) {
      const users = textsToCrates.get(text) ?? [];
      users.push(`${crate.name} ${crate.version}`);
      textsToCrates.set(text, users);
    }
  }
  for (const [text, users] of textsToCrates) {
    lines.push("", `Used by: ${users.join(", ")}`, "-".repeat(78), "", text, "");
  }
  return `${lines.join("\r\n")}\r\n`;
}
