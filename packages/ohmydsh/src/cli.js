/**
 * The ohmydsh command line: argument parsing, dispatch, and exit codes.
 *
 * Exit codes: 0 success; 1 launcher/report failure (or the booted dsh's own
 * propagated code); 2 usage error.
 *
 * @module ohmydsh/cli
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_ROOT, describeError, loadOwnPackage, loadUpstream } from './data.js';
import { doctor } from './doctor.js';
import { formatCommand, locateDsh, resolveDshHome, runPassthrough } from './dsh.js';
import { findMode, modeOverlay, modesCatalog } from './modes.js';
import { BootstrapError, ProfileError, SURFACES, ensure, plan, runSteps, updateSteps } from './profiles.js';

/** @typedef {import('./profiles.js').Surface} Surface */
/** @typedef {'tui' | 'desktop' | 'modes' | 'doctor' | 'update' | 'version' | 'help'} Command */

/** Usage text for `ohmydsh help` and usage errors. */
export const USAGE = `ohmydsh — OMP-flavoured DeepSeek Harness (dsh) distribution

Usage:
  ohmydsh [tui] [flags] [-- <dsh args>...]        boot the TUI surface (default)
  ohmydsh desktop | web [flags] [-- <dsh args>...]
                                                  boot the desktop surface
  ohmydsh modes [--json]                          list OMP working modes
  ohmydsh doctor [--json]                         environment, pin, profile and composition report
  ohmydsh update                                  refresh both profiles to the pinned bundles
  ohmydsh version | --version                     print ohmydsh, pinned dsh and pinned TUI plugin
  ohmydsh help | --help                           show this help

Flags (before the surface name):
  --mode <id>        OMP mode to launch (default: modes.json defaultMode)
  --profile <name>   override the profile name
  --dsh <path>       dsh binary (fallback: $DSH_REAL, then dsh on PATH)
  --dry-run          print the command lines; bootstrap and boot nothing
  --json             machine-readable output for modes/doctor
  --no-bootstrap     fail instead of initialising missing profiles

Everything after \`--\`, plus unknown arguments, is passed to the booted
surface verbatim (e.g. \`ohmydsh desktop --no-open\`).
Env: OHMYDSH_HOME overrides the repo read-root for modes.json/upstream.json;
DSH_HOME is honoured by dsh itself and never modified by ohmydsh.`;

/** Error for malformed invocations; maps to exit code 2. */
export class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * @typedef {Object} ParsedArgs
 * @property {Command} command - the command to run (`tui`/`desktop` boot a surface).
 * @property {boolean} explicitCommand - true when the command was written out.
 * @property {string | undefined} mode - `--mode` value.
 * @property {string | undefined} profile - `--profile` value.
 * @property {string | undefined} dsh - `--dsh` value.
 * @property {boolean} dryRun - `--dry-run`.
 * @property {boolean} json - `--json`.
 * @property {boolean} noBootstrap - `--no-bootstrap`.
 * @property {string[]} passthrough - arguments handed to the booted surface.
 */

/** Command tokens, including the `web` alias for the desktop surface. */
const COMMAND_ALIASES = {
  tui: 'tui',
  desktop: 'desktop',
  web: 'desktop',
  modes: 'modes',
  doctor: 'doctor',
  update: 'update',
  version: 'version',
  help: 'help',
};

/** Flag keys allowed per command; anything else is a usage error (boots pass through). */
const ALLOWED_FLAGS = /** @type {const} */ ({
  tui: ['mode', 'profile', 'dsh', 'dryRun', 'noBootstrap'],
  desktop: ['mode', 'profile', 'dsh', 'dryRun', 'noBootstrap'],
  modes: ['json'],
  doctor: ['json', 'dsh'],
  update: ['dryRun', 'dsh'],
  version: [],
  help: [],
});

/**
 * Parse launcher arguments. Launcher flags may appear before or after the
 * command; everything after `--`, unknown flags (boot commands only), and any
 * extra positional is collected into `passthrough`.
 * @param {string[]} argv - arguments after the executable.
 * @returns {ParsedArgs} the parsed invocation.
 * @throws {UsageError} when the invocation is malformed.
 */
