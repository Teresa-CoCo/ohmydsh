# ohmydsh

ohmydsh is a distribution *around* DeepSeek Harness (`dsh`), not a fork of it. It
adds two things on top of an unmodified dsh: a **bundle** that patches a dsh
profile with an OMP layer (persona, reasoning effort, permission presets and the
OMP working mode), and a **launcher CLI** that manages the dsh profiles behind
two surfaces — a terminal UI by default and a desktop (web) surface — over one
shared backend. Everything dsh-side is reused, never reimplemented: the TUI comes
from `@deepseek-harness-tui/dsh-tui`, the desktop surface from the in-box
`@deepseek-ai/dsh-web-app`, and agents, tools, sessions and the sandbox from
`@deepseek-ai/dsh-base`. The upstream dsh release is pinned in `upstream.json`
and tracked by CI.

Deeper documentation: [docs/architecture.md](docs/architecture.md),
[docs/modes.md](docs/modes.md), [docs/upstream.md](docs/upstream.md),
[CONTRIBUTING.md](CONTRIBUTING.md).

## At a glance

| Surface | Profile | Command | Reuses |
|---|---|---|---|
| TUI (default) | `ohmydsh-tui` | `ohmydsh` (or `ohmydsh tui`) | `@deepseek-harness-tui/dsh-tui` |
| Desktop (web) | `ohmydsh-desktop` | `ohmydsh desktop` (or `ohmydsh web`) | in-box `@deepseek-ai/dsh-web-app` |
| both | — | — | shared backend `@deepseek-ai/dsh-base` |

Both surfaces run against the same `$DSH_HOME`, so they share one set of
sessions, settings and credentials.

## Install and quick start

Requires Node.js `^22.19.0 || >=24.0.0` and a `dsh` CLI that is reachable: on
`PATH`, or pointed at with `DSH_REAL` (or the `--dsh` flag).

```sh
npm i -g ohmydsh
```

```sh
ohmydsh           # TUI (default)
ohmydsh desktop   # desktop (web) surface
```

On first run, bootstrap initialises `$DSH_HOME/profiles/ohmydsh-tui` and
`$DSH_HOME/profiles/ohmydsh-desktop` (`$DSH_HOME` defaults to `~/.dsh`). Pass
`--no-bootstrap` to skip bootstrap.

From a checkout, run the launcher directly; the subcommands are the same:

```sh
node packages/ohmydsh/bin/ohmydsh.js           # TUI
node packages/ohmydsh/bin/ohmydsh.js desktop   # desktop
```

## OMP modes

Generated from `packages/ohmydsh/modes.json`:

| id | label | sandbox | approval | summary | default |
|---|---|---|---|---|---|
| `plan` | Plan | `read-only` | `ask` | Read-only investigation that ends in a decision-complete plan. |  |
| `build` | Build | `workspace-write` | `ask` | The full OMP coding agent inside the workspace. | yes |
| `yolo` | YOLO | `danger-full-access` | `never` | The full OMP coding agent with no confinement and no prompts. |  |

`--mode <id>` is applied as a generated `--patch` overlay on top of the profile.
Because a dsh patch replaces the whole config of the row it targets, the overlay
restates all three permission presets and selects the mode's own preset as
`defaultPreset` — see [docs/modes.md](docs/modes.md) for the exact YAML. The
`plan` mode additionally prints the in-session hint: dsh keeps the tool catalog
stable across modes, so plan mode is a session toggle — press `/plan` inside the
session; it is backed by the read-only sandbox.

## CLI reference

### Commands

| Command | What it does |
|---|---|
| `ohmydsh` / `ohmydsh tui` | Launch the TUI surface on the `ohmydsh-tui` profile. This is the default command. |
| `ohmydsh desktop` / `ohmydsh web` | Launch the desktop (web) surface on the `ohmydsh-desktop` profile. |
| `ohmydsh modes [--json]` | Print the OMP modes from `modes.json` (`--json` for machine-readable output). |
| `ohmydsh doctor [--json]` | Diagnostic report (`--json` for machine-readable output). It checks the Node range, `upstream.json`, the TUI-plugin pin, `modes.json`, the `dsh` binary and its `--version` against the pin, whether both profiles list our bundle, and `dsh --profile <p> --dump-config` (exit 0, empty stderr) for every profile that exists. It reports, never repairs, and exits 1 when a check fails. |
| `ohmydsh update` | Refresh both profiles to the pinned bundles: run the still-missing bootstrap steps, then `dsh plugin --profile <p> update` and re-add the pinned bundles. This is how a released pin bump reaches an existing install without a manual bootstrap. |
| `ohmydsh version` | Print the ohmydsh version plus the pinned dsh and TUI-plugin versions. |
| `ohmydsh help` | Print usage. |

