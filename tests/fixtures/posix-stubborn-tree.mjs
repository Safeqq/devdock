import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

if (process.env.DEVDOCK_STUBBORN_CHILD === "1") {
  const server = createServer((request, response) => {
    if (request.url === "/ready") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ready" }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  process.on("SIGTERM", () => undefined);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address");
    console.log(JSON.stringify({ type: "stubborn-listening", port: address.port }));
  });
} else {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, DEVDOCK_STUBBORN_CHILD: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  process.on("SIGTERM", () => undefined);
  child.once("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.once("close", (code) => {
    process.exitCode = code ?? 1;
  });
}
