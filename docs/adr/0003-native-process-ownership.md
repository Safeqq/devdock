# ADR-0003: Require Native Process-Tree Ownership

Status: Accepted

Date: 2026-10-02

## Context

Stopping a root PID does not prove that npm descendants have stopped, and a PID can be reused. Searching or killing by executable name can terminate unrelated developer applications. Windows and POSIX expose different safe containment primitives.

## Decision

On Windows, create the root process atomically inside an owned Job Object and use the live job handle for inspection and forced termination. On macOS and Linux, create a new process group, signal the negative group ID with SIGTERM, and escalate to SIGKILL only after the grace timeout. In both cases, an opaque in-memory adapter object is required alongside the run ID and PID. Stored snapshots are history, never stop authority.

Windows reports graceful stop as unsupported. POSIX signal-0 `EPERM` means the group still exists; only `ESRCH` proves absence. Completion also waits for output closure. A daemon restart does not reconstruct ownership from process metadata.

## Consequences

DevDock stops only trees it can prove it owns and preserves external sentinels even when they use the same executable and script. Historical active runs can block replacement as `unknown` until manually reconciled. A trusted project can deliberately escape a POSIX process group, and detailed cross-restart adoption would require a future native broker or equivalent durable authority.
