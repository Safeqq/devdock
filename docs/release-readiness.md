# Release Readiness

Audit date: 2026-10-07

DevDock has completed the implementation and verification gates in phases 0–7. The latest full native matrix passed at commit `635ad15` in [workflow 37342681182](https://github.com/Safeqq/devdock/actions/runs/37342681182), including build, typecheck, lint, unit, integration, installed-package lifecycle, and browser tests on Windows Server 2025 x64, macOS 15 arm64, and Ubuntu 24.04 x64.

## Local package evidence

- `npm run package:local` rebuilt `artifacts/devdock-0.0.0.tgz` with Node.js 24.21.0 and npm 11.19.0.
- The tarball is 6,064,061 bytes with an unpacked size of 30,326,937 bytes, contains 3,536 entries, and has SHA-256 `918c83bacf113068bbaca8634cb1677921945f6fde01a4c4427c3666248fb509`.
- The package contains the root CLI, README, changelog, and the five required runtime workspaces: daemon, web, contracts, platform, and storage.
- Internal DevDock `src` and `tests` directories, root development configuration, repository scripts, CI configuration, artifacts, and local docs are excluded.
- `npm run check:versions` verifies that all six manifests, internal dependency pins, and workspace lockfile entries use the root version before either package command builds an artifact. A temporary `9.9.9` skew test failed with both source-manifest and lockfile diagnostics as intended.
- `npm run package:local` now creates two isolated npm pack results, audits both, and requires byte-for-byte equality before promoting the tarball. It then writes ignored `artifacts/package-latest.json` and `artifacts/devdock-0.0.0.tgz.sha256` after independently matching npm's SHA-1 and SHA-512 integrity. The schema 2 report records the two successful pack attempts, SHA-256, sizes, 3,536 entries, 76 bundled dependencies including all five DevDock workspaces, and the pinned runtime identity without absolute local paths.
- `npm run verify:artifact` independently checks an existing tarball, schema 2 report, reproducibility evidence, and checksum against the current manifest. Its unit test accepts intact fixture bytes, rejects an unproven reproducibility claim, and rejects a same-size artifact after one byte is changed.
- `npm run verify:reproducible` first verifies the promoted artifact, then creates one isolated fresh npm pack and requires an exact byte match. Its unit test accepts current package inputs and rejects the previously valid artifact after an included README changes. `release:inspect` and the strict candidate gate include this freshness check as `artifact-current`.
- `npm run package:sbom` generates a deterministic CycloneDX 1.5 document from the production-only package-lock tree. It normalizes npm's checkout-folder root identity, removes volatile timestamps, derives the UUID from semantic content, and records a checksum plus hashes linking the SBOM to the lockfile and tarball. The 66,680-byte document has SHA-256 `be49ccdb19fa85aa8fc71c61e6e13fcce614f182aa474b5698ba011b7bb64ff0`, 79 components, 80 dependency nodes including the root, and exactly the same 76 unique package names as npm's bundled package report. `verify:sbom` rejects development components, inventory drift, stale inputs, local paths, URL credentials, and sensitive query parameters; readiness includes it as `sbom-evidence`.
- `npm run verify:clean-setup` copied 127 repository files to a fresh path, installed 104 packages, checked the pinned toolchain and workspace versions, and rebuilt every workspace successfully.
- `npm run verify:package` passed on Windows native. Its latest clean-prefix package test completed in 23.0 seconds after the build, installed the tarball under a path with spaces and Unicode, exercised CLI flags without creating state, started the normal daemon, paired through the dashboard, and shut it down through the native adapter.
- `npm run release:version -- 1.0.0 --date 2026-10-07` previewed all nine target files on the real repository while before/after SHA-256 checks proved that dry-run mode wrote nothing. Its end-to-end unit test also applied `1.2.3-rc.1` inside a temporary repository and verified every manifest, internal pin, lock entry, README filename, changelog heading/date, and final consistency check; invalid dates and an empty subsequent `Unreleased` section were rejected.
- `npm run release:inspect -- --target local|repository|npm` now records a target-aware readiness report without failing, while `npm run verify:candidate -- --target TARGET` applies the same checks as a strict gate. A complete temporary npm candidate passed; removing its license and making the root private produced the expected blockers and strict exit code 1.
- `npm run verify:release` passed on Windows native as the single local release gate: toolchain, workspace versions, typecheck, lint, 47 unit tests, 19 integration tests with one POSIX-only skip, 2 browser tests, clean setup, final local package, checksum, independent artifact verification, final fresh-repack comparison, and deterministic SBOM generation/verification all passed. Negative SBOM evidence tests reject stale lockfiles, substituted tarball hashes, and changed document bytes.

The current tarball was built from the current working tree, so it remains a local audit artifact until it is rebuilt from the exact commit that will be tagged. The new changelog, workspace-version and version-update tools, package-evidence/checksum writer, artifact verifier, readiness inspector, and version-derived assertions have only run on Windows locally; the existing three-OS evidence still applies to commit `635ad15` until the next matrix run.

## Release decisions still required

- Version: every manifest and internal dependency is still pinned to `0.0.0`. Choose whether the first release is `0.1.0`, `1.0.0`, or another SemVer version; `npm run release:version -- X.Y.Z --date YYYY-MM-DD` previews the exact metadata and changelog changes and `--write` applies them consistently.
- License: there is no `LICENSE` file or `license` package metadata. Choose the intended license before public distribution.
- Publication scope: decide independently whether to publish the Git repository, npm package, and 3:20 demo recording.
- Package metadata: the root package has no `repository` metadata. Add it when the repository publication target is known.
- Release history: `CHANGELOG.md` now records the completed work under `Unreleased`, but no version heading or Git tag exists yet.

The latest inspection confirms that workspace versions, internal workspace privacy, and package evidence already pass. The `local` target is blocked only by the placeholder version and pending changelog promotion. The `repository` target additionally requires license text, license metadata, and repository metadata. The `npm` target also requires deliberately removing `private: true` from the root package.

All six manifests use `private: true`, which currently protects the root and workspaces from accidental npm publication. Keep internal workspaces private unless a separate publication model is deliberately selected. Publishing, tagging, or uploading the demo requires explicit user authorization under `AGENT.md`.

## Sequence after those decisions

1. Choose the intended `local`, `repository`, or `npm` target and review it with `npm run release:inspect -- --target TARGET`.
2. Preview the chosen version and release date with `npm run release:version -- X.Y.Z --date YYYY-MM-DD`, review its nine target files, then rerun it with `--write`. This also promotes the non-empty `Unreleased` changelog content.
3. For a public repository or npm target, add the chosen license and final repository metadata. For npm publication, make only the root package publishable while keeping internal workspaces private.
4. Run `npm run verify:release`, followed by `npm run verify:candidate -- --target TARGET`, on the exact release tree.
5. Run the three-OS workflow on the exact release commit and retain the matching artifact evidence and SHA-256 checksum.
6. Create a version tag and publish only the destinations the user explicitly authorizes.
