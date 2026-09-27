# DevDock

DevDock is a local dashboard for developer projects and services. The planned flow is: register a trusted project, choose a service or profile, start it, inspect status and logs, open the app, and stop it.

Phase 0 established the project tooling, runtime contracts, and an HTTP fixture. Phase 1.2 adds a one-service supervisor to the Windows fixture control CLI. There is no persistent daemon or browser UI yet. The intended stack is a Node.js/TypeScript daemon with Fastify, a React/Vite browser UI, SQLite storage, and Server-Sent Events for live status and logs. The release target is native Windows, macOS, and Linux; full application support has not been verified on any of them. See [platform support](docs/platform-support.md), [process contract](docs/process-contract.md), and [progress](docs/progress.md).

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
| `npm run test:unit` | Build and test runtime service/run validation. |
| `npm run test:integration` | Test the HTTP fixture and Windows CLI with real child processes. |
| `npm run test:browser` | Reserved for the Phase 3 UI; exits with a pending message today. |
| `npm run fixture:http` | Start the fixture on loopback using an available port. |
| `npm run fixture:control` | Build and open the Windows fixture control CLI. |

`npm run fixture:http` prints a JSON line containing its port. Open `http://127.0.0.1:<port>/ready` to see the readiness response, then press Ctrl+C to stop it. To select port 4300 in PowerShell, run `$env:PORT=4300; npm run fixture:http`. The `.env.example` file documents that non-secret value but is not loaded automatically. Do not commit real secrets.

No persistent daemon or dashboard start command exists yet. The fixture tests establish only the one-service supervisor on native Windows, not a general project launcher or cross-platform application support.

## Windows fixture control

Run `npm run fixture:control` on native Windows, then type `start`, `inspect`, `stop`, `restart`, or `exit`, pressing Enter after each command. The CLI prints JSON events. `start` launches the HTTP fixture and prints its run ID and PID; a second `start` reuses the same run. The fixture prints its listening port. `inspect` reports process status, ownership, and readiness separately. `restart` waits for the old run to close before assigning a new run ID. `stop` asks the fixture to shut down over Node IPC and waits for process and stdio closure. `exit` also stops a running fixture.

This CLI holds its process handle only for the current session. A separate CLI invocation cannot inspect or stop an earlier run. If shutdown cannot be confirmed, the supervisor keeps the run in `stopping` and blocks replacement. The fixture-specific Windows adapter does not yet provide a safe forced process-tree stop; that capability will be investigated in Phase 1. There is no background daemon or project-script launcher yet.

## Scope

DevDock will run scripts from projects that the user chooses and trusts. It is neither a sandbox for untrusted repositories nor a production process manager. The implementation roadmap and learning checkpoints are in [AGENT.md](AGENT.md).
