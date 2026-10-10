# Phase 3.1 local API contract

The auth prototype listens only on `127.0.0.1`; callers cannot select another bind address. It rejects an HTTP `Host` different from its exact loopback host and port. An `Origin` header, when present, must match its exact origin. Every mutation, including pairing, requires that matching `Origin`. The server does not enable CORS or trust proxy headers.

The CLI prints a random pairing code once after the server starts. The code is valid for five minutes, permits at most five failed code guesses, and is consumed by a successful `POST /api/pair` with JSON `{ "code": "..." }`. The response sets an opaque, host-only `devdock_session` cookie with `HttpOnly`, `SameSite=Strict`, `Path=/`, and an eight-hour lifetime. The response body contains a separate CSRF token and expiry time. Neither the pairing code nor the session token is stored in SQLite or returned by a read endpoint. This loopback HTTP prototype omits the cookie `Secure` attribute; any future HTTPS endpoint must set it.

All other API routes require the session cookie, including `GET /api/events` (SSE) and `GET /api/session`. The session endpoint returns the current CSRF token so a same-origin page can recover it after reload. Mutations also require `X-DevDock-CSRF` with that token. `POST /api/session/renew` requires the old token, rotates it, and extends the session. Responses use `Cache-Control: no-store`, and errors expose short codes without stack traces. At most eight SSE clients can connect. The auth-only CLI has no managed run; the registry CLI registers each npm run's real log buffer with SSE on every supported production platform.

Sessions live only in daemon memory. A daemon restart invalidates them and creates a new pairing code. This initial prototype supports one successful pairing per server start; after session expiry, restarting the prototype is the recovery path. A later interactive CLI can provide a deliberate re-pair action without restarting services. The cross-platform browser gate covers Start, log reception, tab close without process shutdown, session recovery in a new tab, and Stop.

## Project registry routes (3.2 API increment)

`npm run api:registry` opens the SQLite registry from the OS user data directory and listens at the fixed loopback port 4317. A second instance on that endpoint fails to bind. All routes below require the session; `POST` routes also require matching `Origin` and `X-DevDock-CSRF`. Path IDs must be registry UUIDs, and request bodies are runtime validated. Responses use the same safe error shape as the auth routes.

| Route | Purpose |
| --- | --- |
| `GET /api/projects` | List active projects. |
| `POST /api/projects` | Register a chosen directory with `{ "path": "...", "displayName": "..." }`; the name is optional. |
| `GET /api/projects/:id` | Read project detail, selected services, and profiles, including an archived project's metadata. |
| `GET /api/projects/:id/export` | Download the versioned non-secret project configuration as `devdock-configuration.json`. |
| `POST /api/projects/:id/archive` | Archive metadata without deleting source files. Returns 409 while any service or profile is active, or service ownership is unknown. |
| `GET /api/projects/:id/scripts?cwd=.` | Read `package.json` script names without executing them. |
| `POST /api/projects/:id/services` | Select a script with `{ "scriptName": "dev", "cwd": ".", "displayName": "Dev", "expectedPort": 4300, "readiness": { "kind": "http", "path": "/ready", "timeoutMs": 5000 }, "restartPolicy": { "kind": "off" }, "envFiles": [".env.local"], "requiredEnvKeys": ["DATABASE_URL"] }`; all but `scriptName` are optional, and readiness requires an expected port. |
| `GET /api/services/:id/preview` | Return npm executable, argument array, and canonical cwd; no environment values. |
| `GET /api/services/:id/open-app` | Return `http://127.0.0.1:<expectedPort>/` when a port is configured. This is a URL suggestion, not a readiness claim or redirect. |
| `GET /api/services/:id/diagnostics` | Check expected-port availability, configured environment-file status, and required key presence without returning values. |
| `GET /api/services/:id/status` | Return the latest in-memory or persisted run snapshot and current ownership result. |
| `POST /api/services/:id/start` | Start the selected npm script with an empty JSON object. An accepted run returns 202 with readiness `checking` when a probe is configured, otherwise `unknown`; an already-owned run returns 200 with the same run ID. |
| `POST /api/services/:id/stop` | Stop the owned process tree with an empty JSON object. Incomplete cleanup returns 409 and keeps the run blocked. |
| `POST /api/services/:id/delete` | Forget the service's settings, run history, and retained logs with an empty JSON object; returns `{ "id" }`. Returns 409 `SERVICE_ACTIVE` while a run is active or its ownership is unknown, and 409 `SERVICE_IN_GROUP` while a profile still lists it. The project's files are untouched. |
| `GET /api/services/:id/leftover` | For a run whose ownership is unknown, return `{ pid, processRunning, port, canMarkStopped }`: whether some process currently has the recorded PID, the configured port's availability, and whether this daemon session no longer holds the run. Both checks are hints only, because PIDs are reused and a busy port proves nothing about its owner. Returns 409 `RUN_NOT_UNKNOWN` when the status is known. |
| `POST /api/services/:id/mark-stopped` | Record, at the user's request, that a run left over from an earlier daemon session is gone: the snapshot becomes `stopped` with `reconciliationState: known` and reason `MARKED_STOPPED_BY_USER`, so Start is allowed again. Nothing is signalled or killed. Returns 409 `RUN_NOT_UNKNOWN` for a known status or a run the current session still holds (Stop is the way out there). |
| `POST /api/projects/:id/profiles` | Store a named profile with service IDs and `dependsOn` arrays. Members must belong to the project and form an acyclic graph. |
| `GET /api/profiles/:id/status` | Return the current in-memory profile operation and per-service states. |
| `POST /api/profiles/:id/start` | Queue a topological profile startup with an empty JSON object and return 202 for a new operation. |
| `POST /api/profiles/:id/stop` | Release the profile operation and stop eligible profile-managed runs after their final profile consumer leaves. |
| `POST /api/profiles/:id/update` | Replace a profile's name and members with the same body and validation as creating one; returns `{ profile }`. Returns 409 `PROFILE_ACTIVE` while the profile is starting, running, stopping, or still holds runs it started; the profile's last operation result is dropped after a change. |
| `POST /api/profiles/:id/delete` | Delete a stopped profile with an empty JSON object; returns `{ "id" }`. Its scripts and their settings stay. Returns 409 `PROFILE_ACTIVE` like update. |

