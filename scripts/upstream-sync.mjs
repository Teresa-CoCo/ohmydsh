#!/usr/bin/env node
/**
 * ohmydsh upstream sync: compare the pin in `upstream.json` against the newest
 * published versions of `@deepseek-ai/dsh` (npm dist-tag channel) and
 * `@deepseek-harness-tui/dsh-tui`, then — on `--apply` — rewrite the pin,
 * re-verify composition, and record a compat row only when verification passes.
 *
 * Usage:
 *   node scripts/upstream-sync.mjs --check  [--json] [--channel latest|next|alpha] [--repo-root <path>]
 *   node scripts/upstream-sync.mjs --apply  [--json] [--channel …] [--repo-root <path>] [--dsh <bin>]
 *
 * Exit codes: 0 = query/apply succeeded; 1 = apply ran but composition
 * verification failed (the pin is left untouched); 2 = usage, network, or
 * payload error.
 *
 * SPDX-License-Identifier: MIT
 */

import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  CHANNELS,
  UpstreamError,
  VERIFIED_PROFILES,
  appendCompat,
  buildCompatEntry,
  compareSemver,
  isNewer,
  parseSemver,
  readPinFile,
  resolveAvailable,
  serializePin,
  summarizePin,
  updatedPin,
  writePinFile,
} from './lib/upstream.mjs';

export const USAGE = `usage: node scripts/upstream-sync.mjs --check|--apply [options]

  --check                 compare the pin with the newest available versions (always exits 0 on success)
  --apply                 update the pin when newer versions exist, then verify composition
  --json                  emit a machine-readable JSON payload on stdout
  --channel <name>        npm dist-tag channel: ${CHANNELS.join(', ')} (default: the pin's channel)
  --repo-root <path>      repository root holding upstream.json (default: this script's parent directory)
  --dsh <bin>             dsh executable forwarded to verify-composition (default: npx pinned dsh)
  --help                  print this help

Exit codes: 0 success, 1 apply-verification failed, 2 usage/network error.`;

export class UsageError extends Error {}

/** @typedef {import('./lib/upstream.mjs').Channel} Channel */

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * @param {string[]} argv
 * @returns {{ mode: 'check' | 'apply', json: boolean, channel: string | null, repoRoot: string, dsh: string | null, help: boolean }}
 */
export function parseArgs(argv) {
  /** @type {{ mode: 'check' | 'apply' | null, json: boolean, channel: string | null, repoRoot: string, dsh: string | null, help: boolean }} */
  const parsed = {
    mode: null,
    json: false,
    channel: null,
    repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    dsh: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check' || arg === '--apply') {
      if (parsed.mode !== null) throw new UsageError(`only one of --check/--apply may be given`);
      parsed.mode = arg === '--check' ? 'check' : 'apply';
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--channel') {
      const value = argv[++index];
      if (value === undefined) throw new UsageError('--channel needs a value');
      if (!CHANNELS.includes(/** @type {any} */ (value))) throw new UsageError(`unknown channel "${value}" (expected ${CHANNELS.join(', ')})`);
      parsed.channel = value;
    } else if (arg === '--repo-root') {
      const value = argv[++index];
      if (value === undefined) throw new UsageError('--repo-root needs a value');
      parsed.repoRoot = resolve(value);
    } else if (arg === '--dsh') {
      const value = argv[++index];
      if (value === undefined) throw new UsageError('--dsh needs a value');
      parsed.dsh = value;
    } else {
      throw new UsageError(`unknown argument "${arg}"`);
    }
  }
  if (!parsed.help && parsed.mode === null) throw new UsageError('one of --check/--apply is required');
  return { ...parsed, mode: parsed.mode ?? 'check' };
}

/**
 * Compact GitHub view for the JSON payload.
 * @param {any} github
 * @returns {{ source: string, count: number, newest: any, newestStable: any } | null}
 */
function githubView(github) {
  if (!github) return null;
  /** @param {any} value */
  const row = (value) => (value === null || value === undefined ? null : { tag: value.tag, version: value.version, publishedAt: value.publishedAt, prerelease: value.prerelease });
  return {
    source: github.source,
    count: github.count,
    newest: row(github.newest),
    newestStable: row(github.newestStable),
  };
}

