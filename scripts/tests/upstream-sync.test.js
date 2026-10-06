/**
 * Unit tests for scripts/lib/upstream.mjs and scripts/upstream-sync.mjs.
 *
 * Network-free: every test injects a fake `fetchImpl`; filesystem tests use a
 * throwaway temp directory as the "repo root".
 *
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  COMPAT_LIMIT,
  UpstreamError,
  appendCompat,
  buildCompatEntry,
  compareSemver,
  fetchGithubNewest,
  fetchNpmPackument,
  isNewer,
  parseSemver,
  pickChannelVersion,
  pickNewest,
  readPinFile,
  resolveAvailable,
  serializePin,
  stripTagPrefix,
  summarizePin,
  updatedPin,
  writePinFile,
} from '../lib/upstream.mjs';
import { UsageError, buildPayload, formatIssue, hasUpdate, main, parseArgs, runSync } from '../upstream-sync.mjs';

/**
 * A repo-root fixture with the pin document.
 * @param {import('node:test').TestContext} t
 * @param {any} [pin]
 */
async function makeRepoRoot(t, pin = basePin()) {
  const dir = await mkdtemp(join(tmpdir(), 'ohmydsh-sync-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writePinFile(dir, serializePin(pin));
  return dir;
}

function basePin() {
  return {
    schemaVersion: 1,
    repository: 'https://github.com/Teresa-CoCo/ohmydsh',
    upstream: {
      repository: 'deepseek-ai/deepseek-harness',
      npmPackage: '@deepseek-ai/dsh',
      channel: 'latest',
      version: '0.2.0-rc.2',
      publishedAt: '2026-09-29T09:56:27.792Z',
      resolvedAt: '2026-10-06T00:00:00.000Z',
    },
    tuiPlugin: { npmPackage: '@deepseek-harness-tui/dsh-tui', version: '0.13.0' },
    profiles: { tui: 'ohmydsh-tui', desktop: 'ohmydsh-desktop' },
    compat: {
      verified: [
        { dsh: '0.2.0-rc.2', tuiPlugin: '0.13.0', verifiedAt: '2026-10-06T00:00:00.000Z', profiles: ['tui', 'desktop'] },
      ],
    },
  };
}

/**
 * Minimal fetch stand-in. `routes` maps a URL to a JSON body (or a function
 * returning a Response-like object). Unknown URLs 404.
 * @param {Record<string, any>} routes
 */
function fakeFetch(routes) {
  /** @type {any[]} */
  const calls = [];
  /** @type {any} */
  const impl = async (/** @type {string} */ url, /** @type {any} */ options = {}) => {
    calls.push({ url: String(url), options });
    const route = routes[String(url)];
    if (route === undefined) {
      return { ok: false, status: 404, text: async () => 'not found' };
    }
    if (typeof route === 'function') return route(String(url), options);
    return { ok: true, status: 200, text: async () => JSON.stringify(route) };
  };
  impl.calls = calls;
  return impl;
}

/**
 * @param {{ distTags: Record<string, string>, versions: string[], times?: Record<string, string> }} options
 */
function packument({ distTags, versions, times }) {
  return { 'dist-tags': distTags, versions: Object.fromEntries(versions.map((/** @type {string} */ version) => [version, {}])), time: times ?? {} };
}

/** @param {[string, any?][]} rows */
function githubReleases(rows) {
  return rows.map(([tag, extra = {}]) => ({ tag_name: tag, draft: false, prerelease: tag.includes('-'), published_at: '2026-10-03T06:42:19Z', ...extra }));
}

test('compareSemver orders prereleases and releases per SemVer 2.0.0', () => {
  const newer = [
    ['0.2.0-rc.2', '0.2.0-rc.1'],
    ['0.2.0', '0.2.0-rc.2'],
    ['0.2.1-alpha.1', '0.2.0'],
    ['0.2.0-rc.10', '0.2.0-rc.9'],
    ['0.2.0-alpha.1', '0.2.0-alpha'],
    ['0.2.0-beta', '0.2.0-alpha.99'],
    ['0.2.0-rc.1', '0.2.0-beta.9'],
    ['1.0.0', '1.0.0-rc.1'],
    ['1.0.1', '1.0.0'],
  ];
  for (const [a, b] of newer) {
    assert.equal(compareSemver(a, b), 1, `${a} > ${b}`);
    assert.equal(compareSemver(b, a), -1, `${b} < ${a}`);
    assert.equal(isNewer(a, b), true, `isNewer(${a}, ${b})`);
    assert.equal(isNewer(b, a), false, `isNewer(${b}, ${a})`);
  }
  assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
  assert.equal(compareSemver('v1.2.3', '1.2.3'), 0);
  assert.equal(compareSemver('1.2.3+build.5', '1.2.3'), 0, 'build metadata is ignored');
  assert.equal(isNewer('garbage', '1.0.0'), false, 'invalid candidates never look newer');
  assert.equal(isNewer('1.0.0', 'garbage'), false, 'invalid baselines never look older');
});

test('parseSemver accepts semver-ish tags and rejects junk', () => {
  assert.deepEqual(parseSemver('v0.2.0-rc.2'), { major: 0, minor: 2, patch: 0, prerelease: ['rc', '2'], version: '0.2.0-rc.2' });
  assert.equal(parseSemver('dsh-v0.2.0-rc.2'), null, 'tag prefixes are stripped separately');
  assert.equal(parseSemver('1.2'), null);
  assert.equal(parseSemver('1.2.3.4'), null);
  assert.equal(parseSemver('1.2.3-..'), null, 'empty prerelease identifiers are invalid');
  assert.equal(parseSemver(null), null);
  assert.equal(stripTagPrefix('dsh-v0.2.0-rc.2'), '0.2.0-rc.2');
  assert.equal(stripTagPrefix('v1.2.3'), '1.2.3');
  assert.equal(stripTagPrefix('release-2026.10'), '2026.10');
  assert.equal(stripTagPrefix('nope'), null);
});

test('pickNewest ignores invalid versions and returns the semver maximum', () => {
  assert.equal(pickNewest(['0.1.0', 'junk', '0.2.1-alpha.1', '0.2.0-rc.2', '0.2.0']), '0.2.1-alpha.1');
  assert.equal(pickNewest([]), null);
  assert.equal(pickNewest(['junk']), null);
});

test('pickChannelVersion honors dist-tags and channel policy', () => {
  const versions = ['0.2.0-rc.2', '0.2.0-rc.1', '0.2.1-alpha.1'];
  assert.deepEqual(pickChannelVersion({ latest: '0.2.0-rc.2', next: '0.2.0-rc.2', alpha: '0.2.1-alpha.1' }, versions, 'latest'), {
    version: '0.2.0-rc.2',
    source: 'dist-tag',
  });
  // A missing dist-tag falls back to scanning, where `latest` must skip prereleases.
  assert.deepEqual(pickChannelVersion({}, versions, 'latest'), { version: null, source: 'none' });
  assert.deepEqual(pickChannelVersion({}, ['0.2.0', '0.2.1-alpha.1'], 'latest'), { version: '0.2.0', source: 'versions-scan' });
  assert.deepEqual(pickChannelVersion({}, versions, 'next'), { version: '0.2.1-alpha.1', source: 'versions-scan' });
  assert.deepEqual(pickChannelVersion({}, ['0.1.9', '0.2.1-alpha.1'], 'alpha'), { version: '0.2.1-alpha.1', source: 'versions-scan' });
  assert.throws(() => pickChannelVersion({}, versions, /** @type {any} */ ('beta')), /unknown channel/);
});

test('fetchNpmPackument encodes scoped names and normalizes the payload', async () => {
  const fetchImpl = fakeFetch({
    'https://registry.npmjs.org/@deepseek-ai%2Fdsh': packument({
      distTags: { latest: '0.2.0-rc.2' },
      versions: ['0.2.0-rc.1', '0.2.0-rc.2'],
      times: { '0.2.0-rc.2': '2026-09-29T09:56:27.792Z' },
    }),
  });
  const doc = await fetchNpmPackument('@deepseek-ai/dsh', { fetchImpl });
  assert.equal(fetchImpl.calls[0].url, 'https://registry.npmjs.org/@deepseek-ai%2Fdsh');
  assert.deepEqual(doc.versions, ['0.2.0-rc.1', '0.2.0-rc.2']);
  assert.equal(doc.distTags.latest, '0.2.0-rc.2');
  assert.equal(doc.time['0.2.0-rc.2'], '2026-09-29T09:56:27.792Z');
});

test('fetchJson surfaces HTTP and JSON errors as UpstreamError', async () => {
  await assert.rejects(
    () => fetchNpmPackument('@deepseek-ai/dsh', { fetchImpl: fakeFetch({}) }),
    (error) => error instanceof UpstreamError && /HTTP 404/.test(error.message),
  );
  const broken = fakeFetch({ 'https://registry.npmjs.org/@deepseek-ai%2Fdsh': () => ({ ok: true, status: 200, text: async () => 'not json' }) });
  await assert.rejects(() => fetchNpmPackument('@deepseek-ai/dsh', { fetchImpl: broken }), /invalid JSON/);
  const throwing = async () => {
    throw new Error('socket exploded');
  };
  await assert.rejects(() => fetchNpmPackument('@deepseek-ai/dsh', { fetchImpl: throwing }), /socket exploded/);
});

test('fetchGithubNewest reads releases, ignores drafts, and falls back to tags', async () => {
  const releases = fakeFetch({
    'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=30': [
      ...githubReleases([['dsh-v0.2.1-alpha.1'], ['dsh-v0.2.0-rc.2']]),
      { tag_name: 'dsh-v9.9.9', draft: true, prerelease: false, published_at: null },
    ],
  });
  const fromReleases = await fetchGithubNewest('deepseek-ai/deepseek-harness', { fetchImpl: releases, token: 'gh-test' });
  assert.equal(fromReleases.source, 'releases');
  assert.equal(fromReleases.newest?.version, '0.2.1-alpha.1');
  assert.equal(fromReleases.newest?.tag, 'dsh-v0.2.1-alpha.1');
  assert.equal(releases.calls[0].options.headers.authorization, 'Bearer gh-test');
  assert.equal(releases.calls[0].options.headers.accept, 'application/vnd.github+json');

  const tagsOnly = fakeFetch({
    'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=30': [],
    'https://api.github.com/repos/deepseek-ai/deepseek-harness/tags?per_page=100': [{ name: 'dsh-v0.3.0' }, { name: 'dsh-v0.2.0-rc.2' }],
  });
  const fromTags = await fetchGithubNewest('deepseek-ai/deepseek-harness', { fetchImpl: tagsOnly });
  assert.equal(fromTags.source, 'tags');
  assert.equal(fromTags.newest?.version, '0.3.0');
  assert.equal(fromTags.newestStable?.version, '0.3.0');
});

test('resolveAvailable combines npm channels with the GitHub view', async () => {
  const fetchImpl = fakeFetch({
    'https://registry.npmjs.org/@deepseek-ai%2Fdsh': packument({
      distTags: { latest: '0.2.0-rc.2', next: '0.2.0-rc.2', alpha: '0.2.1-alpha.1' },
      versions: ['0.2.0-rc.2', '0.2.1-alpha.1'],
      times: { '0.2.0-rc.2': '2026-09-29T09:56:27.792Z', '0.2.1-alpha.1': '2026-10-03T04:53:22.343Z' },
    }),
    'https://registry.npmjs.org/@deepseek-harness-tui%2Fdsh-tui': packument({
      distTags: { latest: '0.13.0' },
      versions: ['0.12.0', '0.13.0'],
      times: { '0.13.0': '2026-10-04T13:04:19.877Z' },
    }),
    'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=30': githubReleases([['dsh-v0.2.1-alpha.1']]),
  });
  const available = await resolveAvailable({
    channel: 'latest',
    dshPackage: '@deepseek-ai/dsh',
    tuiPackage: '@deepseek-harness-tui/dsh-tui',
    githubRepository: 'deepseek-ai/deepseek-harness',
    fetchImpl,
  });
  assert.deepEqual(available.dsh, { version: '0.2.0-rc.2', source: 'dist-tag', distTag: '0.2.0-rc.2', publishedAt: '2026-09-29T09:56:27.792Z' });
  assert.deepEqual(available.tuiPlugin, { version: '0.13.0', source: 'dist-tag', distTag: '0.13.0', publishedAt: '2026-10-04T13:04:19.877Z' });
  assert.equal(available.github.newest?.version, '0.2.1-alpha.1');

  const alpha = await resolveAvailable({
    channel: 'alpha',
    dshPackage: '@deepseek-ai/dsh',
    tuiPackage: '@deepseek-harness-tui/dsh-tui',
    githubRepository: 'deepseek-ai/deepseek-harness',
    fetchImpl,
  });
  assert.equal(alpha.dsh.version, '0.2.1-alpha.1');
  assert.equal(alpha.dsh.publishedAt, '2026-10-03T04:53:22.343Z');
});

test('pin document I/O is atomic, serialized deterministically, and round-trips', async (t) => {
  const root = await makeRepoRoot(t);
  const { pin, text } = await readPinFile(root);
  assert.equal(pin.upstream.version, '0.2.0-rc.2');
  assert.equal(text, serializePin(pin));
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(summarizePin(pin), {
    dsh: '0.2.0-rc.2',
    channel: 'latest',
    publishedAt: '2026-09-29T09:56:27.792Z',
    resolvedAt: '2026-10-06T00:00:00.000Z',
    tuiPlugin: '0.13.0',
    verified: 1,
  });
  await writePinFile(root, `${text.trim()}\n`);
  assert.equal((await readFile(join(root, 'upstream.json'), 'utf8')).trim(), text.trim());
  const missing = join(root, 'does-not-exist');
  await assert.rejects(() => writePinFile(missing, 'nope'), { code: 'ENOENT' });
});

test('updatedPin and appendCompat keep the pin invariants', () => {
  const next = updatedPin(basePin(), {
    channel: 'alpha',
    dshVersion: '0.2.1-alpha.1',
    dshPublishedAt: '2026-10-03T04:53:22.343Z',
    tuiVersion: '0.14.0',
    resolvedAt: '2026-10-07T00:00:00.000Z',
  });
  assert.equal(next.upstream.version, '0.2.1-alpha.1');
  assert.equal(next.upstream.channel, 'alpha');
  assert.equal(next.upstream.publishedAt, '2026-10-03T04:53:22.343Z');
  assert.equal(next.upstream.resolvedAt, '2026-10-07T00:00:00.000Z');
  assert.equal(next.tuiPlugin.version, '0.14.0');
  assert.equal(next.schemaVersion, 1, 'unknown fields are preserved');

  let pin = basePin();
  for (let index = 0; index < COMPAT_LIMIT + 5; index += 1) {
    pin = appendCompat(pin, buildCompatEntry({ dsh: `0.${index}.0`, tuiPlugin: '0.13.0', verifiedAt: '2026-10-07T00:00:00.000Z' }));
  }
  assert.equal(pin.compat.verified.length, COMPAT_LIMIT);
  assert.equal(pin.compat.verified.at(-1)?.dsh, `0.${COMPAT_LIMIT + 4}.0`, 'newest row stays last');
  assert.equal(pin.compat.verified.some((row) => row.dsh === '0.2.0-rc.2'), false, 'old rows are dropped');
});

test('parseArgs validates the CLI surface', () => {
  const defaults = parseArgs(['--check']);
  assert.equal(defaults.mode, 'check');
  assert.equal(defaults.json, false);
  assert.equal(defaults.channel, null);
  assert.ok(existsSync(join(defaults.repoRoot, 'upstream.json')), `default repo root ${defaults.repoRoot} should hold upstream.json`);
  assert.deepEqual(parseArgs(['--apply', '--json', '--channel', 'alpha', '--repo-root', '/tmp/x', '--dsh', '/opt/dsh']), {
    mode: 'apply',
    json: true,
    channel: 'alpha',
    repoRoot: '/tmp/x',
    dsh: '/opt/dsh',
    help: false,
  });
  assert.throws(() => parseArgs([]), UsageError);
  assert.throws(() => parseArgs(['--check', '--apply']), /only one/);
  assert.throws(() => parseArgs(['--check', '--channel', 'beta']), /unknown channel/);
  assert.throws(() => parseArgs(['--check', '--nope']), /unknown argument/);
  assert.equal(parseArgs(['--help']).help, true);
});

test('--check reports the pin versus npm/GitHub with a changed boolean', async (t) => {
  const root = await makeRepoRoot(t);
  const fetchImpl = fakeFetch({
    'https://registry.npmjs.org/@deepseek-ai%2Fdsh': packument({
      distTags: { latest: '0.3.0' },
      versions: ['0.2.0-rc.2', '0.3.0'],
      times: { '0.3.0': '2026-10-05T00:00:00.000Z' },
    }),
    'https://registry.npmjs.org/@deepseek-harness-tui%2Fdsh-tui': packument({
      distTags: { latest: '0.13.0' },
      versions: ['0.13.0'],
      times: { '0.13.0': '2026-10-04T13:04:19.877Z' },
    }),
    'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=30': githubReleases([['dsh-v0.3.0']]),
  });
  const result = await runSync({ mode: 'check', repoRoot: root, fetchImpl, now: () => new Date('2026-10-07T00:00:00.000Z') });
  assert.equal(result.exitCode, 0);
  assert.equal(result.payload.schemaVersion, 1);
  assert.equal(result.payload.mode, 'check');
  assert.equal(result.payload.channel, 'latest');
  assert.equal(result.payload.changed, true);
  assert.equal(result.payload.applied, false);
  assert.deepEqual(result.payload.pin, { dsh: '0.2.0-rc.2', channel: 'latest', publishedAt: '2026-09-29T09:56:27.792Z', resolvedAt: '2026-10-06T00:00:00.000Z', tuiPlugin: '0.13.0', verified: 1 });
  assert.equal(result.payload.available.dsh.version, '0.3.0');
  assert.equal(result.payload.available.dsh.publishedAt, '2026-10-05T00:00:00.000Z');
  assert.equal(result.payload.available.tuiPlugin.version, '0.13.0');
  assert.equal(result.payload.available.github.newest.tag, 'dsh-v0.3.0');
  assert.match(result.payload.reason, /newer dsh available/);
  assert.match(result.stdout, /dsh\s+0\.2\.0-rc\.2 -> 0\.3\.0/);
  assert.equal(result.stderr, '');
  // The pin is a query: --check must not modify the file.
  assert.equal((await readPinFile(root)).pin.upstream.version, '0.2.0-rc.2');
});

test('--check stays quiet when the pin matches the channel', async (t) => {
  const root = await makeRepoRoot(t);
  const fetchImpl = fakeFetch({
    'https://registry.npmjs.org/@deepseek-ai%2Fdsh': packument({ distTags: { latest: '0.2.0-rc.2' }, versions: ['0.2.0-rc.2'] }),
    'https://registry.npmjs.org/@deepseek-harness-tui%2Fdsh-tui': packument({ distTags: { latest: '0.13.0' }, versions: ['0.13.0'] }),
    'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=30': githubReleases([['dsh-v0.2.1-alpha.1'], ['dsh-v0.2.0-rc.2']]),
  });
  const result = await runSync({ mode: 'check', repoRoot: root, fetchImpl });
  assert.equal(result.exitCode, 0);
  assert.equal(result.payload.changed, false);
  assert.match(result.payload.reason, /pin already matches/);
});

test('--apply rewrites the pin and appends a compat row only after verification passes', async (t) => {
  const root = await makeRepoRoot(t);
  const fetchImpl = fakeFetch({
    'https://registry.npmjs.org/@deepseek-ai%2Fdsh': packument({
      distTags: { latest: '0.3.0' },
      versions: ['0.2.0-rc.2', '0.3.0'],
      times: { '0.3.0': '2026-10-05T00:00:00.000Z' },
    }),
    'https://registry.npmjs.org/@deepseek-harness-tui%2Fdsh-tui': packument({
      distTags: { latest: '0.14.0' },
      versions: ['0.13.0', '0.14.0'],
      times: { '0.14.0': '2026-10-06T00:00:00.000Z' },
    }),
    'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=30': githubReleases([['dsh-v0.3.0']]),
  });
  /** @type {any[]} */
  const verifyCalls = [];
  const now = () => new Date('2026-10-07T12:00:00.000Z');
  const result = await runSync({
    mode: 'apply',
    repoRoot: root,
    fetchImpl,
    now,
    runVerify: async (options) => {
      verifyCalls.push(options);
      return { ok: true, exitCode: 0, stdout: '{"ok":true,"results":[]}', stderr: '', summary: { ok: true, profiles: ['tui', 'desktop'], failed: [] } };
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.payload.applied, true);
  assert.equal(verifyCalls.length, 1, 'verification runs exactly once');
  assert.equal(verifyCalls[0].repoRoot, root);
  const { pin } = await readPinFile(root);
  assert.equal(pin.upstream.version, '0.3.0');
  assert.equal(pin.upstream.channel, 'latest');
  assert.equal(pin.upstream.publishedAt, '2026-10-05T00:00:00.000Z');
  assert.equal(pin.upstream.resolvedAt, '2026-10-07T12:00:00.000Z');
  assert.equal(pin.tuiPlugin.version, '0.14.0');
  assert.equal(pin.compat.verified.length, 2);
  assert.deepEqual(pin.compat.verified.at(-1), {
    dsh: '0.3.0',
    tuiPlugin: '0.14.0',
    verifiedAt: '2026-10-07T12:00:00.000Z',
    profiles: ['tui', 'desktop'],
  });
  assert.equal(result.payload.pin.dsh, '0.3.0');
  assert.equal(result.payload.compatEntry.dsh, '0.3.0');
});

test('--apply restores the pin byte-for-byte and suggests an issue when verification fails', async (t) => {
  const root = await makeRepoRoot(t);
  const original = (await readPinFile(root)).text;
  const fetchImpl = fakeFetch({
    'https://registry.npmjs.org/@deepseek-ai%2Fdsh': packument({
      distTags: { latest: '0.3.0' },
      versions: ['0.3.0'],
      times: { '0.3.0': '2026-10-05T00:00:00.000Z' },
    }),
    'https://registry.npmjs.org/@deepseek-harness-tui%2Fdsh-tui': packument({ distTags: { latest: '0.13.0' }, versions: ['0.13.0'] }),
    'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=30': githubReleases([['dsh-v0.3.0']]),
  });
  const result = await runSync({
    mode: 'apply',
    repoRoot: root,
    fetchImpl,
    now: () => new Date('2026-10-07T12:00:00.000Z'),
    runVerify: async () => ({
      ok: false,
      exitCode: 1,
      timedOut: false,
      stdout: '{"ok":false,"results":[]}',
      stderr: 'FAIL desktop\n  ✗ permission-presets: mismatch\n',
      summary: { ok: false, profiles: ['desktop'], failed: ['desktop/permission-presets'] },
    }),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.payload.applied, false);
  assert.match(result.payload.reason, /restored/);
  assert.equal((await readPinFile(root)).text, original, 'pin file is untouched');
  assert.match(result.stderr, /composition verification failed/);
  assert.match(result.stderr, /permission-presets: mismatch/);
  assert.match(result.stderr, /--- suggested issue ---/);
  assert.match(result.stderr, /title: chore\(upstream\): dsh 0\.3\.0 fails ohmydsh composition verification/);
  assert.match(result.stderr, /body:\n/);
  assert.match(result.stderr, /--- end suggested issue ---/);
});

test('--apply is a no-op (and never verifies) when the pin is current', async (t) => {
  const root = await makeRepoRoot(t);
  const original = (await readPinFile(root)).text;
  const fetchImpl = fakeFetch({
    'https://registry.npmjs.org/@deepseek-ai%2Fdsh': packument({ distTags: { latest: '0.2.0-rc.2' }, versions: ['0.2.0-rc.2'] }),
    'https://registry.npmjs.org/@deepseek-harness-tui%2Fdsh-tui': packument({ distTags: { latest: '0.13.0' }, versions: ['0.13.0'] }),
    'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=30': githubReleases([['dsh-v0.2.0-rc.2']]),
  });
  let verified = 0;
  const result = await runSync({
    mode: 'apply',
    repoRoot: root,
    fetchImpl,
    runVerify: async () => {
      verified += 1;
      return { ok: true, exitCode: 0, stderr: '' };
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.payload.applied, false);
  assert.equal(verified, 0);
  assert.equal((await readPinFile(root)).text, original);
});

test('network failures propagate as UpstreamError so the CLI can exit 2', async (t) => {
  const root = await makeRepoRoot(t);
  const fetchImpl = async () => {
    throw new Error('offline');
  };
  await assert.rejects(() => runSync({ mode: 'check', repoRoot: root, fetchImpl }), (error) => error instanceof UpstreamError && /offline/.test(error.message));
});

test('main maps unusable repo roots to exit 2 with a message on stderr', async () => {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const io = { stdout: { write: (/** @type {string} */ chunk) => (out.push(chunk), true) }, stderr: { write: (/** @type {string} */ chunk) => (err.push(chunk), true) } };
  const code = await main(['--check', '--json', '--repo-root', '/nonexistent-ohmydsh-root'], io);
  assert.equal(code, 2);
  assert.match(err.join(''), /upstream-sync: .*upstream\.json|upstream-sync: ENOENT/);
  assert.equal(out.join(''), '');
});

test('main handles help, usage errors, and --json payloads', async () => {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const io = { stdout: { write: (/** @type {string} */ chunk) => (out.push(chunk), true) }, stderr: { write: (/** @type {string} */ chunk) => (err.push(chunk), true) } };
  assert.equal(await main(['--help'], io), 0);
  assert.match(out.join(''), /usage: node scripts\/upstream-sync\.mjs/);
  assert.equal(await main(['--nope'], io), 2);
  assert.match(err.join(''), /unknown argument/);
  assert.equal(await main([], io), 2);
  assert.match(err.join(''), /one of --check\/--apply is required/);
});

test('hasUpdate compares pin and candidate with strict semver ordering', () => {
  const pin = basePin();
  assert.deepEqual(hasUpdate(pin, { dsh: { version: '0.2.0-rc.2' }, tuiPlugin: { version: '0.13.0' } }), { dshChanged: false, tuiChanged: false, changed: false });
  assert.deepEqual(hasUpdate(pin, { dsh: { version: '0.2.0' }, tuiPlugin: { version: '0.13.0' } }), { dshChanged: true, tuiChanged: false, changed: true });
  assert.deepEqual(hasUpdate(pin, { dsh: { version: '0.1.9' }, tuiPlugin: { version: '0.14.0' } }), { dshChanged: false, tuiChanged: true, changed: true }, 'never auto-downgrades');
  assert.deepEqual(hasUpdate(pin, { dsh: { version: '0.2.0-rc.1' }, tuiPlugin: { version: '0.13.0' } }), { dshChanged: false, tuiChanged: false, changed: false }, 'older prerelease is not newer');
  const malformed = { ...basePin(), upstream: { ...basePin().upstream, version: 'not-a-version' }, tuiPlugin: { npmPackage: 'x', version: '0.13.0' } };
  assert.equal(hasUpdate(malformed, { dsh: { version: '0.2.0-rc.2' }, tuiPlugin: { version: '0.13.0' } }).changed, true, 'a malformed pin is refreshed');
});

test('buildPayload and formatIssue keep the machine-readable contract', () => {
  const pin = basePin();
  const payload = buildPayload({
    mode: 'apply',
    repoRoot: '/repo',
    channel: 'latest',
    pin,
    now: '2026-10-07T00:00:00.000Z',
    available: {
      dsh: { version: '0.3.0', source: 'dist-tag', distTag: '0.3.0', publishedAt: '2026-10-05T00:00:00.000Z' },
      tuiPlugin: { version: '0.14.0', source: 'dist-tag', distTag: '0.14.0', publishedAt: null },
      github: { source: 'releases', count: 1, newest: { tag: 'dsh-v0.3.0', version: '0.3.0', publishedAt: null, prerelease: false }, newestStable: { tag: 'dsh-v0.3.0', version: '0.3.0', publishedAt: null, prerelease: false }, latest: null },
    },
  });
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.mode, 'apply');
  assert.equal(payload.changed, false);
  assert.equal(payload.applied, false);
  assert.deepEqual(payload.available.github.newest, { tag: 'dsh-v0.3.0', version: '0.3.0', publishedAt: null, prerelease: false });
  assert.equal(payload.pin.verified, 1);

  const issue = formatIssue({
    pin: { dsh: '0.2.0-rc.2', tuiPlugin: '0.13.0' },
    payload: { ...payload, channel: 'latest', generatedAt: '2026-10-07T00:00:00.000Z' },
    verification: { exitCode: 1, stderr: 'FAIL desktop\n' },
  });
  assert.match(issue, /^--- suggested issue ---\ntitle: chore\(upstream\): dsh 0\.3\.0 fails ohmydsh composition verification\nbody:\n/);
  assert.match(issue, /FAIL desktop/);
  assert.match(issue, /--- end suggested issue ---$/);
});

test('--json output is a single machine-readable document', async (t) => {
  const root = await makeRepoRoot(t);
  const fetchImpl = fakeFetch({
    'https://registry.npmjs.org/@deepseek-ai%2Fdsh': packument({ distTags: { latest: '0.2.0-rc.2' }, versions: ['0.2.0-rc.2'] }),
    'https://registry.npmjs.org/@deepseek-harness-tui%2Fdsh-tui': packument({ distTags: { latest: '0.13.0' }, versions: ['0.13.0'] }),
    'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=30': githubReleases([['dsh-v0.2.0-rc.2']]),
  });
  const result = await runSync({ mode: 'check', repoRoot: root, fetchImpl });
  const parsed = JSON.parse(`${JSON.stringify(result.payload, null, 2)}\n`);
  assert.equal(parsed.changed, false);
  assert.equal(parsed.pin.dsh, '0.2.0-rc.2');
});
