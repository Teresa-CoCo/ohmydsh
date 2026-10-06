/**
 * Unit tests for scripts/verify-composition.mjs.
 *
 * Network-free and dsh-free: the planning, dump parsing, and assertion helpers
 * run against fixtures that mirror real `dsh --dump-config` /
 * `--dump-config-schema` output captured from dsh 0.2.0-rc.2.
 *
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  UsageError,
  checkDump,
  checkSchema,
  extractConfigScalars,
  isToleratedSchemaMessage,
  layerIncludes,
  messageMentionsPackage,
  parseArgs,
  parseComposedTree,
  planBootstrap,
  selectProfiles,
  summarizeChecks,
} from '../verify-composition.mjs';

/** modes.json-shaped fixture (the frozen contract shape). */
const MODES = {
  schemaVersion: 1,
  defaultMode: 'build',
  reasoningEffort: 'max',
  agentPreset: 'omp',
  persona: { prefix: 'You are an OMP-style coding agent.', suffix: 'Verify your work.' },
  modes: [
    { id: 'plan', label: 'Plan', planMode: true, permission: { name: 'omp-readonly', sandbox: 'read-only', approval: 'ask' } },
    { id: 'build', label: 'Build', planMode: false, permission: { name: 'omp-workspace', sandbox: 'workspace-write', approval: 'ask' } },
    { id: 'yolo', label: 'YOLO', planMode: false, permission: { name: 'omp-full', sandbox: 'danger-full-access', approval: 'never' } },
  ],
};

const PIN = {
  upstream: { version: '0.2.0-rc.2', channel: 'latest' },
  tuiPlugin: { npmPackage: '@deepseek-harness-tui/dsh-tui', version: '0.13.0' },
  profiles: { tui: 'ohmydsh-tui', desktop: 'ohmydsh-desktop' },
};

/** Mirrors the real dump shape: layers group rows by provenance, each row appears once. */
const DUMP = `# == @deepseek-ai/dsh-base
- id: timer
  name: '@deepseek-ai/cordis-plugin-timer'
# == @deepseek-ai/dsh-base, patched by @deepseek-harness-tui/dsh-tui
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: true
# == @deepseek-ai/dsh-base, patched by ohmydsh
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    defaultPreset: omp-workspace
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
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
  config:
    personaPrefix: >-
      You are an OMP-style coding agent powered by the {{model}} model.
    personaSuffix: >-
      Your working directory is {{cwd}}. Verify your work by running it.
- id: plan-mode
  name: '@deepseek-ai/dsh-plan-mode'
  config:
    section: !!js "ctx.get('ompPlanSection') ?? undefined"
# == ohmydsh
- id: preset-omp
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: omp
    name: OMP
    order: 10
    plugins:
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config:
          prefix: You are an OMP-style coding agent.
      - id: cordis
        name: cordis
      - id: tool-bash
        name: '@deepseek-ai/dsh-tool-bash'
`;

/**
 * Build a schema document whose entry list matches the dump order.
 * @param {{ tree: ReturnType<typeof parseComposedTree>, statuses?: Record<string, string>, diagnostics?: any[], complete?: boolean }} options
 */
function schemaDocument({ tree, statuses = {}, diagnostics = [], complete = false }) {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Cordis configuration',
    'x-cordis': {
      profile: 'ohmydsh-desktop',
      complete,
      entries: tree.entries.map((entry) => ({
        path: `/${entry.index - 1}`,
        id: entry.id,
        name: entry.name,
        status: statuses[entry.id] ?? 'schema',
        configRef: '#/$defs/config0',
      })),
      diagnostics,
    },
  };
}

/** @param {Record<string, any>} [overrides] */
function dumpRun(overrides = {}) {
  return { id: 'dump-config', title: 'dump', command: ['dsh', '--profile', 'ohmydsh-desktop', '--dump-config'], exitCode: 0, stderr: '', stdout: DUMP, ...overrides };
}

/**
 * @param {any} document
 * @param {Record<string, any>} [overrides]
 */
function schemaRun(document, overrides = {}) {
  return {
    id: 'dump-config-schema',
    title: 'schema',
    command: ['dsh', '--profile', 'ohmydsh-desktop', '--dump-config-schema'],
    exitCode: document === null ? 2 : 1,
    stderr: '',
    stdout: document === null ? 'boom' : JSON.stringify(document),
    ...overrides,
  };
}

