# Changelog

All notable changes to DevDock will be documented in this file.

## Unreleased

## 0.2.0 - 2026-10-11

### Added

- A stdin control channel for running the daemon as a desktop sidecar: a parent can request shutdown or a fresh pairing code, and the daemon shuts down when the parent's pipe closes or the parent crashes.
- Automatic dashboard pairing from a code injected by the desktop shell, without the pairing form or a code in the URL.
- A single-instance lock per data directory, so the desktop app and CLI cannot manage the same services at once.
- A development build of the Windows desktop shell (Tauri v2) that runs the daemon as a hidden sidecar, pairs its window automatically, grants the native folder dialog only to the daemon's exact origin, blocks navigation away from it, and stops the daemon when the app exits.
- Desktop app lifecycle: the window hides to a tray icon with Open and Quit, a second launch shows the existing window, `--quit` stops a running instance, the window signs back in by itself when its session ends, and an error window with Try again and Close appears when the engine cannot start or stops unexpectedly.
- A redesigned interface for first-time users, used by both the desktop app and the browser dashboard: a welcome screen, an "Add this project?" preview of `package.json` before anything is saved, one card per script with a plain-language description and status, a Quick start hint, optional Script settings, tabbed output with Copy and Clear, groups, a project menu, and a sidebar with running and failed counts and the Node.js version in use. It uses a paper-and-ink theme with bundled fonts (SIL Open Font License 1.1) that work offline.
- API routes behind the new interface: `POST /api/folders/inspect` reads a folder without registering it, `POST /api/services/:id/settings` changes a script's optional settings, `GET /api/runtime/summary` counts running and failed scripts per project, and `GET /api/system` reports which Node.js runs projects. Script discovery now includes each script's command.
- DevDock recognizes the loopback address an app prints, such as Vite's `Local: http://localhost:5173/`, and uses it for Ready and Open when no port or readiness check is configured. Terminal colour codes are removed from output.
- The desktop app opens project addresses in the default browser and project folders in File Explorer, accepting only loopback addresses and existing folders.
- Groups can be edited and deleted while they are stopped, and a script's settings and run history can be reset (or a card without a `package.json` script removed) while it is stopped and not part of a group.
- A Check dialog for scripts whose status DevDock lost after it was closed abruptly: it shows whether the recorded process ID is in use and whether the port is busy, as hints only, and lets the user mark the run as stopped once it is gone. DevDock still never stops or adopts such a program itself.
- The desktop tray lists how many scripts run per project, shows the count in its tooltip, and offers Stop all scripts without quitting.
- Windows notifications from the desktop app when a script exits with an error, fails to launch, or misses its readiness deadline while the DevDock window is hidden or not focused.
- A per-user Windows installer for the desktop app (`npm run desktop:bundle`), carrying the official Node.js 24.21.0 runtime and the DevDock package; install and uninstall ask a running DevDock to quit first, and uninstalling keeps the user's data. `npm run desktop:verify-installer` and a Windows CI job install it silently, run an npm script with it, and uninstall it.
- `check:versions` and `release:version` now also cover the desktop crate's `Cargo.toml`, `Cargo.lock`, and `tauri.conf.json`.
- The installer carries `LICENSE.txt` and `THIRD-PARTY-NOTICES.txt`, which cover the Rust crates in the desktop app, the npm packages in the engine, Node.js, and the fonts. `npm run desktop:bundle` also writes a `.sha256` file next to the installer.
- An optional startup trace for the desktop app: when `DEVDOCK_SHELL_LOG` names a file, each startup step is appended to it.
- [Install DevDock on Windows](docs/install-windows.md), a user guide covering the SmartScreen warning, updating, uninstalling, and startup problems.

### Changed

- The desktop app icon now matches the paper-and-ink logo in the app.
- Projects now run with the first Node.js and npm found on the user's `PATH`, falling back to the Node.js running DevDock; the ready event reports which one is used.

## 0.1.0 - 2026-10-09

### Added

- A loopback-only dashboard and authenticated local API for registering trusted projects, discovering npm scripts, configuring services, and controlling their lifecycle.
- Native process-tree ownership through Windows Job Objects and POSIX process groups, with platform-specific shutdown behavior and external-process protection.
- SQLite-backed projects, services, profiles, settings, and run history with runtime validation and transactional migrations.
- Bounded realtime logs with UTF-8 handling, replay cursors, gap reporting, SSE backpressure protection, and a bounded dashboard view.
- Environment diagnostics, TCP and HTTP readiness probes, dependency-aware profiles, shared-service leases, rollback, bounded restart policies, and conservative restart reconciliation.
- A self-contained `devdock` CLI package with side-effect-free help and version commands, clean-prefix installation tests, and a repeatable local packaging command.
- Three-OS CI coverage, workload profiling, clean-setup verification, a repeatable dashboard demo, and validation against two trusted projects.
- Local release gates plus a dry-run-first workspace version command that keeps manifests, internal dependencies, the lockfile, changelog release heading, and README package names synchronized.
- Audited local package evidence containing verified npm integrity, SHA-256, package sizes, entry counts, bundled dependencies, and runtime identity without local absolute paths.
- A portable SHA-256 checksum and independent artifact verifier that rejects stale evidence or same-size byte tampering.
- Target-aware release readiness inspection for local, repository, and npm candidates, with an optional strict gate and non-secret ignored report.
- Byte-for-byte reproducibility verification across two isolated npm pack attempts before a local artifact is promoted.
- Independent fresh-repack verification that detects when a valid promoted tarball no longer matches current package inputs.
- Deterministic CycloneDX 1.5 production SBOM generation bound to exact lockfile versions, package URLs, SHA-512 integrity, distribution sources, and the promoted package inventory, with path and credential validation.
- Deterministic third-party license inventory and evidence verification derived from the production SBOM.
- MIT license text, license metadata on the root package and all five workspaces, and repository, homepage, and issue-tracker metadata for the GitHub repository.

### Security

- Pairing codes are emitted locally once, authenticated mutations require CSRF protection, and Host and Origin checks restrict browser access.
- Environment values, pairing data, logs, run history, and absolute local paths are excluded from exported project configuration.
- Process termination requires live adapter ownership; historical PIDs alone never authorize a kill.

### Reliability

- Lifecycle operations are serialized per service and tied to run IDs so stale probes, timers, and watchers cannot mutate replacement runs.
- Output queues, log retention, rendered rows, SSE clients, retries, timeouts, and cleanup paths all have explicit bounds.
- Native Windows, macOS, and Linux gates exercise build, typecheck, lint, unit, integration, installed-package, and browser behavior.
- Workspace builds clear previous compiler output first, so outputs from deleted sources can no longer end up in the bundled package.
- The packaged CLI no longer bundles React, ReactDOM, or `scheduler`; the dashboard ships as prebuilt static files, which shrinks the tarball by 85 entries and about 8.3 MB unpacked.
- On Windows, launch environments resolve allowlisted variables case-insensitively, so a copied environment containing `SYSTEMROOT` still gives services the `SystemRoot` that Node.js needs to start.
