// Writes DevDock_<version>_x64-setup.exe.sha256 next to the installer that `npm run desktop:bundle`
// built, in the usual "<hash> *<file>" form that `sha256sum -c` and the install guide's PowerShell
// check read.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const installer = join(
  root,
  "apps/desktop/src-tauri/target/release/bundle/nsis",
  `DevDock_${version}_x64-setup.exe`,
);
if (!existsSync(installer)) {
  console.error(`Installer not found: ${installer}`);
  process.exit(1);
}
const bytes = await readFile(installer);
const sha256 = createHash("sha256").update(bytes).digest("hex");
await writeFile(`${installer}.sha256`, `${sha256} *${basename(installer)}\n`);
console.log(
  JSON.stringify({
    type: "installer-checksum",
    file: basename(installer),
    bytes: bytes.length,
    sha256,
  }),
);