test('parseArgs validates surfaces and flags', () => {
  assert.deepEqual(parseArgs([]), { profile: 'all', json: false, keep: false, dsh: null, repoRoot: parseArgs([]).repoRoot, help: false });
  assert.equal(parseArgs(['--profile', 'tui']).profile, 'tui');
  assert.equal(parseArgs(['--json']).json, true);
  assert.equal(parseArgs(['--keep']).keep, true);
  assert.equal(parseArgs(['--dsh', '/opt/dsh']).dsh, '/opt/dsh');
  assert.equal(parseArgs(['--repo-root', '/srv/repo']).repoRoot, '/srv/repo');
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs(['--profile']), UsageError);
  assert.throws(() => parseArgs(['--profile', 'bogus']), /unknown --profile/);
  assert.throws(() => parseArgs(['--wat']), /unknown argument/);
});

test('selectProfiles returns canonical surfaces', () => {
  assert.deepEqual(selectProfiles('all'), ['tui', 'desktop']);
  assert.deepEqual(selectProfiles('desktop'), ['desktop']);
  assert.deepEqual(selectProfiles('tui'), ['tui']);
  assert.throws(() => selectProfiles('web'), /unknown --profile/);
});

test('planBootstrap reproduces the launcher bootstrap per surface', () => {
  const tui = planBootstrap({ profile: 'tui', repoRoot: '/repo', pin: PIN });
  assert.equal(tui.profileName, 'ohmydsh-tui');
  assert.deepEqual(
    tui.steps.map((step) => step.command),
    [
      ['npx', '--yes', '@deepseek-ai/dsh@0.2.0-rc.2', 'plugin', '--profile', 'ohmydsh-tui', 'add', '@deepseek-harness-tui/dsh-tui@0.13.0'],
      ['npx', '--yes', '@deepseek-ai/dsh@0.2.0-rc.2', 'plugin', '--profile', 'ohmydsh-tui', 'add', 'file:/repo/packages/ohmydsh'],
      ['npx', '--yes', '@deepseek-ai/dsh@0.2.0-rc.2', '--profile', 'ohmydsh-tui', '--dump-config'],
      ['npx', '--yes', '@deepseek-ai/dsh@0.2.0-rc.2', '--profile', 'ohmydsh-tui', '--dump-config-schema'],
    ],
  );

  const desktop = planBootstrap({ profile: 'desktop', repoRoot: '/repo', pin: PIN, dsh: '/opt/dsh' });
  assert.equal(desktop.profileName, 'ohmydsh-desktop');
  assert.deepEqual(
    desktop.steps.map((step) => step.command),
    [
      ['/opt/dsh', '--profile', 'ohmydsh-desktop', '--from-default-profile', 'web', '--dump-config'],
      ['/opt/dsh', 'plugin', '--profile', 'ohmydsh-desktop', 'add', 'file:/repo/packages/ohmydsh'],
      ['/opt/dsh', '--profile', 'ohmydsh-desktop', '--dump-config'],
      ['/opt/dsh', '--profile', 'ohmydsh-desktop', '--dump-config-schema'],
    ],
  );
  assert.ok(desktop.steps.every((step) => step.timeoutMs > 0));
});

test('parseComposedTree follows layer markers and attributes rows', () => {
  const tree = parseComposedTree(DUMP);
  assert.deepEqual(
    tree.layers.map((layer) => layer.contributors),
    [
      ['@deepseek-ai/dsh-base'],
      ['@deepseek-ai/dsh-base', '@deepseek-harness-tui/dsh-tui'],
      ['@deepseek-ai/dsh-base', 'ohmydsh'],
      ['ohmydsh'],
    ],
  );
  const preset = tree.entries.find((entry) => entry.id === 'preset-omp');
  assert.equal(preset?.name, '@deepseek-ai/dsh-agent-preset');
  assert.deepEqual(preset?.contributors, ['ohmydsh']);
  assert.equal(preset?.index, tree.entries.length);
  const patched = tree.entries.find((entry) => entry.id === 'permission');
  assert.equal(patched?.layer, '@deepseek-ai/dsh-base, patched by ohmydsh');
  assert.equal(layerIncludes(patched, 'ohmydsh'), true);
  assert.equal(layerIncludes(patched, '@deepseek-harness-tui/dsh-tui'), false);
  assert.equal(tree.layers.at(-1)?.entryIndexes.length, 1);
});