The export format is `devdock.project-configuration` schema version 1. It assigns document-local references such as `service-1`, represents each cwd as path segments relative to the project root, and includes display names, selected npm scripts, ports, readiness, restart policy, environment file names, required key names, profiles, and dependency edges. It excludes project and service database IDs, absolute/display paths, filesystem identity, environment values, launch environment, run history, PIDs, logs, pairing/session/CSRF data, and timestamps. The response schema is strict so an accidental extra field fails before the document is sent. Export is read-only and authenticated; it does not require CSRF because it does not mutate state or execute a script.

The lifecycle endpoints never accept command text, executable paths, cwd, or environment values. They resolve the stored service again, verify that its selected script still exists, and create a fresh npm launch plan. Each service has a serialized supervisor backed by the native Windows Job Object or POSIX process-group adapter; daemon shutdown closes admission and stops its owned services. Platforms outside Windows, macOS, and Linux return 501 `SERVICE_CONTROL_UNAVAILABLE`. A spawn failure returns its validated failed snapshot with HTTP 500, and an unsafe overlapping start returns 409. Process, readiness, reconciliation, and ownership states remain separate facts.

Every supervisor transition is persisted in SQLite, including a natural terminal exit observed by the background monitor. A history-write failure is reported without dropping the live process handle or its monitor. During construction, a new runtime manager scans every stored service. A historical `starting`, `running`, or `stopping` snapshot without a live adapter handle changes immediately to `stopping` with `reconciliationState: unknown`. Start is rejected and Stop returns incomplete; the scan neither creates an adapter nor uses the stored PID as kill authority. The user can inspect such a run with `GET /api/services/:id/leftover` and, after closing any leftover program themselves, release it with `mark-stopped`. Cross-restart ownership proof and adoption remain future work.

The React page is served from the same loopback origin as the API. The HTML and hashed build assets are public so an unpaired browser can display the pairing form; project APIs remain session protected. A strict path allowlist, Fastify's static-file plugin, and Content Security Policy constrain public assets. Service cards show server snapshots, ownership, readiness, Start/Stop availability, command preview, and Open App. Unknown ownership blocks both lifecycle buttons. Native buttons, labels, focus styles, loading/error states, and connection labels provide the initial keyboard and accessibility behavior.

## Diagnostics (4.1 increment)

Environment file references are relative to the service cwd, limited to eight entries and 1 MiB per file, and cannot escape through `..`, an absolute path, or a resolved symlink. Files are parsed as dotenv data without executing them. The inherited launch allowlist is the base environment; configured files apply in list order and later files override earlier ones; the pinned Node directory is then prepended to the effective `PATH`. A missing, unreadable, invalid, oversized, or escaping file blocks Start. Required key names use portable identifier syntax and are checked against that effective environment before Start.

