# DevDock

DevDock is a local dashboard for developer projects and services. Register a trusted project, choose a service or profile, start it, inspect status and logs, open the app, and stop it from one loopback-only dashboard.

Phase 0 established project tooling, runtime contracts, and an HTTP fixture. Phase 1 added a serialized supervisor and native process-tree experiments. Phase 2 added a project registry, safe `package.json` script discovery, SQLite persistence, and an npm launch plan. Phase 3 added the authenticated loopback API and React/Vite dashboard. Phase 4 added diagnostics, readiness, and profiles. Phase 5 added bounded restart, reconciliation, directed shutdown, and reliability gates. Phase 6 added native Windows Job Object and POSIX process-group adapters, the same application contract suite on all three target OS families, and a self-contained local npm package. Phase 7 added profiling, non-secret configuration export, repeatable dashboard recording and clean-setup verification, plus evidence from two trusted real projects. The exact Windows 2025 x64, macOS 15 arm64, and Ubuntu 24.04 x64 matrix, including installed CLI, packed-content, SBOM, and license-inventory gates, passed on 2026-10-08 at commit `7ea89ea` in [workflow run 37820516272](https://github.com/Safeqq/devdock/actions/runs/37820516272).

## Setup

1. Install Node.js 24.21.0, which includes npm 11.19.0. The required versions are recorded in `.node-version` and `package.json`; `.npmrc` enforces them during installation.
2. Run `npm ci` from the repository root.
3. Run `npm run check:toolchain` and `npm run check:versions` to confirm the runtime, package manager, workspace manifests, internal dependency pins, and lockfile.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run check:versions` | Verify that every workspace, internal dependency, and lockfile entry uses the root version. |
| `npm run typecheck` | Check the strict TypeScript contracts. |
| `npm run lint` | Lint and format-check source, scripts, tests, and configuration. |
| `npm run build` | Compile each workspace package to its ignored `dist/` output. |
| `npm run test:unit` | Build and test runtime contracts, supervisor behavior, and data directory mapping. |
| `npm run test:integration` | Test fixtures, lifecycle APIs, project and profile persistence, clean package installation, and native Windows/POSIX process containment. |
| `npm run test:browser` | Build and test the dashboard in a real system Edge/Chrome browser. |
| `npm run profile:local` | Profile API latency, live/flood logs, and daemon/child resources with a native workload. |
| `npm run demo:prepare` | Create an ignored dependency-free project for the manual demo runbook. |
| `npm run demo:record` | Build and record the real dashboard demo to an ignored local WebM artifact. |
| `npm run portfolio:project` | Validate one explicitly trusted external npm service from environment-supplied configuration. |
| `npm run portfolio:self-host` | Run a trusted self-host lifecycle check without retaining paths or credentials. |
| `npm run verify:clean-setup` | Copy the current repository files to a fresh temporary path, install, check the toolchain and workspace versions, and build. |
| `npm run verify:package` | Build, pack, install, and exercise the CLI and daemon from a clean local prefix. |
| `npm run verify:artifact` | Verify an existing tarball against its evidence report and SHA-256 checksum file. |
| `npm run verify:reproducible` | Fresh-pack the current package inputs and require a byte-for-byte match with the promoted tarball. |
| `npm run verify:sbom` | Verify the production CycloneDX inventory against the package artifact and current lockfile. |
| `npm run verify:licenses` | Verify third-party license declarations against the current SBOM and package evidence. |
| `npm run verify:candidate -- --target TARGET` | Fail unless a `local`, `repository`, or `npm` release target has no remaining blockers. |
| `npm run verify:release` | Run the complete local release gate and finish by rebuilding the installable tarball. |
| `npm run release:version -- X.Y.Z` | Preview a synchronized manifest, lockfile, changelog, and README release update; add `--write` to apply it. |
| `npm run release:inspect -- --target TARGET` | Report release blockers without failing or publishing anything. |
| `npm run package:local` | Build and audit a self-contained tarball, then record its hashes in ignored artifacts. |
| `npm run package:sbom` | Generate a deterministic production CycloneDX SBOM and portable checksum. |
| `npm run package:licenses` | Generate a deterministic third-party license inventory from the verified SBOM. |
| `npm run fixture:http` | Start the fixture on loopback using an available port. |
| `npm run fixture:tree` | Start a parent fixture that launches the HTTP child and shuts it down on Ctrl+C. |
| `npm run fixture:control` | Build and open the cooperative fixture control CLI. |
| `npm run api:auth` | Build and start the standalone loopback auth fixture. |
| `npm run api:registry` | Build and start the authenticated project dashboard and API on port 4317. |

`npm run fixture:http` prints a JSON line containing its port. Open `http://127.0.0.1:<port>/ready` to see the readiness response, then press Ctrl+C to stop it. To select port 4300 in PowerShell, run `$env:PORT=4300; npm run fixture:http`. The repository-level `.env.example` only documents that non-secret fixture value. A service loads environment files only when their relative paths are explicitly saved in its configuration. Do not commit real secrets.

`npm run fixture:tree` prints a `tree-listening` event with the parent PID, child PID, and child HTTP port. Open its `/ready` URL, then press Ctrl+C. The parent asks the child to shut down and waits for its `close` event before exiting. The native integration test runs this tree under the supervisor beside an external HTTP sentinel using the same Node executable and script; it verifies that the managed child closes while the sentinel keeps serving requests.

The registry API and dashboard can run as a local server. Configuration discovery, environment diagnostics, and command preview do not execute project code. A service can reference environment files inside its cwd, list required key names, and configure a TCP or HTTP readiness probe for its expected loopback port. The daemon loads environment files as data when building a launch plan; key values remain in daemon memory and are never returned by the API. On Windows, macOS, and Linux, authenticated API clients can start a selected service, inspect process/readiness/ownership separately, stream its run logs, and stop its owned tree. The API accepts only the stored service ID and an empty lifecycle action body; it does not accept arbitrary command text or environment values.

`npm run api:auth` starts the standalone auth fixture on `127.0.0.1:4317` and prints its origin and one-time pairing code to the terminal. Set `DEVDOCK_PORT=0` to choose an available port. This fixture exposes session status, renewal, and authenticated SSE without loading the project registry; use `npm run api:registry` for the complete dashboard. The pairing code expires after five minutes, is never served by the API, and is renewed by restarting the fixture. Do not paste the code into a URL or share terminal output containing it.

`npm run api:registry` serves the dashboard and API at `http://127.0.0.1:4317` and stores registry data in the OS user data directory. Open that URL, enter the pairing code printed in the terminal, then register a trusted folder. Discovery, preview, diagnostics, and configuration export do not execute project scripts. Export downloads a versioned JSON document with relative cwd segments, service/profile settings, environment file names, and required key names; it omits absolute paths, environment values, run history, logs, and authentication data. Each service card can check whether its expected loopback port is currently available and whether required environment key names are present. The port result is advisory; DevDock never kills the listener or changes the configured port. On Windows, macOS, and Linux, each selected service also has status, Start, Stop, command preview, Open App, and a bounded live log view. A configured readiness probe changes from `checking` to `ready`, or stops the owned tree and records `failed/unhealthy` at timeout. Automatic restart is off by default; an opt-in failure policy limits both attempts and exponential backoff, and Stop cancels a pending restart. Profiles start dependencies before their consumers and wait for configured readiness. Startup failure rolls back only profile-started runs; a later dependency exit marks the profile `degraded` without automatically stopping its dependents. Only the selected service runtime opens an SSE connection, and closing the browser does not stop the service. Stop active services and profiles from a paired dashboard before archiving their project.

The browser tests use an installed Edge/Chrome executable and do not download a browser. They cover configuration without execution, profile creation, the real Start/readiness/log/tab-close/Stop service lifecycle, a successful profile Start/Stop, Open App URL validation, and secret filtering. The runner searches standard browser locations on each target OS; set `DEVDOCK_TEST_BROWSER` to an absolute browser executable path if needed.

The [platform contract workflow](.github/workflows/platform-spike.yml) is configured for Windows 2025 x64, macOS 15 arm64, and Ubuntu 24.04 x64 runners. It records runner details and runs the pinned toolchain, workspace-version, lint, typecheck, unit, integration, clean-package-install, reproducible-package, artifact, SBOM, license-inventory, and browser gates. Support is limited to those exact runner, OS, architecture, and toolchain combinations; later runner, OS, Node.js, or npm versions require a new passing result.

## Verification artifacts

`npm run profile:local` writes its current-machine JSON report to ignored `artifacts/profile-latest.json`. `npm run package:local` packs twice in isolated temporary directories, requires byte-for-byte identical tarballs, then writes non-secret size, entry count, SHA-1, SHA-256, npm SHA-512 integrity, all bundled dependency names, reproducibility evidence, and runtime identity to ignored `artifacts/package-latest.json`, plus a standard `devdock-<version>.tgz.sha256` checksum. `npm run verify:artifact` independently checks those files against the current manifest and rejects stale metadata, missing reproducibility evidence, or changed bytes. `npm run verify:reproducible` additionally creates a temporary fresh pack from the current package inputs and rejects a promoted tarball that is internally valid but no longer current. `npm run package:sbom` writes a deterministic CycloneDX 1.5 production inventory, evidence report, and checksum under ignored `artifacts/`; `npm run verify:sbom` binds that inventory to both the current lockfile and promoted tarball. `npm run package:licenses` derives a deterministic license inventory from that SBOM, while `npm run verify:licenses` requires license metadata for every third-party production component and binds its evidence to the SBOM and tarball. `npm run demo:prepare` creates an ignored, dependency-free demo project and prints the paths and ports needed by the demo runbook. `npm run demo:record` drives the actual loopback dashboard in a system Edge/Chrome browser, records only dashboard frames, validates the 3–5 minute WebM, and writes the video plus evidence report under ignored `artifacts/`. `npm run portfolio:self-host` validates the current trusted repository. `npm run portfolio:project` validates a separate project only after its absolute path, npm script, cwd, port, readiness, and explicit trust flag are supplied through the local environment; neither command retains paths or credentials in its ignored report. `npm run verify:clean-setup` copies all current non-ignored repository files to a fresh temporary checkout, runs the README toolchain setup and build, then removes that checkout.

## Local package

Run `npm run package:local` to create and audit `artifacts/devdock-0.1.0.tgz`, `artifacts/devdock-0.1.0.tgz.sha256`, and `artifacts/package-latest.json`. Packaging checks the required root files and five runtime workspaces, rejects internal source/test and root development files, verifies npm's SHA-1 and SHA-512 values, and promotes the artifact only after two independent pack attempts match byte for byte. Run `npm run verify:artifact` to verify the completed artifact set and its reproducibility evidence again without rebuilding it, then use `npm run verify:reproducible` to compare that artifact with a fresh temporary pack of the current inputs. The tarball contains the changelog, daemon, dashboard assets, platform helper, and runtime dependencies. Run `npm run verify:package` to rebuild that package, install it under a clean temporary prefix, exercise its CLI and dashboard startup, and remove the temporary installation. To install it manually under any user-writable prefix without administrator access:

Generate `artifacts/devdock-0.1.0.cdx.json` with `npm run package:sbom` after packaging, then run `npm run verify:sbom`. The generator uses the production-only package-lock tree, removes volatile timestamps, derives a deterministic UUID from normalized content, and normalizes root identity from the manifest so checkout directory names do not affect the result. Verification requires every production lockfile component, exact version and package URL; external components must also match the lockfile's SHA-512 integrity and distribution URL. It rejects development components, inventory drift, stale lockfile or tarball hashes, absolute paths, URL credentials, and sensitive URL query parameters.

Generate `artifacts/devdock-0.1.0.licenses.json` with `npm run package:licenses` after the SBOM is verified, then run `npm run verify:licenses`. Linked workspaces from the lockfile are listed separately from third-party components and carry the project's MIT license declaration. Every external production component must contain an ID, expression, or name supplied by the package metadata. This inventory records declarations and does not determine legal compatibility.

```text
npm install --ignore-scripts --no-audit --no-fund --prefix ./devdock-local ./artifacts/devdock-0.1.0.tgz
```

The prefix can be any user-writable folder; it does not need to be inside a project, and DevDock can register projects anywhere on disk. A folder outside source repositories, such as `%USERPROFILE%\tools\devdock` on Windows, keeps the installed files out of version control; this repository already ignores `devdock-local/`. Installing a release downloaded from GitHub works the same way with the tarball's path in place of `./artifacts/...`.

With a Node.js or npm version other than the pinned 24.21.0 and 11.19.0, npm prints an `EBADENGINE` warning and still installs; older Node.js 24 releases such as 24.11.1 also print an `ExperimentalWarning` for SQLite at startup. Windows PowerShell 5.1 shows these stderr warnings in red as `NativeCommandError`, but the install succeeded if npm ends with `added 1 package`, and the daemon is running once it prints its `registry-api-ready` line. Only the pinned versions are verified.

npm creates the command under `devdock-local/node_modules/.bin`. Launch it from PowerShell with:

```powershell
$env:DEVDOCK_PORT = "0"
& ".\devdock-local\node_modules\.bin\devdock.cmd"
```

On macOS or Linux, launch the same installed command with:

```sh
DEVDOCK_PORT=0 ./devdock-local/node_modules/.bin/devdock
```

Run `devdock --help` through the same installed command for usage, or `devdock --version` to print the package version without starting the daemon. The entry point does not require a desktop wrapper or Unix shell. Port `0` requests a free loopback port. Ctrl+C and SIGTERM close the API and owned services; POSIX also handles SIGHUP, while a Windows parent or future desktop wrapper can send the IPC message `{ "type": "shutdown" }` for window-close cleanup.

## Release preparation

Preview a synchronized version update without changing any file:

```text
npm run release:version -- 1.0.0 --date 2026-10-07
```

After reviewing the listed files, apply that version explicitly:

```text
npm run release:version -- 1.0.0 --date 2026-10-07 --write
```

The date is optional and defaults to the current UTC date. The command updates the root and five workspace manifests, exact internal dependency pins, workspace entries in `package-lock.json`, the tarball, SBOM, and license-inventory filenames shown in this README, and promotes the non-empty `Unreleased` changelog content under the selected version and date. It refuses inconsistent starting metadata, duplicate release headings, and invalid dates, then reruns `check:versions` after writing and restores every changed file if final validation fails. It does not change package privacy, choose a license, create a Git tag, or publish anything. Run `npm run verify:release` after applying the selected version.

Inspect remaining decisions with `npm run release:inspect -- --target local`, replacing `local` with `repository` or `npm` for stricter public metadata checks. The command writes an ignored, non-secret `artifacts/release-readiness-latest.json` report and exits successfully even when it finds blockers. Run `npm run verify:candidate -- --target TARGET` when the selected target should be complete; strict mode exits with code 1 while any blocker remains. Neither command creates a tag, changes package privacy, or publishes an artifact.

## Fixture control

Run `npm run fixture:control` on native Windows, macOS, or Linux, then type `start`, `inspect`, `stop`, `restart`, or `exit`, pressing Enter after each command. The CLI prints JSON events. `start` launches the HTTP fixture and prints its run ID and PID; a second `start` reuses the same run. The fixture prints its listening port. `inspect` reports process status, ownership, and readiness separately. `restart` waits for the old run to close before assigning a new run ID. `stop` asks the fixture to shut down over Node IPC and waits for process and stdio closure. `exit` also stops a running fixture.

This teaching CLI holds its process handle only for the current session and deliberately uses the cooperative fixture adapter. A separate invocation cannot inspect or stop an earlier run. If shutdown cannot be confirmed, the supervisor keeps the run in `stopping` and blocks replacement. Project scripts started through `api:registry` instead use the production Windows Job Object or POSIX process-group adapter; those adapters likewise never reconstruct stop authority from a stored PID after a daemon restart.

## Scope

DevDock will run scripts from projects that the user chooses and trusts. It is neither a sandbox for untrusted repositories nor a production process manager. The implementation roadmap and learning checkpoints are in [AGENT.md](AGENT.md).

## License

DevDock is released under the [MIT License](LICENSE).