/**
 * Build the shared JSON payload skeleton.
 * @param {{ mode: 'check' | 'apply', repoRoot: string, channel: string, pin: any, available: any, now: string }} options
 * @returns {{ schemaVersion: number, mode: string, channel: string, repoRoot: string, generatedAt: string, changed: boolean, applied: boolean, reason: string | null, pin: any, candidate: any, available: any, verification: any, compatEntry: any }}
 */
export function buildPayload({ mode, repoRoot, channel, pin, available, now }) {
  return {
    schemaVersion: 1,
    mode,
    channel,
    repoRoot,
    generatedAt: now,
    changed: false,
    applied: false,
    reason: null,
    pin: summarizePin(pin),
    candidate: null,
    available: {
      dsh: { ...available.dsh },
      tuiPlugin: { ...available.tuiPlugin },
      github: githubView(available.github),
    },
    verification: null,
    compatEntry: null,
  };
}

/**
 * Compare the pin against the newest available versions.
 * @param {any} candidatePin
 * @param {any} available
 */
export function hasUpdate(candidatePin, available) {
  const dshVersion = available?.dsh?.version ?? null;
  const tuiVersion = available?.tuiPlugin?.version ?? null;
  const dshChanged = Boolean(dshVersion) && (isNewer(dshVersion, candidatePin.upstream?.version) || parseSemver(candidatePin.upstream?.version) === null);
  const tuiChanged = Boolean(tuiVersion) && (isNewer(tuiVersion, candidatePin.tuiPlugin?.version) || parseSemver(candidatePin.tuiPlugin?.version) === null);
  return { dshChanged, tuiChanged, changed: dshChanged || tuiChanged };
}

/**
 * Human-readable one-liner pair for a version.
 * @param {any} before
 * @param {any} after
 */
function pair(before, after) {
  if (before === null || before === undefined) return `(none) -> ${after}`;
  if (after === null || after === undefined) return `${before} -> (none)`;
  return compareSemver(after, before) === 0 ? `${before} (current)` : `${before} -> ${after}`;
}

/**
 * @param {any} payload
 */