`GET /api/services/:id/diagnostics` is authenticated and read-only. It returns each configured file path and status, each required key name and a presence boolean, and `available`, `in_use`, `unknown`, or `not_configured` for the expected port. It never returns environment values. The port check briefly attempts an exclusive bind to `127.0.0.1`, immediately releases a successful bind, and never kills a listener or changes the configured port. Availability is advisory because another process can claim the port immediately after the check; an occupied port does not prove the listener belongs to this service.

The dashboard exposes the same configuration and renders diagnostics on demand. Environment values remain inside the daemon and launch payload. Command preview and diagnostics omit them. A project process may still print its own secrets to stdout/stderr, so log redaction remains best effort rather than a secrecy guarantee.

## Readiness probes (4.2 increment)

A service may configure TCP readiness or HTTP readiness with a path and a timeout from 1 to 60,000 ms. Both probe types connect only to the configured port on `127.0.0.1`. HTTP uses `GET`, accepts only 2xx responses, caps response headers, does not read the body, and never follows redirects. Paths beginning with an authority (`//`), fragments, and control characters are rejected at the runtime contract boundary.

After spawn, process state becomes `running` while readiness changes to `checking`. The probe retries within its total timeout. A success changes only readiness to `ready`. Timeout marks readiness `unhealthy`, stops the owned process tree through its existing adapter handle, and records the terminal run as `failed` with `READINESS_TIMEOUT`. User Stop and daemon shutdown abort an in-flight probe before stopping the process. A late result checks both service and run identity, so it cannot update a replacement run.

Start remains asynchronous and returns the `checking` snapshot. The dashboard polls authenticated status only while that state is active. A successful TCP connection or HTTP response proves that something answered at the configured loopback target; it does not prove process identity. Profile startup consumes the stored readiness state rather than treating process spawn as ready.

## Profiles and rollback (4.3–4.4 increment)

A profile contains 1–32 services from one project. Each member lists other profile members that must become usable first. Creation rejects duplicate members, self or outside references, cross-project services, and cycles. Cycle errors include the closed service-name path. Profiles are stored by SQLite schema version 2; operation snapshots and service leases remain in daemon memory because a daemon restart cannot reconstruct safe process ownership.

Profile Start creates an operation UUID, computes a deterministic topological order, and queues the operation through one coordinator. Each service starts only after its dependencies have reached `running/ready`; a service without a readiness probe is usable once its owned process is running. The API returns the initial `starting` snapshot while the dashboard polls profile status. A successful operation becomes `ready`. Stop can cancel a pending readiness wait and then releases services in reverse topological order.

The coordinator records the exact `runId` observed for every member. An `existing` run is marked `pre_existing` and is never made rollback-owned by that operation. A newly started run receives a profile lease. Multiple active profiles can consume the same lease: stopping one preserves the run, and the final consumer may stop it. Before every stop, the coordinator checks that the current snapshot has the same run ID and live ownership. A mismatch, unknown ownership, or incomplete stop is preserved rather than targeted by PID history.

If spawn, process lifetime, or readiness fails during startup, later services remain pending and the profile becomes `degraded`. The coordinator releases acquired members in reverse order. It stops only newly profile-managed runs with no remaining profile consumer; pre-existing and shared runs are displayed as `preserved`. The native integration gate starts a three-service profile, forces the last service to fail, proves the middle service is rolled back, and proves the manually started first service remains responsive.

After a profile reaches `ready`, the coordinator keeps bounded subscriptions to each exact member run. A later exit, failure, unhealthy readiness state, ownership loss, or run replacement changes that member and the profile to `degraded`. Other members are not stopped automatically. Their leases remain available so an explicit profile Stop can release and stop the still-owned runs in reverse dependency order.

## Reliability and shutdown (5.1–5.4 increment)

Automatic restart is represented in stored service configuration. `{ "kind": "off" }` is the default. `{ "kind": "on_failure", "maxAttempts": 3, "initialBackoffMs": 1000, "maxBackoffMs": 10000 }` restarts only terminal failures, uses capped exponential backoff, and allows at most ten configured attempts. A pending timer is tied to its source run ID and rechecks the active runtime before launch. User Stop and manual Start cancel the timer synchronously; daemon shutdown cancels every pending timer before stopping owned processes.

