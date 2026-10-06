/**
 * Shared, dependency-free helpers for upstream tracking in ohmydsh.
 *
 * Everything here is deterministic and unit-testable: network access goes
 * through an injected `fetchImpl`, time through an explicit `now()`/ISO string,
 * and the filesystem only ever touches `<repoRoot>/upstream.json`.
 *
 * Semver comparison is implemented from the SemVer 2.0.0 precedence rules
 * (numeric identifiers compare numerically; numeric identifiers sort below
 * alphanumeric ones; a release outranks its prereleases) so that:
 *   0.2.0-rc.2 > 0.2.0-rc.1   — later prerelease
 *   0.2.0      > 0.2.0-rc.2   — release outranks prerelease
 *   0.2.1-alpha.1 > 0.2.0     — higher patch, even as a prerelease
 *
 * SPDX-License-Identifier: MIT
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** @typedef {'latest' | 'next' | 'alpha'} Channel */

export const PIN_FILENAME = 'upstream.json';
export const COMPAT_LIMIT = 20;
/** @type {readonly Channel[]} */
export const CHANNELS = Object.freeze(['latest', 'next', 'alpha']);
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
export const DEFAULT_GITHUB_API = 'https://api.github.com';
/** Profiles every verified compat row must cover. */
export const VERIFIED_PROFILES = Object.freeze(['tui', 'desktop']);

/** Error raised for network and payload problems (exit code 2 at the CLI). */
export class UpstreamError extends Error {
  /** @param {string} message @param {{ cause?: unknown, status?: number }} [options] */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'UpstreamError';
    this.status = options.status;
  }
}

/**
 * Parse a semver-ish version into comparable parts.
 * @param {unknown} value
 * @returns {{ major: number, minor: number, patch: number, prerelease: string[], version: string } | null}
 */
export function parseSemver(value) {
  if (typeof value !== 'string') return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) return null;
  const prerelease = match[4] === undefined ? [] : match[4].split('.');
  if (prerelease.some((identifier) => identifier === '')) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
    version: value.trim().replace(/^v/, ''),
  };
}

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {-1 | 0 | 1}
 */
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // release > prerelease
  if (b.length === 0) return -1;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const delta = Number(left) - Number(right);
      if (delta !== 0) return delta < 0 ? -1 : 1;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * SemVer precedence comparison.
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 * @throws {TypeError} when either side is not semver-ish.
 */
export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left) throw new TypeError(`invalid version: ${String(a)}`);
  if (!right) throw new TypeError(`invalid version: ${String(b)}`);
  for (const key of /** @type {const} */ (['major', 'minor', 'patch'])) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/**
 * True when `candidate` is strictly newer than `baseline`; invalid versions
 * never count as newer (they are surfaced separately instead).
 * @param {unknown} candidate
 * @param {unknown} baseline
 */
export function isNewer(candidate, baseline) {
  const left = parseSemver(candidate);
  const right = parseSemver(baseline);
  if (!left || !right) return false;
  return compareSemver(left.version, right.version) > 0;
}

/**
 * Strip a release-tag prefix like `dsh-v` / `v` / `release-` from a tag name.
 * @param {unknown} tag
 * @returns {string | null}
 */
export function stripTagPrefix(tag) {
  if (typeof tag !== 'string') return null;
  const stripped = tag.trim().replace(/^[^0-9]*/, '');
  return stripped.length > 0 ? stripped : null;
}

/**
 * Newest semver among candidates (prereleases included).
 * @param {string[]} versions
 * @returns {string | null}
 */
export function pickNewest(versions) {
  let best = null;
  for (const raw of versions) {
    const parsed = parseSemver(raw);
    if (!parsed) continue;
    if (best === null || compareSemver(parsed.version, best) > 0) best = parsed.version;
  }
  return best;
}

/**
 * Resolve the newest version advertised for a channel.
 *
 * The registry dist-tag is the publisher's designation and wins whenever it is
 * present and semver-ish. Only when it is missing do we scan published versions,
 * where the `latest` channel deliberately ignores prereleases — so
 * `0.2.1-alpha.1` can never become "newest" for `latest`.
 *
 * @param {Record<string, string>} distTags
 * @param {string[]} versions
 * @param {Channel} channel
 * @returns {{ version: string | null, source: 'dist-tag' | 'versions-scan' | 'none' }}
 */
export function pickChannelVersion(distTags, versions, channel) {
  if (!CHANNELS.includes(channel)) throw new TypeError(`unknown channel: ${String(channel)}`);
  const tagged = parseSemver(distTags?.[channel]);
  if (tagged) return { version: tagged.version, source: 'dist-tag' };
  const all = (versions ?? []).filter((version) => parseSemver(version));
  let candidates = all;
  if (channel === 'latest') {
    candidates = all.filter((version) => parseSemver(version)?.prerelease.length === 0);
  } else if (channel === 'alpha') {
    const alphaOnly = all.filter((version) => parseSemver(version)?.prerelease[0] === 'alpha');
    if (alphaOnly.length > 0) candidates = alphaOnly;
  }
  const version = pickNewest(candidates);
  return version === null ? { version: null, source: 'none' } : { version, source: 'versions-scan' };
}

