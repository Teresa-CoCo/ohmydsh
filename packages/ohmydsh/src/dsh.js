/**
 * Locating and running the real `dsh`: binary resolution (`--dsh`, then
 * `$DSH_REAL`, then `dsh` on `PATH`), captured and passthrough spawning with
 * Windows-safe shell handling, and exit-code propagation.
 *
 * @module ohmydsh/dsh
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { constants as osConstants, homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { expandHome } from './data.js';

/** Error raised when the dsh binary cannot be found or started. */
export class DshError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'DshError';
  }
}

/**
 * @typedef {Object} LocatedDsh
 * @property {string} command - absolute path (or PATH-resolved name) to run.
 * @property {'flag' | 'DSH_REAL' | 'PATH'} source - where it was found.
 * @property {string[]} notes - diagnostics about skipped candidates.
 */

/**
 * Resolve the DeepSeek Harness home exactly like dsh does: `$DSH_HOME` when
 * non-blank, else `~/.dsh`, with a leading `~` expanded.
 * @param {NodeJS.ProcessEnv} [env] - environment to read `DSH_HOME` from.
 * @returns {string} the absolute harness home.
 */
export function resolveDshHome(env = process.env) {
  const configured = env.DSH_HOME;
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(expandHome(configured.trim()));
  return join(homedir(), '.dsh');
}

/**
 * Whether spawning this command needs a shell: Windows npm shims (`.cmd` /
 * `.bat`) are not executable images, so `spawn` must go through `cmd.exe`.
 * @param {string} command - the command to spawn.
 * @param {NodeJS.Platform} [platform] - platform to decide for.
 * @returns {boolean} true when `shell: true` is required.
 */
export function needsShell(command, platform = process.platform) {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

/**
 * Render a command line for humans (POSIX-style quoting; display only).
 * @param {string} command - executable.
 * @param {readonly string[]} args - arguments.
 * @returns {string} the quoted command line.
 */
export function formatCommand(command, args) {
  return [command, ...args].map(quoteArg).join(' ');
}

/**
 * @param {string} value - one argv token.
 * @returns {string} the token, single-quoted when it contains shell-special characters.
 */
function quoteArg(value) {
  if (value !== '' && /^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Locate the dsh binary: `--dsh <path>` first, then `$DSH_REAL`, then `dsh`
 * on `PATH`. An explicit `--dsh` that is not executable is an error; a stale
 * `$DSH_REAL` is reported in `notes` and skipped.
 * @param {{ explicit?: string | undefined, env?: NodeJS.ProcessEnv, cwd?: string,
 *   platform?: NodeJS.Platform }} [options] - `explicit` is the `--dsh` value.
 * @returns {LocatedDsh | null} the located binary, or null when none was found.
 * @throws {DshError} when `--dsh` was given but is not executable.
 */
export function locateDsh(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const explicit = options.explicit;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const found = findExecutable(explicit.trim(), { env, cwd, platform });
    if (found === undefined) throw new DshError(`--dsh ${explicit.trim()} is not an executable file`);
    return { command: found, source: 'flag', notes: [] };
  }
  /** @type {string[]} */
  const notes = [];
  const fromEnv = env.DSH_REAL;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    const found = findExecutable(fromEnv.trim(), { env, cwd, platform });
    if (found !== undefined) return { command: found, source: 'DSH_REAL', notes };
    notes.push(`$DSH_REAL=${fromEnv.trim()} is not an executable file`);
  }
  const onPath = findOnPath('dsh', { env, platform, cwd });
  if (onPath !== undefined) return { command: onPath, source: 'PATH', notes };
  return null;
}

/**
 * Resolve one executable path, trying Windows `PATHEXT` suffixes there.
 * @param {string} target - absolute or relative path (a leading `~` is expanded).
 * @param {{ env: NodeJS.ProcessEnv, cwd: string, platform: NodeJS.Platform }} options
 * @returns {string | undefined} the executable path, or undefined.
 */
function findExecutable(target, options) {
  const base = isAbsolute(target) ? target : resolve(options.cwd, expandHome(target));
  const candidates = options.platform === 'win32' ? [base, ...pathExts(options.env).map((ext) => base + ext)] : [base];
  for (const candidate of candidates) {
    if (isExecutable(candidate, options.platform)) return candidate;
  }
  return undefined;
}

/**
 * @param {string} candidate - path to test.
 * @param {NodeJS.Platform} platform - platform to test for.
 * @returns {boolean} true when the path is a file this platform can execute.
 */
function isExecutable(candidate, platform) {
  try {
    if (!statSync(candidate).isFile()) return false;
    // X_OK reflects the real executable bit on POSIX and is meaningless on Windows.
    if (platform !== 'win32') accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {NodeJS.ProcessEnv} env - environment holding `PATHEXT`.
 * @returns {string[]} the Windows executable extensions.
 */
function pathExts(env) {
  const raw = env.PATHEXT;
  const value = typeof raw === 'string' && raw !== '' ? raw : '.COM;.EXE;.BAT;.CMD';
  return value
    .split(';')
    .filter((ext) => ext !== '')
    .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));
}

/**
 * Search `$PATH` for a command.
 * @param {string} name - command name.
 * @param {{ env: NodeJS.ProcessEnv, platform: NodeJS.Platform, cwd: string }} options
 * @returns {string | undefined} the resolved path, or undefined.
 */
function findOnPath(name, options) {
  const raw = options.env.PATH;
  if (typeof raw !== 'string' || raw === '') return undefined;
  for (const dir of raw.split(delimiter)) {
    if (dir === '') continue;
    const found = findExecutable(join(dir, name), options);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * @typedef {Object} RunResult
 * @property {number | null} code - exit code (null when killed or not started).
 * @property {NodeJS.Signals | null} signal - terminating signal, if any.
 * @property {string} stdout - captured stdout.
 * @property {string} stderr - captured stderr.
 * @property {Error | undefined} error - spawn failure or timeout.
 * @property {boolean} timedOut - true when the timeout fired.
 */

/**
 * Run a command with captured output. Never rejects: spawn failures and
 * timeouts are reported in the result so callers can print a report.
 * @param {string} command - executable.
 * @param {readonly string[]} args - arguments.
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, platform?: NodeJS.Platform,
 *   timeoutMs?: number }} [options] - `timeoutMs` > 0 kills a hung child.
 * @returns {Promise<RunResult>} the result.
 */
export function runCapture(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  return new Promise((settle) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd ?? process.cwd(),
        env: options.env ?? process.env,
        shell: needsShell(command, platform),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      settle({ code: null, signal: null, stdout: '', stderr: '', error: asError(error), timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const finish = (/** @type {RunResult} */ result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(result);
    };
    const timeoutMs = options.timeoutMs ?? 0;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({
          code: null,
          signal: 'SIGKILL',
          stdout,
          stderr,
          error: new DshError(`${command} did not finish within ${timeoutMs}ms`),
          timedOut: true,
        });
      }, timeoutMs);
    }
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      finish({ code: null, signal: null, stdout, stderr, error, timedOut: false });
    });
    child.on('close', (code, signal) => {
      finish({ code, signal, stdout, stderr, error: undefined, timedOut: false });
    });
  });
}

