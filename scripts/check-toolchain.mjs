import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const expectedNode = `v${manifest.engines.node}`;
const expectedNpm = manifest.engines.npm;
const npmUserAgent = process.env.npm_config_user_agent;
const actualNpm = /^npm\/([^\s]+)/.exec(npmUserAgent ?? "")?.[1];

const errors = [];
if (process.version !== expectedNode) {
  errors.push(`Node.js: expected ${expectedNode}, found ${process.version}`);
}
if (actualNpm !== expectedNpm) {
  errors.push(`npm: expected ${expectedNpm}, found ${actualNpm ?? "unknown"}`);
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exitCode = 1;
} else {
  console.log(`Toolchain OK: Node.js ${expectedNode}, npm ${expectedNpm}`);
}
