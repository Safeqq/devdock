# Trusted Project Usage

Status: verified locally with two trusted real projects on 2026-10-04.

Phase 7.1 requires using DevDock with two projects the user already trusts. The generated demo and test fixtures do not count as real-project evidence. DevDock must not install dependencies during discovery, and no project script will be executed until its project path and script are deliberately selected.

For each chosen project, record only the following non-secret information:

| Field | Project 1 | Project 2 |
| --- | --- | --- |
| Display name | DevDock | TaskHarbor |
| Trusted path | Current DevDock repository root; absolute path deliberately omitted | Separate trusted repository; absolute path deliberately omitted |
| Selected npm script | `api:auth` | `dev` |
| Cwd relative to project | Project root (`.`) | `apps/web` |
| Expected loopback port | Dynamic; verified run used `63683` | `5173` |
| Environment file names | Temporary `.env.portfolio-self-host`, removed after Stop | None |
| Required key names | `DEVDOCK_PORT` | None |
| Readiness configuration | TCP, 30,000 ms timeout | HTTP `/`, 15,000 ms timeout |
| Start/log/Open App/Stop result | Passed through the authenticated API; `running/ready` with owned runtime, 39 retained events without a gap, loopback Open App URL matched, Stop released ownership, and the port closed | Passed through the authenticated API; HTTP 200, `running/ready` with owned runtime, 9 retained stdout events without a gap, loopback Open App URL matched, Stop released ownership, and port 5173 closed |
| Integration limitation | Self-host rather than an external repository; the script rebuilds first, TCP does not prove listener identity, the auth-only API has no dashboard at its root, and only npm scripts are supported | Frontend Vite only; API proxy behavior was outside this run, dependencies were already installed, and DevDock's Node/npm pin differs from TaskHarbor's development pin |

## Project 1 evidence

Run `npm run portfolio:self-host` with the pinned toolchain. The command builds DevDock, creates an isolated temporary registry, and uses the production process adapter to register the current repository and run `api:auth`. It checks discovery, command preview, diagnostics, versioned non-secret export, Start, readiness, bounded logs, an unauthenticated `401` from the nested API, Open App, Stop, ownership release, and port closure.

The latest machine-readable result is the ignored local file `artifacts/portfolio-self-host-latest.json`. It records Windows x64 with Node.js 24.21.0 and contains no absolute project path, database ID, PID, cookie, CSRF token, controller pairing code, nested pairing code, environment value, or log text. The temporary registry and environment file are removed even when verification fails.

## Project 2 evidence

Project 2 uses TaskHarbor's existing Vite dashboard. Its `dev` script binds to `127.0.0.1:5173`; HTTP `/` checks only the frontend listener, so the Rust API, PostgreSQL, worker, and proxy responses are outside this validation. The repository already had its dependencies installed, and DevDock did not install or update them.

Run the generic verifier with an explicitly trusted absolute path supplied only in the local shell:

```powershell
$env:DEVDOCK_PORTFOLIO_CONFIRMED_TRUSTED = "1"
$env:DEVDOCK_PORTFOLIO_PROJECT_PATH = "<trusted-taskharbor-root>"
$env:DEVDOCK_PORTFOLIO_PROJECT_NAME = "TaskHarbor"
$env:DEVDOCK_PORTFOLIO_CWD = "apps/web"
$env:DEVDOCK_PORTFOLIO_SCRIPT = "dev"
$env:DEVDOCK_PORTFOLIO_PORT = "5173"
$env:DEVDOCK_PORTFOLIO_READINESS_PATH = "/"
npm run portfolio:project
```

The ignored report `artifacts/portfolio-project-latest.json` omits the project path, IDs, PID, authentication data, environment values, and log text. The verified run returned HTTP 200, retained nine stdout events without a gap, and left TaskHarbor's Git worktree unchanged. DevDock stopped the owned Vite tree, proved port 5173 closed, and removed its temporary registry.

Do not copy environment values, tokens, cookies, pairing codes, source files, or full terminal output into this document. A project that intentionally daemonizes outside the native Job Object/process group, requires interactive stdin, binds only to a non-loopback interface, or depends on a package manager other than the currently supported npm launcher must have that limitation recorded rather than worked around with broad process kills. The generated demo and test fixtures remain excluded from the two-project evidence.