/**
 * Fetch and parse JSON with uniform error reporting.
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch, token?: string, headers?: Record<string, string> }} [options]
 * @returns {Promise<any>}
 */
export async function fetchJson(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new UpstreamError('no fetch implementation available');
  /** @type {Record<string, string>} */
  const headers = { accept: 'application/json', ...(options.headers ?? {}) };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let response;
  try {
    response = await fetchImpl(url, { headers });
  } catch (error) {
    throw new UpstreamError(`request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!response || typeof response.status !== 'number') {
    throw new UpstreamError(`request to ${url} returned an invalid response`);
  }
  let text;
  try {
    text = typeof response.text === 'function' ? await response.text() : JSON.stringify(await response.json());
  } catch (error) {
    throw new UpstreamError(`could not read the body of ${url}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!response.ok) {
    const snippet = text.trim().slice(0, 200);
    throw new UpstreamError(`request to ${url} failed: HTTP ${response.status}${snippet ? ` — ${snippet}` : ''}`, { status: response.status });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UpstreamError(`invalid JSON from ${url}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * Fetch one npm packument.
 * @param {string} name
 * @param {{ fetchImpl?: typeof fetch, registry?: string, token?: string }} [options]
 * @returns {Promise<{ name: string, distTags: Record<string, string>, time: Record<string, string>, versions: string[] }>}
 */
export async function fetchNpmPackument(name, options = {}) {
  const registry = (options.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, '');
  const url = `${registry}/${name.startsWith('@') ? name.replace('/', '%2F') : name}`;
  const body = await fetchJson(url, { fetchImpl: options.fetchImpl, token: options.token });
  return {
    name,
    distTags: body?.['dist-tags'] ?? {},
    time: body?.time ?? {},
    versions: Object.keys(body?.versions ?? {}),
  };
}

/** @typedef {{ tag: string, version: string, publishedAt: string | null, prerelease: boolean }} GithubRow */

/**
 * Normalize GitHub releases/tags into comparable rows, dropping anything without
 * a semver-ish tag.
 * @param {any[]} raw
 * @returns {GithubRow[]}
 */
function githubRows(raw) {
  /** @type {GithubRow[]} */
  const rows = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || item.draft === true) continue;
    const tag = typeof item.tag_name === 'string' ? item.tag_name : typeof item.name === 'string' ? item.name : null;
    if (tag === null) continue;
    const version = stripTagPrefix(tag);
    const parsed = version === null ? null : parseSemver(version);
    if (!parsed) continue;
    rows.push({
      tag,
      version: parsed.version,
      publishedAt: typeof item.published_at === 'string' ? item.published_at : null,
      prerelease: item.prerelease === true || parsed.prerelease.length > 0,
    });
  }
  return rows;
}

/** @param {GithubRow[]} rows */
function newestOf(rows) {
  return rows.reduce((best, row) => (compareSemver(row.version, best.version) > 0 ? row : best));
}

/**
 * Newest GitHub release (falling back to tags when no release exists).
 * Drafts are ignored; prereleases are reported but tracked separately.
 * @param {string} repository `owner/repo`
 * @param {{ fetchImpl?: typeof fetch, token?: string, api?: string }} [options]
 */
export async function fetchGithubNewest(repository, options = {}) {
  const api = (options.api ?? DEFAULT_GITHUB_API).replace(/\/+$/, '');
  const headers = { accept: 'application/vnd.github+json' };
  const token = options.token;
  /** @type {any[] | null} */
  let releases = null;
  /** @type {unknown} */
  let releasesError = null;
  try {
    releases = await fetchJson(`${api}/repos/${repository}/releases?per_page=30`, { fetchImpl: options.fetchImpl, token, headers });
  } catch (error) {
    releasesError = error;
  }
  if (Array.isArray(releases) && releases.length > 0) {
    const rows = githubRows(releases);
    if (rows.length > 0) {
      const stable = rows.filter((row) => !row.prerelease);
      return {
        source: 'releases',
        count: rows.length,
        newest: newestOf(rows),
        newestStable: stable.length > 0 ? newestOf(stable) : null,
        latest: rows[0],
      };
    }
  }
  /** @type {any[] | null} */
  let tags = null;
  try {
    tags = await fetchJson(`${api}/repos/${repository}/tags?per_page=100`, { fetchImpl: options.fetchImpl, token, headers });
  } catch (error) {
    throw releasesError ?? error;
  }
  const rows = githubRows(Array.isArray(tags) ? tags : []);
  if (rows.length === 0) {
    if (releasesError) throw releasesError;
    return { source: 'tags', count: 0, newest: null, newestStable: null, latest: null };
  }
  const stable = rows.filter((row) => !row.prerelease);
  return {
    source: 'tags',
    count: rows.length,
    newest: newestOf(rows),
    newestStable: stable.length > 0 ? newestOf(stable) : null,
    latest: rows[0],
  };
}

/**
 * Resolve the newest available dsh (per channel) and TUI plugin, plus a
 * best-effort GitHub view of the same upstream.
 * @param {{
 *   channel: Channel,
 *   dshPackage: string,
 *   tuiPackage: string,
 *   githubRepository: string,
 *   fetchImpl?: typeof fetch,
 *   token?: string,
 *   registry?: string,
 *   githubApi?: string,
 * }} options
 */
export async function resolveAvailable(options) {
  const { channel, dshPackage, tuiPackage, githubRepository } = options;
  const dshDoc = await fetchNpmPackument(dshPackage, { fetchImpl: options.fetchImpl, registry: options.registry, token: options.token });
  const dshPick = pickChannelVersion(dshDoc.distTags, dshDoc.versions, channel);
  const tuiDoc = await fetchNpmPackument(tuiPackage, { fetchImpl: options.fetchImpl, registry: options.registry, token: options.token });
  const tuiTag = parseSemver(tuiDoc.distTags.latest);
  const tuiVersion = tuiTag ? tuiTag.version : pickNewest(tuiDoc.versions);
  const github = await fetchGithubNewest(githubRepository, { fetchImpl: options.fetchImpl, token: options.token, api: options.githubApi });
  return {
    channel,
    dsh: {
      version: dshPick.version,
      source: dshPick.source,
      distTag: dshDoc.distTags[channel] ?? null,
      publishedAt: dshPick.version ? dshDoc.time[dshPick.version] ?? null : null,
    },
    tuiPlugin: {
      version: tuiVersion,
      source: tuiTag ? 'dist-tag' : 'versions-scan',
      distTag: tuiDoc.distTags.latest ?? null,
      publishedAt: tuiVersion ? tuiDoc.time[tuiVersion] ?? null : null,
    },
    github,
  };
}

/**
 * Read the raw pin document plus its parsed form.
 * @param {string} repoRoot
 */
export async function readPinFile(repoRoot) {
  const text = await readFile(join(repoRoot, PIN_FILENAME), 'utf8');
  /** @type {any} */
  let pin;
  try {
    pin = JSON.parse(text);
  } catch (error) {
    throw new UpstreamError(`invalid JSON in ${join(repoRoot, PIN_FILENAME)}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return { text, pin };
}

/**
 * Atomically write the pin document.
 * @param {string} repoRoot
 * @param {string} text
 */
export async function writePinFile(repoRoot, text) {
  const target = join(repoRoot, PIN_FILENAME);
  const temporary = `${target}.tmp`;
  await writeFile(temporary, text, 'utf8');
  await rename(temporary, target);
}

/** @param {string} repoRoot */
export async function readPin(repoRoot) {
  return (await readPinFile(repoRoot)).pin;
}

/**
 * @param {string} repoRoot
 * @param {any} pin
 */
export async function writePin(repoRoot, pin) {
  await writePinFile(repoRoot, serializePin(pin));
}

/** Stable pretty printing for upstream.json. @param {any} pin */
export function serializePin(pin) {
  return `${JSON.stringify(pin, null, 2)}\n`;
}

/**
 * Immutably produce the next pin after an upstream update.
 * @param {any} pin
 * @param {{ channel: Channel, dshVersion: string, dshPublishedAt?: string | null, tuiVersion: string, resolvedAt: string }} next
 */
export function updatedPin(pin, { channel, dshVersion, dshPublishedAt, tuiVersion, resolvedAt }) {
  return {
    ...pin,
    upstream: {
      ...pin.upstream,
      channel,
      version: dshVersion,
      publishedAt: dshPublishedAt ?? pin.upstream?.publishedAt ?? null,
      resolvedAt,
    },
    tuiPlugin: { ...pin.tuiPlugin, version: tuiVersion },
  };
}

/** @param {{ dsh: string, tuiPlugin: string, verifiedAt: string, profiles?: string[] }} entry */
export function buildCompatEntry({ dsh, tuiPlugin, verifiedAt, profiles = [...VERIFIED_PROFILES] }) {
  return { dsh, tuiPlugin, verifiedAt, profiles: [...profiles] };
}

/**
 * Append a verified compat row, keeping at most `limit` rows, newest last.
 * @param {any} pin
 * @param {any} entry
 * @param {number} [limit]
 */
export function appendCompat(pin, entry, limit = COMPAT_LIMIT) {
  const verified = [...(pin.compat?.verified ?? []), entry].slice(-limit);
  return { ...pin, compat: { ...(pin.compat ?? {}), verified } };
}

/**
 * Compact pin view used in JSON payloads.
 * @param {any} pin
 */
export function summarizePin(pin) {
  return {
    dsh: pin?.upstream?.version ?? null,
    channel: pin?.upstream?.channel ?? null,
    publishedAt: pin?.upstream?.publishedAt ?? null,
    resolvedAt: pin?.upstream?.resolvedAt ?? null,
    tuiPlugin: pin?.tuiPlugin?.version ?? null,
    verified: (pin?.compat?.verified ?? []).length,
  };
}