/**
 * Run a command with inherited stdio (the boot path), propagating its exit
 * status: a signal termination becomes `128 + signal number`.
 * @param {string} command - executable.
 * @param {readonly string[]} args - arguments.
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, platform?: NodeJS.Platform }} [options]
 * @returns {Promise<number>} the exit code to propagate.
 * @throws {DshError} when the process cannot be started.
 */
export function runPassthrough(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  return new Promise((settle, reject) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd ?? process.cwd(),
        env: options.env ?? process.env,
        shell: needsShell(command, platform),
        stdio: 'inherit',
        windowsHide: true,
      });
    } catch (error) {
      reject(new DshError(`failed to start ${command}: ${asError(error).message}`));
      return;
    }
    child.on('error', (error) => {
      reject(new DshError(`failed to start ${command}: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      if (code !== null) {
        settle(code);
        return;
      }
      const number = signal === null ? 1 : (osConstants.signals[signal] ?? 0) + 128;
      settle(number === 128 ? 1 : number);
    });
  });
}

/**
 * @typedef {Object} DshVersionResult
 * @property {boolean} ok - true when `--version` ran and parsed.
 * @property {string} version - the reported version ('' when unknown).
 * @property {number | null} code - process exit code.
 * @property {string} stdout - captured stdout.
 * @property {string} stderr - captured stderr.
 * @property {string} detail - human-readable summary.
 */

/**
 * Read `dsh --version`.
 * @param {string} command - the dsh binary.
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, platform?: NodeJS.Platform,
 *   timeoutMs?: number }} [options] - passed through to {@link runCapture}.
 * @returns {Promise<DshVersionResult>} the parsed version result.
 */
export async function readDshVersion(command, options = {}) {
  const result = await runCapture(command, ['--version'], options);
  if (result.error !== undefined) {
    return { ok: false, version: '', code: result.code, stdout: result.stdout, stderr: result.stderr, detail: `cannot run ${command} --version: ${result.error.message}` };
  }
  if (result.code !== 0) {
    return { ok: false, version: '', code: result.code, stdout: result.stdout, stderr: result.stderr, detail: `${command} --version exited ${result.code}` };
  }
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(result.stdout);
  if (match === null) {
    return { ok: false, version: '', code: result.code, stdout: result.stdout, stderr: result.stderr, detail: `${command} --version printed no version: ${JSON.stringify(result.stdout.trim())}` };
  }
  return { ok: true, version: match[1], code: result.code, stdout: result.stdout, stderr: result.stderr, detail: `${command} --version → ${match[1]}` };
}

/**
 * Best-effort error normalisation.
 * @param {unknown} value - thrown value.
 * @returns {Error} an Error instance.
 */
export function asError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
