// The desktop shell carries the release version in three files that npm does not manage. They are
// edited as text so their formatting stays as Cargo and Tauri write it. A checkout without the
// desktop crate has nothing to check.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const crateDirectory = ["apps", "desktop", "src-tauri"];
const cratePackageName = "devdock-desktop";

const files = [
  {
    label: "apps/desktop/src-tauri/Cargo.toml",
    path: [...crateDirectory, "Cargo.toml"],
    // The first version line of the [package] table.
    pattern: /(^\[package\][^[]*?^version\s*=\s*")([^"\r\n]*)(")/mu,
  },
  {
    label: "apps/desktop/src-tauri/Cargo.lock",
    path: [...crateDirectory, "Cargo.lock"],
    pattern: new RegExp(
      `(^\\[\\[package\\]\\]\\r?\\nname = "${cratePackageName}"\\r?\\nversion = ")([^"\\r\\n]*)(")`,
      "mu",
    ),
  },
  {
    label: "apps/desktop/src-tauri/tauri.conf.json",
    path: [...crateDirectory, "tauri.conf.json"],
    // A top-level key: two-space indentation, as the file is written.
    pattern: /(^ {2}"version":\s*")([^"\r\n]*)(")/mu,
  },
];

// Returns each desktop version file with the version it declares, or an error when the version
// cannot be found. Returns an empty list when the desktop crate is not in this checkout.
export function readDesktopVersions(root) {
  if (!existsSync(join(root, ...crateDirectory, "Cargo.toml"))) return [];
  return files.map((file) => {
    const path = join(root, ...file.path);
    let contents;
    try {
      contents = readFileSync(path, "utf8");
    } catch (error) {
      return { label: file.label, path, error: error.message };
    }
    const match = file.pattern.exec(contents);
    return match === null
      ? { label: file.label, path, contents, error: "version not found" }
      : { label: file.label, path, contents, version: match[2] };
  });
}

// Change records that move every desktop version file from `current` to `next`.
export function desktopVersionChanges(root, current, next) {
  return readDesktopVersions(root).map((entry) => {
    if (entry.error !== undefined) throw new Error(`${entry.label}: ${entry.error}`);
    if (entry.version !== current) {
      throw new Error(`${entry.label} does not use ${current}`);
    }
    const pattern = files.find((file) => file.label === entry.label).pattern;
    return {
      path: entry.path,
      original: entry.contents,
      next: entry.contents.replace(pattern, (_, before, _version, after) => {
        return `${before}${next}${after}`;
      }),
    };
  });
}