export function parseArgs(argv) {
  /** @type {ParsedArgs} */
  const args = {
    command: 'tui',
    explicitCommand: false,
    mode: undefined,
    profile: undefined,
    dsh: undefined,
    dryRun: false,
    json: false,
    noBootstrap: false,
    passthrough: [],
  };
  /** @type {Set<string>} */
  const used = new Set();
  let verbatim = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (verbatim) {
      args.passthrough.push(token);
      continue;
    }
    if (token === '--') {
      verbatim = true;
      continue;
    }
    const option = /^--([a-z][a-z-]*)(?:=([\s\S]*))?$/.exec(token);
    if (option !== null) {
      const name = option[1];
      const inline = option[2];
      if (name === 'mode' || name === 'profile' || name === 'dsh') {
        const value = inline !== undefined ? inline : argv[index + 1];
        if (value === undefined || value === '') throw new UsageError(`--${name} requires a value`);
        if (inline === undefined) index += 1;
        if (name === 'mode') args.mode = value;
        else if (name === 'profile') args.profile = value;
        else args.dsh = value;
        used.add(name);
        continue;
      }
      if (name === 'dry-run' || name === 'json' || name === 'no-bootstrap') {
        if (name === 'dry-run') args.dryRun = true;
        else if (name === 'json') args.json = true;
        else args.noBootstrap = true;
        used.add(name === 'dry-run' ? 'dryRun' : name === 'no-bootstrap' ? 'noBootstrap' : 'json');
        continue;
      }
      if (name === 'help') {
        args.command = 'help';
        args.explicitCommand = true;
        continue;
      }
      if (name === 'version') {
        args.command = 'version';
        args.explicitCommand = true;
        continue;
      }
      if (isBootCommand(args.command)) {
        args.passthrough.push(token);
        continue;
      }
      throw new UsageError(`unknown option ${JSON.stringify(token)}`);
    }
    if (token.startsWith('-') && token !== '-') {
      if (token === '-h') {
        args.command = 'help';
        args.explicitCommand = true;
        continue;
      }
      if (token === '-V') {
        args.command = 'version';
        args.explicitCommand = true;
        continue;
      }
      if (isBootCommand(args.command)) {
        args.passthrough.push(token);
        continue;
      }
      throw new UsageError(`unknown option ${JSON.stringify(token)}`);
    }
    if (!args.explicitCommand) {
      const command = commandFor(token);
      if (command === undefined) throw new UsageError(`unknown command ${JSON.stringify(token)}`);
      args.command = command;
      args.explicitCommand = true;
      continue;
    }
    if (isBootCommand(args.command)) {
      args.passthrough.push(token);
      continue;
    }
    throw new UsageError(`command ${args.command} accepts no arguments (got ${JSON.stringify(token)})`);
  }
  validateFlags(args, used);
  return args;
}

/**
 * @param {string} token - first positional token.
 * @returns {Command | undefined} the command it names.
 */
function commandFor(token) {
  return /** @type {Record<string, Command | undefined>} */ (COMMAND_ALIASES)[token];
}

/**
 * @param {Command} command - parsed command.
 * @returns {boolean} true for a surface boot.
 */
function isBootCommand(command) {
  return command === 'tui' || command === 'desktop';
}

/**
 * Reject launcher flags a command does not accept, and extra arguments on
 * commands that take none.
 * @param {ParsedArgs} args - parsed invocation.
 * @param {Set<string>} used - launcher flags that were written.
 * @returns {void}
 * @throws {UsageError} on a mismatch.
 */
function validateFlags(args, used) {
  if (!isBootCommand(args.command) && args.passthrough.length > 0) {
    throw new UsageError(`command ${args.command} accepts no arguments (got ${JSON.stringify(args.passthrough[0])})`);
  }
  const allowed = ALLOWED_FLAGS[args.command];
  for (const flag of used) {
    if (!allowed.some((candidate) => candidate === flag)) {
      throw new UsageError(`${spellFlag(flag)} cannot be used with command ${args.command} (allowed: ${allowed.length === 0 ? 'none' : allowed.map(spellFlag).join(', ')})`);
    }
  }
}

/** CLI spelling per stable flag key, for diagnostics. */
const FLAG_SPELLING = /** @type {Record<string, string>} */ ({
  mode: '--mode',
  profile: '--profile',
  dsh: '--dsh',
  dryRun: '--dry-run',
  json: '--json',
  noBootstrap: '--no-bootstrap',
});

/**
 * @param {string} key - stable flag key.
 * @returns {string} the CLI spelling.
 */
function spellFlag(key) {
  return FLAG_SPELLING[key] ?? `--${key}`;
}

/**
 * @typedef {Object} RunOptions
 * @property {NodeJS.ProcessEnv} [env] - environment for data files and spawned processes.
 * @property {string} [cwd] - working directory.
 * @property {{ write: (chunk: string) => unknown }} [stdout] - report sink.
 * @property {{ write: (chunk: string) => unknown }} [stderr] - diagnostic sink.
 */

