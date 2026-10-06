/**
 * End-to-end tests for the launcher CLI. The real dsh is never invoked: every
 * spawn goes to the committed fake binary, and every run gets an isolated
 * `DSH_HOME` under the temp dir. No network.
 *
 * @module ohmydsh/tests/cli.test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { USAGE, UsageError, parseArgs, run, writeModeOverlay } from '../src/cli.js';
import { PACKAGE_ROOT, loadOwnPackage, loadUpstream } from '../src/data.js';
import { selfInstallSpec } from '../src/profiles.js';
import { Sink, installFakeDsh, makeTempDir, readLog, testEnv, writeProfileManifest } from './helpers.js';

const own = loadOwnPackage(PACKAGE_ROOT);
const upstream = loadUpstream(process.env);
const tuiBundles = ['@deepseek-ai/dsh-base', upstream.tuiPlugin.npmPackage, own.name];
const desktopBundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', own.name];

/** @typedef {{ defaultMode: string, agentPreset: string, modes: Array<{ id: string, default: boolean, permission: { name: string } }> }} ModesReport */
/** @typedef {{ ok: boolean, checks: Array<{ id: string, status: string, detail: string }>, counts: { pass: number, warn: number, fail: number, skip: number } }} DoctorReport */

/**
 * Assert that a lookup found something and narrow its type.
 * @template T
 * @param {T | undefined} value - possibly missing value.
 * @param {string} label - description used in the assertion message.
 * @returns {T} the present value.
 */
function required(value, label) {
  assert.ok(value !== undefined, `${label} is present`);
  return /** @type {T} */ (value);
}

/**
 * One isolated launcher setup.
 * @param {import('node:test').TestContext} t - test context for cleanup.
 * @param {Record<string, string>} [extra] - extra environment variables.
 * @returns {{ dir: string, home: string, fake: string, log: string, env: NodeJS.ProcessEnv }} the setup.
 */
