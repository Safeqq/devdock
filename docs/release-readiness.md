# Release Readiness

Audit date: 2026-10-07

DevDock has completed the implementation and verification gates in phases 0–7. The latest full native matrix passed at commit `635ad15` in [workflow 37342681182](https://github.com/Safeqq/devdock/actions/runs/37342681182), including build, typecheck, lint, unit, integration, installed-package lifecycle, and browser tests on Windows Server 2025 x64, macOS 15 arm64, and Ubuntu 24.04 x64.

## Local package evidence

- `npm run package:local` rebuilt `artifacts/devdock-0.0.0.tgz` with Node.js 24.21.0 and npm 11.19.0.
- The tarball is 6,062,924 bytes with an unpacked size of 30,323,488 bytes, contains 3,536 entries, and has SHA-256 `4d1d72fc7c482bc45c971ecebe433c407da11fe3966f52d196c9adad31d1212b`.
- The package contains the root CLI, README, changelog, and the five required runtime workspaces: daemon, web, contracts, platform, and storage.
- Internal DevDock `src` and `tests` directories, root development configuration, repository scripts, CI configuration, artifacts, and local docs are excluded.
- `npm run check:versions` verifies that all six manifests, internal dependency pins, and workspace lockfile entries use the root version before either package command builds an artifact. A temporary `9.9.9` skew test failed with both source-manifest and lockfile diagnostics as intended.
- `npm run package:local` now writes ignored `artifacts/package-latest.json` and `artifacts/devdock-0.0.0.tgz.sha256` after auditing package contents and independently matching npm's SHA-1 and SHA-512 integrity against the tarball. The non-secret report records SHA-256, sizes, 3,536 entries, 76 bundled dependencies including all five DevDock workspaces, and the pinned runtime identity without absolute local paths.
- `npm run verify:artifact` independently checks an existing tarball, report, and checksum against the current manifest. Its unit test accepts intact fixture bytes and rejects a same-size artifact after one byte is changed.
- `npm run verify:clean-setup` copied 118 repository files to a fresh path, installed 104 packages, checked the pinned toolchain and workspace versions, and rebuilt every workspace successfully.
- `npm run verify:package` passed on Windows native. Its clean-prefix package test completed in 33.9 seconds after the build, installed the tarball under a path with spaces and Unicode, exercised CLI flags without creating state, started the normal daemon, paired through the dashboard, and shut it down through the native adapter.
- `npm run release:version -- 1.0.0 --date 2026-10-07` previewed all nine target files on the real repository while before/after SHA-256 checks proved that dry-run mode wrote nothing. Its end-to-end unit test also applied `1.2.3-rc.1` inside a temporary repository and verified every manifest, internal pin, lock entry, README filename, changelog heading/date, and final consistency check; invalid dates and an empty subsequent `Unreleased` section were rejected.
- `npm run verify:release` passed on Windows native as the single local release gate: toolchain, workspace versions, typecheck, lint, 43 unit tests, 19 integration tests with one POSIX-only skip, 2 browser tests, clean setup, final local package, checksum, and independent artifact verification all passed.

The current tarball includes uncommitted release-preparation changes, so it is a local audit artifact rather than a reproducible release candidate from a Git commit. Rebuild the final artifact from the exact commit that will be tagged. The new changelog, workspace-version and version-update tools, package-evidence/checksum writer, artifact verifier, and version-derived assertions have only run on Windows locally; the existing three-OS evidence still applies to commit `635ad15` until the next matrix run.

## Release decisions still required

- Version: every manifest and internal dependency is still pinned to `0.0.0`. Choose whether the first release is `0.1.0`, `1.0.0`, or another SemVer version; `npm run release:version -- X.Y.Z --date YYYY-MM-DD` previews the exact metadata and changelog changes and `--write` applies them consistently.
- License: there is no `LICENSE` file or `license` package metadata. Choose the intended license before public distribution.
- Publication scope: decide independently whether to publish the Git repository, npm package, and 3:20 demo recording.
- Package metadata: the root package has no `repository` metadata. Add it when the repository publication target is known.
- Release history: `CHANGELOG.md` now records the completed work under `Unreleased`, but no version heading or Git tag exists yet.

All six manifests use `private: true`, which currently protects the root and workspaces from accidental npm publication. Keep internal workspaces private unless a separate publication model is deliberately selected. Publishing, tagging, or uploading the demo requires explicit user authorization under `AGENT.md`.

## Sequence after those decisions

1. Commit the tracked README evidence update.
2. Preview the chosen version and release date with `npm run release:version -- X.Y.Z --date YYYY-MM-DD`, review its nine target files, then rerun it with `--write`. This also promotes the non-empty `Unreleased` changelog content.
3. Add the chosen license and final repository metadata.
4. Run the complete local gate and the three-OS workflow on the exact release commit.
5. Rebuild the tarball from that commit, rerun the clean-install package test and `verify:artifact`, then retain its evidence report and SHA-256 checksum.
6. Create a version tag and publish only the destinations the user explicitly authorizes.