/**
 * Run one ohmydsh invocation.
 * @param {string[]} argv - arguments after the executable.
 * @param {RunOptions} [options] - overrides for tests and embedders.
 * @returns {Promise<number>} the process exit code.
 */
export async function run(argv, options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  /** @type {ParsedArgs} */
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`ohmydsh: ${error.message}\n\n${USAGE}\n`);
      return 2;
    }
    throw error;
  }
  switch (args.command) {
    case 'help':
      stdout.write(`${USAGE}\n`);
      return 0;
    case 'version':
      return commandVersion({ env, stdout, stderr });
    case 'modes':
      return commandModes(args, { env, stdout, stderr });
    case 'doctor':
      return commandDoctor(args, { env, cwd, stdout, stderr });
    case 'update':
      return commandUpdate(args, { env, cwd, stderr });
    case 'tui':
    case 'desktop':
      return commandBoot(args, args.command, { env, cwd, stdout, stderr });
    default:
      stderr.write(`ohmydsh: unknown command ${JSON.stringify(args.command)}\n`);
      return 2;
  }
}

/**
 * `ohmydsh` entry point: run and record the exit code on the process.
 * @param {string[]} [argv] - arguments after the executable.
 * @param {RunOptions} [options] - overrides for tests and embedders.
 * @returns {Promise<number>} the exit code.
 */
export async function main(argv = process.argv.slice(2), options = {}) {
  const code = await run(argv, options);
  process.exitCode = code;
  return code;
}

/**
 * @param {{ env: NodeJS.ProcessEnv, stdout: { write: (chunk: string) => unknown }, stderr: { write: (chunk: string) => unknown } }} io - sinks.
 * @returns {number} the exit code.
 */
function commandVersion(io) {
  try {
    const own = loadOwnPackage(PACKAGE_ROOT);
    const upstream = loadUpstream(io.env);
    io.stdout.write(
      `ohmydsh ${own.version}\n` +
        `${upstream.npmPackage} ${upstream.version} (pinned, channel ${upstream.channel})\n` +
        `${upstream.tuiPlugin.npmPackage} ${upstream.tuiPlugin.version} (pinned)\n`,
    );
    return 0;
  } catch (error) {
    io.stderr.write(`ohmydsh: ${describeError(error)}\n`);
    return 1;
  }
}

/**
 * @param {ParsedArgs} args - parsed invocation.
 * @param {{ env: NodeJS.ProcessEnv, stdout: { write: (chunk: string) => unknown }, stderr: { write: (chunk: string) => unknown } }} io - sinks.
 * @returns {number} the exit code.
 */
function commandModes(args, io) {
  /** @type {import('./modes.js').ModesCatalog} */
  let catalog;
  try {
    catalog = modesCatalog({ env: io.env });
  } catch (error) {
    io.stderr.write(`ohmydsh: ${describeError(error)}\n`);
    return 1;
  }
  if (args.json) {
    io.stdout.write(`${JSON.stringify(modesReport(catalog), null, 2)}\n`);
  } else {
    io.stdout.write(renderModes(catalog));
  }
  return 0;
}

/**
 * @param {import('./modes.js').ModesCatalog} catalog - validated catalog.
 * @returns {{ schemaVersion: number, defaultMode: string, reasoningEffort: string, agentPreset: string, modes: object[] }} machine-readable report.
 */
function modesReport(catalog) {
  return {
    schemaVersion: catalog.schemaVersion,
    defaultMode: catalog.defaultMode,
    reasoningEffort: catalog.reasoningEffort,
    agentPreset: catalog.agentPreset,
    modes: catalog.modes.map((mode) => ({
      id: mode.id,
      label: mode.label,
      summary: mode.summary,
      description: mode.description,
      planMode: mode.planMode,
      permission: { name: mode.permission.name, sandbox: mode.permission.sandbox, approval: mode.permission.approval },
      default: mode.id === catalog.defaultMode,
    })),
  };
}

/**
 * @param {import('./modes.js').ModesCatalog} catalog - validated catalog.
 * @returns {string} the human-readable modes list.
 */