Closing the API stops new admission, ends SSE responses, clears heartbeat timers and log subscriptions, closes profile observers, cancels readiness/restart work, and then stops service runtimes. Remaining HTTP keep-alive connections are force-closed only after these cleanup hooks run, so an abandoned SSE client cannot keep daemon shutdown pending. Log buffers detach their stream listeners during eviction and shutdown.

The packaged registry CLI handles SIGINT and SIGTERM on every target OS and SIGHUP on POSIX. Windows parents and desktop wrappers can request the same cleanup over the inherited Node IPC channel, which models window-close without requiring a GUI wrapper in the package. The clean-install gate launches the packaged ESM entry directly with Node, verifies the public page does not contain the pairing code, completes a real pair request, checks the platform data-directory database, and then exercises the appropriate shutdown path.

## Per-run SSE transport (3.3 increment)

When a run log buffer is registered with the API, `GET /api/events?runId=<uuid>` replays its retained log events, then follows new events on the same connection. `after=<sequence>` supplies an initial cursor; an SSE `Last-Event-ID` header takes precedence on reconnect. Each `log` event has an integer SSE ID and a runtime-validated JSON envelope with daemon session ID, run ID, sequence, timestamp, stream, and text. If the cursor predates the retained buffer, the server first sends a `gap` event describing the oldest and latest retained sequences. Invalid or future cursors return 400; an unknown run ID returns 404. This route uses the same session and Host/Origin checks as the rest of the API.

The server keeps no separate application-level queue for a viewer. If an HTTP write signals backpressure, that SSE connection closes after its buffered output; a reconnect can replay retained events or receive a gap marker if they have been evicted. Log capture continues without a viewer. `ServiceRuntimeManager` registers real npm stdout/stderr before the Start response is returned. When the run-buffer collection exceeds 50 entries, it evicts the oldest completed buffers while preserving active runs. The dashboard opens one EventSource for the selected service, validates every log/gap envelope, renders at most 500 recent rows, reports connecting/live/disconnected state, and closes the EventSource when selection changes or the page unmounts. Browser and API gates exercise reconnect after `Last-Event-ID`, retained-buffer gaps, and a real npm run producing more rows than the UI limit. One SSE connection currently selects one run; multiplexing across services remains unnecessary for the current UI.

## Desktop sidecar control (8.x increment)

The registry daemon's ready line is `{"type":"registry-api-ready","origin":"...","pairingCode":"...","projectNode":{"source":"path"|"daemon","executable":"..."}}`.

When started with `DEVDOCK_CONTROL=stdin`, as the desktop shell does, the daemon reads JSON lines of at most 1,024 characters from stdin:

| Line | Effect |
| --- | --- |
| `{"type":"issue-pairing-code"}` | Replaces the pairing code and prints `{"type":"pairing-code","pairingCode":"..."}`. The new code has the normal five-minute lifetime and attempt limit; the previous code stops working; an existing session stays valid until a successful pairing replaces it. |
| `{"type":"shutdown"}` | Starts the same graceful shutdown as SIGINT, SIGTERM, or the Node IPC `shutdown` message. |
| `{"type":"stop-all"}` | Stops every active profile, then every active service, while the daemon keeps running. Used by the tray's Stop all scripts. |
| End of input | The parent closed the pipe or exited, including a crash; the daemon shuts down gracefully instead of running without an owner. |

Other lines are ignored. Only the parent process holds the pipe, so this channel adds no network-reachable way to obtain a pairing code.

In this mode the daemon also prints, after its ready line:

| Line | Meaning |
| --- | --- |
| `{"type":"runtime-summary","active":N,"projects":[{"name":"...","active":N}]}` | How many services are starting, running, or stopping, in total and per project (at most 20 projects, sorted by name). Printed once at startup and again whenever the count changes; runs with unknown ownership are not counted. |
| `{"type":"script-alert","title":"...","body":"..."}` | A run failed by exiting with an error, failing to launch, or missing its readiness deadline; printed once per run with notification text built from the script and project display names. A requested stop never produces an alert. |

Neither line carries paths, PIDs, or environment values.

The dashboard also accepts a pairing code injected by the desktop shell as `window.__DEVDOCK_DESKTOP__.pairingCode` through a webview initialization script. When `GET /api/session` returns 401, the page removes that value and submits it to `POST /api/pair`; if pairing fails, it shows the normal pairing form. The code never appears in a URL, browser history, or storage.
