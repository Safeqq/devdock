import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifactsDirectory = join(repositoryRoot, "artifacts");

async function availablePort(excluded) {
  while (true) {
    const reservation = createServer();
    await new Promise((resolveListen, reject) => {
      reservation.once("error", reject);
      reservation.listen({ host: "127.0.0.1", port: 0 }, resolveListen);
    });
    const address = reservation.address();
    if (address === null || typeof address === "string") {
      reservation.close();
      throw new Error("Demo port reservation did not receive a TCP address");
    }
    await new Promise((resolveClose, reject) => {
      reservation.close((error) => (error ? reject(error) : resolveClose()));
    });
    if (!excluded.has(address.port)) return address.port;
  }
}

async function main() {
  await mkdir(artifactsDirectory, { recursive: true });
  const projectPath = await mkdtemp(join(artifactsDirectory, "devdock-demo-"));
  const ports = new Set();
  const apiPort = await availablePort(ports);
  ports.add(apiPort);
  const unhealthyPort = await availablePort(ports);
  ports.add(unhealthyPort);
  const sentinelPort = await availablePort(ports);

  await writeFile(
    join(projectPath, "package.json"),
    `${JSON.stringify(
      {
        name: "devdock-demo-project",
        private: true,
        type: "module",
        scripts: {
          api: "node service.mjs api",
          worker: "node worker.mjs",
          unhealthy: "node service.mjs unhealthy",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(projectPath, "service.mjs"),
    `import { createServer } from "node:http";

const mode = process.argv[2] ?? "api";
const port = Number(process.env.PORT);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

let sequence = 0;
const server = createServer((request, response) => {
  if (request.url === "/ready") {
    const healthy = mode !== "unhealthy";
    response.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ mode, healthy }));
    return;
  }
  response.writeHead(404).end();
});

server.listen({ host: "127.0.0.1", port }, () => {
  console.log(JSON.stringify({ type: "demo-listening", mode, port, pid: process.pid }));
});

const timer = setInterval(() => {
  sequence += 1;
  console.log(JSON.stringify({ type: "demo-log", mode, sequence }));
}, 500);

function close() {
  clearInterval(timer);
  server.close(() => process.exitCode = 0);
}

process.once("SIGINT", close);
process.once("SIGTERM", close);
`,
    "utf8",
  );
  await writeFile(
    join(projectPath, "worker.mjs"),
    `let sequence = 0;
console.log(JSON.stringify({ type: "worker-ready", pid: process.pid }));
const timer = setInterval(() => {
  sequence += 1;
  console.log(JSON.stringify({ type: "worker-log", sequence }));
}, 400);
function close() {
  clearInterval(timer);
  process.exitCode = 0;
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
`,
    "utf8",
  );
  await Promise.all([
    writeFile(join(projectPath, "env.api"), `PORT=${apiPort}\n`, "utf8"),
    writeFile(join(projectPath, "env.unhealthy"), `PORT=${unhealthyPort}\n`, "utf8"),
    writeFile(join(projectPath, "env.sentinel"), `PORT=${sentinelPort}\n`, "utf8"),
  ]);
  const configuration = {
    projectPath,
    apiPort,
    unhealthyPort,
    sentinelPort,
    services: {
      api: {
        envFile: "env.api",
        expectedPort: apiPort,
        readiness: { kind: "http", path: "/ready", timeoutMs: 5_000 },
      },
      worker: { envFile: null, expectedPort: null, readiness: null },
      unhealthy: {
        envFile: "env.unhealthy",
        expectedPort: unhealthyPort,
        readiness: { kind: "http", path: "/ready", timeoutMs: 1_000 },
      },
    },
    sentinelCommand: `node --env-file=env.sentinel service.mjs sentinel`,
    conflictCommand: `node --env-file=env.api service.mjs sentinel`,
  };
  await writeFile(
    join(projectPath, "demo-config.json"),
    `${JSON.stringify(configuration, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify({ type: "demo-ready", ...configuration })}\n`);
}

main().catch((caught) => {
  process.stderr.write(`${caught instanceof Error ? caught.stack : "Demo preparation failed"}\n`);
  process.exitCode = 1;
});
