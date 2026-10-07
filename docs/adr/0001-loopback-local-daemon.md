# ADR-0001: Use a Loopback Local Daemon

Status: Accepted

Date: 2026-10-02

## Context

DevDock needs one owner for process handles, lifecycle serialization, log capture, SQLite access, and browser sessions. A static frontend cannot safely own child processes, while a remotely hosted control plane would expand the trust boundary and require transmitting local project metadata.

## Decision

Run one Node.js daemon on `127.0.0.1`. It serves the React application and JSON/SSE API from the same origin, stores configuration and history in the current user's data directory, and keeps live process authority only in memory. Pairing, an HttpOnly session cookie, CSRF tokens, exact Host/Origin checks, and no CORS protect local mutations from unrelated pages running on the same machine.

The daemon does not expose a configurable network bind address. Packaging launches the same daemon through a Node entry point; a desktop wrapper may later own that process and send the existing IPC shutdown message, but it does not replace the daemon architecture.

## Consequences

The browser can close without stopping services because the daemon owns them. Restarting the daemon invalidates sessions and loses live process authority, so historical active runs become `unknown` instead of being adopted by PID. Remote access, multi-user control, TLS, and production hosting are outside the current product boundary.
