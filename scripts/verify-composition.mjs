#!/usr/bin/env node
/**
 * ohmydsh composition verifier.
 *
 * Boots nothing and needs no API key. For each surface (tui, desktop) it
 * bootstraps a fresh isolated DSH_HOME exactly like the launcher does, then
 * asserts that the composed profile still carries the ohmydsh layer:
 *
 *   1. the bootstrap commands succeed;
 *   2. `dsh --profile <p> --dump-config` exits 0 with EMPTY stderr (no unmatched
 *      patch targets), contains an ohmydsh layer marker, the `permission` row
 *      declares exactly the OMP presets from modes.json, and an ohmydsh-inserted
 *      `@deepseek-ai/dsh-agent-preset` row carries `config.id` = modes.agentPreset;
 *   3. `dsh --profile <p> --dump-config-schema` collects a schema for every
 *      ohmydsh-contributed row (this is what proves our inserted package names
 *      resolve in the pinned dsh) and reports no error attributable to ohmydsh.
 *
 * Note on upstream dsh 0.2.0-rc.2: `--dump-config-schema` sets exit code 1
 * ("incomplete") for diagnostics that ship with upstream itself — the stock
 * `web` profile reports "unrecognized Loader tree carrier" for every
 * `@deepseek-ai/dsh-agent-preset` row, and dsh-tui 0.13.0 reports two
 * "Cannot find package" errors for optional rows that only newer dsh
 * generations provide. Requiring exit 0 would therefore fail on a stock
 * profile before ohmydsh is even involved. This verifier instead fails on any
 * diagnostic attributable to the ohmydsh layer and reports the upstream ones.
 *
 * Exit codes: 0 = all selected surfaces verified; 1 = at least one check
 * failed; 2 = usage error.
 *
 * SPDX-License-Identifier: MIT
 */

import process from 'node:process';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const PROFILE_NAMES = Object.freeze(['tui', 'desktop']);
export const TMP_ROOT_NAME = '.tmp-verify';
export const BOOTSTRAP_TIMEOUT_MS = 15 * 60 * 1000;
export const DUMP_TIMEOUT_MS = 5 * 60 * 1000;

/** Messages from the pinned dsh's own schema collector that are not ohmydsh's. */
export const TOLERATED_SCHEMA_MESSAGES = Object.freeze([
  /^unrecognized Loader tree carrier; use cordis:group or cordis:include for native child collection$/,
]);

export const USAGE = `usage: node scripts/verify-composition.mjs [options]

  --profile tui|desktop|all   surface(s) to verify (default: all)
  --json                      emit a machine-readable JSON payload on stdout
  --keep                      keep the isolated .tmp-verify work directories
  --dsh <bin>                 dsh executable to use (default: npx --yes @deepseek-ai/dsh@<pin>)
  --repo-root <path>          repository root holding upstream.json/packages (default: this script's parent)
  --help                      print this help

Exit codes: 0 verified, 1 check failed, 2 usage error.`;

export class UsageError extends Error {}

/**
 * @typedef {{ id: string, label: string, summary?: string, description?: string, planMode: boolean, permission: { name: string, sandbox: string, approval: string } }} ModeEntry
 * @typedef {{ schemaVersion: number, defaultMode: string, agentPreset: string, modes: ModeEntry[] }} ModesDocument
 */

/**
 * @param {string[]} argv
 * @returns {{ profile: string, json: boolean, keep: boolean, dsh: string | null, repoRoot: string, help: boolean }}
 */
export function parseArgs(argv) {
  const parsed = {
    profile: 'all',
    json: false,
    keep: false,
    dsh: /** @type {string | null} */ (null),
    repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--profile') {
      const value = argv[++index];
      if (value === undefined) throw new UsageError('--profile needs a value');
      selectProfiles(value); // validate eagerly
      parsed.profile = value;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--keep') {
      parsed.keep = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--dsh') {
      const value = argv[++index];
      if (value === undefined) throw new UsageError('--dsh needs a value');
      parsed.dsh = value;
    } else if (arg === '--repo-root') {
      const value = argv[++index];
      if (value === undefined) throw new UsageError('--repo-root needs a value');
      parsed.repoRoot = resolve(value);
    } else {
      throw new UsageError(`unknown argument "${arg}"`);
    }
  }
  return parsed;
}

