#!/usr/bin/env node
// Fake dsh for ohmydsh tests: records argv, answers --version, and emulates
// profile initialisation well enough that the launcher's idempotency checks
// (manifest reads) behave like the real thing. Never touches the network and
// never writes outside $DSH_HOME.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const log = process.env.FAKE_DSH_LOG;
if (typeof log === 'string' && log !== '') fs.appendFileSync(log, JSON.stringify(args) + '\n');

if (args.includes('--version')) {
  process.stdout.write((process.env.FAKE_DSH_VERSION || '0.2.0-rc.2') + '\n');
  process.exit(0);
}

const profileIndex = args.indexOf('--profile');
const profile = profileIndex >= 0 ? args[profileIndex + 1] : undefined;
const home = process.env.DSH_HOME || '';
const manifestPath = profile === undefined ? undefined : path.join(home, 'profiles', profile, 'package.json');

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return { name: 'dsh-profile-' + String(profile), private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
  }
}

function writeManifest(value) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(value, null, 2) + '\n');
}

/** Package name for one install spec (file: paths read their manifest). */
function nameOf(spec) {
  if (spec.startsWith('file:')) {
    return JSON.parse(fs.readFileSync(path.join(spec.slice('file:'.length), 'package.json'), 'utf8')).name;
  }
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

if (args[0] === 'plugin' && manifestPath !== undefined) {
  const addIndex = args.indexOf('add');
  if (addIndex >= 0) {
    const value = readManifest();
    for (const spec of args.slice(addIndex + 1)) {
      if (spec.startsWith('-')) continue;
      const name = nameOf(spec);
      value.dependencies[name] = spec.startsWith('file:') ? spec : spec.slice(name.length + 1);
      if (!value.dsh.profile.bundles.includes(name)) value.dsh.profile.bundles.push(name);
    }
    if (!value.dsh.profile.bundles.includes('@deepseek-ai/dsh-base')) value.dsh.profile.bundles.unshift('@deepseek-ai/dsh-base');
    writeManifest(value);
    process.exit(Number(process.env.FAKE_DSH_ADD_EXIT || 0));
  }
  process.exit(Number(process.env.FAKE_DSH_EXIT || 0));
}

if (args.includes('--from-default-profile') && manifestPath !== undefined) {
  const value = readManifest();
  value.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
  writeManifest(value);
  process.exit(Number(process.env.FAKE_DSH_EXIT || 0));
}

if (args.includes('--dump-config')) {
  process.stdout.write('# == @deepseek-ai/dsh-base\n- id: permission\n  name: \'@deepseek-ai/dsh-permission-presets\'\n# == ohmydsh\n- id: preset-omp\n');
  if (Number(process.env.FAKE_DSH_DUMP_STDERR || 0) !== 0) process.stderr.write('dsh: unmatched patch target\n');
  process.exit(Number(process.env.FAKE_DSH_DUMP_EXIT || 0));
}

process.exit(Number(process.env.FAKE_DSH_EXIT || 0));
