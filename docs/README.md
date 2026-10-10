# DevDock Documentation

The documentation separates current behavior, evidence, and design decisions:

- [Install DevDock on Windows](install-windows.md) is the user guide for the desktop installer: SmartScreen, updating, uninstalling, and startup problems.
- [Local API contract](local-api-contract.md) lists authentication, project, service, profile, lifecycle, and SSE routes.
- [Storage contract](storage-contract.md) describes canonical paths, launch inputs, SQLite schema, and user data locations.
- [Process contract](process-contract.md) defines runtime ownership, stop capabilities, readiness, restart, and reconciliation.
- [Platform support](platform-support.md) records the exact OS, architecture, toolchain, and native CI evidence.
- [Windows Job Object spike](windows-job-spike.md) records the Win32 containment implementation and tested limits.
- [Performance](performance.md) records the reproducible local profiling workload and measured results.
- [Troubleshooting](troubleshooting.md) maps common symptoms to bounded diagnostic and recovery steps.
- [Demo runbook](demo.md) provides the repeatable Phase 7 demonstration sequence.
- [Portfolio usage](portfolio.md) records trusted-project use without storing project secrets.
- [Progress](progress.md) is the chronological implementation and verification checkpoint.
- [Desktop plan](desktop-plan.md) is the approved plan for turning DevDock into a Tauri desktop app, Windows first (Indonesian).

Architecture decisions are recorded under [`adr/`](adr/):

- [ADR-0001: Loopback local daemon](adr/0001-loopback-local-daemon.md)
- [ADR-0002: Bounded log pipeline](adr/0002-bounded-log-pipeline.md)
- [ADR-0003: Native process ownership](adr/0003-native-process-ownership.md)
