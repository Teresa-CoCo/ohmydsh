# Upstream tracking

ohmydsh pins the upstream DeepSeek Harness release and the TUI plugin it was
verified against, and moves the pin with CI instead of floating dependencies.

## What is pinned

`upstream.json` is the only place the pin lives:

```json
{
  "schemaVersion": 1,
  "repository": "https://github.com/Teresa-CoCo/ohmydsh",
  "upstream": {
    "repository": "deepseek-ai/deepseek-harness",
    "npmPackage": "@deepseek-ai/dsh",
    "channel": "latest",
    "version": "0.2.0-rc.2",
    "publishedAt": "2026-10-06T06:30:20Z",
    "resolvedAt": "2026-10-06T00:00:00Z"
  },
  "tuiPlugin": {
    "npmPackage": "@deepseek-harness-tui/dsh-tui",
    "version": "0.13.0"
  },
  "profiles": {
    "tui": "ohmydsh-tui",
    "desktop": "ohmydsh-desktop"
  },
  "compat": {
    "verified": [
      {
        "dsh": "0.2.0-rc.2",
        "tuiPlugin": "0.13.0",
        "verifiedAt": "2026-10-06T00:00:00Z",
        "profiles": ["tui", "desktop"]
      }
    ]
  }
}
```

Field by field:

- `upstream.channel` — the npm dist-tag the pin resolves (`latest`, `next` or
  `alpha`); `upstream.version` / `publishedAt` — the pinned release and when npm
  published it; `resolvedAt` — when this repository recorded the pin.
- `tuiPlugin` — the TUI plugin package and version verified alongside that
  release.
- `profiles` — the profile name each surface uses.
- `compat.verified` — the `dsh` × `tuiPlugin` pairs that were verified together,
  each with `verifiedAt` and the profiles covered.

## How the pin is verified

`scripts/verify-composition.mjs` boots nothing: it composes the real dsh tree in
an isolated `DSH_HOME` and asserts that our rows survive — the permission
presets, the persona and the OMP agent preset must still appear in the composed
config for each profile.

```sh
node scripts/verify-composition.mjs --profile tui
node scripts/verify-composition.mjs --profile desktop
```

Under the hood this uses dsh's own no-boot composition:
`dsh --profile <name> --dump-config` prints `# == <layer>` markers for every
composed layer and reports unmatched patch targets on stderr. No API key is
needed. The verifier tolerates diagnostics attributable to upstream itself and
fails only on diagnostics attributable to ohmydsh.

## How CI proposes updates

`.github/workflows/upstream-watch.yml` runs the check and, when a newer release
exists on the pinned channel, opens a pull request from a
`chore/upstream-<version>` branch (`<version>` is the resolved upstream release)
that rewrites `upstream.json` and re-runs verification. If verification fails,
it opens an `upstream-break` issue instead, so the pin stays on the last
known-good release until the rows are reconciled.

## Channels and semver

- `upstream.channel` selects the npm dist-tag the sync resolves: `latest`,
  `next` or `alpha`. The pin currently rides `latest`.
- A proposal is made when the channel resolves to a release newer than
  `upstream.version`; the pin only moves forward.
- Prereleases follow semver ordering: `0.2.0-rc.2` sorts before `0.2.0`, and
  numeric identifiers compare numerically, so `0.2.0-rc.10` is newer than
  `0.2.0-rc.2`. The current pin is itself a prerelease.

## Compat table

`compat.verified` records which `dsh` and `tuiPlugin` versions were verified
together, with a timestamp and the profiles covered (`["tui", "desktop"]`). The
list is capped, so it keeps only recent pairs; if you need an older combination,
verify it yourself with the composition script.

## Manual runbook

```sh
pnpm upstream:check          # resolve newer upstream releases (network: npm + GitHub)
pnpm upstream:apply          # rewrite the pin and verify
pnpm verify                  # compose the real dsh tree
```

`upstream:check` and `upstream:apply` map to `scripts/upstream-sync.mjs --check`
and `--apply`. Call the script directly when you want machine-readable output:

```sh
node scripts/upstream-sync.mjs --check --json
```

The per-profile composition forms are `pnpm verify:tui` and `pnpm verify:desktop`
(equivalently `node scripts/verify-composition.mjs --profile tui|desktop`).

## CI and release pipelines

Three workflows own the automation; all of them use only `actions/checkout` and
`actions/setup-node`.

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | every push and pull request | `test` (Node 22.19 / 24 / 26: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `node --test`), `composition` (`node scripts/verify-composition.mjs --profile all`), `workflows` (structural validation of every workflow file and of the `upstream.json` schema) |
| `upstream-watch.yml` | daily at 05:23 UTC, plus manual dispatch with `channel` and `apply` inputs | `--check`; when a newer release exists it runs `--apply`, commits the new pin on `chore/upstream-<version>`, pushes and opens a PR labelled `upstream`; when verification fails it opens an `upstream-break` issue carrying the captured diagnostics |
| `release.yml` | pushes of `v*` tags | typecheck, unit tests and composition verification, then `npm publish --provenance --access public` from `packages/ohmydsh` and a GitHub release whose notes come from the matching `CHANGELOG.md` section |

Repository setup this needs:

- secret `NPM_TOKEN` — an npm automation token allowed to publish `ohmydsh`.
  Without it the release job fails at the publish step; nothing else breaks.
- `upstream-watch` writes branches, PRs and issues with the default
  `GITHUB_TOKEN` (`contents: write`, `pull-requests: write`, `issues: write`),
  and creates the `upstream` / `upstream-break` labels when they are missing.
- `release.yml` requests `id-token: write` for npm provenance attestation, and
  the tag must match `packages/ohmydsh/package.json`'s `version`.

## When upstream renames a row

A dsh release can rename plugin rows, and our patches target rows by id. If a
row we patch is renamed, the patch no longer matches anything:
`--dump-config` reports the unmatched patch target on stderr and
`verify-composition.mjs` fails its assertions. That is the composition gate — it
catches the rename before the pin moves, CI opens `upstream-break` instead of a
pull request, and the fix is to update the row ids in
`packages/ohmydsh/cordis.patch.yml` / `packages/ohmydsh/presets/omp.patch.yml`
and re-verify.
