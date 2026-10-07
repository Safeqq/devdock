# Repeatable Demo Runbook

Status: repeatable runbook and automated 3–5 minute local recording verified on 2026-10-02; publication pending explicit authorization.

## Automated recording

Run `npm run demo:record` to build DevDock, generate a temporary dependency-free project, configure the real registry/runtime, drive the authenticated dashboard in a system Edge/Chrome browser, and encode ten captioned dashboard scenes. The command validates the WebM metadata, stops only processes it owns, verifies all three demo ports close, and removes the generated project. It never captures the desktop, terminal, pairing screen, or unrelated applications.

The current local artifact is `artifacts/devdock-demo.webm`; its machine-readable evidence is `artifacts/demo-recording-latest.json`. Both paths are ignored by Git. The verified recording is VP9 WebM, 1280×720, 200.437 seconds (3:20.437), and 11,516,165 bytes. Its SHA-256 is `f2e76b5ba8dc6b43a9428c00353663dcb4a50e94f037bc449b5acbdaec9000f8`. It has captions and no audio. It remains local and has not been published.

Set `DEVDOCK_DEMO_SCENE_MS=500` only for a short encoder and interaction smoke test. An override writes `artifacts/devdock-demo-smoke.webm` and `artifacts/demo-recording-smoke.json`, so it does not replace the final artifact. A default run enforces a total duration between three and five minutes.

## Prepare

1. Run `npm run demo:prepare`. It creates an ignored project under `artifacts/devdock-demo-*` and prints its absolute path plus three available ports. No existing directory is deleted.
2. Open the generated `demo-config.json`; keep its project path and ports visible.
3. From the generated project directory, start the external sentinel shown in `sentinelCommand`. Leave it running throughout the demo.
4. Run `npm run api:registry`, open its exact origin, and pair with the code printed in the terminal.
5. Register the generated project. Add these services:
   - `api`: use `env.api`, the recorded API port, and HTTP readiness `/ready` with 5,000 ms timeout.
   - `worker`: no environment file, port, or readiness probe.
   - `unhealthy`: use `env.unhealthy`, its recorded port, and HTTP readiness `/ready` with 1,000 ms timeout.
6. Create profile `Full Stack` with `api` as a dependency of `worker`.

The generated project contains no dependencies or secrets. Its scripts use the current Node executable, bind only to loopback, emit bounded demo logs, and handle SIGINT/SIGTERM where the platform supports graceful delivery.

## Recording sequence: 3–5 minutes

| Time | Action | Evidence to show |
| --- | --- | --- |
| 0:00–0:30 | Introduce the paired local dashboard and registered project. | Loopback URL, three selected scripts, no secret values. |
| 0:30–1:30 | Start `Full Stack`. | Dependency-first startup, API `Ready`, worker running, and separate live logs for both services. |
| 1:30–2:10 | Stop the profile, then query the sentinel `/ready` URL from its recorded port. | Both owned services stop while the external sentinel still returns HTTP 200. |
| 2:10–2:50 | Run the generated `conflictCommand`, run API diagnostics, then stop that temporary command. | Port status is `In use`; DevDock reports it without killing or changing the listener. |
| 2:50–3:40 | Start `unhealthy`. | Process enters `checking`, repeated HTTP 503 never becomes ready, timeout records `failed/unhealthy`, and the owned port closes. |
| 3:40–4:20 | Reopen API logs/status and summarize platform ownership. | Bounded log tail, explicit process/readiness states, Windows forced Job Object stop or POSIX graceful/escalated capability. |
| 4:20–5:00 | Stop the external sentinel and close DevDock. | Clean shutdown and no remaining demo listener. |

If a step takes longer, pause before the next action instead of cutting away a failed state. Do not display the pairing code, cookie, local project paths containing personal names, environment values, terminal history, or unrelated applications in a published recording.

## Verification and cleanup

After a manual recording, verify all three generated ports are closed. The manual demo project is under ignored `artifacts/`; delete that one generated `devdock-demo-*` directory when it is no longer needed. The automated command performs these checks and cleanup itself. Store recordings under `artifacts/` until publication is explicitly authorized. Publication is a separate user action and is not required to run DevDock locally.
