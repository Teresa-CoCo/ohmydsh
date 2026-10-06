// Tests for the ohmydsh OMP layer: `modes.json` is the single source of truth,
// and the bundle patch files must agree with it.
//
// The repo takes zero runtime dependencies, so no YAML library is available.
// `parseYamlSubset` below implements only the YAML subset the three files here
// use: indentation-nested block mappings and sequences, plain scalars,
// single/double-quoted scalars, literal `|` / `|-` blocks, and `!!js` tagged
// expressions kept as raw strings. It deliberately does NOT support flow
// collections, anchors/aliases, folded scalars, multi-document streams, tabs,
// inline comments, or multi-line plain scalars — none of which appear in these
// files. Blank lines are dropped before parsing, so literal blocks lose their
// blank lines; these tests only inspect row ids, names, and configs, for which
// that is irrelevant.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

/** Matches `key:` or `key: value` at the start of a mapping line. */
const KEY_LINE = /^([A-Za-z0-9_@./-]+):(?:[ \t]+(.*))?$/;

/** Parse one scalar token of the supported YAML subset. */
function parseScalar(text) {
  if (text.startsWith("'")) {
    const end = text.lastIndexOf("'");
    assert.ok(end > 0, `unterminated single-quoted scalar: ${text}`);
    return text.slice(1, end);
  }
  if (text.startsWith('"')) return JSON.parse(text);
  if (text.startsWith('!!js')) return text;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

/** Read the supported YAML subset into plain objects/arrays/scalars. */
function parseYamlSubset(text) {
  const lines = [];
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    lines.push({ indent: line.length - line.trimStart().length, text: trimmed });
  }

  let at = 0;

  function isDash(line) {
    return line.text === '-' || line.text.startsWith('- ');
  }

  function parseBlock(indent) {
    const line = lines[at];
    assert.ok(line && line.indent === indent, `expected a block at indent ${indent}`);
    return isDash(line) ? parseSequence(indent) : parseMapping(indent);
  }

  function parseSequence(indent) {
    const out = [];
    while (at < lines.length && lines[at].indent === indent && isDash(lines[at])) {
      const rest = lines[at].text.slice(1).trim();
      at += 1;
      if (rest === '') {
        out.push(parseBlock(lines[at].indent));
      } else if (KEY_LINE.test(rest)) {
        // The item's mapping starts on the dash line itself; splice it back in
        // at the content column so parseMapping sees its first key.
        lines.splice(at, 0, { indent: indent + 2, text: rest });
        out.push(parseMapping(indent + 2));
      } else {
        out.push(parseScalar(rest));
      }
    }
    return out;
  }

  function parseMapping(indent) {
    const out = {};
    while (at < lines.length && lines[at].indent === indent && !isDash(lines[at])) {
      const match = KEY_LINE.exec(lines[at].text);
      assert.ok(match, `unsupported YAML line: "${lines[at].text}"`);
      const key = match[1];
      const rest = (match[2] ?? '').trim();
      at += 1;
      if (rest === '') {
        out[key] = at < lines.length && lines[at].indent > indent ? parseBlock(lines[at].indent) : null;
      } else if (rest === '|' || rest === '|-') {
        const block = [];
        while (at < lines.length && lines[at].indent > indent) {
          block.push(lines[at].text);
          at += 1;
        }
        out[key] = block.join('\n');
      } else {
        out[key] = parseScalar(rest);
      }
    }
    return out;
  }

  const value = parseBlock(lines[0].indent);
  assert.equal(at, lines.length, 'trailing content after the document root');
  return value;
}

const modes = JSON.parse(readFileSync(join(PACKAGE_DIR, 'modes.json'), 'utf8'));
const packageJson = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'));
const cordis = parseYamlSubset(readFileSync(join(PACKAGE_DIR, 'cordis.patch.yml'), 'utf8'));
const omp = parseYamlSubset(readFileSync(join(PACKAGE_DIR, 'presets', 'omp.patch.yml'), 'utf8'));

/** All bundle patch documents declared by `dsh.bundle.patch`. */
const bundleDocs = packageJson.dsh.bundle.patch.map((rel) =>
  parseYamlSubset(readFileSync(join(PACKAGE_DIR, rel), 'utf8')),
);

/** Every row from `insert:` entries of a patch document. */
function insertedRows(doc) {
  const rows = [];
  for (const entry of Array.isArray(doc) ? doc : []) {
    if (entry !== null && typeof entry === 'object' && Array.isArray(entry.insert)) rows.push(...entry.insert);
  }
  return rows;
}

