// Starts the development build of the DevDock desktop shell with this repository's daemon.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const executable = join(
  repositoryRoot,
  "apps",
  "desktop",
  "src-tauri",
  "target",
  "debug",
  process.platform === "win32" ? "devdock-desktop.exe" : "devdock-desktop",
);
const app = spawn(executable, [], {
  env: {
    ...process.env,
    DEVDOCK_SIDECAR_NODE: process.execPath,
    DEVDOCK_SIDECAR_ENTRY: join(repositoryRoot, "apps", "daemon", "dist", "registry-api-cli.js"),
  },
  stdio: "inherit",
});
app.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
