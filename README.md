# DevDock

DevDock is a local dashboard for developer projects and services. The planned flow is: register a trusted project, choose a service or profile, start it, inspect status and logs, open the app, and stop it.

Phase 0 established project tooling, runtime contracts, and an HTTP fixture. Phase 1 added a serialized supervisor and native process-tree experiments. Phase 2 added a project registry, safe `package.json` script discovery, SQLite persistence, and an npm launch plan. Phase 3 added the authenticated loopback API and React/Vite dashboard. Phase 4 added diagnostics, readiness, and profiles. Phase 5 added bounded restart, reconciliation, directed shutdown, and reliability gates. Phase 6 adds native Windows Job Object and POSIX process-group adapters, the same application contract suite on all three target OS families, and a self-contained local npm package. Native Windows verification is complete; the Phase 6 macOS/Linux CI gate must pass before cross-platform v1 support is claimed. See [platform support](docs/platform-support.md), [process contract](docs/process-contract.md), [Windows Job Object spike](docs/windows-job-spike.md), [storage contract](docs/storage-contract.md), [local API contract](docs/local-api-contract.md), and [progress](docs/progress.md).

## Setup

1. Install Node.js 24.21.0, which includes npm 11.19.0. The required versions are recorded in `.node-version` and `package.json`; `.npmrc` enforces them during installation.
2. Run `npm ci` from the repository root.
3. Run `npm run check:toolchain` to confirm the runtime and package manager.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Check the strict TypeScript contracts. |
| `npm run lint` | Lint and format-check source, scripts, tests, and configuration. |
| `npm run build` | Compile each workspace package to its ignored `dist/` output. |
| `npm run test:unit` | Build and test runtime contracts, supervisor behavior, and data directory mapping. |
| `npm run test:integration` | Test the HTTP fixture, CLI, cooperative process tree, Windows Job Object adapter and spike, project registry, SQLite persistence, and npm launch plan. |
| `npm run test:browser` | Build and test the dashboard in a real system Edge/Chrome browser. |
| `npm run package:local` | Build a self-contained installable tarball in `artifacts/`. |
| `npm run fixture:http` | Start the fixture on loopback using an available port. |
| `npm run fixture:tree` | Start a parent fixture that launches the HTTP child and shuts it down on Ctrl+C. |
| `npm run fixture:control` | Build and open the Windows fixture control CLI. |
| `npm run api:auth` | Build and start the loopback API auth prototype. |
| `npm run api:registry` | Build and start the authenticated project dashboard and API on port 4317. |

`npm run fixture:http` prints a JSON line containing its port. Open `http://127.0.0.1:<port>/ready` to see the readiness response, then press Ctrl+C to stop it. To select port 4300 in PowerShell, run `$env:PORT=4300; npm run fixture:http`. The repository-level `.env.example` only documents that non-secret fixture value. A service loads environment files only when their relative paths are explicitly saved in its configuration. Do not commit real secrets.

`npm run fixture:tree` prints a `tree-listening` event with the parent PID, child PID, and child HTTP port. Open its `/ready` URL, then press Ctrl+C. The parent asks the child to shut down and waits for its `close` event before exiting. The Windows integration test runs this tree under the supervisor beside an external HTTP sentinel using the same Node executable and script; it verifies that the managed child closes while the sentinel keeps serving requests.

The registry API and dashboard can run as a local server. Configuration discovery, environment diagnostics, and command preview do not execute project code. A service can reference environment files inside its cwd, list required key names, and configure a TCP or HTTP readiness probe for its expected loopback port. The daemon loads environment files as data when building a launch plan; key values remain in daemon memory and are never returned by the API. On Windows, macOS, and Linux, authenticated API clients can start a selected service, inspect process/readiness/ownership separately, stream its run logs, and stop its owned tree. The API accepts only the stored service ID and an empty lifecycle action body; it does not accept arbitrary command text or environment values.