### Flags

| Flag | What it does |
|---|---|
| `--mode <id>` | Apply the named OMP mode as a generated `--patch` overlay on top of the profile. |
| `--profile <name>` | Use a specific dsh profile instead of the surface's default (`ohmydsh-tui` for TUI, `ohmydsh-desktop` for desktop). |
| `--dsh <path>` | Use a specific `dsh` CLI. Precedence: `--dsh`, then `DSH_REAL`, then `dsh` on `PATH`. |
| `--dry-run` | Print every command the invocation would run (as `ohmydsh: would run: <argv>` lines) and execute nothing. |
| `--no-bootstrap` | Fail instead of initialising a missing profile. |
| `--json` | Machine-readable output for `modes` and `doctor`. |

### Environment

| Variable | What it does |
|---|---|
| `OHMYDSH_HOME` | Override the read-root for `modes.json` and `upstream.json`; defaults to the checkout that contains the package, or the package root for an installed copy. |
| `DSH_HOME` | The dsh home; defaults to `~/.dsh`, with profiles at `$DSH_HOME/profiles/<name>`. ohmydsh reads it but never writes it directly — `dsh` owns it. |
| `DSH_REAL` | Path to the `dsh` CLI, used when `--dsh` is absent. |

Exit codes: `0` success, `1` a failed check or a failed bootstrap, `2` a usage
error. Booting a surface propagates the dsh process's own exit code.

## Upstream tracking

`upstream.json` pins the upstream `dsh` (`@deepseek-ai/dsh`) at channel
`latest`, currently `0.2.0-rc.2`, and the TUI plugin
`@deepseek-harness-tui/dsh-tui` `0.13.0`, plus the `compat.verified` rows.
`scripts/upstream-sync.mjs` resolves newer upstream releases and rewrites the
pin; `scripts/verify-composition.mjs` composes the real dsh tree and asserts
that our rows survive. In CI, `.github/workflows/upstream-watch.yml` proposes
updates as `chore/upstream-<version>` pull requests and opens an
`upstream-break` issue when verification fails. See
[docs/upstream.md](docs/upstream.md).

## Verification

From a checkout:

```sh
node --test                                            # unit tests, no network
pnpm typecheck                                         # tsc checkJs over packages/** + scripts/**
node scripts/verify-composition.mjs --profile tui      # real dsh, isolated DSH_HOME
node scripts/verify-composition.mjs --profile desktop
node scripts/upstream-sync.mjs --check --json          # network: npm + GitHub
node packages/ohmydsh/bin/ohmydsh.js modes
```

## Repository layout

```
ohmydsh/
├── .editorconfig
├── .github/workflows/
│   ├── ci.yml
│   ├── release.yml
│   └── upstream-watch.yml
├── .gitignore
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE
├── README.md
├── README.zh.md
├── docs/
│   ├── architecture.md
│   ├── contracts.md
│   ├── modes.md
│   └── upstream.md
├── packages/ohmydsh/
│   ├── bin/                 # launcher entry point: bin/ohmydsh.js
│   ├── presets/             # presets/omp.patch.yml (OMP agent preset)
│   ├── src/                 # launcher modules
│   ├── tests/
│   ├── cordis.patch.yml     # the OMP layer patch
│   ├── modes.json           # single source of truth for the OMP modes
│   ├── package.json         # bin, exports, dsh.bundle.patch
│   └── README.md
├── package.json
├── pnpm-workspace.yaml
├── scripts/
│   ├── lib/
│   ├── upstream-sync.mjs
│   └── verify-composition.mjs
├── tsconfig.json
└── upstream.json
```

## Licence and credits

MIT — see [LICENSE](LICENSE). Preset compositions are adapted from the
MIT-licensed upstream `packages/bundle/web-app/presets/*.patch.yml`; the TUI
plugin (`@deepseek-harness-tui/dsh-tui`) belongs to its own authors.
