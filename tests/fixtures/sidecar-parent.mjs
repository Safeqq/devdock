// Stands in for the desktop shell (a non-Node parent): starts the daemon with a stdin control pipe, reports the
// daemon's PID and origin, then waits until the test kills this process.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [daemonEntry] = process.argv.slice(2);
if (!daemonEntry) throw new Error("daemon entry path is required");

const daemon = spawn(process.execPath, [daemonEntry], {
  env: { ...process.env, DEVDOCK_CONTROL: "stdin", DEVDOCK_PORT: "0" },
  // stderr is not inherited: a detached daemon holding the test's pipe would stall the runner.
  stdio: ["pipe", "pipe", "ignore"],
  // On Windows, libuv places non-detached children in a kill-on-close job, so they would die
  // with this Node.js parent regardless of DevDock. A Tauri shell does not do that; detaching
  // keeps the daemon outside that job so only its own stdin handling can stop it.
  detached: true,
  windowsHide: true,
});
createInterface({ input: daemon.stdout }).on("line", (line) => {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event.type === "registry-api-ready") {
    process.stdout.write(
      `${JSON.stringify({ type: "sidecar-started", pid: daemon.pid, origin: event.origin })}\n`,
    );
  }
});
setInterval(() => {}, 60_000);
