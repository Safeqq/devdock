import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const readyFile = process.env.DEVDOCK_READY_FILE;
if (!readyFile) throw new Error("DEVDOCK_READY_FILE is required");

process.stdout.write("devdock-job-stdout: café\n");
process.stderr.write("devdock-job-stderr: warning\n");

const child = spawn(
  process.execPath,
  [fileURLToPath(new URL("./http-server.mjs", import.meta.url))],
  {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "ignore"],
    detached: true,
    windowsHide: true,
  },
);

if (child.pid === undefined || child.stdout === null) {
  throw new Error("Orphan fixture child did not start");
}

let output = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  output += chunk;
  const end = output.indexOf("\n");
  if (end === -1) return;
  const line = output.slice(0, end);
  const event = JSON.parse(line);
  if (event.type !== "listening" || !Number.isInteger(event.port)) {
    throw new Error("Orphan fixture child did not report its port");
  }
  writeFileSync(
    `${readyFile}.tmp`,
    JSON.stringify({ parentPid: process.pid, childPid: child.pid, port: event.port }),
  );
  renameSync(`${readyFile}.tmp`, readyFile);
  // Deliberately leave the HTTP child running after its direct parent exits.
  process.exit(0);
});