/** An inserted row plus the children of every `cordis:group` it contains. */
function pluginRows(rows) {
  const out = [];
  const visit = (row) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return;
    out.push(row);
    if (row.name === 'cordis:group' && Array.isArray(row.config)) for (const child of row.config) visit(child);
  };
  for (const row of rows) visit(row);
  return out;
}

/** The top-level patch entry for `id`, or undefined. */
function entryById(doc, id) {
  return (Array.isArray(doc) ? doc : []).find((entry) => entry !== null && typeof entry === 'object' && entry.id === id);
}

test('invariant 1: modes.json permission names are unique and avoid reserved dsh names', () => {
  const names = modes.modes.map((mode) => mode.permission.name);
  assert.equal(new Set(names).size, names.length, 'permission.name values must be unique');
  for (const name of names) {
    assert.ok(!['custom', 'auto'].includes(name), `"${name}" is reserved by @deepseek-ai/dsh-permission-presets`);
  }
});

test('invariant 2: modes.json permission bundles use the supported sandbox/approval enums', () => {
  for (const mode of modes.modes) {
    assert.ok(
      ['read-only', 'workspace-write', 'danger-full-access'].includes(mode.permission.sandbox),
      `mode "${mode.id}" has unsupported sandbox "${mode.permission.sandbox}"`,
    );
    assert.ok(
      ['ask', 'never'].includes(mode.permission.approval),
      `mode "${mode.id}" has unsupported approval "${mode.permission.approval}"`,
    );
  }
});

test('invariant 3: modes.json defaultMode names an existing mode', () => {
  assert.ok(modes.modes.some((mode) => mode.id === modes.defaultMode), `unknown defaultMode "${modes.defaultMode}"`);
});

test('invariant 4: cordis.patch.yml permission row mirrors modes.json exactly', () => {
  const row = entryById(cordis, 'permission');
  assert.ok(row, 'cordis.patch.yml must target the `permission` row');

  const expected = Object.fromEntries(
    modes.modes.map((mode) => [mode.permission.name, { sandbox: mode.permission.sandbox, approval: mode.permission.approval }]),
  );
  assert.deepEqual(row.config.presets, expected, 'presets must be exactly the modes.json permission entries');

  const defaultMode = modes.modes.find((mode) => mode.id === modes.defaultMode);
  assert.equal(row.config.defaultPreset, defaultMode.permission.name, 'defaultPreset must be the default mode permission');
});

test('invariant 5: the bundle patch list inserts the top-level agentPreset as a dsh-agent-preset row', () => {
  const presetRows = bundleDocs.flatMap(insertedRows).filter((row) => row.name === '@deepseek-ai/dsh-agent-preset');
  assert.ok(
    presetRows.some((row) => row.config.id === modes.agentPreset),
    `an inserted @deepseek-ai/dsh-agent-preset row must declare config.id "${modes.agentPreset}"`,
  );
});

test('omp.patch.yml plugin names are only @deepseek-ai/ or cordis: specs', () => {
  const names = pluginRows(insertedRows(omp)).map((row) => row.name);
  assert.ok(names.length > 0, 'omp.patch.yml must insert at least one plugin row');
  for (const name of names) {
    assert.match(name, /^@deepseek-ai\/|^cordis:/, `plugin name "${name}" must resolve from the dsh install`);
  }
});

test('omp.patch.yml inserts exactly one preset row, preset-omp', () => {
  const presetRows = bundleDocs.flatMap(insertedRows).filter((row) => row.name === '@deepseek-ai/dsh-agent-preset');
  assert.equal(presetRows.length, 1, 'preset-omp must be the only inserted agent-preset row');
  const [preset] = presetRows;
  assert.equal(preset.id, 'preset-omp');
  assert.equal(preset.config.id, modes.agentPreset);
  assert.equal(preset.config.name, 'OMP');
  assert.equal(preset.config.order, 1);
  assert.ok(Array.isArray(preset.config.plugins) && preset.config.plugins.length > 0, 'the preset must compose plugins');
});

test('cordis.patch.yml rows carry the OMP persona and reasoning effort', () => {
  assert.deepEqual(
    (Array.isArray(cordis) ? cordis : []).map((entry) => entry.id),
    ['system-prompt', 'llm-deepseek', 'permission'],
  );
  assert.deepEqual(entryById(cordis, 'system-prompt').config, {
    personaPrefix: modes.persona.prefix,
    personaSuffix: modes.persona.suffix,
  });
  assert.deepEqual(entryById(cordis, 'llm-deepseek').config, {
    thinking: 'enabled',
    reasoningEffort: modes.reasoningEffort,
  });
});
