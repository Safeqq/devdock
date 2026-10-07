# Changelog

All notable changes to DevDock will be documented in this file.

## Unreleased

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

### Security

- Pairing codes are emitted locally once, authenticated mutations require CSRF protection, and Host and Origin checks restrict browser access.
- Environment values, pairing data, logs, run history, and absolute local paths are excluded from exported project configuration.
- Process termination requires live adapter ownership; historical PIDs alone never authorize a kill.

### Reliability

- Lifecycle operations are serialized per service and tied to run IDs so stale probes, timers, and watchers cannot mutate replacement runs.
- Output queues, log retention, rendered rows, SSE clients, retries, timeouts, and cleanup paths all have explicit bounds.
- Native Windows, macOS, and Linux gates exercise build, typecheck, lint, unit, integration, installed-package, and browser behavior.
