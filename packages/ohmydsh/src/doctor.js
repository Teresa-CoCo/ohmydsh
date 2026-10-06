/**
 * `ohmydsh doctor`: an environment + pin + profile + composition report. It
 * reports, it never repairs, and it never crashes on missing credentials,
 * missing binaries, or network failures — every check degrades into a
 * diagnostic line.
 *
 * @module ohmydsh/doctor
 */
import { dataPath, describeError, loadUpstream } from './data.js';
import { locateDsh, readDshVersion, resolveDshHome, runCapture } from './dsh.js';
import { modesCatalog } from './modes.js';
import { SURFACES, plan, readProfileManifest } from './profiles.js';

/** Node.js range declared by both package manifests. */
export const NODE_RANGE = '^22.19.0 || >=24.0.0';

/** @typedef {'pass' | 'warn' | 'fail' | 'skip'} CheckStatus */

/**
 * @typedef {Object} DoctorCheck
 * @property {string} id - stable check id.
 * @property {string} label - what was checked.
 * @property {CheckStatus} status - outcome.
 * @property {string} detail - evidence.
 */

/**
 * @typedef {Object} DoctorReport
 * @property {boolean} ok - true when no check failed.
 * @property {string} node - the running Node.js version.
 * @property {{ path: string, version: string, npmPackage: string, channel: string,
 *   tuiPlugin: { npmPackage: string, version: string } } | null} pins - loaded pin, when readable.
 * @property {{ command: string, source: string } | null} dsh - located binary, when found.
 * @property {DoctorCheck[]} checks - the checks, in report order.
 * @property {{ pass: number, warn: number, fail: number, skip: number }} counts - status totals.
 */

/**
 * @typedef {Object} DoctorOptions
 * @property {NodeJS.ProcessEnv} [env] - environment (supplies `OHMYDSH_HOME`, `DSH_HOME`, `PATH`).
 * @property {string} [cwd] - working directory for dsh invocations.
 * @property {string} [dsh] - `--dsh` binary override.
 * @property {string} [dshHome] - harness home override.
 * @property {string} [packageRoot] - package root override.
 * @property {number} [timeoutMs] - bound for each dsh invocation (default 60000).
 */

/**
 * Whether a Node.js version satisfies {@link NODE_RANGE}.
 * @param {string} version - version without a leading `v` (e.g. `24.21.0`).
 * @returns {boolean} true for `^22.19.0 || >=24.0.0`.
 */
export function supportsNode(version) {
  const [major, minor] = version.split('.').map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return (major === 22 && minor >= 19) || major >= 24;
}

/**
 * Collect the doctor report.
 * @param {DoctorOptions} [options] - overrides.
 * @returns {Promise<DoctorReport>} the report.
 */
