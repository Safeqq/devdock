// Renders each mockup screen at the desktop window size into a PNG for review.
// Run from the repository root on Windows: node docs/mockups/d3/capture.mjs
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const page = new URL("./index.html", import.meta.url);
const candidates = [
  process.env.DEVDOCK_TEST_BROWSER,
  process.env["ProgramFiles(x86)"] &&
    join(process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
  process.env.ProgramFiles &&
    join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
].filter(Boolean);
let executablePath;
for (const candidate of candidates) {
  try {
    await access(candidate);
    executablePath = candidate;
    break;
  } catch {
    // Try the next installed browser.
  }
}
if (executablePath === undefined) throw new Error("No Edge installation found");

const browser = await chromium.launch({ executablePath, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  for (const screen of ["welcome", "project", "add", "advanced"]) {
    const tab = await context.newPage();
    await tab.goto(`${page.href}#${screen}`);
    await tab.screenshot({ path: fileURLToPath(new URL(`./${screen}.png`, import.meta.url)) });
    await tab.close();
  }
} finally {
  await browser.close();
}
console.log("captured welcome, project, add, and advanced");