function setup(t, extra = {}) {
  const dir = makeTempDir('ohmydsh-cli-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const fake = installFakeDsh(dir);
  const log = join(dir, 'log.jsonl');
  return { dir, home, fake, log, env: testEnv(home, { FAKE_DSH_LOG: log, ...extra }) };
}

test('parseArgs: commands, flags, aliases, and passthrough', () => {
  assert.deepEqual(parseArgs([]), {
    command: 'tui',
    explicitCommand: false,
    mode: undefined,
    profile: undefined,
    dsh: undefined,
    dryRun: false,
    json: false,
    noBootstrap: false,
    passthrough: [],
  });
  assert.equal(parseArgs(['desktop']).command, 'desktop');
  assert.equal(parseArgs(['web']).command, 'desktop');
  assert.equal(parseArgs(['modes']).command, 'modes');
  assert.equal(parseArgs(['doctor']).command, 'doctor');
  assert.equal(parseArgs(['update']).command, 'update');
  assert.equal(parseArgs(['version']).command, 'version');
  assert.equal(parseArgs(['--version']).command, 'version');
  assert.equal(parseArgs(['-V']).command, 'version');
  assert.equal(parseArgs(['help']).command, 'help');
  assert.equal(parseArgs(['--help']).command, 'help');
  assert.equal(parseArgs(['-h']).command, 'help');

  const boot = parseArgs(['--mode', 'yolo', 'tui', '--resume', 'abc', '--no-open']);
  assert.equal(boot.command, 'tui');
  assert.equal(boot.mode, 'yolo');
  assert.deepEqual(boot.passthrough, ['--resume', 'abc', '--no-open']);

  const inline = parseArgs(['--mode=plan', '--profile=my-tui', '--dsh=/tmp/dsh', 'desktop']);
  assert.equal(inline.mode, 'plan');
  assert.equal(inline.profile, 'my-tui');
  assert.equal(inline.dsh, '/tmp/dsh');

  const verbatim = parseArgs(['desktop', '--', '--mode', 'not-ours']);
  assert.deepEqual(verbatim.passthrough, ['--mode', 'not-ours']);
  assert.equal(verbatim.mode, undefined);

  assert.equal(parseArgs(['modes', '--json']).json, true);
  assert.equal(parseArgs(['tui', '--dry-run', '--no-bootstrap']).noBootstrap, true);
  assert.equal(parseArgs(['doctor', '--dsh', '/tmp/x']).dsh, '/tmp/x');
});

test('parseArgs: malformed invocations raise UsageError', () => {
  for (const argv of [
    ['bogus'],
    ['modes', 'extra'],
    ['modes', '--mode', 'build'],
    ['modes', '--no-open'],
    ['doctor', '--profile', 'x'],
    ['update', '--json'],
    ['tui', '--json'],
    ['--mode'],
    ['--profile='],
    ['version', 'extra'],
  ]) {
    assert.throws(() => parseArgs(argv), UsageError, `expected UsageError for ${argv.join(' ')}`);
  }
});

test('modes: human list and --json report', async () => {
  const out = new Sink();
  const err = new Sink();
  assert.equal(await run(['modes'], { stdout: out, stderr: err }), 0);
  assert.match(out.text, /OMP modes — default: build/);
  assert.match(out.text, /\* build {2}Build \(default\)/);
  assert.match(out.text, /permission: omp-workspace \(sandbox=workspace-write, approval=ask\)/);
  assert.match(out.text, /plan  Plan/);
  assert.match(out.text, /yolo  YOLO/);
  assert.equal(err.text, '');

  const jsonOut = new Sink();
  assert.equal(await run(['modes', '--json'], { stdout: jsonOut, stderr: new Sink() }), 0);
  const report = /** @type {ModesReport} */ (JSON.parse(jsonOut.text));
  assert.equal(report.defaultMode, 'build');
  assert.equal(report.agentPreset, 'omp');
  assert.deepEqual(report.modes.map((mode) => mode.id), ['plan', 'build', 'yolo']);
  const build = required(report.modes.find((mode) => mode.id === 'build'), 'build mode');
  assert.equal(build.default, true);
  assert.equal(build.permission.name, 'omp-workspace');
});

test('version prints ohmydsh and both pins', async () => {
  const out = new Sink();
  assert.equal(await run(['version'], { stdout: out, stderr: new Sink() }), 0);
  assert.match(out.text, new RegExp(`^ohmydsh ${own.version.replaceAll('.', '\\.')}$`, 'm'));
  assert.ok(out.text.includes(`${upstream.npmPackage} ${upstream.version}`), 'pinned dsh');
  assert.ok(out.text.includes(`${upstream.tuiPlugin.npmPackage} ${upstream.tuiPlugin.version}`), 'pinned TUI plugin');
});

test('help prints the usage text', async () => {
  const out = new Sink();
  assert.equal(await run(['help'], { stdout: out, stderr: new Sink() }), 0);
  assert.equal(out.text, `${USAGE}\n`);
});

test('unknown invocations exit 2 with the usage text', async () => {
  const err = new Sink();
  assert.equal(await run(['bogus'], { stdout: new Sink(), stderr: err }), 2);
  assert.match(err.text, /unknown command "bogus"/);
  assert.match(err.text, /Usage:/);
});

test('tui --dry-run prints the bootstrap and boot commands and boots nothing', async (t) => {
  const { home, fake, log, env } = setup(t);
  const err = new Sink();
  assert.equal(await run(['tui', '--dry-run', '--dsh', fake], { env, stdout: new Sink(), stderr: err }), 0);
  assert.deepEqual(readLog(log), [], 'nothing was spawned');
  assert.ok(!existsSync(join(home, 'ohmydsh', 'mode-build.yml')), 'dry run writes no overlay');
  assert.match(err.text, /would run: .*plugin --profile ohmydsh-tui add @deepseek-harness-tui\/dsh-tui@0\.13\.0/);
  assert.match(err.text, /would run: .*--profile ohmydsh-tui --patch .*mode-build\.yml$/m);
  assert.match(err.text, /dry run/);
});

test('desktop --dry-run keeps passthrough arguments verbatim', async (t) => {
  const { fake, env } = setup(t);
  const err = new Sink();
  assert.equal(await run(['desktop', '--no-open', '--dry-run', '--dsh', fake], { env, stdout: new Sink(), stderr: err }), 0);
  assert.match(err.text, /--profile ohmydsh-desktop --patch .*mode-build\.yml --no-open/);
  assert.match(err.text, /--from-default-profile web --dump-config/);

  const web = new Sink();
  assert.equal(await run(['web', '--dry-run', '--dsh', fake], { env, stdout: new Sink(), stderr: web }), 0);
  assert.match(web.text, /--profile ohmydsh-desktop/);
});

test('tui --mode plan prints the /plan hint', async (t) => {
  const { fake, env } = setup(t);
  const err = new Sink();
  assert.equal(await run(['tui', '--mode', 'plan', '--dry-run', '--dsh', fake], { env, stdout: new Sink(), stderr: err }), 0);
  assert.match(err.text, /press \/plan in-session/);
});

test('an unknown --mode exits 2', async (t) => {
  const { fake, env } = setup(t);
  const err = new Sink();
  assert.equal(await run(['tui', '--mode', 'nope', '--dry-run', '--dsh', fake], { env, stdout: new Sink(), stderr: err }), 2);
  assert.match(err.text, /unknown mode "nope"/);
});

test('boot bootstraps the profile, writes the overlay, and propagates the exit code', async (t) => {
  const { home, fake, log } = setup(t);
  writeProfileManifest(home, 'ohmydsh-tui', tuiBundles);
  const env = testEnv(home, { FAKE_DSH_LOG: log, FAKE_DSH_EXIT: '7' });
  const err = new Sink();

  const code = await run(['tui', '--mode', 'yolo', '--resume', 'abc', '--dsh', fake], { env, stdout: new Sink(), stderr: err });
  assert.equal(code, 7, 'the booted surface exit code is propagated');

  const lines = readLog(log);
  assert.equal(lines.length, 1, 'bootstrap was skipped and only the boot ran');
  assert.deepEqual(lines[0].slice(0, 2), ['--profile', 'ohmydsh-tui']);
  assert.equal(lines[0][2], '--patch');
  assert.match(lines[0][3], /[/\\]ohmydsh[/\\]mode-yolo\.yml$/);
  assert.deepEqual(lines[0].slice(4), ['--resume', 'abc']);

  const overlay = readFileSync(lines[0][3], 'utf8');
  assert.match(overlay, /^# Generated by ohmydsh/m);
  assert.match(overlay, /^    defaultPreset: "omp-full"$/m);
  assert.match(err.text, /OMP mode "yolo"/);
  if (process.platform !== 'win32') {
    assert.equal(statSync(lines[0][3]).mode & 0o777, 0o600, 'overlay file is 0600');
    assert.equal(statSync(join(home, 'ohmydsh')).mode & 0o777, 0o700, 'overlay dir is 0700');
  }
});

test('boot runs the bootstrap steps before booting', async (t) => {
  const { home, fake, log, env } = setup(t);
  const code = await run(['tui', '--dsh', fake], { env, stdout: new Sink(), stderr: new Sink() });
  assert.equal(code, 0);
  const lines = readLog(log);
  assert.equal(lines.length, 3, 'two bootstrap steps plus the boot');
  assert.deepEqual(lines[0], ['plugin', '--profile', 'ohmydsh-tui', 'add', `@deepseek-harness-tui/dsh-tui@${upstream.tuiPlugin.version}`]);
  assert.deepEqual(lines[1], ['plugin', '--profile', 'ohmydsh-tui', 'add', selfInstallSpec()]);
  assert.deepEqual(lines[2].slice(0, 2), ['--profile', 'ohmydsh-tui']);
  assert.deepEqual(lines[2].slice(4), [], 'no passthrough arguments');
  assert.equal(lines[2][3].endsWith('mode-build.yml'), true);
});

test('--no-bootstrap fails instead of initialising a profile', async (t) => {
  const { fake, log, env } = setup(t);
  const err = new Sink();
  assert.equal(await run(['tui', '--no-bootstrap', '--dsh', fake], { env, stdout: new Sink(), stderr: err }), 1);
  assert.match(err.text, /--no-bootstrap/);
  assert.deepEqual(readLog(log), []);
});

test('a missing dsh binary fails cleanly', async (t) => {
  const { env, log } = setup(t);
  const err = new Sink();
  assert.equal(await run(['tui', '--dsh', join(log, '..', 'nope'), '--dry-run'], { env, stdout: new Sink(), stderr: err }), 1);
  assert.match(err.text, /is not an executable file/);
});

test('update refreshes and repins both profiles', async (t) => {
  const { fake, log, env } = setup(t);
  assert.equal(await run(['update', '--dsh', fake], { env, stdout: new Sink(), stderr: new Sink() }), 0);

  const tuiSpec = `@deepseek-harness-tui/dsh-tui@${upstream.tuiPlugin.version}`;
  assert.deepEqual(readLog(log), [
    ['plugin', '--profile', 'ohmydsh-tui', 'add', tuiSpec],
    ['plugin', '--profile', 'ohmydsh-tui', 'add', selfInstallSpec()],
    ['plugin', '--profile', 'ohmydsh-tui', 'update'],
    ['plugin', '--profile', 'ohmydsh-tui', 'add', tuiSpec, selfInstallSpec()],
    ['--profile', 'ohmydsh-desktop', '--from-default-profile', 'web', '--dump-config'],
    ['plugin', '--profile', 'ohmydsh-desktop', 'add', selfInstallSpec()],
    ['plugin', '--profile', 'ohmydsh-desktop', 'update'],
    ['plugin', '--profile', 'ohmydsh-desktop', 'add', selfInstallSpec()],
  ]);
});

test('update --dry-run prints the refresh plan without spawning', async (t) => {
  const { fake, log, env } = setup(t);
  const err = new Sink();
  assert.equal(await run(['update', '--dry-run', '--dsh', fake], { env, stdout: new Sink(), stderr: err }), 0);
  assert.deepEqual(readLog(log), []);
  assert.match(err.text, /plugin --profile ohmydsh-tui update/);
  assert.match(err.text, /plugin --profile ohmydsh-desktop add/);
});

test('doctor --json reports pins, profiles, and composition and exits 0', async (t) => {
  const { home, fake, log } = setup(t);
  writeProfileManifest(home, 'ohmydsh-tui', tuiBundles);
  writeProfileManifest(home, 'ohmydsh-desktop', desktopBundles);
  const env = testEnv(home, { FAKE_DSH_LOG: log });
  const out = new Sink();
  assert.equal(await run(['doctor', '--json', '--dsh', fake], { env, stdout: out, stderr: new Sink() }), 0);

  const report = /** @type {DoctorReport} */ (JSON.parse(out.text));
  assert.equal(report.ok, true);
  const status = Object.fromEntries(report.checks.map((check) => [check.id, check.status]));
  assert.equal(status.node, 'pass');
  assert.equal(status.pin, 'pass');
  assert.equal(status['tui-plugin'], 'pass');
  assert.equal(status.modes, 'pass');
  assert.equal(status['dsh-version'], 'pass');
  assert.equal(status['profile:tui'], 'pass');
  assert.equal(status['profile:desktop'], 'pass');
  assert.equal(status['composition:tui'], 'pass');
  assert.equal(status['composition:desktop'], 'pass');
  assert.equal(report.counts.fail, 0);
  // The dump ran once per profile, and only for composition.
  const dumps = readLog(log).filter((argv) => argv.includes('--dump-config'));
  assert.equal(dumps.length, 2);
  assert.deepEqual(dumps[0], ['--profile', 'ohmydsh-tui', '--dump-config']);
});

test('doctor warns on a dsh version mismatch but still passes', async (t) => {
  const { home, fake, log } = setup(t);
  writeProfileManifest(home, 'ohmydsh-tui', tuiBundles);
  writeProfileManifest(home, 'ohmydsh-desktop', desktopBundles);
  const env = testEnv(home, { FAKE_DSH_LOG: log, FAKE_DSH_VERSION: '0.9.9' });
  const out = new Sink();
  assert.equal(await run(['doctor', '--json', '--dsh', fake], { env, stdout: out, stderr: new Sink() }), 0);
  const report = /** @type {DoctorReport} */ (JSON.parse(out.text));
  assert.equal(report.ok, true);
  const version = required(report.checks.find((check) => check.id === 'dsh-version'), 'dsh-version check');
  assert.equal(version.status, 'warn');
  assert.ok(version.detail.includes('0.9.9'));
  assert.ok(version.detail.includes(upstream.version));
  assert.ok(version.detail.includes('upstream.json'));
});

test('doctor fails when profiles are missing and when composition is dirty', async (t) => {
  const { home, fake, log } = setup(t);
  const env = testEnv(home, { FAKE_DSH_LOG: log });
  const out = new Sink();
  assert.equal(await run(['doctor', '--json', '--dsh', fake], { env, stdout: out, stderr: new Sink() }), 1);
  const report = /** @type {DoctorReport} */ (JSON.parse(out.text));
  assert.equal(report.ok, false);
  const status = Object.fromEntries(report.checks.map((check) => [check.id, check.status]));
  assert.equal(status['profile:tui'], 'fail');
  assert.equal(status['composition:tui'], 'skip');
  assert.ok(required(report.checks.find((check) => check.id === 'profile:tui'), 'tui profile check').detail.includes('ohmydsh tui'));

  // A profile that exists but composes dirty fails the composition check.
  writeProfileManifest(home, 'ohmydsh-tui', tuiBundles);
  writeProfileManifest(home, 'ohmydsh-desktop', desktopBundles);
  const dirty = testEnv(home, { FAKE_DSH_LOG: log, FAKE_DSH_DUMP_STDERR: '1' });
  const dirtyOut = new Sink();
  assert.equal(await run(['doctor', '--json', '--dsh', fake], { env: dirty, stdout: dirtyOut, stderr: new Sink() }), 1);
  const dirtyReport = /** @type {DoctorReport} */ (JSON.parse(dirtyOut.text));
  const composition = required(dirtyReport.checks.find((check) => check.id === 'composition:tui'), 'composition check');
  assert.equal(composition.status, 'fail');
  assert.match(composition.detail, /wrote to stderr/);
});

test('doctor prints a human report and never touches $HOME/.dsh', async (t) => {
  const { home, fake, log } = setup(t);
  const env = testEnv(home, { FAKE_DSH_LOG: log });
  const out = new Sink();
  assert.equal(await run(['doctor', '--dsh', fake], { env, stdout: out, stderr: new Sink() }), 1);
  assert.match(out.text, /^ohmydsh doctor$/m);
  assert.match(out.text, /FAIL profile ohmydsh-tui bootstrapped/);
  assert.match(out.text, /doctor: FAILED/);
});

test('OHMYDSH_HOME points modes and doctor at a fixture read-root', async (t) => {
  const { dir, env } = setup(t);
  const root = join(dir, 'fixture-root');
  mkdirSync(join(root, 'packages', 'ohmydsh'), { recursive: true });
  mkdirSync(join(root, 'profiles'), { recursive: true });
  const fixture = {
    schemaVersion: 1,
    defaultMode: 'solo',
    reasoningEffort: 'max',
    agentPreset: 'omp',
    persona: { prefix: 'p', suffix: 's' },
    modes: [
      {
        id: 'solo',
        label: 'Solo',
        summary: 'Fixture mode.',
        description: 'Fixture mode.',
        planMode: false,
        permission: { name: 'fixture-solo', sandbox: 'read-only', approval: 'never' },
      },
    ],
  };
  writeFileSyncJson(join(root, 'packages', 'ohmydsh', 'modes.json'), fixture);
  writeFileSyncJson(join(root, 'upstream.json'), {
    schemaVersion: 1,
    repository: 'https://example.invalid/ohmydsh',
    upstream: { repository: 'x', npmPackage: '@deepseek-ai/dsh', channel: 'latest', version: '1.2.3', publishedAt: '', resolvedAt: '' },
    tuiPlugin: { npmPackage: '@deepseek-harness-tui/dsh-tui', version: '4.5.6' },
    profiles: { tui: 'fixture-tui', desktop: 'fixture-desktop' },
    compat: { verified: [] },
  });

  const out = new Sink();
  assert.equal(await run(['modes'], { env: { ...env, OHMYDSH_HOME: root }, stdout: out, stderr: new Sink() }), 0);
  assert.match(out.text, /default: solo/);
  assert.ok(out.text.includes('fixture-solo'));

  const versionOut = new Sink();
  assert.equal(await run(['version'], { env: { ...env, OHMYDSH_HOME: root }, stdout: versionOut, stderr: new Sink() }), 0);
  assert.ok(versionOut.text.includes('1.2.3'), 'pinned dsh from the fixture root');
  assert.ok(versionOut.text.includes('4.5.6'), 'pinned TUI plugin from the fixture root');
});

test('writeModeOverlay hardens the overlay directory and file', (t) => {
  const { home } = setup(t);
  const file = writeModeOverlay('build', '- id: permission\n', { dshHome: home });
  assert.equal(file, join(home, 'ohmydsh', 'mode-build.yml'));
  assert.equal(readFileSync(file, 'utf8'), '- id: permission\n');
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(home, 'ohmydsh')).mode & 0o777, 0o700);
  }
});

/**
 * @param {string} path - file path.
 * @param {unknown} value - JSON value.
 * @returns {void}
 */
function writeFileSyncJson(path, value) {
  writeFileSync(path, JSON.stringify(value));
}
