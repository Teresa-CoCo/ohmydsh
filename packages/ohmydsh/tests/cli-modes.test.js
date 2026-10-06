/**
 * Tests for the modes catalog: validation, lookup, and the generated overlay.
 * Uses the shipped `modes.json` plus `OHMYDSH_HOME` fixtures; no network.
 *
 * @module ohmydsh/tests/modes.test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModesError, findMode, modeOverlay, modesCatalog, validateModesCatalog } from '../src/modes.js';
import { makeTempDir } from './helpers.js';

const shipped = modesCatalog();

test('the shipped modes.json satisfies the frozen invariants', () => {
  assert.equal(shipped.schemaVersion, 1);
  assert.equal(shipped.defaultMode, 'build');
  assert.ok(shipped.modes.length >= 3);
  assert.equal(typeof shipped.reasoningEffort, 'string');
  assert.equal(typeof shipped.agentPreset, 'string');
  assert.equal(typeof shipped.persona.prefix, 'string');
  assert.equal(typeof shipped.persona.suffix, 'string');

  const ids = shipped.modes.map((mode) => mode.id);
  const names = shipped.modes.map((mode) => mode.permission.name);
  assert.equal(new Set(ids).size, ids.length, 'mode ids are unique');
  assert.equal(new Set(names).size, names.length, 'permission names are unique');
  for (const mode of shipped.modes) {
    assert.ok(!['custom', 'auto'].includes(mode.permission.name), 'reserved permission names are not used');
    assert.ok(['read-only', 'workspace-write', 'danger-full-access'].includes(mode.permission.sandbox));
    assert.ok(['ask', 'never'].includes(mode.permission.approval));
    assert.equal(typeof mode.planMode, 'boolean');
    assert.notEqual(mode.label, '');
    assert.notEqual(mode.summary, '');
  }
  assert.equal(findMode(shipped, 'plan').planMode, true);
  assert.equal(findMode(shipped, 'build').planMode, false);
  assert.equal(findMode(shipped, 'yolo').permission.sandbox, 'danger-full-access');
});

test('findMode rejects an unknown id with the available ids', () => {
  assert.throws(
    () => findMode(shipped, 'nope'),
    (error) => error instanceof ModesError && /unknown mode "nope"/.test(error.message) && error.message.includes('build'),
  );
});

test('modesCatalog reads the checkout layout through OHMYDSH_HOME', (t) => {
  const root = makeTempDir('ohmydsh-modes-home-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'packages', 'ohmydsh'), { recursive: true });
  writeFileSync(join(root, 'packages', 'ohmydsh', 'modes.json'), JSON.stringify(fixtureCatalog()));

  const catalog = modesCatalog({ env: { OHMYDSH_HOME: root } });
  assert.equal(catalog.defaultMode, 'quick');
  assert.deepEqual(catalog.modes.map((mode) => mode.id), ['quick']);
});

test('modesCatalog also accepts modes.json directly under the read-root', (t) => {
  const root = makeTempDir('ohmydsh-modes-flat-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'modes.json'), JSON.stringify(fixtureCatalog({ defaultMode: 'quick' })));

  const catalog = modesCatalog({ env: { OHMYDSH_HOME: root } });
  assert.equal(catalog.modes.length, 1);
});

test('modesCatalog fails loudly on a missing file', () => {
  const root = makeTempDir('ohmydsh-modes-missing-');
  assert.throws(() => modesCatalog({ env: { OHMYDSH_HOME: join(root, 'nowhere') } }), /cannot read/);
  rmSync(root, { recursive: true, force: true });
});

test('validateModesCatalog rejects every contract violation', async (t) => {
  /** @type {Array<[string, (catalog: any) => void]>} */
  const cases = [
    ['schemaVersion', (catalog) => { catalog.schemaVersion = 2; }],
    ['defaultMode missing mode', (catalog) => { catalog.defaultMode = 'ghost'; }],
    ['duplicate mode id', (catalog) => { catalog.modes.push({ ...catalog.modes[0] }); }],
    ['duplicate permission name', (catalog) => { catalog.modes.push({ ...catalog.modes[0], id: 'second' }); }],
    ['reserved permission name', (catalog) => { catalog.modes[0].permission.name = 'custom'; }],
    ['reserved auto permission name', (catalog) => { catalog.modes[0].permission.name = 'auto'; }],
    ['unknown sandbox', (catalog) => { catalog.modes[0].permission.sandbox = 'read-write'; }],
    ['unknown approval', (catalog) => { catalog.modes[0].permission.approval = 'sometimes'; }],
    ['non-boolean planMode', (catalog) => { catalog.modes[0].planMode = 'yes'; }],
    ['unsafe mode id', (catalog) => { catalog.modes[0].id = '../escape'; }],
    ['empty label', (catalog) => { catalog.modes[0].label = ''; }],
    ['empty modes', (catalog) => { catalog.modes = []; }],
    ['missing agentPreset', (catalog) => { delete catalog.agentPreset; }],
    ['missing persona', (catalog) => { catalog.persona = 'OMP'; }],
    ['non-string summary', (catalog) => { catalog.modes[0].summary = 42; }],
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, () => {
      const value = fixtureCatalog();
      mutate(value);
      assert.throws(
        () => validateModesCatalog(value, 'modes.json'),
        (error) => error instanceof ModesError && error.message.startsWith('modes.json: '),
      );
    });
  }
});

