/**
 * OMP working modes: load and validate `modes.json` (the single source of
 * truth) and render the per-mode `permission` overlay that the launcher hands
 * to `dsh --patch`.
 *
 * The permission row lives in `@deepseek-ai/dsh-base`; a dsh patch REPLACES
 * the targeted row's whole `config`, so every overlay restates the complete
 * preset table and only switches `defaultPreset`.
 *
 * @module ohmydsh/modes
 */
import { dataPath, isRecord, readJsonFile } from './data.js';

/** @typedef {'read-only' | 'workspace-write' | 'danger-full-access'} Sandbox */
/** @typedef {'ask' | 'never'} Approval */

/**
 * @typedef {Object} PermissionPreset
 * @property {string} name - preset name in the `permission` row's `presets` table.
 * @property {Sandbox} sandbox - sandbox bundle for the preset.
 * @property {Approval} approval - approval policy for the preset.
 */

/**
 * @typedef {Object} Mode
 * @property {string} id - CLI value (`ohmydsh --mode <id>`).
 * @property {string} label - display name.
 * @property {string} summary - one line for `ohmydsh modes`.
 * @property {string} description - paragraph for `ohmydsh modes --json`.
 * @property {boolean} planMode - true when the launcher prints the `/plan` hint.
 * @property {PermissionPreset} permission - the preset this mode selects.
 */

/**
 * @typedef {Object} ModesCatalog
 * @property {1} schemaVersion
 * @property {string} defaultMode - mode used when `--mode` is omitted.
 * @property {string} reasoningEffort - `llm-deepseek.reasoningEffort` in the bundle patch.
 * @property {string} agentPreset - `@deepseek-ai/dsh-agent-preset` config id of the OMP agent.
 * @property {{ prefix: string, suffix: string }} persona - system-prompt row values.
 * @property {Mode[]} modes - modes in declaration order.
 */

/** Error raised for a `modes.json` that violates the frozen contract. */
export class ModesError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ModesError';
  }
}

/** Sandbox values accepted by the `permission` row. */
const SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
/** Approval values accepted by the `permission` row. */
const APPROVALS = new Set(['ask', 'never']);
/** Permission names the `permission` row reserves for its own UI. */
const RESERVED_PERMISSION_NAMES = new Set(['custom', 'auto']);
/** Mode ids become part of the overlay file name, so keep them path-safe. */
const MODE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Fail loudly with the offending file in the message.
 * @param {string} source - the file the value came from.
 * @param {string} message - what is wrong.
 * @returns {never}
 */
function fail(source, message) {
  throw new ModesError(`${source}: ${message}`);
}

/**
 * Validate a parsed `modes.json` against the invariants frozen in docs/contracts.md.
 *
 * Enforced here: schema version, top-level shape, unique mode ids, safe mode
 * ids, `planMode` typing, unique permission names that avoid the reserved
 * `custom`/`auto`, the sandbox/approval value sets, and a `defaultMode` naming
 * an existing mode. The cross-file invariants (the `permission` row in
 * `cordis.patch.yml`, the inserted agent-preset row) are enforced by the
 * bundle tests and `scripts/verify-composition.mjs`.
 * @param {unknown} value - parsed JSON value.
 * @param {string} [source] - file path used in messages.
 * @returns {ModesCatalog} the validated catalog.
 * @throws {ModesError} when the value violates the contract.
 */
export function validateModesCatalog(value, source = 'modes.json') {
  if (!isRecord(value)) fail(source, 'top level must be an object');
  if (value.schemaVersion !== 1) fail(source, `schemaVersion must be 1 (got ${JSON.stringify(value.schemaVersion)})`);
  const defaultMode = requiredModeString(value.defaultMode, source, 'defaultMode');
  const reasoningEffort = requiredModeString(value.reasoningEffort, source, 'reasoningEffort');
  const agentPreset = requiredModeString(value.agentPreset, source, 'agentPreset');
  const persona = value.persona;
  if (!isRecord(persona)) fail(source, 'persona must be an object');
  const prefix = requiredModeString(persona.prefix, source, 'persona.prefix');
  const suffix = requiredModeString(persona.suffix, source, 'persona.suffix');
  if (!Array.isArray(value.modes) || value.modes.length === 0) fail(source, 'modes must be a non-empty array');

  /** @type {Mode[]} */
  const modes = value.modes.map((mode, index) => validateMode(mode, source, index));
  /** @type {Set<string>} */
  const ids = new Set();
  /** @type {Set<string>} */
  const names = new Set();
  for (const mode of modes) {
    if (ids.has(mode.id)) fail(source, `duplicate mode id ${JSON.stringify(mode.id)}`);
    ids.add(mode.id);
    if (names.has(mode.permission.name)) fail(source, `duplicate permission preset name ${JSON.stringify(mode.permission.name)}`);
    names.add(mode.permission.name);
  }
  if (!ids.has(defaultMode)) fail(source, `defaultMode ${JSON.stringify(defaultMode)} does not name a mode (have: ${[...ids].join(', ')})`);
  return { schemaVersion: 1, defaultMode, reasoningEffort, agentPreset, persona: { prefix, suffix }, modes };
}

