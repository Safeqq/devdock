import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

// TypeScript never deletes outputs whose sources were removed, so a stale file in
// `dist` would silently ship inside the bundled package. Workspace builds call this
// from their own directory before `tsc`.
const workspaceRoot = process.cwd();
if (!existsSync(join(workspaceRoot, "package.json"))) {
  console.error(`Refusing to clean build output: ${workspaceRoot} has no package.json`);
  process.exit(1);
}

rmSync(join(workspaceRoot, "dist"), { force: true, recursive: true });
