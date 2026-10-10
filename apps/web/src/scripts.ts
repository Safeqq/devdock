// Plain-language hints about npm scripts, guessed from their names and commands. They only shape
// labels and ordering; DevDock always runs exactly the script from package.json.

export type ScriptKind = "keeps-running" | "runs-once";

export interface ScriptHint {
  // A short phrase such as "Development server", or null when nothing sensible can be guessed.
  readonly description: string | null;
  readonly kind: ScriptKind | null;
}

const byName: Record<string, ScriptHint> = {
  dev: { description: "Development server", kind: "keeps-running" },
  develop: { description: "Development server", kind: "keeps-running" },
  start: { description: "Starts your app", kind: "keeps-running" },
  serve: { description: "Serves your app", kind: "keeps-running" },
  server: { description: "Starts the server", kind: "keeps-running" },
  api: { description: "Starts the API", kind: "keeps-running" },
  backend: { description: "Starts the backend", kind: "keeps-running" },
  frontend: { description: "Starts the frontend", kind: "keeps-running" },
  web: { description: "Starts the web app", kind: "keeps-running" },
  preview: { description: "Previews the built app", kind: "keeps-running" },
  watch: { description: "Rebuilds when files change", kind: "keeps-running" },
  storybook: { description: "Opens Storybook", kind: "keeps-running" },
  build: { description: "Builds your app for release", kind: "runs-once" },
  compile: { description: "Compiles your code", kind: "runs-once" },
  test: { description: "Runs your tests", kind: "runs-once" },
  e2e: { description: "Runs end-to-end tests", kind: "runs-once" },
  lint: { description: "Checks your code", kind: "runs-once" },
  format: { description: "Formats your code", kind: "runs-once" },
  fmt: { description: "Formats your code", kind: "runs-once" },
  typecheck: { description: "Checks your types", kind: "runs-once" },
  "type-check": { description: "Checks your types", kind: "runs-once" },
  check: { description: "Checks your project", kind: "runs-once" },
  clean: { description: "Deletes build output", kind: "runs-once" },
  deploy: { description: "Deploys your app", kind: "runs-once" },
  release: { description: "Publishes a release", kind: "runs-once" },
  seed: { description: "Fills the database with sample data", kind: "runs-once" },
  migrate: { description: "Updates the database structure", kind: "runs-once" },
};

const byPrefix: Array<[string, ScriptHint]> = [
  ["dev:", { description: "Development server", kind: "keeps-running" }],
  ["start:", { description: "Starts part of your app", kind: "keeps-running" }],
  ["serve:", { description: "Serves part of your app", kind: "keeps-running" }],
  ["watch:", { description: "Rebuilds when files change", kind: "keeps-running" }],
  ["build:", { description: "Builds part of your app", kind: "runs-once" }],
  ["test:", { description: "Runs some of your tests", kind: "runs-once" }],
  ["lint:", { description: "Checks part of your code", kind: "runs-once" }],
  ["db:", { description: "Database task", kind: "runs-once" }],
];

// Ordered: the first matching rule wins, so "vite build" is checked before plain "vite".
const byCommand: Array<[RegExp, ScriptHint]> = [
  [/\b(?:vite|next|nuxt|astro|remix|svelte-kit)\s+build\b/u, byName.build as ScriptHint],
  [/\b(?:vite|astro)\s+preview\b|\bnext\s+start\b/u, byName.preview as ScriptHint],
  [
    /\b(?:vitest|jest|mocha|ava|playwright\s+test|cypress\s+run)\b|node\s+--test\b/u,
    byName.test as ScriptHint,
  ],
  [/\b(?:eslint|biome\s+(?:check|lint)|stylelint|oxlint)\b/u, byName.lint as ScriptHint],
  [/\b(?:prettier|biome\s+format)\b/u, byName.format as ScriptHint],
  [/\btsc\b(?![^&|;]*--watch)/u, { description: "Compiles TypeScript", kind: "runs-once" }],
  [/--watch\b|\bnodemon\b|\btsx\s+watch\b/u, byName.watch as ScriptHint],
  [
    /\b(?:vite|next\s+dev|nuxt\s+dev|astro\s+dev|webpack\s+serve|react-scripts\s+start|ng\s+serve)\b/u,
    byName.dev as ScriptHint,
  ],
  [/\b(?:rimraf|del-cli)\b|\brm\s+-rf?\b/u, byName.clean as ScriptHint],
];

// npm runs these on its own around install and publish, or before and after other scripts.
const automaticNames = new Set([
  "prepare",
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "prepublishOnly",
  "prepack",
  "postpack",
  "dependencies",
]);

export function scriptHint(name: string, command: string | null): ScriptHint {
  const known = byName[name];
  if (known !== undefined) return known;
  for (const [prefix, hint] of byPrefix) {
    if (name.startsWith(prefix)) return hint;
  }
  if (command !== null) {
    for (const [pattern, hint] of byCommand) {
      if (pattern.test(command)) return hint;
    }
    const file = /^node\s+(?:--?[\w-]+(?:=\S+)?\s+)*([^\s&|;"'-][^\s&|;"']*\.[cm]?[jt]s)\b/u.exec(
      command,
    )?.[1];
    if (file !== undefined) return { description: `Runs ${file}`, kind: null };
  }
  return { description: null, kind: null };
}

// True for scripts npm runs by itself, such as postinstall or a "pre" hook of another script.
// They stay available but are tucked away so they do not crowd the main cards.
export function isAutomaticScript(name: string, allNames: ReadonlySet<string>): boolean {
  if (automaticNames.has(name)) return true;
  for (const prefix of ["pre", "post"]) {
    if (name.startsWith(prefix) && allNames.has(name.slice(prefix.length))) return true;
  }
  return false;
}

const recommendedOrder = ["dev", "start", "serve", "develop", "preview"];

// The script most likely to run the app while someone works on it.
export function recommendedScript(names: readonly string[]): string | null {
  return recommendedOrder.find((name) => names.includes(name)) ?? null;
}
