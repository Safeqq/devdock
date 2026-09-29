import { renameSync, writeFileSync } from "node:fs";

const readyFile = process.env.DEVDOCK_READY_FILE;
if (!readyFile) throw new Error("DEVDOCK_READY_FILE is required");

process.stdout.write("natural stdout: café\n");
process.stderr.write("natural stderr: expected failure\n");
writeFileSync(`${readyFile}.tmp`, JSON.stringify({ pid: process.pid }));
renameSync(`${readyFile}.tmp`, readyFile);
process.exitCode = 7;
