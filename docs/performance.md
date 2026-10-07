# Performance Profile

## Scope and method

`npm run profile:local` builds DevDock, launches the API/runtime manager in a dedicated daemon process, and starts one npm service through the production native adapter. The service exposes only loopback profiling endpoints. Resource samples are taken every 50 ms from the daemon over IPC and from the workload child over HTTP, keeping their CPU and memory figures separate.

The normal workload emits 500 structured lines in batches while the driver performs 200 authenticated `GET status` requests and consumes live SSE. The flood workload emits 12,000 lines in paced batches, exceeding the 5,000-line run buffer without overwhelming the adapter. The driver then inspects the retained buffer and its replay gap. The raw report is written to ignored `artifacts/profile-latest.json`; rerunning the command replaces it.

## Recorded run

Date: 2026-10-02. Base commit: `1e9b5401d7afeffca178809b86016b27412de071`, with uncommitted Phase 7 profiling files present.

| Environment | Value |
| --- | --- |
| OS | Windows 11 Pro, build 10.0.26200, native x64 |
| Runtime | Node.js 24.21.0 |
| CPU | AMD Ryzen 7 5800X, 8 cores / 16 logical processors |
| Physical memory | 17,102,823,424 bytes |
| Services | 1 production-adapter npm service |
| Sampling | 50 ms resource interval; 200 API requests |

| Measurement | Result | Initial hypothesis |
| --- | --- | --- |
| Control API latency | p50 0.80 ms; p95 1.59 ms; p99 2.65 ms; max 3.86 ms | p95 below 200 ms: met for this run |
| Normal log delivery | 500/500 live events; 328.73 lines/s observed | No live loss: met |
| Normal log latency | p50 1 ms; p95 2 ms; p99 3 ms; max 4 ms | p95 below 500 ms: met for this run |
| Flood retention | 12,000 emitted; 4,999 workload events retained; 7,001 evicted | Bounded retention and visible gap: met |
| Flood transport | 1,605.72 source lines/s; 0 adapter-dropped bytes; gap sequences 7,508–12,507 | Adapter continues draining: met for this paced run |
| Daemon resources | RSS 80.35 MiB baseline, 99.75 MiB peak; heap 34.49 MiB peak; 3.08% of one logical core averaged over 9.623 s | Observation only |
| Workload child resources | RSS 56.10 MiB baseline, 60.11 MiB peak; heap 9.91 MiB peak; 0.17% of one logical core averaged over 9.622 s | Observation only |

The 7,001 unavailable flood events were retention eviction rather than adapter loss: the buffer reported a replay gap, held its configured 5,000 total entries including the completion marker, and reported zero dropped adapter bytes. CPU percentages are normalized to one logical core, so a multithreaded process could exceed 100%.

## Limits

This is one development-machine run, not a universal benchmark or release guarantee. The daemon sample includes Fastify, SQLite, the runtime manager, log parsing, and the profiling IPC handler. The workload-child sample excludes the npm wrapper and any OS-wide work. Windows timer scheduling reduced the configured flood pacing below its theoretical rate. Antivirus, power mode, concurrent applications, different filesystems, and later runtime or OS versions can materially change the result. Compare new runs only when their environment and workload configuration are recorded together.