export function formatHuman(payload) {
  const lines = [];
  const { available, pin } = payload;
  lines.push(`upstream-sync: ${payload.mode} on channel "${payload.channel}"`);
  lines.push(`  dsh        ${pair(pin.dsh, available.dsh.version)}  [npm ${available.dsh.source}${available.dsh.publishedAt ? `, published ${available.dsh.publishedAt}` : ''}]`);
  lines.push(`  tui-plugin ${pair(pin.tuiPlugin, available.tuiPlugin.version)}  [npm ${available.tuiPlugin.source}]`);
  if (available.github?.newest) {
    lines.push(`  github     newest ${available.github.newest.tag}${available.github.newest.prerelease ? ' (prerelease)' : ''} via ${available.github.source}${available.github.newestStable ? `, newest stable ${available.github.newestStable.tag}` : ''}`);
  } else {
    lines.push('  github     no semver-ish release or tag found');
  }
  if (payload.reason) lines.push(`  reason     ${payload.reason}`);
  if (payload.applied) {
    lines.push(`  applied    dsh ${payload.pin.dsh}, tui-plugin ${payload.pin.tuiPlugin}; compat rows: ${payload.pin.verified}`);
  } else if (payload.mode === 'apply' && payload.changed && payload.verification) {
    lines.push(`  applied    no (verification failed, pin restored)`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Suggested GitHub issue for a failed apply.
 * @param {{ pin: any, payload: any, verification: any }} options
 */
export function formatIssue({ pin, payload, verification }) {
  const candidateDsh = payload.available.dsh.version;
  const title = `chore(upstream): dsh ${candidateDsh} fails ohmydsh composition verification`;
  const diagnostics = String(verification?.stderr ?? '').trim().slice(-6000);
  const body = [
    `The scheduled upstream sync resolved **@deepseek-ai/dsh@${candidateDsh}**` +
      `${payload.available.tuiPlugin.version ? ` with **@deepseek-harness-tui/dsh-tui@${payload.available.tuiPlugin.version}**` : ''}` +
      ` on channel \`${payload.channel}\`, but \`node scripts/verify-composition.mjs --profile all --json\` failed.`,
    '',
    `\`upstream.json\` was restored to dsh \`${pin.dsh}\` + tui-plugin \`${pin.tuiPlugin}\`; no compat row was appended.`,
    '',
    `- verification exit code: \`${verification?.exitCode ?? 'unknown'}\``,
    `- ran at: \`${payload.generatedAt}\``,
    '',
    '### Diagnostics',
    '',
    '```text',
    diagnostics || '(no stderr captured)',
    '```',
    '',
    '_Filed automatically by `.github/workflows/upstream-watch.yml`._',
  ].join('\n');
  return `--- suggested issue ---\ntitle: ${title}\nbody:\n${body}\n--- end suggested issue ---`;
}

/**
 * Run `verify-composition.mjs` as a child process.
 * @param {{ repoRoot: string, dsh?: string | null, timeoutMs?: number }} options
 */
function spawnVerification(options) {
  const script = fileURLToPath(new URL('./verify-composition.mjs', import.meta.url));
  const args = [script, '--profile', 'all', '--json', '--repo-root', options.repoRoot];
  if (options.dsh) args.push('--dsh', options.dsh);
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, { cwd: options.repoRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      /** @type {any} */
      let json = null;
      try {
        json = JSON.parse(stdout.slice(stdout.indexOf('{')));
      } catch {
        json = null;
      }
      const summary = json && Array.isArray(json.results)
        ? {
            ok: json.ok === true,
            profiles: json.results.map((/** @type {any} */ result) => result.profile),
            failed: json.results.flatMap((/** @type {any} */ result) => (result.checks ?? []).filter((/** @type {any} */ check) => !check.ok).map((/** @type {any} */ check) => `${result.profile}/${check.id}`)),
          }
        : null;
      resolvePromise({ ok: code === 0 && !timedOut, exitCode: code, signal, timedOut, stdout, stderr, json, summary });
    });
  });
}

/**
 * The whole sync flow, injectable for tests.
 * @param {{
 *   mode: 'check' | 'apply',
 *   channel?: string | null,
 *   repoRoot: string,
 *   fetchImpl?: typeof fetch,
 *   token?: string,
 *   now?: () => Date,
 *   runVerify?: (options: { repoRoot: string, dsh?: string | null }) => Promise<any>,
 *   dsh?: string | null,
 *   log?: (line: string) => void,
 * }} options
 * @returns {Promise<{ exitCode: number, payload: any, stdout: string, stderr: string }>}
 */
