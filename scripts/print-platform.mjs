import { release, version } from "node:os";

console.log(
  JSON.stringify({
    platform: process.platform,
    architecture: process.arch,
    osRelease: release(),
    osVersion: version(),
    node: process.version,
    runnerImage: process.env.ImageOS ?? null,
    runnerImageVersion: process.env.ImageVersion ?? null,
  }),
);
