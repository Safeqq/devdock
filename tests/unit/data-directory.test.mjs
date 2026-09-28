import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDataDirectory } from "../../packages/platform/dist/index.js";

test("data directory follows the target OS and ignores relative overrides", () => {
  assert.equal(
    resolveDataDirectory(
      "win32",
      { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" },
      "C:\\Users\\Ada",
    ),
    "C:\\Users\\Ada\\AppData\\Local\\DevDock",
  );
  assert.equal(
    resolveDataDirectory("win32", { LOCALAPPDATA: "relative" }, "C:\\Users\\Ada"),
    "C:\\Users\\Ada\\AppData\\Local\\DevDock",
  );
  assert.equal(
    resolveDataDirectory("darwin", {}, "/Users/ada"),
    "/Users/ada/Library/Application Support/DevDock",
  );
  assert.equal(
    resolveDataDirectory("linux", { XDG_DATA_HOME: "/data/ada" }, "/home/ada"),
    "/data/ada/devdock",
  );
  assert.equal(
    resolveDataDirectory("linux", { XDG_DATA_HOME: "relative" }, "/home/ada"),
    "/home/ada/.local/share/devdock",
  );
  assert.throws(() => resolveDataDirectory("linux", {}, "relative"), {
    name: "DataDirectoryError",
  });
});