/**
 * @param {string} value
 * @returns {string[]} surface names in canonical order
 */
export function selectProfiles(value) {
  if (value === 'all') return [...PROFILE_NAMES];
  if (PROFILE_NAMES.includes(value)) return [value];
  throw new UsageError(`unknown --profile "${value}" (expected tui, desktop, or all)`);
}

/** @param {string} value */
function unquote(value) {
  const text = value.trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  return text;
}

/**
 * Parse the composed profile printed by `dsh --dump-config`.
 *
 * The output is a YAML entry list grouped by `# == <layer stack>` markers; we
 * only need row identity, the ohmydsh provenance, and the plain scalars inside
 * `config:` — block scalars and `!!js` expressions are preserved verbatim,
 * never evaluated.
 *
 * @param {string} text
 * @returns {{ layers: { marker: string, contributors: string[], entryIndexes: number[] }[], entries: { index: number, id: string, name: string | null, layer: string, contributors: string[], scalars: Map<string, string>, raw: string }[] }}
 */
export function parseComposedTree(text) {
  /** @type {{ marker: string, contributors: string[], entryIndexes: number[] }[]} */
  const layers = [];
  /** @type {{ index: number, id: string, name: string | null, layer: string, contributors: string[], scalars: Map<string, string>, raw: string }[]} */
  const entries = [];
  /** @type {string[] | null} */
  let currentRow = null;
  /** @type {{ layer: string, contributors: string[], index: number } | null} */
  let currentLayer = null;
  const finishRow = () => {
    if (currentRow === null) return;
    const rowText = currentRow.join('\n');
    const first = currentRow[0];
    const id = unquote(first.replace(/^- id:\s*/, ''));
    const nameMatch = /^ {2}name:\s*(.+)$/m.exec(rowText);
    entries.push({
      index: entries.length + 1,
      id,
      name: nameMatch ? unquote(nameMatch[1]) : null,
      layer: currentLayer?.layer ?? '',
      contributors: currentLayer?.contributors ?? [],
      scalars: extractConfigScalars(currentRow),
      raw: rowText,
    });
    currentRow = null;
  };
  for (const line of text.split(/\r?\n/)) {
    const marker = /^# == (.*)$/.exec(line);
    if (marker) {
      finishRow();
      const contributors = marker[1].split(', patched by ').map((part) => part.trim());
      currentLayer = { layer: marker[1], contributors, index: layers.length };
      layers.push({ marker: marker[1], contributors, entryIndexes: [] });
      continue;
    }
    if (/^- id:\s*\S/.test(line)) {
      finishRow();
      currentRow = [line];
      const layer = layers[layers.length - 1];
      if (layer) layer.entryIndexes.push(entries.length + 1);
      continue;
    }
    if (currentRow !== null) currentRow.push(line);
  }
  finishRow();
  return { layers, entries };
}

/**
 * Extract plain `key: value` scalars from a row, honoring 2-space nesting.
 * Block scalars (`|`, `>`, `|-`, `>-`, `!!js >-`, …) are captured as text,
 * never evaluated. Paths are dotted and start at `config` for the row's config
 * block (nested plugin entries included, which is fine: we only read known paths).
 * @param {string[]} rowLines
 * @returns {Map<string, string>}
 */