test('validateModesCatalog rejects non-object top levels', () => {
  assert.throws(() => validateModesCatalog('modes', 'modes.json'), (error) => error instanceof ModesError && /top level must be an object/.test(error.message));
  assert.throws(() => validateModesCatalog([], 'modes.json'), ModesError);
  assert.throws(() => validateModesCatalog(null, 'modes.json'), ModesError);
});

test('modeOverlay restates every preset and selects the mode', () => {
  const yaml = modeOverlay('yolo');
  assert.match(yaml, /^# Generated by ohmydsh — do not edit/m);
  assert.match(yaml, /^- id: permission$/m);
  assert.equal(yaml.split('\n').filter((line) => line.startsWith('- id:')).length, 1, 'exactly one patch entry');
  for (const mode of shipped.modes) {
    assert.ok(yaml.includes(`      "${mode.permission.name}":`), `preset ${mode.permission.name} is restated`);
    assert.ok(yaml.includes(`        sandbox: "${mode.permission.sandbox}"`), `sandbox of ${mode.permission.name} is restated`);
    assert.ok(yaml.includes(`        approval: "${mode.permission.approval}"`), `approval of ${mode.permission.name} is restated`);
  }
  assert.equal(yaml.split('\n').filter((line) => line.includes('defaultPreset:')).length, 1, 'exactly one defaultPreset');
  assert.match(yaml, /^    defaultPreset: "omp-full"$/m);
  assert.ok(yaml.endsWith('\n'));
});

test('modeOverlay selects each shipped mode exactly', () => {
  for (const mode of shipped.modes) {
    const yaml = modeOverlay(mode.id);
    assert.match(yaml, new RegExp(`^    defaultPreset: "${mode.permission.name}"$`, 'm'));
  }
  assert.throws(() => modeOverlay('nope'), ModesError);
});

test('modeOverlay works against an OHMYDSH_HOME fixture catalog', (t) => {
  const root = makeTempDir('ohmydsh-modes-overlay-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'packages', 'ohmydsh'), { recursive: true });
  writeFileSync(join(root, 'packages', 'ohmydsh', 'modes.json'), JSON.stringify(fixtureCatalog()));

  const yaml = modeOverlay('quick', { env: { OHMYDSH_HOME: root } });
  assert.match(yaml, /^    defaultPreset: "fixture-quick"$/m);
});

/**
 * A minimal valid catalog used for mutations and fixtures.
 * @param {{ defaultMode?: string }} [overrides] - tweaks.
 * @returns {any} the catalog.
 */
function fixtureCatalog(overrides = {}) {
  return {
    schemaVersion: 1,
    defaultMode: overrides.defaultMode ?? 'quick',
    reasoningEffort: 'max',
    agentPreset: 'omp',
    persona: { prefix: 'You are a fixture.', suffix: 'Be brief.' },
    modes: [
      {
        id: 'quick',
        label: 'Quick',
        summary: 'One fixture mode.',
        description: 'Fixture mode used by the modes tests.',
        planMode: false,
        permission: { name: 'fixture-quick', sandbox: 'workspace-write', approval: 'ask' },
      },
    ],
  };
}