test('extractConfigScalars reads nested maps and skips block scalars', () => {
  const tree = parseComposedTree(DUMP);
  const permission = tree.entries.find((entry) => entry.id === 'permission' && layerIncludes(entry, 'ohmydsh'));
  assert.equal(permission?.scalars.get('config.defaultPreset'), 'omp-workspace');
  assert.equal(permission?.scalars.get('config.presets.omp-readonly.sandbox'), 'read-only');
  assert.equal(permission?.scalars.get('config.presets.omp-full.approval'), 'never');
  assert.equal(permission?.scalars.get('config.presets.read-only.sandbox'), undefined, 'base presets are replaced, not merged');

  const planMode = tree.entries.find((entry) => entry.id === 'plan-mode' && layerIncludes(entry, 'ohmydsh'));
  assert.equal(planMode?.scalars.get('config.section'), '!!js "ctx.get(\'ompPlanSection\') ?? undefined"');

  const prompt = tree.entries.find((entry) => entry.id === 'system-prompt' && layerIncludes(entry, 'ohmydsh'));
  assert.equal(prompt?.scalars.get('config.personaPrefix'), 'You are an OMP-style coding agent powered by the {{model}} model.');
  assert.equal(prompt?.scalars.get('config.personaSuffix'), 'Your working directory is {{cwd}}. Verify your work by running it.');
  assert.equal(prompt?.scalars.get('personaPrefix'), undefined, 'the `config:` line itself is not a scalar');

  const preset = tree.entries.find((entry) => entry.id === 'preset-omp');
  assert.equal(preset?.scalars.get('config.id'), 'omp');
  assert.equal(preset?.scalars.get('config.order'), '10');
});

test('checkDump passes on a well-composed tree', () => {
  const tree = parseComposedTree(DUMP);
  const { checks, ourRows, ourNames } = checkDump({ modes: MODES, bundleName: 'ohmydsh', tree, run: dumpRun() });
  assert.deepEqual(summarizeChecks(checks), { ok: true, total: 6, failed: [] });
  assert.deepEqual(
    ourRows.map((row) => row.id),
    ['permission', 'system-prompt', 'plan-mode', 'preset-omp'],
  );
  assert.ok(ourNames.has('@deepseek-ai/dsh-agent-preset'));
  assert.ok(ourNames.has('@deepseek-ai/dsh-permission-presets'));
  assert.ok(ourNames.has('@deepseek-ai/dsh-persona'), 'nested plugin names inside inserted rows are attributed too');
  assert.equal(ourNames.has('cordis'), false, 'bare plugin labels are not package names');
  assert.equal(ourNames.has('OMP'), false, 'display names are not package names');
});

