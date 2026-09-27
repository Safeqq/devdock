import { createServer } from "node:http";

const rawPort = process.env.PORT ?? "0";
if (!/^\d+$/.test(rawPort)) {
  throw new Error("PORT must be an integer between 0 and 65535");
}
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error("PORT must be an integer between 0 and 65535");
}

const server = createServer((request, response) => {
  if (request.url === "/ready") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ status: "ready" }));
    return;
  }

  if (request.url === "/") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("DevDock fixture\n");
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found\n");
});

let closing = false;
function close() {
  if (closing) return;
  closing = true;
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
    process.disconnect?.();
  });
}

process.on("message", (message) => {
  if (message !== null && typeof message === "object" && message.type === "shutdown") {
    close();
  }
});
process.once("SIGINT", close);
process.once("SIGTERM", close);
process.once("disconnect", close);
server.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
  process.disconnect?.();
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP address");
  }
  console.log(JSON.stringify({ type: "listening", port: address.port }));
});
