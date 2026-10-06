/**
 * Tests for profile planning and bootstrapping. All dsh invocations go to the
 * committed fake binary; the harness home is always an isolated temp dir.
 *
 * @module ohmydsh/tests/profiles.test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_ROOT, loadUpstream } from '../src/data.js';
import {
  BootstrapError,
  ProfileError,
  ensure,
  plan,
  readProfileManifest,
  runSteps,
  selfInstallSpec,
  updateSteps,
  workspaceRoot,
} from '../src/profiles.js';
import { installFakeDsh, makeTempDir, readLog, testEnv, writeProfileManifest } from './helpers.js';

/**
 * One isolated setup: temp dir, harness home, fake dsh, argv log.
 * @param {import('node:test').TestContext} t - test context for cleanup.
 * @returns {{ dir: string, home: string, fake: string, log: string, env: NodeJS.ProcessEnv }} the setup.
 */
function setup(t) {
  const dir = makeTempDir('ohmydsh-profiles-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const fake = installFakeDsh(dir);
  const log = join(dir, 'log.jsonl');
  return { dir, home, fake, log, env: testEnv(home, { FAKE_DSH_LOG: log }) };
}

test('plan(tui) installs the pinned plugin, then the checkout bundle', () => {
  const dir = makeTempDir('ohmydsh-plan-tui-');
  const home = join(dir, 'home');
  const upstream = loadUpstream(process.env);
  const result = plan('tui', { env: testEnv(home), dshHome: home });

  assert.equal(result.surface, 'tui');
  assert.equal(result.profile, 'ohmydsh-tui');
  assert.equal(result.profileDir, join(home, 'profiles', 'ohmydsh-tui'));
  assert.equal(result.manifestPath, join(home, 'profiles', 'ohmydsh-tui', 'package.json'));
  assert.deepEqual(result.bundles, [`@deepseek-harness-tui/dsh-tui@${upstream.tuiPlugin.version}`, selfInstallSpec()]);
  assert.deepEqual(result.expectedBundles, ['@deepseek-harness-tui/dsh-tui', 'ohmydsh']);
  assert.deepEqual(result.steps.map((step) => step.id), ['tui-plugin', 'self']);
  assert.deepEqual(result.steps[0].argv, ['plugin', '--profile', 'ohmydsh-tui', 'add', `@deepseek-harness-tui/dsh-tui@${upstream.tuiPlugin.version}`]);
  assert.deepEqual(result.steps[1].argv, ['plugin', '--profile', 'ohmydsh-tui', 'add', selfInstallSpec()]);
  assert.equal(result.steps[0].satisfied, false);
  assert.deepEqual(result.steps[0].missing, ['@deepseek-harness-tui/dsh-tui']);
  rmSync(dir, { recursive: true, force: true });
});

test('plan(desktop) initialises the web template, then installs the bundle', () => {
  const dir = makeTempDir('ohmydsh-plan-desktop-');
  const home = join(dir, 'home');
  const result = plan('desktop', { env: testEnv(home), dshHome: home });

  assert.equal(result.profile, 'ohmydsh-desktop');
  assert.deepEqual(result.steps.map((step) => step.id), ['init-web', 'self']);
  assert.deepEqual(result.steps[0].argv, ['--profile', 'ohmydsh-desktop', '--from-default-profile', 'web', '--dump-config']);
  assert.deepEqual(result.steps[0].bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
  assert.deepEqual(result.expectedBundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ohmydsh']);
  assert.deepEqual(result.bundles, [selfInstallSpec()]);
  rmSync(dir, { recursive: true, force: true });
});

test('plan honours the profile override and rejects unsafe names', () => {
  const dir = makeTempDir('ohmydsh-plan-override-');
  const home = join(dir, 'home');
  const result = plan('tui', { env: testEnv(home), dshHome: home, profile: 'my-tui' });
  assert.equal(result.profile, 'my-tui');
  assert.ok(result.steps.every((step) => step.argv.includes('my-tui')));

  for (const invalid of ['', 'a/b', '..', 'node_modules']) {
    assert.throws(() => plan('tui', { env: testEnv(home), dshHome: home, profile: invalid }), ProfileError);
  }
  assert.throws(() => plan(/** @type {any} */ ('headless'), { env: testEnv(home), dshHome: home }), ProfileError);
  rmSync(dir, { recursive: true, force: true });
});

test('selfInstallSpec: file: from a checkout, registry spec otherwise', (t) => {
  assert.ok(workspaceRoot(PACKAGE_ROOT) !== undefined, 'the repo is a checkout');
  assert.equal(selfInstallSpec(), `file:${PACKAGE_ROOT}`);

  const installed = makeTempDir('ohmydsh-installed-');
  t.after(() => rmSync(installed, { recursive: true, force: true }));
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'ohmydsh', version: '9.9.9' }));
  assert.equal(selfInstallSpec(installed), 'ohmydsh@9.9.9');

  const checkout = join(installed, 'checkout');
  mkdirSync(checkout);
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'ohmydsh', version: '9.9.9' }));
  writeFileSync(join(checkout, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  assert.equal(selfInstallSpec(checkout), `file:${checkout}`);
});