`npm run api:auth` binds to `127.0.0.1:4317` and prints its origin and one-time pairing code to the terminal. Set `DEVDOCK_PORT=0` to choose an available port. The pairing code expires after five minutes and is never served by the API. The API currently exposes authenticated session status, session renewal, and an authenticated SSE connection. It does not yet expose project or process commands. Restart the prototype to create a new pairing code. Do not paste the code into a URL or share terminal output containing it.

`npm run api:registry` serves the dashboard and API at `http://127.0.0.1:4317` and stores registry data in the OS user data directory. Open that URL, enter the pairing code printed in the terminal, then register a trusted folder. Discovery, preview, and diagnostics only read configuration. Each service card can check whether its expected loopback port is currently available and whether required environment key names are present. The port result is advisory; DevDock never kills the listener or changes the configured port. On Windows, macOS, and Linux, each selected service also has status, Start, Stop, command preview, Open App, and a bounded live log view. A configured readiness probe changes from `checking` to `ready`, or stops the owned tree and records `failed/unhealthy` at timeout. Automatic restart is off by default; an opt-in failure policy limits both attempts and exponential backoff, and Stop cancels a pending restart. Profiles start dependencies before their consumers and wait for configured readiness. Startup failure rolls back only profile-started runs; a later dependency exit marks the profile `degraded` without automatically stopping its dependents. Only the selected service runtime opens an SSE connection, and closing the browser does not stop the service. Stop active services and profiles from a paired dashboard before archiving their project.

The browser tests use an installed Edge/Chrome executable and do not download a browser. They cover configuration without execution, profile creation, the real Start/readiness/log/tab-close/Stop service lifecycle, a successful profile Start/Stop, Open App URL validation, and secret filtering. The runner searches standard browser locations on each target OS; set `DEVDOCK_TEST_BROWSER` to an absolute browser executable path if needed.

The [platform contract workflow](.github/workflows/platform-spike.yml) is configured for Windows 2025 x64, macOS 15 arm64, and Ubuntu 24.04 x64 runners. It records runner details and runs the pinned toolchain, lint, typecheck, unit, integration, clean-package-install, and browser gates. CI results must be reviewed before recording a runner as verified.

## Local package

Run `npm run package:local` to create `artifacts/devdock-0.0.0.tgz`. The tarball contains the daemon, dashboard assets, platform helper, and runtime dependencies. It can be installed under any user-writable prefix without administrator access. Launch the installed `node_modules/devdock/bin/devdock.mjs` with the pinned Node executable; the entry point does not require a desktop wrapper or Unix shell. Set `DEVDOCK_PORT=0` to request a free loopback port. Ctrl+C and SIGTERM close the API and owned services; POSIX also handles SIGHUP, while a Windows parent or future desktop wrapper can send the IPC message `{ "type": "shutdown" }` for window-close cleanup.

## Windows fixture control

Run `npm run fixture:control` on native Windows, then type `start`, `inspect`, `stop`, `restart`, or `exit`, pressing Enter after each command. The CLI prints JSON events. `start` launches the HTTP fixture and prints its run ID and PID; a second `start` reuses the same run. The fixture prints its listening port. `inspect` reports process status, ownership, and readiness separately. `restart` waits for the old run to close before assigning a new run ID. `stop` asks the fixture to shut down over Node IPC and waits for process and stdio closure. `exit` also stops a running fixture.

This CLI holds its process handle only for the current session. A separate CLI invocation cannot inspect or stop an earlier run. If shutdown cannot be confirmed, the supervisor keeps the run in `stopping` and blocks replacement. The fixture-specific Windows adapter does not yet provide a safe forced process-tree stop; that capability will be investigated in Phase 1. There is no background daemon or interactive project-script control yet.

## Scope

DevDock will run scripts from projects that the user chooses and trusts. It is neither a sandbox for untrusted repositories nor a production process manager. The implementation roadmap and learning checkpoints are in [AGENT.md](AGENT.md).
