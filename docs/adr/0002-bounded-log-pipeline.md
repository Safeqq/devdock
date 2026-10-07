# ADR-0002: Bound Every Log Pipeline Stage

Status: Accepted

Date: 2026-10-02

## Context

An npm service can write faster than a browser can render or a network client can receive. Stopping reads from child pipes can block the service itself, while retaining all output makes daemon memory unbounded. UTF-8 characters and lines may also be split across arbitrary chunks.

## Decision

Continuously drain native stdout/stderr into bounded adapter queues, then decode and sanitize them in a per-run `RunLogBuffer`. One line is capped at 16 KiB; one run retains at most 5,000 lines or 5 MiB. Sequence numbers continue across eviction. SSE replay reports a gap when a cursor predates retained data, closes a client that cannot accept writes, and never controls child-pipe draining. The React view retains at most 500 rendered rows and owns only its current EventSource subscription.

Native adapter loss is emitted as a visible `[DevDock ... dropped N log bytes]` line. It is distinct from normal run-buffer eviction, which is represented by an SSE gap.

## Consequences

Memory and UI work remain bounded, and a disconnected or slow tab cannot stall the producer. DevDock is a live tail rather than a durable log archive; users must rely on application-owned files or an external logging system for complete history. Gap handling is part of the public event contract and must be preserved by future transports.
