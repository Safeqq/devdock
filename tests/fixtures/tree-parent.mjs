import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const child = spawn(
  process.execPath,
  [fileURLToPath(new URL("./http-server.mjs", import.meta.url))],
  {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  },
);

if (child.stdout === null || child.stderr === null || child.pid === undefined) {
  throw new Error("Tree fixture child did not start with managed streams");
}

const lines = createInterface({ input: child.stdout });
child.stderr.pipe(process.stderr, { end: false });
lines.on("line", (line) => {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event.type === "listening" && Number.isInteger(event.port)) {
    console.log(
      JSON.stringify({
        type: "tree-listening",
        parentPid: process.pid,
        childPid: child.pid,
        port: event.port,
      }),
    );
  }
});

let closing = false;
function close() {
  if (closing) return;
  closing = true;
  if (!child.connected && child.exitCode === null && child.signalCode === null) {
    process.exitCode = 1;
    child.kill();
    return;
  }
  if (child.connected) {
    child.send({ type: "shutdown" }, (error) => {
      if (error) {
        console.error(error);
        process.exitCode = 1;
        child.kill();
      }
    });
  }
}

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
  close();
});
child.once("close", (code, signal) => {
  if (!closing || code !== 0) process.exitCode = 1;
  console.log(JSON.stringify({ type: "tree-child-closed", childPid: child.pid, code, signal }));
  lines.close();
  process.disconnect?.();
});

process.on("message", (message) => {
  if (message !== null && typeof message === "object" && message.type === "shutdown") close();
});
process.once("SIGINT", close);
process.once("SIGTERM", close);
process.once("disconnect", close);

// A failed test should not leave its fixture alive indefinitely.
setTimeout(close, 12_000).unref();