function renderModes(catalog) {
  const lines = [`OMP modes — default: ${catalog.defaultMode}`];
  for (const mode of catalog.modes) {
    const isDefault = mode.id === catalog.defaultMode;
    lines.push(`${isDefault ? '*' : ' '} ${mode.id}  ${mode.label}${isDefault ? ' (default)' : ''}`);
    lines.push(`    ${mode.summary}`);
    lines.push(`    permission: ${mode.permission.name} (sandbox=${mode.permission.sandbox}, approval=${mode.permission.approval})`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * @param {ParsedArgs} args - parsed invocation.
 * @param {{ env: NodeJS.ProcessEnv, cwd: string, stdout: { write: (chunk: string) => unknown }, stderr: { write: (chunk: string) => unknown } }} io - sinks.
 * @returns {Promise<number>} the exit code.
 */
async function commandDoctor(args, io) {
  /** @type {import('./doctor.js').DoctorReport} */
  let report;
  try {
    report = await doctor({ env: io.env, cwd: io.cwd, dsh: args.dsh });
  } catch (error) {
    io.stderr.write(`ohmydsh: doctor failed unexpectedly: ${describeError(error)}\n`);
    return 1;
  }
  if (args.json) {
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    io.stdout.write(renderDoctor(report));
  }
  return report.ok ? 0 : 1;
}

/**
 * @param {import('./doctor.js').DoctorReport} report - the report.
 * @returns {string} the human-readable report.
 */
function renderDoctor(report) {
  const lines = ['ohmydsh doctor'];
  for (const check of report.checks) {
    lines.push(`  ${check.status.toUpperCase().padEnd(4)} ${check.label} — ${check.detail}`);
  }
  lines.push(`${report.counts.pass} passed, ${report.counts.warn} warned, ${report.counts.fail} failed, ${report.counts.skip} skipped`);
  lines.push(report.ok ? 'doctor: OK' : 'doctor: FAILED');
  return `${lines.join('\n')}\n`;
}

/**
 * @param {ParsedArgs} args - parsed invocation.
 * @param {{ env: NodeJS.ProcessEnv, cwd: string, stderr: { write: (chunk: string) => unknown } }} io - sinks.
 * @returns {Promise<number>} the exit code.
 */
async function commandUpdate(args, io) {
  const binary = resolveBinary(args, io, { required: args.dryRun !== true });
  if (binary === null) return 1;
  for (const surface of SURFACES) {
    /** @type {import('./profiles.js').ProfilePlan} */
    let planResult;
    /** @type {import('./profiles.js').PlanStep[]} */
    let steps;
    try {
      ({ plan: planResult, steps } = updateSteps(surface, { env: io.env }));
    } catch (error) {
      io.stderr.write(`ohmydsh: ${describeError(error)}\n`);
      return 1;
    }
    io.stderr.write(`ohmydsh: updating profile ${planResult.profile} (${surface})\n`);
    try {
      await runSteps(steps, {
        command: binary.command,
        env: io.env,
        cwd: io.cwd,
        dryRun: args.dryRun,
        log: (line) => io.stderr.write(`ohmydsh: ${line}\n`),
      });
    } catch (error) {
      if (error instanceof BootstrapError) {
        io.stderr.write(`ohmydsh: ${error.message}\n`);
        return error.exitCode;
      }
      throw error;
    }
  }
  return 0;
}

/**
 * Boot one surface: write the mode overlay, bootstrap the profile, then hand
 * off to dsh with the passthrough arguments.
 * @param {ParsedArgs} args - parsed invocation.
 * @param {Surface} surface - surface to boot.
 * @param {{ env: NodeJS.ProcessEnv, cwd: string, stdout: { write: (chunk: string) => unknown }, stderr: { write: (chunk: string) => unknown } }} io - sinks.
 * @returns {Promise<number>} the exit code.
 */
async function commandBoot(args, surface, io) {
  /** @type {import('./modes.js').ModesCatalog} */
  let catalog;
  try {
    catalog = modesCatalog({ env: io.env });
  } catch (error) {
    io.stderr.write(`ohmydsh: ${describeError(error)}\n`);
    return 1;
  }
  const modeId = args.mode ?? catalog.defaultMode;
  /** @type {import('./modes.js').Mode} */
  let mode;
  try {
    mode = findMode(catalog, modeId);
  } catch (error) {
    io.stderr.write(`ohmydsh: ${describeError(error)}\n`);
    return 2;
  }
  /** @type {import('./data.js').UpstreamPin} */
  let upstream;
  try {
    upstream = loadUpstream(io.env);
  } catch (error) {
    io.stderr.write(`ohmydsh: ${describeError(error)}\n`);
    return 1;
  }
  /** @type {import('./profiles.js').ProfilePlan} */
  let profilePlan;
  try {
    profilePlan = plan(surface, { env: io.env, profile: args.profile, upstream });
  } catch (error) {
    if (error instanceof ProfileError) {
      io.stderr.write(`ohmydsh: ${describeError(error)}\n`);
      return 2;
    }
    io.stderr.write(`ohmydsh: ${describeError(error)}\n`);
    return 1;
  }
  const binary = resolveBinary(args, io, { required: args.dryRun !== true });
  if (binary === null) return 1;
  try {
    await ensure(surface, {
      env: io.env,
      cwd: io.cwd,
      profile: args.profile,
      upstream,
      command: binary.command,
      noBootstrap: args.noBootstrap,
      dryRun: args.dryRun,
      log: (line) => io.stderr.write(`ohmydsh: ${line}\n`),
    });
  } catch (error) {
    if (error instanceof BootstrapError) {
      io.stderr.write(`ohmydsh: ${error.message}\n`);
      return error.exitCode;
    }
    if (error instanceof ProfileError) {
      io.stderr.write(`ohmydsh: ${describeError(error)}\n`);
      return 2;
    }
    io.stderr.write(`ohmydsh: ${describeError(error)}\n`);
    return 1;
  }
  const overlayPath = join(resolveDshHome(io.env), 'ohmydsh', `mode-${mode.id}.yml`);
  const overlayText = modeOverlay(mode.id, { catalog });
  if (args.dryRun) {
    io.stderr.write(`ohmydsh: dry run — nothing was bootstrapped or booted\n`);
    io.stderr.write(`ohmydsh: would write ${overlayPath} (OMP mode ${JSON.stringify(mode.id)})\n`);
  } else {
    writeModeOverlay(mode.id, overlayText, { env: io.env });
    io.stderr.write(`ohmydsh: OMP mode ${JSON.stringify(mode.id)} → ${overlayPath} (sandbox=${mode.permission.sandbox}, approval=${mode.permission.approval})\n`);
  }
  if (mode.planMode) {
    io.stderr.write(`ohmydsh: mode ${JSON.stringify(mode.id)} is read-only; press /plan in-session to enter dsh plan mode\n`);
  }
  const bootArgv = ['--profile', profilePlan.profile, '--patch', overlayPath, ...args.passthrough];
  if (args.dryRun) {
    io.stderr.write(`ohmydsh: would run: ${formatCommand(binary.command, bootArgv)}\n`);
    return 0;
  }
  try {
    return await runPassthrough(binary.command, bootArgv, { env: io.env, cwd: io.cwd });
  } catch (error) {
    io.stderr.write(`ohmydsh: ${describeError(error)}\n`);
    return 1;
  }
}

/**
 * @param {ParsedArgs} args - parsed invocation.
 * @param {{ env: NodeJS.ProcessEnv, cwd: string, stderr: { write: (chunk: string) => unknown } }} io - sinks.
 * @param {{ required: boolean }} options - when false, a missing binary only downgrades the printed command.
 * @returns {{ command: string } | null} the binary to run, or null after reporting the failure.
 */
function resolveBinary(args, io, options) {
  try {
    const located = locateDsh({ explicit: args.dsh, env: io.env, cwd: io.cwd });
    if (located !== null) return { command: located.command };
    if (options.required) {
      io.stderr.write('ohmydsh: dsh binary not found (use --dsh <path>, $DSH_REAL, or dsh on PATH)\n');
      return null;
    }
    return { command: args.dsh ?? 'dsh' };
  } catch (error) {
    io.stderr.write(`ohmydsh: ${describeError(error)}\n`);
    return null;
  }
}

/**
 * Write the generated mode overlay under `$DSH_HOME/ohmydsh/`, creating the
 * directory 0700 and the file 0600.
 * @param {string} modeId - the selected mode.
 * @param {string} yaml - the overlay text from `modeOverlay`.
 * @param {{ env?: NodeJS.ProcessEnv, dshHome?: string }} [options] - overrides.
 * @returns {string} the overlay path.
 */
export function writeModeOverlay(modeId, yaml, options = {}) {
  const home = options.dshHome ?? resolveDshHome(options.env ?? process.env);
  const dir = join(home, 'ohmydsh');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `mode-${modeId}.yml`);
  writeFileSync(file, yaml, { mode: 0o600 });
  restrict(dir, 0o700);
  restrict(file, 0o600);
  return file;
}

/**
 * Best-effort chmod: Windows and some mounts do not support file modes.
 * @param {string} path - file or directory.
 * @param {number} mode - the POSIX mode to force.
 * @returns {void}
 */
function restrict(path, mode) {
  try {
    chmodSync(path, mode);
  } catch {
    // The mode is a hardening measure, not a correctness requirement.
  }
}