export function extractConfigScalars(rowLines) {
  const configIndex = rowLines.findIndex((line) => line.trim() === 'config:');
  const block = configIndex === -1 ? [] : rowLines.slice(configIndex);
  /** @type {Map<string, string>} */
  const scalars = new Map();
  /** @type {{ indent: number, key: string }[]} */
  const stack = [];
  /** @type {{ path: string, keyIndent: number, style: string, chomp: string, prefix: string, lines: string[] } | null} */
  let pending = null;
  const flush = () => {
    if (pending === null) return;
    const nonEmpty = pending.lines.filter((line) => line.trim() !== '');
    const dedent = nonEmpty.length > 0 ? Math.min(...nonEmpty.map((line) => line.length - line.trimStart().length)) : 0;
    const text = pending.lines.map((line) => line.slice(dedent)).join('\n').replace(/\n+$/, '');
    const folded = pending.style === '>' ? text.replace(/[ \t]*\n[ \t]*/g, ' ') : text;
    scalars.set(pending.path, pending.prefix ? `${pending.prefix} ${folded}` : folded);
    pending = null;
  };
  for (const line of block) {
    if (pending !== null) {
      if (line.trim() === '' || line.length - line.trimStart().length > pending.keyIndent) {
        pending.lines.push(line);
        continue;
      }
      flush();
    }
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim().startsWith('- ') ? line.trim().slice(2) : line.trim();
    const match = /^([^:\s][^:]*):(?:[ \t]+(.*))?$/.exec(body);
    if (!match) continue;
    const key = unquote(match[1]);
    const rawValue = (match[2] ?? '').trim();
    const keyIndent = indent + (line.trim().startsWith('- ') ? 2 : 0);
    while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? -1) >= keyIndent) stack.pop();
    const path = [...stack.map((frame) => frame.key), key].join('.');
    if (rawValue === '') {
      stack.push({ indent: keyIndent, key });
      continue;
    }
    const blockScalar = /^(?:(.*?)\s+)?([|>])([+-]?)$/.exec(rawValue);
    if (blockScalar && (blockScalar[1] === undefined || /^!!js$/.test(blockScalar[1].trim()) || blockScalar[1].trim() === '!')) {
      pending = { path, keyIndent, style: blockScalar[2] ?? '>', chomp: blockScalar[3] ?? '', prefix: blockScalar[1]?.trim() ?? '', lines: [] };
      continue;
    }
    scalars.set(path, unquote(rawValue));
  }
  flush();
  return scalars;
}

/** @param {{ marker?: string, contributors?: string[] }} layer @param {string} contributor */
export function layerIncludes(layer, contributor) {
  return (layer?.contributors ?? []).includes(contributor);
}

/**
 * Plan the launcher-identical bootstrap steps for one surface.
 * @param {{ profile: string, repoRoot: string, pin: any, dsh?: string | null }} options
 */
export function planBootstrap({ profile, repoRoot, pin, dsh = null }) {
  if (!PROFILE_NAMES.includes(profile)) throw new UsageError(`unknown profile "${profile}" (expected ${PROFILE_NAMES.join(', ')})`);
  const dshBase = dsh ? [dsh] : ['npx', '--yes', `@deepseek-ai/dsh@${pin.upstream.version}`];
  const profileName = pin.profiles?.[profile] ?? `ohmydsh-${profile}`;
  const bundleDir = join(repoRoot, 'packages', 'ohmydsh');
  const bundleSpec = `file:${bundleDir}`;
  /** @param {string} id @param {string} title @param {string[]} command @param {number} timeoutMs */
  const step = (id, title, command, timeoutMs) => ({ id, title, command, timeoutMs });
  const steps =
    profile === 'tui'
      ? [
          step('bootstrap-tui-plugin', `install ${pin.tuiPlugin.npmPackage}@${pin.tuiPlugin.version} into ${profileName}`, [...dshBase, 'plugin', '--profile', profileName, 'add', `${pin.tuiPlugin.npmPackage}@${pin.tuiPlugin.version}`], BOOTSTRAP_TIMEOUT_MS),
          step('bootstrap-bundle', 'install the ohmydsh bundle into the profile', [...dshBase, 'plugin', '--profile', profileName, 'add', bundleSpec], BOOTSTRAP_TIMEOUT_MS),
        ]
      : [
          step('bootstrap-profile', 'initialise the desktop profile from the shipped web template', [...dshBase, '--profile', profileName, '--from-default-profile', 'web', '--dump-config'], BOOTSTRAP_TIMEOUT_MS),
          step('bootstrap-bundle', 'install the ohmydsh bundle into the profile', [...dshBase, 'plugin', '--profile', profileName, 'add', bundleSpec], BOOTSTRAP_TIMEOUT_MS),
        ];
  return {
    profile,
    profileName,
    bundleDir,
    steps: [
      ...steps,
      step('dump-config', 'compose the profile and dump it', [...dshBase, '--profile', profileName, '--dump-config'], DUMP_TIMEOUT_MS),
      step('dump-config-schema', 'collect the config schema (proves inserted names resolve)', [...dshBase, '--profile', profileName, '--dump-config-schema'], DUMP_TIMEOUT_MS),
    ],
  };
}