test('checkDump fails on missing markers, wrong presets, and wrong agent preset', () => {
  const noMarker = parseComposedTree(DUMP.replace('# == ohmydsh', '# == @deepseek-ai/dsh-base'));
  const missing = checkDump({ modes: MODES, bundleName: 'ohmydsh', tree: noMarker, run: dumpRun() });
  assert.equal(missing.checks.find((item) => item.id === 'layer-marker')?.ok, true, 'the patched-by marker still counts as a layer contribution');
  assert.equal(missing.checks.find((item) => item.id === 'agent-preset')?.ok, false);

  const noOhmydsh = parseComposedTree(DUMP.replace(/, patched by ohmydsh/g, '').replace('# == ohmydsh\n', ''));
  const absent = checkDump({ modes: MODES, bundleName: 'ohmydsh', tree: noOhmydsh, run: dumpRun() });
  assert.deepEqual(summarizeChecks(absent.checks).failed, ['layer-marker', 'ohmydsh-rows', 'permission-presets', 'agent-preset']);

  const wrongPreset = parseComposedTree(DUMP.replace('omp-full:\n        sandbox: danger-full-access', 'omp-full:\n        sandbox: workspace-write'));
  const wrong = checkDump({ modes: MODES, bundleName: 'ohmydsh', tree: wrongPreset, run: dumpRun() });
  const permissionCheck = wrong.checks.find((item) => item.id === 'permission-presets');
  assert.equal(permissionCheck?.ok, false);
  assert.match(String(permissionCheck?.detail), /omp-full is workspace-write\/never, expected danger-full-access\/never/);

  const extraPreset = parseComposedTree(DUMP.replace('      omp-full:\n        sandbox: danger-full-access\n        approval: never', '      omp-full:\n        sandbox: danger-full-access\n        approval: never\n      custom:\n        sandbox: read-only\n        approval: ask'));
  const extra = checkDump({ modes: MODES, bundleName: 'ohmydsh', tree: extraPreset, run: dumpRun() });
  assert.match(String(extra.checks.find((item) => item.id === 'permission-presets')?.detail), /unexpected preset custom/);

  const wrongDefault = parseComposedTree(DUMP.replace('defaultPreset: omp-workspace', 'defaultPreset: omp-readonly'));
  const defaultCheck = checkDump({ modes: MODES, bundleName: 'ohmydsh', tree: wrongDefault, run: dumpRun() });
  assert.match(String(defaultCheck.checks.find((item) => item.id === 'permission-presets')?.detail), /defaultPreset is omp-readonly, expected omp-workspace/);
});

test('checkDump reports bad exits and dirty stderr', () => {
  const tree = parseComposedTree(DUMP);
  const failed = checkDump({ modes: MODES, bundleName: 'ohmydsh', tree, run: dumpRun({ exitCode: 1, stderr: 'dsh: error: unmatched patch target `nope`' }) });
  assert.deepEqual(summarizeChecks(failed.checks).failed, ['dump-exit', 'dump-stderr']);
  assert.match(String(failed.checks.find((item) => item.id === 'dump-stderr')?.detail), /unmatched patch target/);
});

test('checkSchema passes when ohmydsh rows collect schemas and upstream errors are tolerated', () => {
  const tree = parseComposedTree(DUMP);
  const { ourRows, ourNames } = checkDump({ modes: MODES, bundleName: 'ohmydsh', tree, run: dumpRun() });
  const document = schemaDocument({
    tree,
    diagnostics: [
      { level: 'warning', path: '/1', message: 'config/section: loose validation can replace invalid values with defaults' },
      { level: 'error', path: '/5', message: 'unrecognized Loader tree carrier; use cordis:group or cordis:include for native child collection' },
      { level: 'error', path: '/0', message: "Cannot find package '@deepseek-ai/dsh-code-runtime-worker-thread' imported from /tmp/x/cordis.yml" },
    ],
  });
  const result = checkSchema({ modes: MODES, bundleName: 'ohmydsh', tree, ourRows, ourNames, run: schemaRun(document) });
  assert.deepEqual(summarizeChecks(result.checks), { ok: true, total: 4, failed: [] });
  assert.equal(result.tolerated.length, 1, 'the tree-carrier error on the omp agent-preset row is a known pinned-dsh limitation');
  assert.equal(result.upstream.length, 2, 'warnings and other-package errors are reported, not fatal');
  assert.equal(result.hard.length, 0);
  assert.equal(isToleratedSchemaMessage('unrecognized Loader tree carrier; use cordis:group or cordis:include for native child collection'), true);
  assert.equal(isToleratedSchemaMessage('Cannot find package'), false);
});

test('checkSchema fails when an ohmydsh package does not resolve', () => {
  const tree = parseComposedTree(DUMP);
  const { ourRows, ourNames } = checkDump({ modes: MODES, bundleName: 'ohmydsh', tree, run: dumpRun() });
  const presetIndex = (tree.entries.find((entry) => entry.id === 'preset-omp')?.index ?? 1) - 1;
  const document = schemaDocument({
    tree,
    statuses: { 'preset-omp': 'error' },
    diagnostics: [{ level: 'error', path: `/${presetIndex}`, message: "Cannot find package '@deepseek-ai/dsh-persona' imported from /tmp/x/cordis.yml" }],
  });
  const result = checkSchema({ modes: MODES, bundleName: 'ohmydsh', tree, ourRows, ourNames, run: schemaRun(document) });
  assert.deepEqual(summarizeChecks(result.checks).failed, ['schema-ohmydsh-rows', 'schema-attribution']);
  assert.match(String(result.checks.find((item) => item.id === 'schema-ohmydsh-rows')?.detail), /preset-omp/);
  assert.match(String(result.checks.find((item) => item.id === 'schema-attribution')?.detail), /dsh-persona/);
  assert.equal(result.hard.length, 1);
});

