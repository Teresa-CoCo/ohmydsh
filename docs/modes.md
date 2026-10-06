# Modes

ohmydsh ships three OMP working modes — `plan`, `build` and `yolo` — defined
once in `packages/ohmydsh/modes.json`.

## The mode model

OMP vocabulary maps onto dsh mechanisms:

| OMP concept | dsh mechanism |
|---|---|
| working mode (`plan` / `build` / `yolo`) | a **permission preset** — a `{sandbox, approval}` pair in the `permission` row of `@deepseek-ai/dsh-permission-presets` — selected with `defaultPreset` |
| OMP agent preset | an `@deepseek-ai/dsh-agent-preset` row (`config.id: omp`, plus `config.plugins` and `config.order`); dsh calls these working modes |
| thinking effort | `llm-deepseek.reasoningEffort` in `cordis.patch.yml` (currently `max`) |
| persona | the `system-prompt` row's `personaPrefix` / `personaSuffix` (0.2.x) |
| plan mode | a session toggle: dsh keeps the tool catalog stable across modes, so plan mode is `/plan` inside the session, backed by the read-only sandbox |

Model roles are not parameterised here: `modes.json` fixes a single
`reasoningEffort` and a single agent preset for the OMP layer, and
`docs/contracts.md` defines no per-role model mechanism, so none is documented.

## The modes

Generated from `packages/ohmydsh/modes.json`:

| id | label | sandbox | approval | summary | default |
|---|---|---|---|---|---|
| `plan` | Plan | `read-only` | `ask` | Read-only investigation that ends in a decision-complete plan. |  |
| `build` | Build | `workspace-write` | `ask` | The full OMP coding agent inside the workspace. | yes |
| `yolo` | YOLO | `danger-full-access` | `never` | The full OMP coding agent with no confinement and no prompts. |  |

Descriptions, verbatim from `modes.json`:

- `plan` — "Launches in a read-only sandbox: file mutations are unavailable and
  risky actions still ask first. dsh keeps the tool catalog stable across modes,
  so the OMP plan preset also carries the plan-mode section; press /plan inside
  the session to enter it. Mirrors OMP's plan mode."
- `build` — "Launches in a workspace-write sandbox: bash and filesystem
  mutations stay inside the session workspace, and anything risky asks first.
  This is the default mode."
- `yolo` — "Launches with danger-full-access and never-ask approval. Mirrors
  OMP's auto-approve mode; use only in throwaway workspaces."

## The permission row in the bundle

The bundle declares all three presets at once in
`packages/ohmydsh/cordis.patch.yml`:

```yaml
- id: permission
  config:
    presets:
      omp-readonly:
        sandbox: read-only
        approval: ask
      omp-workspace:
        sandbox: workspace-write
        approval: ask
      omp-full:
        sandbox: danger-full-access
        approval: never
    defaultPreset: omp-workspace
```

`defaultPreset` is the default mode's preset: `build` → `omp-workspace`. The
tests assert that this row declares exactly the presets in `modes.json`, with
exactly their sandbox/approval bundles.

## The generated `--mode` overlay

`ohmydsh --mode <id>` does not edit the profile. It generates a patch and passes
it to dsh as `--patch`, applied on top of the composed profile. A dsh patch
entry replaces the whole `config` of the row it targets — there is no deep merge
— so the overlay must restate every preset, not just the selected one. For
`--mode plan`:

```yaml
# generated for `ohmydsh --mode plan`; passed to dsh as --patch
- id: permission
  config:
    presets:
      omp-readonly:
        sandbox: read-only
        approval: ask
      omp-workspace:
        sandbox: workspace-write
        approval: ask
      omp-full:
        sandbox: danger-full-access
        approval: never
    defaultPreset: omp-readonly
```

Without `--mode`, the profile's own row applies: `defaultPreset` stays
`omp-workspace`.

`plan` has `planMode: true`, so the launcher also prints the in-session hint on
launch: dsh keeps the tool catalog stable across modes, so plan mode is entered
with `/plan` inside the session, with the read-only sandbox and `ask` approval
behind it.

## Adding a mode

1. Add the mode to `packages/ohmydsh/modes.json`: `id`, `label`, `summary`,
   `description`, `planMode`, and a `permission` object. Keep `permission.name`
   unique and out of the reserved names `custom` / `auto`; `sandbox` must be one
   of `read-only` / `workspace-write` / `danger-full-access` and `approval` one
   of `ask` / `never`. If the new mode should be the default, update
   `defaultMode` too.
2. Keep the `permission` row in `packages/ohmydsh/cordis.patch.yml` in sync: it
   must declare exactly these preset names with exactly these bundles, and
   `defaultPreset` must equal the default mode's `permission.name`.
3. Run the modes tests: `node --test`. They enforce the invariants on both
   files, so they fail if the two drift apart.

`modes.json` is the single source of truth; everything else mirrors it.
