import { renameSync, writeFileSync } from "node:fs";

const readyFile = process.env.DEVDOCK_READY_FILE;
if (!readyFile) throw new Error("DEVDOCK_READY_FILE is required");

const bytesPerStream = 16 * 1024 * 1024;
const chunkSize = 64 * 1024;

async function writeFlood(stream, byte) {
  const chunk = Buffer.alloc(chunkSize, byte);
  let written = 0;
  while (written < bytesPerStream) {
    const count = Math.min(chunk.length, bytesPerStream - written);
    if (!stream.write(chunk.subarray(0, count))) {
      await new Promise((resolve) => stream.once("drain", resolve));
    }
    written += count;
  }
  await new Promise((resolve, reject) => {
    stream.write("\n", (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

await Promise.all([writeFlood(process.stdout, 0x6f), writeFlood(process.stderr, 0x65)]);
writeFileSync(`${readyFile}.tmp`, JSON.stringify({ parentPid: process.pid, bytesPerStream }));
renameSync(`${readyFile}.tmp`, readyFile);
process.exitCode = 7;
