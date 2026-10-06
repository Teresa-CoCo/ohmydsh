# ohmydsh

A dsh bundle plus its launcher: an OMP-flavoured distribution *around* DeepSeek
Harness, not a fork.

- **Bundle** — `cordis.patch.yml` and `presets/omp.patch.yml` add the OMP layer
  (persona, reasoning effort, permission presets, the OMP working mode) to a dsh
  profile.
- **Launcher** — `bin/ohmydsh.js` bootstraps the profiles and launches a
  surface.

## Install

Requires the `dsh` CLI (on `PATH`, or pointed at with `DSH_REAL`).

```sh
npm i -g ohmydsh
```

```sh
ohmydsh           # TUI (default)
ohmydsh desktop   # desktop (web) surface
```

## Profiles

| Surface | Profile |
|---|---|
| TUI | `ohmydsh-tui` |
| Desktop (web) | `ohmydsh-desktop` |

Both profiles live under `$DSH_HOME/profiles/` and share one backend, so
sessions, settings and credentials are common to both surfaces.

## Modes

| id | sandbox | approval | default |
|---|---|---|---|
| `plan` | `read-only` | `ask` |  |
| `build` | `workspace-write` | `ask` | yes |
| `yolo` | `danger-full-access` | `never` |  |

`ohmydsh --mode <id>` applies a mode as a generated `--patch` overlay on top of
the profile.

## Links

- Repository README: https://github.com/Teresa-CoCo/ohmydsh#readme
- Documentation in the repository: `docs/modes.md`, `docs/upstream.md`,
  `docs/architecture.md`.