/** @param {any[]} checks */
export function summarizeChecks(checks) {
  return {
    ok: checks.every((check) => check.ok),
    total: checks.length,
    failed: checks.filter((check) => !check.ok).map((check) => check.id),
  };
}

/**
 * @param {string} id
 * @param {string} title
 * @param {boolean} ok
 * @param {string} detail
 * @param {Record<string, any>} [extra]
 */
function check(id, title, ok, detail, extra = {}) {
  return { id, title, ok, detail, ...extra };
}

/**
 * Assertions over the composed `--dump-config` tree.
 * @param {{ modes: ModesDocument, bundleName: string, tree: ReturnType<typeof parseComposedTree>, run: any }} options
 */
export function checkDump({ modes, bundleName, tree, run }) {
  /** @type {any[]} */
  const checks = [];
  const stderr = String(run.stderr ?? '').trim();
  checks.push(check('dump-exit', 'dump-config exits 0', run.exitCode === 0, `exit code ${run.exitCode}${run.timedOut ? ' (timed out)' : ''}`, { command: run.command, exitCode: run.exitCode, stderr: stderr.slice(-4000) }));
  checks.push(check('dump-stderr', 'dump-config stderr is empty', stderr === '', stderr === '' ? 'no diagnostics' : `stderr: ${stderr.slice(0, 500)}`, { stderr: stderr.slice(-4000) }));

  const markers = tree.layers.filter((layer) => layerIncludes(layer, bundleName)).map((layer) => layer.marker);
  checks.push(
    check(
      'layer-marker',
      `composed tree contains a "${bundleName}" layer marker`,
      markers.length > 0,
      markers.length > 0 ? markers.join(' | ') : `no layer mentions ${bundleName}; layers: ${tree.layers.map((layer) => layer.marker).slice(0, 6).join(' | ')}`,
    ),
  );

  /** rows the ohmydsh bundle contributed (inserted or patched) */
  const ourRows = tree.entries.filter((entry) => layerIncludes(entry, bundleName));
  /** @type {Set<string>} */
  const ourNames = new Set();
  for (const entry of ourRows) {
    if (entry.name) ourNames.add(entry.name);
    // Nested plugin entries inside an inserted preset row are ours too: attribute
    // resolution errors that name them even when the collector reports the parent.
    // Only package-like (scoped or subpathed) names count: bare plugin labels and
    // display names would create false positives.
    for (const match of entry.raw.matchAll(/name:\s*['"]?(@?[A-Za-z0-9_./@-]+)['"]?/g)) {
      const name = match[1];
      if (name && name.includes('/')) ourNames.add(name);
    }
  }

  checks.push(check('ohmydsh-rows', 'the ohmydsh layer contributes rows', ourRows.length > 0, ourRows.length > 0 ? `${ourRows.length} rows: ${ourRows.map((entry) => entry.id).slice(0, 8).join(', ')}` : 'no rows attributed to ohmydsh'));

  // permission row: exactly the modes.json presets, with matching sandbox/approval.
  const expectedPresets = new Map(modes.modes.map((mode) => [mode.permission.name, mode.permission]));
  const defaultMode = modes.modes.find((mode) => mode.id === modes.defaultMode);
  const permissionRow = ourRows.find((entry) => entry.id === 'permission' && entry.name === '@deepseek-ai/dsh-permission-presets');
  if (!permissionRow) {
    checks.push(check('permission-presets', 'the permission row carries the OMP presets', false, 'no ohmydsh-contributed `permission` row (@deepseek-ai/dsh-permission-presets) in the composed tree'));
  } else {
    const actual = new Map();
    for (const [path, value] of permissionRow.scalars) {
      const match = /^config\.presets\.([^.]+)\.(sandbox|approval)$/.exec(path);
      if (!match) continue;
      const entry = actual.get(match[1]) ?? {};
      entry[match[2]] = value;
      actual.set(match[1], entry);
    }
    const problems = [];
    for (const [name, permission] of expectedPresets) {
      const found = actual.get(name);
      if (!found) problems.push(`missing preset ${name}`);
      else if (found.sandbox !== permission.sandbox || found.approval !== permission.approval) {
        problems.push(`preset ${name} is ${found.sandbox}/${found.approval}, expected ${permission.sandbox}/${permission.approval}`);
      }
    }
    for (const name of actual.keys()) {
      if (!expectedPresets.has(name)) problems.push(`unexpected preset ${name}`);
    }
    const actualDefault = permissionRow.scalars.get('config.defaultPreset');
    if (defaultMode && actualDefault !== defaultMode.permission.name) {
      problems.push(`defaultPreset is ${actualDefault ?? '(unset)'}, expected ${defaultMode.permission.name}`);
    }
    checks.push(
      check(
        'permission-presets',
        'the permission row declares exactly the modes.json presets',
        problems.length === 0,
        problems.length === 0 ? `${[...actual.keys()].join(', ')}; defaultPreset=${actualDefault}` : problems.join('; '),
        { row: permissionRow.id, presets: [...actual.keys()], defaultPreset: actualDefault },
      ),
    );
  }

  // inserted agent-preset row carrying the OMP working mode.
  const presetRows = ourRows.filter((entry) => entry.name === '@deepseek-ai/dsh-agent-preset');
  const ompRow = presetRows.find((entry) => entry.scalars.get('config.id') === modes.agentPreset);
  checks.push(
    check(
      'agent-preset',
      `an inserted @deepseek-ai/dsh-agent-preset row carries config.id=${modes.agentPreset}`,
      Boolean(ompRow),
      ompRow
        ? `row ${ompRow.id} (layer: ${ompRow.layer})`
        : presetRows.length > 0
          ? `agent-preset rows contributed by ohmydsh: ${presetRows.map((entry) => `${entry.id}(config.id=${entry.scalars.get('config.id') ?? '?'})`).join(', ')}`
          : 'no @deepseek-ai/dsh-agent-preset row attributed to ohmydsh',
      ompRow ? { row: ompRow.id, layer: ompRow.layer, configId: ompRow.scalars.get('config.id') } : undefined,
    ),
  );

  return { checks, ourRows, ourNames };
}

/** @param {string} message */
export function isToleratedSchemaMessage(message) {
  return TOLERATED_SCHEMA_MESSAGES.some((pattern) => pattern.test(message));
}

/**
 * True when `message` names one of `names` as a whole package token —
 * `@scope/dsh-agent-preset` must not match inside `@scope/dsh-agent-presets`,
 * and `cordis` must not match inside `cordis:group`.
 * @param {string} message
 * @param {Iterable<string>} names
 */
export function messageMentionsPackage(message, names) {
  for (const name of names) {
    if (!name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[^A-Za-z0-9_./@-])${escaped}(?![A-Za-z0-9_./@:-])`);
    if (pattern.test(message)) return name;
  }
  return null;
}

/**
 * Assertions over the `--dump-config-schema` run: the schema collector must
 * have imported every ohmydsh-contributed package, and no error may be
 * attributable to the ohmydsh layer.
 *
 * @param {{ modes: ModesDocument, bundleName: string, tree: ReturnType<typeof parseComposedTree>, ourRows: any[], ourNames: Set<string>, run: any }} options
 */
export function checkSchema({ modes, bundleName, tree, ourRows, ourNames, run }) {
  /** @type {any[]} */
  const checks = [];
  const stderr = String(run.stderr ?? '').trim();
  checks.push(
    check('schema-exit', 'dump-config-schema ran to completion', run.exitCode === 0 || run.exitCode === 1, `exit code ${run.exitCode}${run.timedOut ? ' (timed out)' : ''}`, {
      command: run.command,
      exitCode: run.exitCode,
      stderr: stderr.slice(-4000),
    }),
  );

  /** @type {any} */
  let document = null;
  try {
    document = JSON.parse(run.stdout);
  } catch {
    document = null;
  }
  const schemaEntries = Array.isArray(document?.['x-cordis']?.entries) ? document['x-cordis'].entries : null;
  checks.push(
    check(
      'schema-json',
      'the schema payload parses and lists entries',
      Array.isArray(schemaEntries),
      Array.isArray(schemaEntries) ? `${schemaEntries.length} entries; complete=${document['x-cordis'].complete === true}` : 'stdout was not a JSON schema document with x-cordis.entries',
    ),
  );
  if (!Array.isArray(schemaEntries) || schemaEntries.length === 0) {
    checks.push(check('schema-ohmydsh-rows', 'every ohmydsh row resolved', false, 'cannot inspect entries without the schema payload'));
    return { checks, schemaEntries: [], hard: [], tolerated: [], upstream: [] };
  }

  const entryById = new Map(schemaEntries.map((entry, index) => [entry.id, { entry, index }]));
  /** @type {string[]} */
  const unresolved = [];
  /** @type {string[]} */
  const degraded = [];
  for (const row of ourRows) {
    const found = entryById.get(row.id);
    if (!found) {
      unresolved.push(`${row.id}: missing from the schema entry list`);
      continue;
    }
    if (found.entry.status === 'error') {
      unresolved.push(`${row.id} (${row.name ?? 'unknown package'}): resolution error`);
      continue;
    }
    if (found.entry.status !== 'schema') degraded.push(`${row.id}=${found.entry.status}`);
  }
  // The two anchor rows must prove a real schema was collected from their package.
  for (const anchor of ['permission', ompPresetRowId(ourRows, modes)]) {
    if (anchor === null) continue;
    const found = entryById.get(anchor);
    if (found && found.entry.status !== 'schema') unresolved.push(`${anchor}: schema status is "${found.entry.status}", expected "schema"`);
  }
  checks.push(
    check(
      'schema-ohmydsh-rows',
      'every ohmydsh-contributed row resolved in the pinned dsh',
      unresolved.length === 0,
      unresolved.length === 0 ? `${ourRows.length} rows resolved${degraded.length > 0 ? ` (no config schema declared for: ${degraded.join(', ')})` : ''}` : unresolved.join('; '),
      { unresolved, degraded },
    ),
  );

  const ourRowIds = new Set(ourRows.map((row) => row.id));
  const ourRowIndexes = new Set(ourRows.map((row) => row.index - 1));
  /** @type {any[]} */
  const hard = [];
  /** @type {any[]} */
  const tolerated = [];
  /** @type {any[]} */
  const upstream = [];
  for (const diagnostic of document['x-cordis'].diagnostics ?? []) {
    const index = typeof diagnostic.path === 'string' && /^\/\d+$/.test(diagnostic.path) ? Number(diagnostic.path.slice(1)) : null;
    const entry = index !== null ? schemaEntries[index] ?? null : null;
    const info = {
      level: diagnostic.level ?? 'error',
      path: diagnostic.path ?? null,
      entry: entry ? { id: entry.id, name: entry.name ?? null } : null,
      message: diagnostic.message ?? '',
    };
    const mentionsOurPackage = messageMentionsPackage(info.message, ourNames) !== null;
    const attributed = mentionsOurPackage || (entry && (ourRowIds.has(entry.id) || (index !== null && ourRowIndexes.has(index)))) || (!entry && /ohmydsh/i.test(info.message));
    if (info.level !== 'error') {
      if (attributed) tolerated.push(info);
      else upstream.push(info);
    } else if (attributed && isToleratedSchemaMessage(info.message)) {
      tolerated.push(info);
    } else if (attributed) {
      hard.push(info);
    } else {
      upstream.push(info);
    }
  }
  checks.push(
    check(
      'schema-attribution',
      'no schema error is attributable to the ohmydsh layer',
      hard.length === 0,
      hard.length === 0
        ? `${upstream.length} upstream diagnostic(s), ${tolerated.length} tolerated`
        : hard.map((item) => `${item.path ?? '?'} ${item.entry?.id ?? ''}: ${item.message}`).join(' | '),
      { hard, tolerated },
    ),
  );
  return { checks, schemaEntries, hard, tolerated, upstream };
}

/** @param {any[]} ourRows @param {any} modes */
function ompPresetRowId(ourRows, modes) {
  const row = ourRows.find((entry) => entry.name === '@deepseek-ai/dsh-agent-preset' && entry.scalars.get('config.id') === modes.agentPreset);
  return row?.id ?? null;
}

/**
 * Spawn one command and capture it.
 * @param {{ id: string, title: string, command: string[], timeoutMs: number }} step
 * @param {{ env: Record<string, string>, cwd?: string }} options
 */
function runStep(step, options) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(step.command[0], step.command.slice(1), {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolvePromise({ ...step, exitCode: null, signal: null, timedOut: false, stdout: '', stderr: `spawn failed: ${error instanceof Error ? error.message : String(error)}`, error: true });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, step.timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      stderr += `${stderr ? '\n' : ''}spawn failed: ${error.message}`;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ ...step, exitCode: code, signal, timedOut, stdout, stderr });
    });
  });
}

/**
 * Run every planned step for one surface in a fresh isolated DSH_HOME.
 * @param {{
 *   profile: string,
 *   repoRoot: string,
 *   pin: any,
 *   modes: any,
 *   bundleName: string,
 *   dsh: string | null,
 *   runRoot: string,
 *   keep: boolean,
 *   log?: (line: string) => void,
 * }} options
 */
export async function runProfile(options) {
  const plan = planBootstrap({ profile: options.profile, repoRoot: options.repoRoot, pin: options.pin, dsh: options.dsh });
  const profileDir = join(options.runRoot, options.profile);
  const dshHome = join(profileDir, 'dsh-home');
  const logsDir = join(profileDir, 'logs');
  await mkdir(logsDir, { recursive: true });
  const env = { DSH_HOME: dshHome, NO_COLOR: '1' };
  /** @type {any[]} */
  const runs = [];
  for (const step of plan.steps) {
    const result = await runStep(step, { env });
    runs.push(result);
    await writeFile(
      join(logsDir, `${step.id}.log`),
      [`$ ${step.command.join(' ')}`, `exit-code: ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}`, '', '--- stdout ---', result.stdout, '', '--- stderr ---', result.stderr, ''].join('\n'),
      'utf8',
    );
    options.log?.(`  · ${options.profile}/${step.id}: exit ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}`);
  }
  const [bootstrapSteps, dumpRun, schemaRun] = [runs.slice(0, -2), runs[runs.length - 2], runs[runs.length - 1]];

  /** @type {any[]} */
  const checks = [];
  for (const bootstrap of bootstrapSteps) {
    const stderr = String(bootstrap.stderr ?? '').trim();
    checks.push(
      check(`bootstrap:${bootstrap.id}`, `${bootstrap.title}`, bootstrap.exitCode === 0, bootstrap.exitCode === 0 ? 'ok' : `exit code ${bootstrap.exitCode}${bootstrap.timedOut ? ' (timed out)' : ''}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`, {
        command: bootstrap.command,
        exitCode: bootstrap.exitCode,
        stderr: stderr.slice(-4000),
      }),
    );
  }
  const tree = parseComposedTree(dumpRun?.stdout ?? '');
  const dump = checkDump({ modes: options.modes, bundleName: options.bundleName, tree, run: dumpRun });
  checks.push(...dump.checks);
  const schema = checkSchema({ modes: options.modes, bundleName: options.bundleName, tree, ourRows: dump.ourRows, ourNames: dump.ourNames, run: schemaRun });
  checks.push(...schema.checks);

  const summary = summarizeChecks(checks);
  return {
    profile: options.profile,
    profileName: plan.profileName,
    bundleDir: plan.bundleDir,
    dshHome,
    logsDir,
    tmpDir: profileDir,
    ok: summary.ok,
    checks,
    schemaDiagnostics: { hard: schema.hard ?? [], tolerated: schema.tolerated ?? [], upstream: schema.upstream ?? [] },
  };
}

/** Human-readable rendering of one profile result. @param {any} result */
export function formatProfile(result) {
  const lines = [`${result.ok ? 'PASS' : 'FAIL'} ${result.profile} (profile ${result.profileName})`];
  for (const item of result.checks) {
    lines.push(`  ${item.ok ? '✓' : '✗'} ${item.id}: ${item.title}${item.detail ? ` — ${item.detail}` : ''}`);
    if (!item.ok && item.command) lines.push(`      command: ${item.command.join(' ')}`);
  }
  if (!result.ok) lines.push(`  logs: ${result.logsDir}`);
  return `${lines.join('\n')}\n`;
}

/**
 * CLI entry point.
 * @param {string[]} [argv]
 * @param {{ stdout?: { write: (chunk: string) => unknown }, stderr?: { write: (chunk: string) => unknown }, log?: (line: string) => void }} [io]
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  /** @type {any} */
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr.write(`verify-composition: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  const human = io.log ?? (args.json ? (line) => stderr.write(line.endsWith('\n') ? line : `${line}\n`) : (line) => stdout.write(line.endsWith('\n') ? line : `${line}\n`));
  try {
    const repoRoot = args.repoRoot;
    const pin = JSON.parse(await readFile(join(repoRoot, 'upstream.json'), 'utf8'));
    const bundleDir = join(repoRoot, 'packages', 'ohmydsh');
    const bundlePackage = JSON.parse(await readFile(join(bundleDir, 'package.json'), 'utf8'));
    const modes = JSON.parse(await readFile(join(bundleDir, 'modes.json'), 'utf8'));
    const patch = bundlePackage?.dsh?.bundle?.patch;
    const patchFiles = Array.isArray(patch) ? patch : patch ? [patch] : [];
    const missing = patchFiles.filter((file) => !existsSync(join(bundleDir, String(file))));
    if (missing.length > 0) throw new Error(`bundle patch file(s) missing under ${bundleDir}: ${missing.join(', ')} (has the modes slice landed?)`);
    const bundleName = String(bundlePackage.name);
    const profiles = selectProfiles(args.profile);
    const runId = `run-${process.pid}-${Date.now().toString(36)}`;
    const runRoot = join(repoRoot, TMP_ROOT_NAME, runId);
    await mkdir(runRoot, { recursive: true });

    /** @type {any[]} */
    const results = [];
    for (const profile of profiles) {
      human(`verify-composition: ${profile} (dsh ${pin.upstream.version}${args.dsh ? `, --dsh ${args.dsh}` : ', npx'})`);
      const result = await runProfile({ profile, repoRoot, pin, modes, bundleName, dsh: args.dsh, runRoot, keep: args.keep, log: human });
      results.push(result);
      human(formatProfile(result));
    }
    const ok = results.every((result) => result.ok);
    for (const result of results) {
      if (ok && !args.keep) {
        await rm(result.tmpDir, { recursive: true, force: true });
        result.kept = false;
      } else {
        result.kept = true;
      }
    }
    if (ok && !args.keep) {
      await rm(runRoot, { recursive: true, force: true });
      const tmpRoot = join(repoRoot, TMP_ROOT_NAME);
      const leftovers = await readdir(tmpRoot).catch(() => []);
      if (leftovers.length === 0) await rm(tmpRoot, { recursive: true, force: true });
    }
    const payload = {
      schemaVersion: 1,
      ok,
      repoRoot,
      profile: args.profile,
      pin: { dsh: pin.upstream.version, tuiPlugin: pin.tuiPlugin.version, channel: pin.upstream.channel },
      dsh: args.dsh ? { command: args.dsh, source: '--dsh' } : { command: `npx --yes @deepseek-ai/dsh@${pin.upstream.version}`, source: 'npx' },
      bundle: { name: bundleName, dir: bundleDir },
      results,
      kept: results.some((result) => result.kept),
    };
    if (args.json) stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else stdout.write(ok ? `\nverify-composition: all checks passed (${profiles.join(', ')})\n` : `\nverify-composition: FAILED (${results.filter((result) => !result.ok).map((result) => result.profile).join(', ')})\n`);
    return ok ? 0 : 1;
  } catch (error) {
    stderr.write(`verify-composition: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then((code) => {
    process.exitCode = code;
  });
}
