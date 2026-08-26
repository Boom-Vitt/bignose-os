import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('Routed Instrument tokens expose distinct provider and route semantics', async () => {
  const css = await read('public/css/tokens.css');

  assert.match(css, /--provider-claude:\s*#F26B21/i);
  assert.match(css, /--provider-codex:\s*#22C3C9/i);
  for (const name of ['route-neutral', 'route-focus', 'rail', 'junction', 'focus-ring']) {
    assert.match(css, new RegExp(`--${name}:\\s*var\\(`));
  }
});

test('functional microtype stays at or above the 11px readability floor', async () => {
  const css = await read('public/css/tokens.css');

  for (const token of ['t-micro', 't-tiny']) {
    const match = new RegExp(`--${token}:\\s*([\\d.]+)px`).exec(css);
    assert.ok(match, `${token} must be declared in pixels`);
    assert.ok(Number(match[1]) >= 11, `${token} must be at least 11px`);
  }
});

test('desktop shell does not clip positioned registration details', async () => {
  const css = await read('public/css/shell.css');
  const block = /\.shell\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';

  assert.doesNotMatch(block, /overflow:\s*hidden/);
});

test('Impeccable exception is limited to the intentional semantic palette', async () => {
  const config = JSON.parse(await read('.impeccable/config.json'));

  assert.deepEqual(config.detector?.ignoreRules, ['ai-color-palette']);
  assert.deepEqual(config.detector?.ignoreFiles, []);
  assert.deepEqual(config.detector?.ignoreValues, []);
});

test('root design contract permits Codex teal only as provider identity', async () => {
  const design = await read('DESIGN.md');

  assert.match(design, /orange remains the sole generic action accent/i);
  assert.match(design, /teal is reserved for Codex provider identity/i);
  assert.doesNotMatch(design, /tokens\.css.*FROZEN|Never introduce a second accent hue/i);
});

test('normal relationship rendering cannot regress to one direct lineTo', async () => {
  const source = await read('public/js/graph-render.js');

  assert.match(source, /routePolyline/);
  assert.doesNotMatch(source, /moveTo\(source\.x, source\.y\);\s*ctx\.lineTo\(target\.x, target\.y\)/s);
});

test('dashboard styles route every major operational surface', async () => {
  const css = await read('public/css/shell.css');

  for (const selector of [
    '.instrument-head', '.signal-rail', '.provider-tick', '.stage-routes',
    '.stage-route', '.routine-junction', '.panel::before', '.stage-cta::before',
  ]) {
    assert.match(css, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(css, /\[data-provider="claude"\].*--provider-claude/s);
  assert.match(css, /\[data-provider="codex"\].*--provider-codex/s);
});

test('narrow dashboard keeps usable touch targets and one-column hierarchy', async () => {
  const css = await read('public/css/shell.css');

  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*min-height:\s*36px/);
  assert.match(css, /@media\s*\(max-width:\s*1100px\)[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test('narrow Second Brain stacks details after results without overflow and keeps touch targets usable', async () => {
  const css = await read('public/css/brain.css');

  assert.match(css, /\.brain-workspace\s*\{[\s\S]*overflow-x:\s*hidden/);
  assert.match(css, /@media\s*\(max-width:\s*900px\)[\s\S]*\.brain-content\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /@media\s*\(max-width:\s*900px\)[\s\S]*\.brain-trail-focus\s*\{[^}]*order:\s*-1/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*\.brain-category\s*\{[^}]*min-height:\s*(?:var\(--brain-touch-target\)|4\dpx)/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*\.brain-result-item\s*\{[^}]*min-height:\s*(?:var\(--brain-result-touch-target\)|[5-9]\dpx)/);
  assert.doesNotMatch(css, /\.bp-provider-mark|\.bp-group-rail/);
});

test('Second Brain repeated geometry is named in tokens and media-query breakpoints are documented exceptions', async () => {
  const [tokens, css, design] = await Promise.all([
    read('public/css/tokens.css'),
    read('public/css/brain.css'),
    read('DESIGN.md'),
  ]);

  for (const name of [
    'brain-rule', 'brain-space-xs', 'brain-space-sm', 'brain-space-md',
    'brain-space-lg', 'brain-space-xl', 'brain-page-gutter',
    'brain-touch-target', 'brain-result-touch-target',
  ]) {
    assert.match(tokens, new RegExp(`--${name}:`), `${name} must be a named token`);
    assert.match(css, new RegExp(`var\\(--${name}\\)`), `${name} must be consumed by the view`);
  }
  assert.match(design, /media-query breakpoints[^.]*exempt/i);
});

test('Second Brain declarations use tokens for every nonzero absolute size and spacing value', async () => {
  const css = await read('public/css/brain.css');
  const source = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@media\s*\([^)]*\)/g, '@media');
  const absoluteLength = /(?<![\w.])[-+]?(?:\d*\.\d+|\d+)(?:px|r?em|vw|vh|vmin|vmax|ch|ex|cm|mm|in|pt|pc)\b/gi;
  const violations = [];

  for (const segment of source.split(/[;{}]/)) {
    const declaration = /^\s*([\w-]+)\s*:\s*(.*?)\s*$/s.exec(segment);
    if (!declaration) continue;
    const [, property, value] = declaration;
    const literals = [...value.matchAll(absoluteLength)]
      .map((match) => match[0])
      .filter((literal) => Number.parseFloat(literal) !== 0);
    if (literals.length) violations.push(`${property}: ${value.trim()} [${literals.join(', ')}]`);
  }

  assert.deepEqual(violations, [], `move direct lengths into tokens.css:\n${violations.join('\n')}`);
});
