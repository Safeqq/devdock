import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const suite = process.argv[2];
if (!["unit", "integration", "browser"].includes(suite)) {
  console.error("Choose a test suite: unit, integration, or browser.");
  process.exit(2);
}

const suiteDirectory = new URL(`../tests/${suite}/`, import.meta.url);
let entries;
try {
  entries = await readdir(suiteDirectory, { withFileTypes: true });
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  entries = [];
}

const files = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
  .map((entry) => fileURLToPath(new URL(entry.name, suiteDirectory)))
  .sort();

if (files.length === 0) {
  console.error(`No ${suite} tests exist yet; this suite is pending.`);
  process.exit(1);
}

const runner = spawn(process.execPath, ["--test", ...files], { stdio: "inherit" });
runner.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
runner.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
