/**
 * Programmatic API of the ohmydsh launcher.
 *
 * ```js
 * import { parseArgs, modesCatalog, modeOverlay, profilePlan, run, doctor } from 'ohmydsh';
 * ```
 *
 * @module ohmydsh
 */
export { USAGE, UsageError, main, parseArgs, run, writeModeOverlay } from './cli.js';
export { ModesError, findMode, modeOverlay, modesCatalog, validateModesCatalog } from './modes.js';
export {
  BootstrapError,
  ProfileError,
  SURFACES,
  ensure,
  plan,
  plan as profilePlan,
  readProfileManifest,
  runSteps,
  selfInstallSpec,
  updateSteps,
  validateProfileName,
  workspaceRoot,
} from './profiles.js';
export { NODE_RANGE, doctor, supportsNode } from './doctor.js';
export {
  DshError,
  formatCommand,
  locateDsh,
  readDshVersion,
  resolveDshHome,
  runCapture,
  runPassthrough,
} from './dsh.js';
export { DataError, PACKAGE_ROOT, dataPath, loadUpstream, repoRoot } from './data.js';
