/**
 * Profile planning and bootstrapping: which profile each surface boots, the
 * ordered bundle install specs, and the idempotent `dsh` commands that
 * initialise or refresh a profile.
 *
 * Idempotency is decided by reading the profile manifest
 * (`$DSH_HOME/profiles/<name>/package.json`, `dsh.profile.bundles`) — never by
 * guessing from the filesystem layout alone.
 *
 * @module ohmydsh/profiles
 */
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { PACKAGE_ROOT, describeError, isRecord, loadOwnPackage, loadUpstream, readJsonFile } from './data.js';
import { formatCommand, resolveDshHome, runPassthrough } from './dsh.js';

/** @typedef {'tui' | 'desktop'} Surface */

/** The surfaces ohmydsh boots, in report order. */
export const SURFACES = /** @type {const} */ (['tui', 'desktop']);

/** Error raised for an invalid surface, profile name, or plan. */
export class ProfileError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ProfileError';
  }
}

/** Error raised when a bootstrap or update step fails. */
export class BootstrapError extends Error {
  /**
   * @param {string} message - what failed.
   * @param {number} [exitCode] - process exit code to propagate.
   */
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'BootstrapError';
    this.exitCode = exitCode;
  }
}

/**
 * @param {unknown} value - candidate surface.
 * @returns {value is Surface} true for 'tui' or 'desktop'.
 */
export function isSurface(value) {
  return value === 'tui' || value === 'desktop';
}

/**
 * Validate a profile name the way dsh resolves profile directories.
 * @param {string} name - candidate name.
 * @returns {string} the validated name.
 * @throws {ProfileError} when the name cannot be a profile directory.
 */
