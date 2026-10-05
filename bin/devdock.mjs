#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const usage = `Usage: devdock [options]

Start the DevDock loopback dashboard and local service daemon.

Options:
  -h, --help     Show this help and exit
  -v, --version  Show the package version and exit

Environment:
  DEVDOCK_PORT   Loopback port from 0 to 65535 (default: 4317)
`;

async function readPackageVersion() {
  const contents = await readFile(new URL("../package.json", import.meta.url), "utf8");
  const metadata = JSON.parse(contents);
  if (metadata === null || typeof metadata !== "object" || typeof metadata.version !== "string") {
    throw new Error("DevDock package metadata does not contain a valid version");
  }
  return metadata.version;
}

const args = process.argv.slice(2);
if (args.length === 0) {
  await import("@devdock/daemon/start");
} else if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  process.stdout.write(usage);
} else if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
  process.stdout.write(`${await readPackageVersion()}\n`);
} else {
  process.stderr.write(`Unknown option: ${args.join(" ")}\nRun 'devdock --help' for usage.\n`);
  process.exitCode = 2;
}
