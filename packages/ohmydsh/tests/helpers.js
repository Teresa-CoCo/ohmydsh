/**
 * Shared test helpers: temp dirs, a capturing sink, and the fake dsh binary.
 *
 * Tests never require the network and never touch the developer's real
 * `$HOME/.dsh`: every run gets its own `DSH_HOME` under the OS temp dir.
 *
 * @module ohmydsh/tests/helpers
 */
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This test directory. */
export const TESTS_DIR = dirname(fileURLToPath(import.meta.url));

/** The committed fake dsh fixture. */
export const FAKE_DSH_FIXTURE = join(TESTS_DIR, 'fixtures', 'fake-dsh.cjs');

/** A tiny collecting sink shaped like a writable stream. */
export class Sink {
  constructor() {
    /** @type {string} */
    this.text = '';
  }

  /**
   * @param {string} chunk - written text.
   * @returns {boolean} always true.
   */
  write(chunk) {
    this.text += String(chunk);
    return true;
  }
}

/**
 * Create a temp directory for one test.
 * @param {string} prefix - directory name prefix.
 * @returns {string} the absolute temp directory.
 */
export function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Write a fake dsh executable into `dir` and return its path.
 * @param {string} dir - directory to install into.
 * @returns {string} the executable path.
 */
export function installFakeDsh(dir) {
  const target = join(dir, 'fake-dsh.cjs');
  copyFileSync(FAKE_DSH_FIXTURE, target);
  chmodSync(target, 0o755);
  return target;
}

/**
 * Environment for a launcher run: the repo environment plus an isolated
 * harness home.
 * @param {string} home - the isolated `DSH_HOME`.
 * @param {Record<string, string>} [extra] - extra variables.
 * @returns {NodeJS.ProcessEnv} the environment.
 */
export function testEnv(home, extra = {}) {
  return { ...process.env, DSH_HOME: home, ...extra };
}

/**
 * Write a profile manifest straight into an isolated harness home.
 * @param {string} home - the isolated `DSH_HOME`.
 * @param {string} profile - profile name.
 * @param {string[]} bundles - `dsh.profile.bundles` entries.
 * @returns {string} the manifest path.
 */
export function writeProfileManifest(home, profile, bundles) {
  const dir = join(home, 'profiles', profile);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'package.json');
  const value = { name: `dsh-profile-${profile}`, private: true, dependencies: {}, dsh: { profile: { bundles } } };
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

/**
 * Read the fake dsh's recorded invocations.
 * @param {string} logPath - the log file (missing when nothing ran).
 * @returns {string[][]} one argv array per invocation.
 */
export function readLog(logPath) {
  let text = '';
  try {
    text = readFileSync(logPath, 'utf8');
  } catch {
    text = '';
  }
  if (text === '') return [];
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => /** @type {string[]} */ (JSON.parse(line)));
}
