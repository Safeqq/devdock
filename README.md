# DevDock

DevDock is a local dashboard for developer projects and services. The planned flow is: register a trusted project, choose a service or profile, start it, inspect status and logs, open the app, and stop it.

Phase 0 established project tooling, runtime contracts, and an HTTP fixture. Phase 1.4 adds a three-OS CI spike for cooperative fixture adapters; native Windows has been tested locally, while macOS and Linux CI results are pending. Phase 2 adds a project registry, safe `package.json` script discovery, SQLite persistence, and an npm launch plan. Phase 3 adds a loopback-only authenticated API and a React/Vite dashboard for project configuration, service control, command preview, validated Open App links, and live per-run logs. The Windows Job Object adapter is connected to authenticated Start, status, Stop, persisted run snapshots, and SSE. A native browser gate starts a real npm service, follows its readiness log, proves closing the tab leaves it running, opens a new tab, and stops its process tree. The release target is native Windows, macOS, and Linux; the complete Phase 3 gate is currently verified only on Windows. See [platform support](docs/platform-support.md), [process contract](docs/process-contract.md), [Windows Job Object spike](docs/windows-job-spike.md), [storage contract](docs/storage-contract.md), [local API contract](docs/local-api-contract.md), and [progress](docs/progress.md).

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
| `npm run fixture:http` | Start the fixture on loopback using an available port. |
| `npm run fixture:tree` | Start a parent fixture that launches the HTTP child and shuts it down on Ctrl+C. |
| `npm run fixture:control` | Build and open the Windows fixture control CLI. |
| `npm run api:auth` | Build and start the loopback API auth prototype. |
| `npm run api:registry` | Build and start the authenticated project dashboard and API on port 4317. |

`npm run fixture:http` prints a JSON line containing its port. Open `http://127.0.0.1:<port>/ready` to see the readiness response, then press Ctrl+C to stop it. To select port 4300 in PowerShell, run `$env:PORT=4300; npm run fixture:http`. The `.env.example` file documents that non-secret value but is not loaded automatically. Do not commit real secrets.

`npm run fixture:tree` prints a `tree-listening` event with the parent PID, child PID, and child HTTP port. Open its `/ready` URL, then press Ctrl+C. The parent asks the child to shut down and waits for its `close` event before exiting. The Windows integration test runs this tree under the supervisor beside an external HTTP sentinel using the same Node executable and script; it verifies that the managed child closes while the sentinel keeps serving requests.

The registry API and dashboard can run as a local server. Configuration discovery and preview do not execute project code. On Windows, authenticated API clients can start a selected service, inspect its current snapshot and ownership, stream its run logs, and stop its owned tree. The API accepts only the stored service ID and an empty action body; it does not accept arbitrary command text or environment values.

`npm run api:auth` binds to `127.0.0.1:4317` and prints its origin and one-time pairing code to the terminal. Set `DEVDOCK_PORT=0` to choose an available port. The pairing code expires after five minutes and is never served by the API. The API currently exposes authenticated session status, session renewal, and an authenticated SSE connection. It does not yet expose project or process commands. Restart the prototype to create a new pairing code. Do not paste the code into a URL or share terminal output containing it.

`npm run api:registry` serves the dashboard and API at `http://127.0.0.1:4317` and stores registry data in the OS user data directory. Open that URL, enter the pairing code printed in the terminal, then register a trusted folder. Discovery and preview only read configuration. On Windows, each selected service has status, Start, Stop, command preview, Open App, and a bounded live log view. Only the selected runtime opens an SSE connection, and closing the browser does not stop the service. Stop the service from a paired dashboard before archiving its project. Other platforms show `SERVICE_CONTROL_UNAVAILABLE` until their production tree adapters exist.

The browser tests use an installed Edge/Chrome executable and do not download a browser. On Windows they cover configuration without execution plus the real Start/log/tab-close/Stop lifecycle. The runner searches standard Edge locations; set `DEVDOCK_TEST_BROWSER` to an absolute browser executable path if needed. Browser results on macOS and Linux remain pending.

The [platform spike workflow](.github/workflows/platform-spike.yml) is configured for Windows 2025 x64, macOS 15 arm64, and Ubuntu 24.04 x64 runners. It records runner details and runs the pinned toolchain, lint, typecheck, unit tests, and integration tests. The POSIX fixture adapter uses the same cooperative IPC protocol as the Windows fixture adapter. CI results must be reviewed before recording macOS or Linux as verified; neither adapter currently provides forced process-tree termination.

## Windows fixture control

Run `npm run fixture:control` on native Windows, then type `start`, `inspect`, `stop`, `restart`, or `exit`, pressing Enter after each command. The CLI prints JSON events. `start` launches the HTTP fixture and prints its run ID and PID; a second `start` reuses the same run. The fixture prints its listening port. `inspect` reports process status, ownership, and readiness separately. `restart` waits for the old run to close before assigning a new run ID. `stop` asks the fixture to shut down over Node IPC and waits for process and stdio closure. `exit` also stops a running fixture.

This CLI holds its process handle only for the current session. A separate CLI invocation cannot inspect or stop an earlier run. If shutdown cannot be confirmed, the supervisor keeps the run in `stopping` and blocks replacement. The fixture-specific Windows adapter does not yet provide a safe forced process-tree stop; that capability will be investigated in Phase 1. There is no background daemon or interactive project-script control yet.

## Scope

DevDock will run scripts from projects that the user chooses and trusts. It is neither a sandbox for untrusted repositories nor a production process manager. The implementation roadmap and learning checkpoints are in [AGENT.md](AGENT.md).