test('plan is idempotent against the profile manifest', async (t) => {
  const { home, fake, log, env } = setup(t);
  writeProfileManifest(home, 'ohmydsh-tui', ['@deepseek-ai/dsh-base', '@deepseek-harness-tui/dsh-tui', 'ohmydsh']);

  const result = plan('tui', { env, dshHome: home });
  assert.ok(result.steps.every((step) => step.satisfied), 'all steps satisfied');
  assert.deepEqual(result.steps.map((step) => step.missing), [[], []]);

  // ensure() never spawns when nothing is pending, even with a bogus binary.
  const outcome = await ensure('tui', { env, dshHome: home, command: join(home, 'does-not-exist') });
  assert.deepEqual(outcome.ran, []);
  assert.deepEqual(readLog(log), []);
});

test('ensure runs pending steps in order and reads the manifest back', async (t) => {
  const { home, fake, log, env } = setup(t);

  const outcome = await ensure('desktop', { env, dshHome: home, command: fake });
  assert.deepEqual(outcome.ran.map((step) => step.id), ['init-web', 'self']);

  const lines = readLog(log);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], ['--profile', 'ohmydsh-desktop', '--from-default-profile', 'web', '--dump-config']);
  assert.deepEqual(lines[1], ['plugin', '--profile', 'ohmydsh-desktop', 'add', selfInstallSpec()]);

  const manifest = readProfileManifest(home, 'ohmydsh-desktop');
  assert.equal(manifest.readable, true);
  assert.deepEqual(manifest.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ohmydsh']);
  assert.ok(plan('desktop', { env, dshHome: home }).steps.every((step) => step.satisfied));

  await ensure('desktop', { env, dshHome: home, command: fake });
  assert.equal(readLog(log).length, 2, 'second ensure is a no-op');
});

test('ensure fails instead of initialising with --no-bootstrap', async (t) => {
  const { home, fake, log, env } = setup(t);
  await assert.rejects(
    () => ensure('tui', { env, dshHome: home, command: fake, noBootstrap: true }),
    (error) => error instanceof BootstrapError && /--no-bootstrap/.test(error.message) && error.message.includes('plugin --profile ohmydsh-tui add'),
  );
  assert.deepEqual(readLog(log), []);
});

test('ensure reports a failing step through BootstrapError', async (t) => {
  const { home, fake, log } = setup(t);
  const env = testEnv(home, { FAKE_DSH_LOG: log, FAKE_DSH_ADD_EXIT: '3' });
  await assert.rejects(
    () => ensure('tui', { env, dshHome: home, command: fake }),
    (error) => error instanceof BootstrapError && error.exitCode === 3 && /tui-plugin failed \(exit code 3\)/.test(error.message),
  );
});

test('runSteps reports commands in dry-run mode without spawning', async (t) => {
  const { home, fake, log, env } = setup(t);
  /** @type {string[]} */
  const lines = [];
  const { steps } = updateSteps('tui', { env, dshHome: home });
  const executed = await runSteps(steps, { command: fake, env, dryRun: true, log: (line) => lines.push(line) });
  assert.equal(executed.length, steps.length);
  assert.equal(lines.length, steps.length);
  assert.deepEqual(readLog(log), []);
});

test('updateSteps refreshes and repins the pinned bundles', (t) => {
  const { home, env } = setup(t);
  const { plan: profilePlan, steps } = updateSteps('tui', { env, dshHome: home });
  assert.equal(profilePlan.profile, 'ohmydsh-tui');
  assert.deepEqual(steps.map((step) => step.id), ['tui-plugin', 'self', 'update', 'repin']);
  assert.deepEqual(steps[2].argv, ['plugin', '--profile', 'ohmydsh-tui', 'update']);
  assert.deepEqual(steps[3].argv, ['plugin', '--profile', 'ohmydsh-tui', 'add', `@deepseek-harness-tui/dsh-tui@${loadUpstream(process.env).tuiPlugin.version}`, selfInstallSpec()]);

  writeProfileManifest(home, 'ohmydsh-tui', ['@deepseek-ai/dsh-base', '@deepseek-harness-tui/dsh-tui', 'ohmydsh']);
  const satisfiedUpdate = updateSteps('tui', { env, dshHome: home });
  assert.deepEqual(satisfiedUpdate.steps.map((step) => step.id), ['update', 'repin']);
});

test('readProfileManifest distinguishes missing, corrupt, and valid manifests', (t) => {
  const { home } = setup(t);
  const missing = readProfileManifest(home, 'nope');
  assert.equal(missing.exists, false);
  assert.deepEqual(missing.bundles, []);

  const dir = join(home, 'profiles', 'broken');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{ not json');
  const corrupt = readProfileManifest(home, 'broken');
  assert.equal(corrupt.exists, true);
  assert.equal(corrupt.readable, false);
  assert.deepEqual(corrupt.bundles, []);

  const path = writeProfileManifest(home, 'good', ['ohmydsh']);
  const good = readProfileManifest(home, 'good');
  assert.equal(good.path, path);
  assert.deepEqual(good.bundles, ['ohmydsh']);
});