test('checkSchema fails on crashes and non-JSON output', () => {
  const tree = parseComposedTree(DUMP);
  const { ourRows, ourNames } = checkDump({ modes: MODES, bundleName: 'ohmydsh', tree, run: dumpRun() });
  const crashed = checkSchema({ modes: MODES, bundleName: 'ohmydsh', tree, ourRows, ourNames, run: schemaRun(null, { exitCode: null, stderr: 'spawn dsh ENOENT' }) });
  const crashedFailed = summarizeChecks(crashed.checks).failed;
  assert.deepEqual(crashedFailed, ['schema-exit', 'schema-json', 'schema-ohmydsh-rows']);

  const document = schemaDocument({ tree });
  const garbled = checkSchema({ modes: MODES, bundleName: 'ohmydsh', tree, ourRows, ourNames, run: schemaRun(document, { stdout: 'not json', exitCode: 0 }) });
  assert.deepEqual(summarizeChecks(garbled.checks).failed, ['schema-json', 'schema-ohmydsh-rows']);
});

test('checkSchema does not attribute lookalike package names to ohmydsh', () => {
  const tree = parseComposedTree(DUMP);
  const { ourRows, ourNames } = checkDump({ modes: MODES, bundleName: 'ohmydsh', tree, run: dumpRun() });
  // The TUI plugin's own rows reference packages our rows never mention, even
  // though `@deepseek-ai/dsh-agent-presets` contains `@deepseek-ai/dsh-agent-preset`.
  assert.equal(messageMentionsPackage("Cannot find package '@deepseek-ai/dsh-agent-presets'", ourNames), null);
  assert.equal(messageMentionsPackage("Cannot find package '@deepseek-ai/dsh-agent-preset'", ourNames), '@deepseek-ai/dsh-agent-preset');
  assert.equal(messageMentionsPackage('imported from /tmp/ohmydsh-tui/cordis.yml', ourNames), null, 'a path fragment is not a package token');
  assert.equal(
    messageMentionsPackage('unrecognized Loader tree carrier; use cordis:group or cordis:include for native child collection', new Set(['cordis'])),
    null,
    'a bare name must not match the cordis:group syntax in upstream diagnostics',
  );

  const document = schemaDocument({
    tree,
    statuses: { 'tool-bash': 'error' },
    diagnostics: [{ level: 'error', path: '/1', message: "Cannot find package '@deepseek-ai/dsh-agent-presets' imported from /tmp/x/cordis.yml" }],
  });
  const result = checkSchema({ modes: MODES, bundleName: 'ohmydsh', tree, ourRows, ourNames, run: schemaRun(document) });
  assert.equal(summarizeChecks(result.checks).ok, true);
  assert.equal(result.hard.length, 0, 'the lookalike package is an upstream diagnostic, not an ohmydsh breakage');
  assert.equal(result.upstream.length, 1);
});

test('checkSchema tolerates missing-anchor diagnostics naming our rows but not our packages', () => {
  const tree = parseComposedTree(DUMP);
  const { ourRows, ourNames } = checkDump({ modes: MODES, bundleName: 'ohmydsh', tree, run: dumpRun() });
  const permissionRow = tree.entries.find((entry) => entry.id === 'permission' && layerIncludes(entry, 'ohmydsh'));
  const permissionIndex = (permissionRow?.index ?? 0) - 1;
  const document = schemaDocument({
    tree,
    diagnostics: [{ level: 'error', path: `/${permissionIndex}`, message: 'unrecognized Loader tree carrier; use cordis:group or cordis:include for native child collection' }],
  });
  const result = checkSchema({ modes: MODES, bundleName: 'ohmydsh', tree, ourRows, ourNames, run: schemaRun(document) });
  assert.equal(summarizeChecks(result.checks).ok, true);
  assert.equal(result.tolerated.length, 1);
});
