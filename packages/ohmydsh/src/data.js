/**
 * Shared data-file helpers for the ohmydsh launcher: the repository read-root,
 * the pinned-upstream reader, and JSON loading with precise diagnostics.
 *
 * `OHMYDSH_HOME` overrides the read-root (tests and CI use it); otherwise the
 * read-root is the git checkout containing this package, or the package root
 * itself for an installed copy.
 *
 * @module ohmydsh/data
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Absolute root of the ohmydsh package (the directory holding its package.json). */
export const PACKAGE_ROOT = resolve(import.meta.dirname, '..');

/** Error raised when a data file is missing, unreadable, malformed, or out of contract. */
export class DataError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'DataError';
  }
}

/**
 * Expand a leading `~`, `~/`, or `~\` against the OS home (mirrors dsh's own
 * home-path expansion).
 * @param {string} value - possibly tilde-prefixed path.
 * @returns {string} the expanded path.
 */
export function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2));
  return value;
}

/**
 * Resolve the repository read-root: `$OHMYDSH_HOME` when set and non-blank,
 * else the nearest ancestor of this package holding `pnpm-workspace.yaml`
 * (a git checkout), else the package root (installed layout).
 * @param {NodeJS.ProcessEnv} [env] - environment to read `OHMYDSH_HOME` from.
 * @returns {string} the absolute read-root.
 */
export function repoRoot(env = process.env) {
  const override = env.OHMYDSH_HOME;
  if (typeof override === 'string' && override.trim() !== '') return resolve(expandHome(override.trim()));
  let dir = PACKAGE_ROOT;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return PACKAGE_ROOT;
    dir = parent;
  }
}

/**
 * Absolute path of a repository data file. Both the checkout layout
 * (`<root>/packages/ohmydsh/modes.json`, `<root>/upstream.json`) and the
 * installed layout (the file beside the package) are supported.
 * @param {'modes.json' | 'upstream.json'} name - data file name.
 * @param {NodeJS.ProcessEnv} [env] - environment to read the read-root from.
 * @returns {string} the absolute path; possibly nonexistent when nothing matches.
 */
export function dataPath(name, env = process.env) {
  const override = env.OHMYDSH_HOME;
  const explicit = typeof override === 'string' && override.trim() !== '';
  const root = repoRoot(env);
  const packaged = explicit ? [] : [join(PACKAGE_ROOT, name)];
  const candidates =
    name === 'modes.json'
      ? [join(root, 'packages', 'ohmydsh', name), join(root, name), ...packaged]
      : [join(root, name), ...packaged];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return candidates[0];
}

/**
 * Read and parse a JSON file.
 * @param {string} path - absolute file path.
 * @returns {unknown} the parsed JSON value.
 * @throws {DataError} when the file is unreadable or not valid JSON.
 */
export function readJsonFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new DataError(`cannot read ${path}: ${describeError(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new DataError(`${path} is not valid JSON: ${describeError(error)}`);
  }
}

/**
 * Render an unknown thrown value for a diagnostic line.
 * @param {unknown} error - the thrown value.
 * @returns {string} a human-readable message.
 */
export function describeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Whether a value is a plain (non-array, non-null) object.
 * @param {unknown} value - value to test.
 * @returns {value is Record<string, unknown>} true for plain records.
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a required non-empty string field with a precise failure message.
 * @param {unknown} value - the field value.
 * @param {string} where - the diagnostic prefix (usually a file path).
 * @param {string} field - the field's dotted name.
 * @returns {string} the validated string.
 * @throws {DataError} when the value is not a non-empty string.
 */
export function requiredString(value, where, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new DataError(`${where}: ${field} must be a non-empty string`);
  return value;
}

/**
 * @typedef {Object} UpstreamPin
 * @property {string} path - the pin file the values were read from.
 * @property {string} repository - the ohmydsh repository URL.
 * @property {string} npmPackage - the upstream dsh npm package name.
 * @property {string} channel - the upstream release channel.
 * @property {string} version - the pinned dsh version.
 * @property {{ npmPackage: string, version: string }} tuiPlugin - the pinned TUI plugin.
 * @property {{ tui: string, desktop: string }} profiles - the profile names per surface.
 */

/**
 * Load and validate the pinned upstream data (`upstream.json`).
 * @param {NodeJS.ProcessEnv} [env] - environment to read the read-root from.
 * @returns {UpstreamPin} the validated pin.
 * @throws {DataError} when the file is missing, malformed, or out of contract.
 */
export function loadUpstream(env = process.env) {
  const path = dataPath('upstream.json', env);
  const value = readJsonFile(path);
  if (!isRecord(value)) throw new DataError(`${path}: top level must be an object`);
  if (value.schemaVersion !== 1) throw new DataError(`${path}: schemaVersion must be 1`);
  const upstream = value.upstream;
  if (!isRecord(upstream)) throw new DataError(`${path}: upstream must be an object`);
  const tui = value.tuiPlugin;
  if (!isRecord(tui)) throw new DataError(`${path}: tuiPlugin must be an object`);
  const profiles = value.profiles;
  if (!isRecord(profiles)) throw new DataError(`${path}: profiles must be an object`);
  return {
    path,
    repository: typeof value.repository === 'string' ? value.repository : '',
    npmPackage: requiredString(upstream.npmPackage, path, 'upstream.npmPackage'),
    channel: typeof upstream.channel === 'string' && upstream.channel !== '' ? upstream.channel : 'latest',
    version: requiredString(upstream.version, path, 'upstream.version'),
    tuiPlugin: {
      npmPackage: requiredString(tui.npmPackage, path, 'tuiPlugin.npmPackage'),
      version: requiredString(tui.version, path, 'tuiPlugin.version'),
    },
    profiles: {
      tui: requiredString(profiles.tui, path, 'profiles.tui'),
      desktop: requiredString(profiles.desktop, path, 'profiles.desktop'),
    },
  };
}

/**
 * Read this package's own manifest (name and version).
 * @param {string} [packageRoot] - package root; defaults to {@link PACKAGE_ROOT}.
 * @returns {{ name: string, version: string }} the package identity.
 * @throws {DataError} when the manifest is unreadable or lacks name/version.
 */
export function loadOwnPackage(packageRoot = PACKAGE_ROOT) {
  const path = join(packageRoot, 'package.json');
  const value = readJsonFile(path);
  if (!isRecord(value)) throw new DataError(`${path}: top level must be an object`);
  return {
    name: requiredString(value.name, path, 'name'),
    version: requiredString(value.version, path, 'version'),
  };
}
