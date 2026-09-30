import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { probeLoopbackReadiness } from "@devdock/platform";

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      assert.notEqual(address, null);
      assert.equal(typeof address, "object");
      resolveListen(address.port);
    });
  });
}

function close(server) {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

test("TCP and HTTP readiness stay on loopback and reject redirects", async () => {
  let redirectRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/ready") {
      response.writeHead(204).end();
      return;
    }
    if (request.url === "/redirect") {
      redirectRequests += 1;
      response.writeHead(302, { location: "http://example.invalid/ready" }).end();
      return;
    }
    response.writeHead(503).end();
  });
  const port = await listen(server);
  try {
    assert.deepEqual(await probeLoopbackReadiness({ kind: "tcp", port, timeoutMs: 500 }), {
      kind: "ready",
    });
    assert.deepEqual(
      await probeLoopbackReadiness({ kind: "http", port, path: "/ready", timeoutMs: 500 }),
      { kind: "ready" },
    );
    assert.deepEqual(
      await probeLoopbackReadiness({
        kind: "http",
        port,
        path: "/redirect",
        timeoutMs: 150,
      }),
      { kind: "unhealthy", reason: "timeout" },
    );
    assert.ok(redirectRequests >= 1);
    assert.equal(server.listening, true);
  } finally {
    await close(server);
  }

  assert.deepEqual(await probeLoopbackReadiness({ kind: "tcp", port, timeoutMs: 120 }), {
    kind: "unhealthy",
    reason: "timeout",
  });
});

test("an aborted readiness probe finishes without waiting for its timeout", async () => {
  const reservation = createServer();
  const port = await listen(reservation);
  await close(reservation);
  const controller = new AbortController();
  const probe = probeLoopbackReadiness({ kind: "tcp", port, timeoutMs: 5_000 }, controller.signal);
  setTimeout(() => controller.abort(), 25);
  assert.deepEqual(await probe, { kind: "aborted" });
});
