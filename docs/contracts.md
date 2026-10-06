# ohmydsh engineering contracts

Internal interface spec. Read this before editing anything: it fixes the file
ownership, the data shapes, and the commands every change must keep working.

## What ohmydsh is

A distribution *around* DeepSeek Harness (`dsh`), not a fork of it:

| Piece | Role | dsh mechanism |
|---|---|---|
| `packages/ohmydsh/cordis.patch.yml` + `presets/*.patch.yml` | the OMP layer: persona, reasoning effort, permission presets, OMP agent presets | bundle patch (`dsh.bundle.patch`) |
| `bin/ohmydsh.js` + `src/*` | launcher: bootstraps profiles, launches surfaces, reports doctor/modes | `dsh plugin --profile …`, `dsh --profile …` |
| `upstream.json` | the pinned upstream dsh + TUI-plugin versions and verified compat rows | data only |
| `modes.json` | single source of truth for OMP working modes | data only |
| `scripts/upstream-sync.mjs` | resolves newer upstream releases, rewrites the pin, verifies | CI |
| `scripts/verify-composition.mjs` | boots nothing; composes the real `dsh` tree and asserts our rows survive | CI + local |

Everything dsh-side is **reused, never reimplemented**: the TUI comes from
`@deepseek-harness-tui/dsh-tui`, the desktop surface from the in-box
`@deepseek-ai/dsh-web-app`, agents/tools/sessions/sandbox from `@deepseek-ai/dsh-base`.

## Frozen interfaces (owned here, do not edit in parallel worktrees)

- `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `.gitignore`, `.editorconfig`, `LICENSE`, `upstream.json`, `packages/ohmydsh/package.json`, `packages/ohmydsh/modes.json`, `docs/contracts.md`

`packages/ohmydsh/package.json` already declares the final
`bin`, `exports`, and `dsh.bundle.patch` list. Adding a file to the bundle means
adding it to `cordis.patch.yml` (`insert`) or as a new `presets/*.patch.yml`
entry in that list.

## Data shapes

`packages/ohmydsh/modes.json`

```jsonc
{
  "schemaVersion": 1,
  "defaultMode": "build",
  "reasoningEffort": "max",        // llm-deepseek.reasoningEffort in cordis.patch.yml
  "persona": { "prefix": "…", "suffix": "…" },   // system-prompt row values
  "modes": [
    {
      "id": "build",               // CLI value: `ohmydsh --mode build`
      "label": "Build",            // display
      "summary": "…",              // one line for `ohmydsh modes`
      "description": "…",          // paragraph
      "agentPreset": "omp-build",  // @deepseek-ai/dsh-agent-preset config.id
      "permission": { "name": "omp-workspace", "sandbox": "workspace-write", "approval": "ask" }
    }
  ]
}
```

Invariants (tested):

1. every `permission.name` is unique; no mode uses the reserved names `custom`/`auto`;
2. `sandbox` ∈ {`read-only`, `workspace-write`, `danger-full-access`}, `approval` ∈ {`ask`, `never`};
3. `defaultMode` names an existing mode;
4. the `permission` row in `cordis.patch.yml` declares exactly these presets with exactly these bundles, and `defaultPreset` equals the default mode's `permission.name`;
5. every `agentPreset` appears as a `config.id` of an inserted `@deepseek-ai/dsh-agent-preset` row across the bundle patch list.

`upstream.json`

```jsonc
{
  "schemaVersion": 1,
  "repository": "https://github.com/Teresa-CoCo/ohmydsh",
  "upstream": { "repository": "deepseek-ai/deepseek-harness", "npmPackage": "@deepseek-ai/dsh",
                "channel": "latest", "version": "0.2.0-rc.2",
                "publishedAt": "<ISO>", "resolvedAt": "<ISO>" },
  "tuiPlugin": { "npmPackage": "@deepseek-harness-tui/dsh-tui", "version": "0.13.0" },
  "profiles": { "tui": "ohmydsh-tui", "desktop": "ohmydsh-desktop" },
  "compat": { "verified": [ { "dsh": "…", "tuiPlugin": "…", "verifiedAt": "<ISO>",
                              "profiles": ["tui", "desktop"] } ] }
}
```

## dsh facts this repo depends on (verified against dsh 0.2.0-rc.2)

- Profile home: `$DSH_HOME` (default `~/.dsh`), profiles at `$DSH_HOME/profiles/<name>`.
- Bundle = npm package with `dsh.bundle.patch` (string or ordered list). Profile manifest = `dsh.profile.bundles` array. "Nothing is both."
- Bootstrap: `dsh plugin --profile <name> add <spec…>` initialises a missing profile with `@deepseek-ai/dsh-base` and forwards to pnpm in the profile dir; it appends every installed package that declares `dsh.bundle`. `dsh --profile <name> --from-default-profile web --dump-config` initialises a web-based profile *without booting*.
- Compose without booting: `dsh --profile <name> --dump-config` (prints `# == <layer>` markers, reports unmatched patch targets on stderr, needs no API key).
- Bundle names resolve from the dsh installation first (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, …), then the profile's `node_modules`.
- Row `permission` (`@deepseek-ai/dsh-permission-presets`) sits in `dsh-base` and carries `presets: {name: {sandbox, approval}}` + `defaultPreset`.
- Row `system-prompt` takes `personaPrefix` / `personaSuffix` on 0.2.x.
- Agent presets are `@deepseek-ai/dsh-agent-preset` rows (`config.id`, `config.plugins`, `config.order`) registered into `@deepseek-ai/dsh-agent-preset-registry`; the registry row id differs per surface (`agent-preset-registry` for web, `dsh-tui-agent-preset-registry` for the TUI plugin).
- `@deepseek-harness-tui/dsh-tui` registers the official `standard`/`ptc`/`minimal`/`cordis` declarations from `@deepseek-ai/dsh-web-app/presets/*.patch.yml` itself and skips any id a profile already declared.

## Verification commands

```sh
node --test                       # all unit tests, no network
pnpm typecheck                    # tsc checkJs over packages/**+scripts/**
node scripts/verify-composition.mjs --profile tui       # real dsh, isolated DSH_HOME
node scripts/verify-composition.mjs --profile desktop
node scripts/upstream-sync.mjs --check --json           # network: npm + GitHub
node packages/ohmydsh/bin/ohmydsh.js modes
```

Offline dsh for local probes (already in the npx cache on this machine):

```sh
export PATH="$HOME/.npm/_npx/1e7f6d9597241db0/node_modules/.bin:$PATH"   # dsh 0.2.0-rc.2
```

## Conventions

- ESM JavaScript with JSDoc types; no runtime dependencies; `node:` builtins only.
- `node:test` + `node:assert/strict`; tests are deterministic and never require an API key.
- Never write into the developer's real `~/.dsh`: tests and scripts use an isolated `DSH_HOME` under `.tmp*/`.
- Attribution: preset compositions adapted from the MIT-licensed upstream
  `packages/bundle/web-app/presets/*.patch.yml` say so in a comment.
