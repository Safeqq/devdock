import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("../fixtures/http-server.mjs", import.meta.url));

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("Fixture did not exit before timeout"));
    }, timeoutMs);
    function onExit(code, signal) {
      clearTimeout(timer);
      resolve({ code, signal });
    }
    child.once("exit", onExit);
  });
}

function waitForListening(child, lines, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error("Fixture did not start before timeout")),
      timeoutMs,
    );
    function finish(error, port) {
      clearTimeout(timer);
      lines.off("line", onLine);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(port);
    }
    function onLine(line) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "listening" && Number.isInteger(event.port)) {
        finish(null, event.port);
      }
    }
    function onError(error) {
      finish(error);
    }
    function onExit(code) {
      finish(new Error(`Fixture exited before listening (code ${code})`));
    }
    lines.on("line", onLine);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

test("HTTP fixture becomes ready and closes cleanly", { timeout: 10_000 }, async () => {
  const child = spawn(process.execPath, [fixture], {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4_096);
  });

  try {
    const port = await waitForListening(child, lines, 3_000);
    assert.ok(port > 0 && port <= 65_535);

    const response = await fetch(`http://127.0.0.1:${port}/ready`, {
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ready" });

    await new Promise((resolve, reject) => {
      child.send({ type: "shutdown" }, (error) => (error ? reject(error) : resolve()));
    });
    const result = await waitForExit(child, 3_000);
    assert.equal(result.code, 0, stderr);
  } finally {
    if (!hasExited(child)) {
      child.kill("SIGKILL");
      await waitForExit(child, 2_000);
    }
    lines.close();
  }
});