/**
 * @param {unknown} value - candidate string.
 * @param {string} source - diagnostic prefix.
 * @param {string} field - dotted field name.
 * @returns {string} the validated string.
 */
function requiredModeString(value, source, field) {
  if (typeof value !== 'string' || value.trim() === '') fail(source, `${field} must be a non-empty string`);
  return value;
}

/**
 * @param {unknown} value - candidate mode entry.
 * @param {string} source - diagnostic prefix.
 * @param {number} index - position in `modes`.
 * @returns {Mode} the validated mode.
 */
function validateMode(value, source, index) {
  const where = `modes[${index}]`;
  if (!isRecord(value)) fail(source, `${where} must be an object`);
  const id = requiredModeString(value.id, source, `${where}.id`);
  if (!MODE_ID_PATTERN.test(id)) fail(source, `${where}.id ${JSON.stringify(id)} must match ${MODE_ID_PATTERN.source}`);
  const label = requiredModeString(value.label, source, `${where}.label`);
  const summary = requiredModeString(value.summary, source, `${where}.summary`);
  const description = typeof value.description === 'string' ? value.description : '';
  if (typeof value.planMode !== 'boolean') fail(source, `${where}.planMode must be a boolean`);
  const permission = validatePermission(value.permission, source, `${where}.permission`);
  return { id, label, summary, description, planMode: value.planMode, permission };
}

/**
 * @param {unknown} value - candidate permission preset.
 * @param {string} source - diagnostic prefix.
 * @param {string} where - dotted field name.
 * @returns {PermissionPreset} the validated preset.
 */
function validatePermission(value, source, where) {
  if (!isRecord(value)) fail(source, `${where} must be an object`);
  const name = requiredModeString(value.name, source, `${where}.name`);
  if (RESERVED_PERMISSION_NAMES.has(name)) fail(source, `${where}.name must not use the reserved name ${JSON.stringify(name)}`);
  const sandbox = requiredModeString(value.sandbox, source, `${where}.sandbox`);
  if (!SANDBOXES.has(sandbox)) fail(source, `${where}.sandbox must be read-only, workspace-write, or danger-full-access (got ${JSON.stringify(sandbox)})`);
  const approval = requiredModeString(value.approval, source, `${where}.approval`);
  if (!APPROVALS.has(approval)) fail(source, `${where}.approval must be ask or never (got ${JSON.stringify(approval)})`);
  return {
    name,
    sandbox: /** @type {Sandbox} */ (sandbox),
    approval: /** @type {Approval} */ (approval),
  };
}

/**
 * Load and validate the OMP modes catalog.
 * @param {{ env?: NodeJS.ProcessEnv, path?: string }} [options] - `path` overrides
 *   the resolved `modes.json`; `env` supplies `OHMYDSH_HOME`.
 * @returns {ModesCatalog} the validated catalog.
 * @throws {ModesError | import('./data.js').DataError} when the file is missing or invalid.
 */
export function modesCatalog(options = {}) {
  const env = options.env ?? process.env;
  const path = options.path ?? dataPath('modes.json', env);
  return validateModesCatalog(readJsonFile(path), path);
}

/**
 * Find a mode by id.
 * @param {ModesCatalog} catalog - validated catalog.
 * @param {string} id - mode id.
 * @returns {Mode} the mode.
 * @throws {ModesError} when no mode has that id.
 */
export function findMode(catalog, id) {
  const mode = catalog.modes.find((candidate) => candidate.id === id);
  if (mode === undefined) {
    throw new ModesError(`unknown mode ${JSON.stringify(id)}; available: ${catalog.modes.map((candidate) => candidate.id).join(', ')}`);
  }
  return mode;
}

/**
 * Render a one-row dsh patch overlay that selects one OMP mode: it patches the
 * `permission` row with the complete preset table from `modes.json` and sets
 * `defaultPreset` to the selected mode's permission name.
 * @param {string} modeId - mode id from the catalog.
 * @param {{ env?: NodeJS.ProcessEnv, catalog?: ModesCatalog }} [options] - preloaded catalog.
 * @returns {string} the overlay YAML text (a top-level array of loader patches).
 * @throws {ModesError} when the mode is unknown or the catalog is invalid.
 */
export function modeOverlay(modeId, options = {}) {
  const catalog = options.catalog ?? modesCatalog({ env: options.env });
  const mode = findMode(catalog, modeId);
  const lines = [
    '# Generated by ohmydsh — do not edit: this overlay is rewritten on every launch.',
    `# OMP mode ${JSON.stringify(mode.id)} (${mode.permission.name}: sandbox=${mode.permission.sandbox}, approval=${mode.permission.approval}).`,
    '# The permission row config is replaced wholesale, so every OMP preset is restated here.',
    '- id: permission',
    '  config:',
    '    presets:',
  ];
  for (const candidate of catalog.modes) {
    lines.push(`      ${JSON.stringify(candidate.permission.name)}:`);
    lines.push(`        sandbox: ${JSON.stringify(candidate.permission.sandbox)}`);
    lines.push(`        approval: ${JSON.stringify(candidate.permission.approval)}`);
  }
  lines.push(`    defaultPreset: ${JSON.stringify(mode.permission.name)}`);
  lines.push('');
  return lines.join('\n');
}