export async function doctor(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 60_000;
  /** @type {DoctorCheck[]} */
  const checks = [];
  const add = (/** @type {string} */ id, /** @type {string} */ label, /** @type {CheckStatus} */ status, /** @type {string} */ detail) => {
    checks.push({ id, label, status, detail });
  };

  add(
    'node',
    `Node.js ${NODE_RANGE}`,
    supportsNode(process.versions.node) ? 'pass' : 'fail',
    `running v${process.versions.node}`,
  );

  /** @type {import('./data.js').UpstreamPin | undefined} */
  let upstream;
  try {
    upstream = loadUpstream(env);
    add('pin', 'upstream.json readable', 'pass', `${upstream.path}: dsh ${upstream.version} (${upstream.npmPackage}@${upstream.channel}), TUI plugin ${upstream.tuiPlugin.npmPackage} ${upstream.tuiPlugin.version}`);
    add('tui-plugin', 'TUI plugin pin present', 'pass', `${upstream.tuiPlugin.npmPackage}@${upstream.tuiPlugin.version}`);
  } catch (error) {
    add('pin', 'upstream.json readable', 'fail', describeError(error));
    add('tui-plugin', 'TUI plugin pin present', 'skip', 'unreadable upstream.json');
  }

  try {
    const catalog = modesCatalog({ env });
    add('modes', 'modes.json valid', 'pass', `${catalog.modes.length} modes, default ${catalog.defaultMode} (${dataPath('modes.json', env)})`);
  } catch (error) {
    add('modes', 'modes.json valid', 'fail', describeError(error));
  }

  /** @type {import('./dsh.js').LocatedDsh | null} */
  let located = null;
  try {
    located = locateDsh({ explicit: options.dsh, env, cwd });
  } catch (error) {
    add('dsh', 'dsh binary found', 'fail', describeError(error));
  }
  if (located !== null) {
    add('dsh', 'dsh binary found', 'pass', `${located.command} (via ${located.source})`);
    for (const note of located.notes) add('dsh-note', 'dsh binary candidate skipped', 'warn', note);
  } else if (options.dsh === undefined) {
    add('dsh', 'dsh binary found', 'fail', 'not found (use --dsh <path>, $DSH_REAL, or dsh on PATH)');
  }

  if (located === null) {
    add('dsh-version', 'dsh version matches the pin', 'skip', 'dsh binary not found');
  } else {
    const version = await readDshVersion(located.command, { env, cwd, timeoutMs });
    if (!version.ok) {
      add('dsh-version', 'dsh version matches the pin', 'fail', version.detail);
    } else if (upstream !== undefined && version.version !== upstream.version) {
      add('dsh-version', 'dsh version matches the pin', 'warn', `dsh reports ${version.version}, pinned ${upstream.version} in ${upstream.path}`);
    } else if (upstream !== undefined) {
      add('dsh-version', 'dsh version matches the pin', 'pass', `${version.version} matches the pin (${upstream.path})`);
    } else {
      add('dsh-version', 'dsh version matches the pin', 'warn', `dsh reports ${version.version}; the pin is unreadable`);
    }
  }

  const dshHome = options.dshHome ?? resolveDshHome(env);
  for (const surface of SURFACES) {
    if (upstream === undefined) {
      add(`profile:${surface}`, `profile for ${surface} bootstrapped`, 'skip', 'upstream.json is unreadable, the profile name is unknown');
      add(`composition:${surface}`, `profile for ${surface} composes cleanly`, 'skip', 'upstream.json is unreadable, the profile name is unknown');
      continue;
    }
    /** @type {import('./profiles.js').ProfilePlan | undefined} */
    let profilePlan;
    try {
      profilePlan = plan(surface, { env, dshHome, packageRoot: options.packageRoot, upstream });
    } catch (error) {
      add(`profile:${surface}`, `profile for ${surface} exists with the ohmydsh bundle`, 'fail', describeError(error));
      add(`composition:${surface}`, `profile for ${surface} composes cleanly`, 'skip', 'profile could not be planned');
      continue;
    }
    const manifest = readProfileManifest(dshHome, profilePlan.profile);
    if (!manifest.exists) {
      add(`profile:${surface}`, `profile ${profilePlan.profile} bootstrapped`, 'fail', `no manifest at ${manifest.path}; run \`ohmydsh ${surface}\` or \`ohmydsh update\``);
    } else if (!manifest.readable) {
      add(`profile:${surface}`, `profile ${profilePlan.profile} bootstrapped`, 'fail', `${manifest.path} is unreadable: ${manifest.error}`);
    } else {
      const missing = profilePlan.expectedBundles.filter((name) => !manifest.bundles.includes(name));
      if (missing.length > 0) {
        add(`profile:${surface}`, `profile ${profilePlan.profile} bootstrapped`, 'fail', `missing bundles: ${missing.join(', ')} (run \`ohmydsh update\`)`);
      } else {
        add(`profile:${surface}`, `profile ${profilePlan.profile} bootstrapped`, 'pass', `bundles: ${manifest.bundles.join(', ')} (${manifest.path})`);
      }
    }
    if (!manifest.exists || !manifest.readable) {
      add(`composition:${surface}`, `profile ${profilePlan.profile} composes cleanly`, 'skip', 'profile is not bootstrapped');
    } else if (located === null) {
      add(`composition:${surface}`, `profile ${profilePlan.profile} composes cleanly`, 'skip', 'dsh binary not found');
    } else {
      const result = await runCapture(located.command, ['--profile', profilePlan.profile, '--dump-config'], { env, cwd, timeoutMs });
      const stderr = result.stderr.trim();
      if (result.error !== undefined) {
        add(`composition:${surface}`, `profile ${profilePlan.profile} composes cleanly`, 'fail', `cannot run dsh --dump-config: ${result.error.message}`);
      } else if (result.code !== 0) {
        add(`composition:${surface}`, `profile ${profilePlan.profile} composes cleanly`, 'fail', `dsh --profile ${profilePlan.profile} --dump-config exited ${result.code}${stderr === '' ? '' : `: ${firstLine(stderr)}`}`);
      } else if (stderr !== '') {
        add(`composition:${surface}`, `profile ${profilePlan.profile} composes cleanly`, 'fail', `dsh --profile ${profilePlan.profile} --dump-config wrote to stderr: ${firstLine(stderr)}`);
      } else {
        add(`composition:${surface}`, `profile ${profilePlan.profile} composes cleanly`, 'pass', `dump-config clean, ${countLayers(result.stdout)} layers`);
      }
    }
  }

  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const check of checks) counts[check.status] += 1;
  return {
    ok: counts.fail === 0,
    node: process.versions.node,
    pins: upstream === undefined
      ? null
      : { path: upstream.path, version: upstream.version, npmPackage: upstream.npmPackage, channel: upstream.channel, tuiPlugin: upstream.tuiPlugin },
    dsh: located === null ? null : { command: located.command, source: located.source },
    checks,
    counts,
  };
}

/**
 * @param {string} text - captured stderr.
 * @returns {string} the first non-empty line.
 */
function firstLine(text) {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '');
  return line === undefined ? '' : line.trim();
}

/**
 * Count the `# ==` layer markers of a config dump.
 * @param {string} stdout - captured dump-config stdout.
 * @returns {number} the marker count.
 */
function countLayers(stdout) {
  return stdout.split('\n').filter((line) => line.startsWith('# ==')).length;
}