export async function runSync(options) {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const { text: originalText, pin } = await readPinFile(options.repoRoot);
  const rawChannel = options.channel ?? pin?.upstream?.channel ?? 'latest';
  if (!CHANNELS.includes(/** @type {any} */ (rawChannel))) throw new UpstreamError(`pin declares unknown channel "${rawChannel}"`);
  /** @type {Channel} */
  const channel = rawChannel;

  const available = await resolveAvailable({
    channel,
    dshPackage: pin.upstream.npmPackage,
    tuiPackage: pin.tuiPlugin.npmPackage,
    githubRepository: pin.upstream.repository,
    fetchImpl: options.fetchImpl,
    token: options.token,
  });

  const nowIso = now().toISOString();
  const payload = buildPayload({ mode: options.mode, repoRoot: options.repoRoot, channel, pin, available, now: nowIso });
  const { dshChanged, tuiChanged, changed } = hasUpdate(pin, available);
  payload.changed = changed;

  if (!changed) {
    payload.reason = `pin already matches the newest "${channel}" release`;
    log(formatHuman(payload));
    return { exitCode: 0, payload, stdout: formatHuman(payload), stderr: '' };
  }

  payload.candidate = {
    dsh: available.dsh.version,
    tuiPlugin: available.tuiPlugin.version,
    dshChanged,
    tuiPluginChanged: tuiChanged,
  };
  if (options.mode === 'check') {
    payload.reason = dshChanged
      ? `newer dsh available on "${channel}": ${available.dsh.version}`
      : `newer tui plugin available: ${available.tuiPlugin.version}`;
    log(formatHuman(payload));
    return { exitCode: 0, payload, stdout: formatHuman(payload), stderr: '' };
  }

  // --apply: write the candidate pin, verify, then keep or restore.
  const candidateDsh = available.dsh.version;
  const candidateTui = available.tuiPlugin.version;
  if (candidateDsh === null || candidateTui === null) throw new UpstreamError(`channel "${channel}" resolved no applicable version`);
  const candidatePin = updatedPin(pin, {
    channel,
    dshVersion: candidateDsh,
    dshPublishedAt: available.dsh.publishedAt,
    tuiVersion: candidateTui,
    resolvedAt: nowIso,
  });
  await writePinFile(options.repoRoot, serializePin(candidatePin));
  const runVerify = options.runVerify ?? ((verifyOptions) => spawnVerification(verifyOptions));
  const verification = await runVerify({ repoRoot: options.repoRoot, dsh: options.dsh ?? null });

  if (!verification?.ok) {
    await writePinFile(options.repoRoot, originalText);
    payload.applied = false;
    payload.reason = 'composition verification failed; upstream.json restored';
    payload.verification = {
      ok: false,
      exitCode: verification?.exitCode ?? null,
      timedOut: verification?.timedOut === true,
      summary: verification?.summary ?? null,
      stderrTail: String(verification?.stderr ?? '').trim().slice(-4000),
    };
    const stderr = [
      `upstream-sync: refusing to pin dsh ${available.dsh.version} + tui-plugin ${available.tuiPlugin.version}: composition verification failed (exit ${verification?.exitCode ?? 'unknown'}).`,
      `upstream.json was left at dsh ${pin.upstream.version} + tui-plugin ${pin.tuiPlugin.version}.`,
      '',
      payload.verification.stderrTail || '(verification produced no stderr)',
      '',
      formatIssue({ pin: summarizePin(pin), payload, verification }),
      '',
    ].join('\n');
    log(formatHuman(payload));
    return { exitCode: 1, payload, stdout: formatHuman(payload), stderr };
  }

  const entry = buildCompatEntry({
    dsh: candidatePin.upstream.version,
    tuiPlugin: candidatePin.tuiPlugin.version,
    verifiedAt: nowIso,
    profiles: [...VERIFIED_PROFILES],
  });
  const finalPin = appendCompat(candidatePin, entry);
  await writePinFile(options.repoRoot, serializePin(finalPin));
  payload.applied = true;
  payload.reason = `pinned dsh ${finalPin.upstream.version} + tui-plugin ${finalPin.tuiPlugin.version}`;
  payload.pin = summarizePin(finalPin);
  payload.verification = {
    ok: true,
    exitCode: verification.exitCode ?? 0,
    timedOut: false,
    summary: verification.summary ?? null,
    stderrTail: '',
  };
  payload.compatEntry = entry;
  log(formatHuman(payload));
  return { exitCode: 0, payload, stdout: formatHuman(payload), stderr: '' };
}

/**
 * CLI entry point.
 * @param {string[]} [argv]
 * @param {{ stdout?: { write: (chunk: string) => unknown }, stderr?: { write: (chunk: string) => unknown } }} [io]
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  /** @type {any} */
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr.write(`upstream-sync: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const result = await runSync({
      mode: args.mode,
      channel: args.channel,
      repoRoot: args.repoRoot,
      dsh: args.dsh,
      token: process.env.GITHUB_TOKEN ?? undefined,
    });
    if (args.json) {
      stdout.write(`${JSON.stringify(result.payload, null, 2)}\n`);
      if (result.stderr) stderr.write(result.stderr);
    } else {
      stdout.write(result.stdout);
      if (result.stderr) stderr.write(result.stderr);
    }
    return result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`upstream-sync: ${message}\n`);
    if (error instanceof UsageError) stderr.write(`\n${USAGE}\n`);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then((code) => {
    process.exitCode = code;
  });
}
