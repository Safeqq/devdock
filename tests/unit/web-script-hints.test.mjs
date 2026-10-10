import assert from "node:assert/strict";
import { test } from "node:test";
// The module has no imports and only erasable TypeScript, so Node runs it directly.
import { isAutomaticScript, recommendedScript, scriptHint } from "../../apps/web/src/scripts.ts";

test("common script names get plain-language descriptions", () => {
  assert.deepEqual(scriptHint("dev", "vite"), {
    description: "Development server",
    kind: "keeps-running",
  });
  assert.deepEqual(scriptHint("build", "tsc && vite build"), {
    description: "Builds your app for release",
    kind: "runs-once",
  });
  assert.equal(scriptHint("test:e2e", "playwright test").description, "Runs some of your tests");
});

test("unknown names fall back to what the command does", () => {
  assert.equal(scriptHint("web", "vite build").kind, "keeps-running");
  assert.equal(scriptHint("bundle", "vite build").description, "Builds your app for release");
  assert.equal(scriptHint("ui", "vite --port 4000").description, "Development server");
  assert.equal(scriptHint("tests", "vitest run").description, "Runs your tests");
  assert.equal(scriptHint("compile-watch", "tsc --watch").kind, "keeps-running");
  assert.equal(
    scriptHint("api-only", "node --env-file=.env src/api.js").description,
    "Runs src/api.js",
  );
  assert.deepEqual(scriptHint("hook", 'node -e "console.log(1)"'), {
    description: null,
    kind: null,
  });
  assert.deepEqual(scriptHint("mystery", "make all"), { description: null, kind: null });
});

test("scripts npm runs by itself are recognised", () => {
  const names = new Set(["build", "prebuild", "postinstall", "prepare", "pretty", "dev"]);
  assert.equal(isAutomaticScript("prebuild", names), true);
  assert.equal(isAutomaticScript("postinstall", names), true);
  assert.equal(isAutomaticScript("prepare", names), true);
  assert.equal(isAutomaticScript("pretty", names), false);
  assert.equal(isAutomaticScript("dev", names), false);
});

test("the recommended script is the one most likely to run the app", () => {
  assert.equal(recommendedScript(["build", "start", "dev"]), "dev");
  assert.equal(recommendedScript(["build", "start"]), "start");
  assert.equal(recommendedScript(["build", "test"]), null);
});
