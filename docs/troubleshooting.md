# Troubleshooting

## Setup rejects Node.js or npm

Run `node --version`, `npm --version`, and `npm run check:toolchain`. DevDock currently pins Node.js 24.21.0 and npm 11.19.0, and `.npmrc` enables `engine-strict`. A shell can still resolve an older system `node` even when a portable npm executable was invoked directly, so ensure the pinned Node directory appears first on `PATH` for npm scripts and their child processes.

On Windows, keep the DevDock source checkout out of directories containing `cmd.exe` metacharacters such as `&`, `|`, `<`, `>`, or `^`. A clean-setup experiment with npm 11.19.0 installed successfully in a path containing `&`, but npm's workspace script PATH was then split by `cmd.exe`. Spaces and Unicode are covered by the supported clean-setup path.

## The dashboard does not open

`npm run api:registry` prints one JSON line containing `origin` and `pairingCode`. Use the exact loopback origin. `DEVDOCK_PORT=0` asks the OS for an available port; a fixed port already in use prevents startup. DevDock never binds to a non-loopback address.

## Pairing is rejected

The code expires after five minutes, permits at most five failed guesses, and is consumed after one successful pairing. Restart the daemon to create a new code. Do not put the code in a URL, issue report, screenshot, or committed file. A browser on another origin cannot pair because mutations require the exact `Origin` header.

## A project or script is missing

Confirm that the selected directory contains a valid `package.json` no larger than 1 MiB and that the desired entry is a non-empty string under `scripts`. Discovery reads JSON without running project code. A service cwd, environment file, or `package.json` symlink that resolves outside the canonical project root is rejected. Windows UNC paths are unsupported.

## Diagnostics reports a port conflict

The port check is advisory. It briefly attempts to bind `127.0.0.1` and never kills the existing listener. Stop the application that owns the port or update the trusted project's configuration. Do not kill processes by executable name or by a PID copied from DevDock history.

## A service runs but never becomes ready

Check the expected port and the configured TCP or HTTP readiness probe. HTTP readiness accepts only a loopback 2xx response and does not follow redirects. A timeout stops the tree DevDock owns and records `failed/unhealthy`. The probe establishes that an endpoint responded; it does not prove the endpoint's application identity.

## Start or Stop reports unknown ownership

After a daemon restart, a stored PID and historical `running` snapshot do not recreate the original Job Object or POSIX process-group authority. DevDock conservatively marks the run `stopping/unknown` and blocks replacement. Inspect the project outside DevDock and reconcile it manually; never use the stored PID alone as permission to terminate a process.

## Logs show a gap

Each run retains at most 5,000 lines or 5 MiB, and the browser renders at most 500 rows. A gap means the requested sequence has already been evicted. Reconnect to receive the retained tail. If a `[DevDock ... dropped N log bytes]` line appears, the native adapter also encountered producer pressure before the daemon buffer; reduce the producer rate and inspect the service's own durable logs if it has them.

## Browser tests cannot find Chrome or Edge

The test suite does not download a browser. Install a compatible system Edge/Chrome, or set `DEVDOCK_TEST_BROWSER` to its absolute executable path. The dashboard itself remains a normal browser application and does not require Playwright.

## Windows stops immediately instead of gracefully

The Windows production adapter intentionally reports graceful stop as unsupported and terminates its owned Job Object. macOS and Linux send SIGTERM to the owned process group and escalate to SIGKILL after the grace timeout. Project scripts that require application-specific shutdown hooks need an explicit future capability rather than an unsafe PID signal fallback.

## The SQLite database needs inspection or backup

Stop DevDock first, then back up `registry.sqlite` together with any `-wal` and `-shm` files present in the same data directory. The default directory is `%LOCALAPPDATA%\DevDock` on Windows, `~/Library/Application Support/DevDock` on macOS, and `${XDG_DATA_HOME:-~/.local/share}/devdock` on Linux. Do not edit applied migrations or copy a live main database file without its WAL state.

## A clean package installation is slow on Windows

The package currently contains thousands of bundled runtime files. The native CI clean install has taken about 93 seconds, so the integration command allows 120 seconds for an individual package command. A timeout does not justify disabling the clean-install gate; inspect disk, antivirus, and runner load first.