export function validateProfileName(name) {
  if (typeof name !== 'string' || name.trim() === '') throw new ProfileError('profile name must be a non-empty string');
  if (name === '.' || name === '..' || name === 'node_modules' || name.includes('/') || name.includes('\\')) {
    throw new ProfileError(`invalid profile name ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Locate the workspace root above a package: the nearest ancestor holding
 * `pnpm-workspace.yaml`, stopping at a `node_modules` boundary (an installed
 * copy is not a checkout).
 * @param {string} [packageRoot] - package root; defaults to this package.
 * @returns {string | undefined} the checkout root, or undefined.
 */
export function workspaceRoot(packageRoot = PACKAGE_ROOT) {
  let dir = resolve(packageRoot);
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir || basename(parent) === 'node_modules') return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * The bundle install spec for this distribution: `file:<packageRoot>` when
 * running from a git checkout, else `ohmydsh@<version>` from the registry.
 * @param {string} [packageRoot] - package root; defaults to this package.
 * @returns {string} the install spec.
 */
export function selfInstallSpec(packageRoot = PACKAGE_ROOT) {
  const own = loadOwnPackage(packageRoot);
  if (workspaceRoot(packageRoot) === undefined) return `${own.name}@${own.version}`;
  return `file:${resolve(packageRoot)}`;
}

/**
 * @typedef {Object} ProfileManifest
 * @property {string} path - the manifest path.
 * @property {boolean} exists - whether the profile manifest exists.
 * @property {boolean} readable - whether it parsed as JSON.
 * @property {string | undefined} error - parse failure detail.
 * @property {string[]} bundles - `dsh.profile.bundles`.
 * @property {Record<string, string>} dependencies - installed dependencies.
 */

/**
 * Read a profile manifest. Missing or unreadable manifests yield empty bundle
 * lists, so every bootstrap step is planned as unsatisfied.
 * @param {string} dshHome - harness home.
 * @param {string} profile - profile name.
 * @returns {ProfileManifest} the manifest view.
 */
export function readProfileManifest(dshHome, profile) {
  const path = join(dshHome, 'profiles', profile, 'package.json');
  if (!existsSync(path)) return { path, exists: false, readable: false, error: undefined, bundles: [], dependencies: {} };
  try {
    const value = readJsonFile(path);
    const profileField = isRecord(value) && isRecord(value.dsh) ? value.dsh.profile : undefined;
    const bundlesValue = isRecord(profileField) ? profileField.bundles : undefined;
    const bundles = Array.isArray(bundlesValue) ? bundlesValue.filter((entry) => typeof entry === 'string') : [];
    const dependenciesValue = isRecord(value) ? value.dependencies : undefined;
    /** @type {Record<string, string>} */
    const dependencies = {};
    if (isRecord(dependenciesValue)) {
      for (const [name, version] of Object.entries(dependenciesValue)) {
        if (typeof version === 'string') dependencies[name] = version;
      }
    }
    return { path, exists: true, readable: true, error: undefined, bundles, dependencies };
  } catch (error) {
    return { path, exists: true, readable: false, error: describeError(error), bundles: [], dependencies: {} };
  }
}

/**
 * @typedef {Object} PlanStep
 * @property {string} id - stable step id.
 * @property {string} description - what the step does.
 * @property {string[]} argv - dsh arguments (binary excluded).
 * @property {string[]} bundles - bundle package names the step installs.
 * @property {boolean} satisfied - true when the manifest already lists every bundle.
 * @property {string[]} missing - the bundles the manifest does not list.
 */

/**
 * @typedef {Object} ProfilePlan
 * @property {Surface} surface - the surface being booted.
 * @property {string} profile - the profile name.
 * @property {string} dshHome - the harness home.
 * @property {string} profileDir - `$DSH_HOME/profiles/<profile>`.
 * @property {string} manifestPath - the profile manifest path.
 * @property {string} selfSpec - this distribution's install spec.
 * @property {string} selfName - this distribution's package name.
 * @property {string[]} bundles - ordered install specs (`dsh plugin add` order).
 * @property {string[]} installBundles - bundle names installed by the final `add`.
 * @property {string[]} expectedBundles - bundle names a complete profile lists.
 * @property {PlanStep[]} steps - ordered bootstrap commands.
 */

/**
 * @typedef {Object} PlanOptions
 * @property {string} [profile] - profile-name override.
 * @property {NodeJS.ProcessEnv} [env] - environment for data files and `DSH_HOME`.
 * @property {string} [dshHome] - harness home override.
 * @property {string} [packageRoot] - package root to install as this distribution.
 * @property {import('./data.js').UpstreamPin} [upstream] - preloaded pin.
 * @property {string} [selfSpec] - install-spec override.
 */

/**
 * Plan a surface's profile: the profile name, the ordered bundle install
 * specs, and the ordered bootstrap commands, each already marked satisfied or
 * pending against the profile manifest.
 * @param {Surface} surface - surface to plan.
 * @param {PlanOptions} [options] - overrides (all optional).
 * @returns {ProfilePlan} the plan.
 * @throws {ProfileError | import('./data.js').DataError} when inputs are invalid.
 */
export function plan(surface, options = {}) {
  if (!isSurface(surface)) throw new ProfileError(`unknown surface ${JSON.stringify(surface)} (expected "tui" or "desktop")`);
  const env = options.env ?? process.env;
  const upstream = options.upstream ?? loadUpstream(env);
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const own = loadOwnPackage(packageRoot);
  const profile = validateProfileName(options.profile ?? upstream.profiles[surface]);
  const dshHome = options.dshHome ?? resolveDshHome(env);
  const selfSpec = options.selfSpec ?? selfInstallSpec(packageRoot);
  const manifest = readProfileManifest(dshHome, profile);
  /** @type {PlanStep[]} */
  const steps = [];
  /** @type {string[]} */
  const specs = [];
  /** @type {string[]} */
  const installBundles = [];
  if (surface === 'tui') {
    const tuiSpec = `${upstream.tuiPlugin.npmPackage}@${upstream.tuiPlugin.version}`;
    steps.push(makeStep({
      id: 'tui-plugin',
      description: `install the pinned TUI plugin ${tuiSpec}`,
      argv: ['plugin', '--profile', profile, 'add', tuiSpec],
      bundles: [upstream.tuiPlugin.npmPackage],
      manifest,
    }));
    specs.push(tuiSpec);
    installBundles.push(upstream.tuiPlugin.npmPackage);
  } else {
    steps.push(makeStep({
      id: 'init-web',
      description: `initialise profile ${profile} from the shipped web template`,
      argv: ['--profile', profile, '--from-default-profile', 'web', '--dump-config'],
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      manifest,
    }));
  }
  steps.push(makeStep({
    id: 'self',
    description: `install the ohmydsh bundle (${selfSpec})`,
    argv: ['plugin', '--profile', profile, 'add', selfSpec],
    bundles: [own.name],
    manifest,
  }));
  specs.push(selfSpec);
  installBundles.push(own.name);
  return {
    surface,
    profile,
    dshHome,
    profileDir: join(dshHome, 'profiles', profile),
    manifestPath: manifest.path,
    selfSpec,
    selfName: own.name,
    bundles: specs,
    installBundles,
    expectedBundles: [...new Set(steps.flatMap((step) => step.bundles))],
    steps,
  };
}

/**
 * @param {{ id: string, description: string, argv: string[], bundles: string[],
 *   manifest: ProfileManifest }} input - step definition.
 * @returns {PlanStep} the step with its satisfaction computed from the manifest.
 */
function makeStep(input) {
  const missing = input.bundles.filter((name) => !input.manifest.bundles.includes(name));
  return {
    id: input.id,
    description: input.description,
    argv: input.argv,
    bundles: input.bundles,
    satisfied: input.manifest.readable && missing.length === 0,
    missing,
  };
}

/**
 * Run bootstrap steps through dsh, in order, with inherited stdio. In
 * dry-run mode nothing is spawned; each command line is reported instead.
 * @param {PlanStep[]} steps - the steps to run.
 * @param {{ command: string, env?: NodeJS.ProcessEnv, cwd?: string,
 *   platform?: NodeJS.Platform, dryRun?: boolean, log?: (line: string) => void }} options
 *   - `command` is the dsh binary to run.
 * @returns {Promise<PlanStep[]>} the steps that ran (or would run).
 * @throws {BootstrapError} when a step exits nonzero or cannot be started.
 */
export async function runSteps(steps, options) {
  const log = options.log ?? (() => {});
  /** @type {PlanStep[]} */
  const executed = [];
  for (const step of steps) {
    log(`${options.dryRun === true ? 'would run' : 'run'}: ${formatCommand(options.command, step.argv)}`);
    if (options.dryRun === true) {
      executed.push(step);
      continue;
    }
    let code;
    try {
      code = await runPassthrough(options.command, step.argv, { env: options.env, cwd: options.cwd, platform: options.platform });
    } catch (error) {
      throw new BootstrapError(`${step.id}: ${describeError(error)}`);
    }
    if (code !== 0) {
      throw new BootstrapError(`${step.id} failed (exit code ${code}): ${formatCommand(options.command, step.argv)}`, code);
    }
    executed.push(step);
  }
  return executed;
}

/**
 * @typedef {Object} EnsureOptions
 * @property {string} [command] - dsh binary to run the steps with.
 * @property {boolean} [noBootstrap] - fail instead of initialising a missing profile.
 * @property {string} [cwd] - working directory for the steps.
 * @property {NodeJS.Platform} [platform] - platform to spawn for.
 * @property {boolean} [dryRun] - report the steps instead of running them.
 * @property {(line: string) => void} [log] - sink for step command lines.
 */

/**
 * Ensure a surface's profile is bootstrapped: plan it, then run only the
 * pending steps.
 * @param {Surface} surface - surface to ensure.
 * @param {PlanOptions & EnsureOptions} [options] - plan overrides plus run options.
 * @returns {Promise<{ plan: ProfilePlan, pending: PlanStep[], ran: PlanStep[] }>} the outcome.
 * @throws {BootstrapError} when a step fails or `noBootstrap` blocks a needed step.
 */
export async function ensure(surface, options = {}) {
  const profilePlan = plan(surface, options);
  const pending = profilePlan.steps.filter((step) => !step.satisfied);
  if (pending.length > 0 && options.noBootstrap === true) {
    const command = options.command ?? 'dsh';
    throw new BootstrapError(
      `profile ${profilePlan.profile} is not bootstrapped and --no-bootstrap was given; omit the flag or run:\n${pending
        .map((step) => `  ${formatCommand(command, step.argv)}`)
        .join('\n')}`,
    );
  }
  const ran = await runSteps(pending, { ...options, command: options.command ?? 'dsh' });
  return { plan: profilePlan, pending, ran };
}

/**
 * Plan an `ohmydsh update`: bootstrap anything missing, refresh the profile's
 * installed bundles, then reinstall the pinned specs so the profile lands on
 * the pinned versions.
 * @param {Surface} surface - surface to update.
 * @param {PlanOptions} [options] - same overrides as {@link plan}.
 * @returns {{ plan: ProfilePlan, steps: PlanStep[] }} the update plan.
 */
export function updateSteps(surface, options = {}) {
  const profilePlan = plan(surface, options);
  /** @type {PlanStep[]} */
  const steps = profilePlan.steps.filter((step) => !step.satisfied);
  steps.push({
    id: 'update',
    description: `refresh the bundles installed in profile ${profilePlan.profile}`,
    argv: ['plugin', '--profile', profilePlan.profile, 'update'],
    bundles: [],
    satisfied: false,
    missing: [],
  });
  steps.push({
    id: 'repin',
    description: `reinstall the pinned bundles (${profilePlan.bundles.join(', ')})`,
    argv: ['plugin', '--profile', profilePlan.profile, 'add', ...profilePlan.bundles],
    bundles: profilePlan.installBundles,
    satisfied: false,
    missing: [],
  });
  return { plan: profilePlan, steps };
}
