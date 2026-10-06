# Contributing

## Requirements

- Node.js `^22.19.0 || >=24.0.0` (the `engines` field in `package.json`).
- pnpm; `package.json` declares `packageManager: pnpm@12.6.0`.
- A `dsh` CLI for the composition checks. The verifier uses the pinned release
  and an isolated `DSH_HOME`, so it never touches your real `~/.dsh`.

## Local setup

```sh
pnpm install
```

## Verification

```sh
node --test                                            # unit tests, no network
pnpm typecheck                                         # tsc checkJs over packages/** + scripts/**
node scripts/verify-composition.mjs --profile tui      # real dsh, isolated DSH_HOME
node scripts/verify-composition.mjs --profile desktop
node scripts/upstream-sync.mjs --check --json          # network: npm + GitHub
node packages/ohmydsh/bin/ohmydsh.js modes
```

- `node --test` runs all unit tests: deterministic, no network, never requires
  an API key.
- `pnpm typecheck` runs `tsc checkJs` over `packages/**` and `scripts/**`.
- The composition verifier needs a real `dsh`; the upstream check additionally
  needs network (npm + GitHub).
- Never write into your real `$DSH_HOME` from scripts or tests: use the isolated
  `DSH_HOME` under `.tmp*/` that the scripts create (`.tmp/`, `.tmp-*` and
  `.ohmydsh-verify/` are gitignored).

## Conventions

- ESM JavaScript with JSDoc types; no runtime dependencies; `node:` builtins
  only.
- Tests use `node:test` + `node:assert/strict`.
- Preset compositions adapted from upstream say so in a comment; upstream
  `packages/bundle/web-app/presets/*.patch.yml` is MIT-licensed.

## The data files are the contract

### modes.json is the single source of truth for modes

`packages/ohmydsh/modes.json` defines the OMP modes; every other artifact
mirrors it. The tests enforce the invariants:

1. every `permission.name` is unique, and no mode uses the reserved names
   `custom` / `auto`;
2. `sandbox` is one of `read-only`, `workspace-write`, `danger-full-access`;
3. `approval` is `ask` or `never`;
4. `defaultMode` names an existing mode;
5. the `permission` row in `cordis.patch.yml` declares exactly these presets
   with exactly these bundles, and its `defaultPreset` equals the default mode's
   `permission.name`;
6. the top-level `agentPreset` appears as a `config.id` of an inserted
   `@deepseek-ai/dsh-agent-preset` row in the bundle patch list.

### The permission row in cordis.patch.yml must match it

A dsh patch entry replaces the whole config of the row it targets, with no deep
merge. So the `permission` row in `packages/ohmydsh/cordis.patch.yml` must
restate every preset, not just the default one. When you add or change a mode,
update both files in the same change and run the modes tests.

### Adding a bundle layer file

A file becomes part of the bundle only when it is declared:

1. adding a row to the OMP layer means adding it to `cordis.patch.yml` (as an
   insert);
2. a new layer file goes under `packages/ohmydsh/presets/` and its path is added
   to the ordered `dsh.bundle.patch` list in `packages/ohmydsh/package.json`.

Order in that list is composition order.

### Bundle vs profile: nothing is both

- A **bundle** is an npm package that declares `dsh.bundle.patch` (a string or
  an ordered list of patch files).
- A **profile manifest** declares `dsh.profile.bundles` (an ordered array).
- A package is one or the other, never both.

## dsh facts you need

- Profile home: `$DSH_HOME` (default `~/.dsh`); profiles live at
  `$DSH_HOME/profiles/<name>`.
- Bootstrap: `dsh plugin --profile <name> add <spec…>` initialises a missing
  profile with `@deepseek-ai/dsh-base` and forwards to pnpm in the profile
  directory; it appends every installed package that declares `dsh.bundle`.
  `dsh --profile <name> --from-default-profile web --dump-config` initialises a
  web-based profile without booting.
- Gates before you change a patch: `dsh --profile <name> --dump-config`
  composes the profile without booting and prints `# == <layer>` markers,
  reporting unmatched patch targets on stderr (no API key needed).
  `dsh --profile <name> --dump-config-schema` prints the config schema, but on
  the pinned dsh (`0.2.0-rc.2`) it exits 1 even for stock profiles because of
  upstream-attributable diagnostics — read its output, not its exit code.
- A patch replaces the whole config of the row it targets — restate everything
  the row needs.
- Each profile directory also carries its own patch,
  `$DSH_HOME/profiles/<name>/cordis.patch.yml` (initialised to `[]`), applied
  after all bundle layers; CLI `--patch` overlays apply after that.
- A patch that no longer matches any row is reported by `--dump-config`; that is
  how upstream renames surface.
- Row ids can be surface-specific: the agent-preset registry is
  `agent-preset-registry` for web and `dsh-tui-agent-preset-registry` for the
  TUI plugin.
- `@deepseek-harness-tui/dsh-tui` registers the official
  `standard` / `ptc` / `minimal` / `cordis` declarations from
  `@deepseek-ai/dsh-web-app/presets/*.patch.yml` itself, and skips any id a
  profile already declared.

## Worktree workflow

Large changes are split into slices, one git worktree per slice
(`git worktree add`), with integration done once in the main tree:

- each slice owns its declared paths; do not edit another slice's files;
- the frozen interfaces listed under "Frozen interfaces" in
  `docs/contracts.md` (`package.json`, `pnpm-workspace.yaml`, `tsconfig.json`,
  `.gitignore`, `.editorconfig`, `LICENSE`, `upstream.json`,
  `packages/ohmydsh/package.json`, `packages/ohmydsh/modes.json`,
  `docs/contracts.md`) are not edited in parallel worktrees — they change once,
  in the main tree;
- verify once after all slices land, not per slice.
