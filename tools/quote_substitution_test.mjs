// Regression test pinning a fixed bug as a constraint: the apostrophe key
// emitted ' in the IGC and Imperial layouts while its legend correctly rendered
// 𐑛. Substituted typographic quotes (macOS "smart quotes" and equivalents)
// reach beforeinput as U+2019, which matched no layout entry, so the character
// bound as itself instead of translating.
//
// The test reads the layout JSON from disk and imports shaw-keys.js under
// a window stub, so it constrains the shipped data and the shipped code rather
// than a restatement of either.
//
// Usage: node tools/quote_substitution_test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { console.log('FAIL  ' + name + '\n        ' + e.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// The library is an ES module graph that touches window/document/navigator as it
// executes. Stub only what module scope reads before any call, then import the
// real modules so the test constrains the shipped code.
async function loadShawKeys() {
  globalThis.window = {};
  globalThis.document = { addEventListener() {}, querySelector: () => null,
                          querySelectorAll: () => [], getElementsByTagName: () => [] };
  // Node defines navigator as a getter-only global, so plain assignment throws.
  Object.defineProperty(globalThis, 'navigator', {
    value: { platform: 'MacIntel', userAgent: 'node' }, configurable: true });
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const { ShawKeys } = await import('../shaw-keys.js');
  assert(ShawKeys && ShawKeys._internal,
         'shaw-keys.js did not export ShawKeys._internal');
  return ShawKeys;
}

function layoutKeys(name) {
  const file = path.join(ROOT, `keyboard_layout_${name}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')).keys;
}

const APOSTROPHE = "'";
const DOUBLE_QUOTE = '"';
// The four characters an OS substitutes for the two ASCII quote keys.
const SUBSTITUTED = {
  '‘': APOSTROPHE,   // left single
  '’': APOSTROPHE,   // right single — the reported bug
  '“': DOUBLE_QUOTE, // left double
  '”': DOUBLE_QUOTE, // right double
};

// Layouts that bind the two quote keys. Rendering reads these entries directly,
// which is why the legend was always right; emission had to reach them too.
const QUOTE_BINDING_LAYOUTS = ['igc', 'imperial'];

const { physicalKeyFor } = (await loadShawKeys())._internal;

check('physicalKeyFor is exported for the emission path to use', () => {
  assert(typeof physicalKeyFor === 'function', 'physicalKeyFor missing from _internal');
});

check('substituted quotes resolve to the ASCII key actually pressed', () => {
  for (const [substituted, ascii] of Object.entries(SUBSTITUTED)) {
    const got = physicalKeyFor(substituted);
    assert(got === ascii,
      `U+${substituted.codePointAt(0).toString(16).toUpperCase()} -> ` +
      `${JSON.stringify(got)}, expected ${JSON.stringify(ascii)}`);
  }
});

check('every other character passes through unchanged', () => {
  for (const ch of ['a', 'Z', '3', ';', '-', ' ', '\u{10450}', '\u{1047F}']) {
    assert(physicalKeyFor(ch) === ch, `physicalKeyFor mangled ${JSON.stringify(ch)}`);
  }
});

// The bug itself: a substituted quote must reach the same layout entry the key
// legend is stamped from. Asserting the emitted glyph equals the rendered one
// makes the render/emit divergence impossible to reintroduce.
for (const name of QUOTE_BINDING_LAYOUTS) {
  check(`${name}: substituted quotes emit the glyph shown on the key`, () => {
    const keys = layoutKeys(name);
    assert(keys[APOSTROPHE], `${name} no longer binds the ' key — update this test`);

    for (const [substituted, ascii] of Object.entries(SUBSTITUTED)) {
      const rendered = keys[ascii];
      if (!rendered) continue;
      const emitted = keys[physicalKeyFor(substituted)];
      assert(emitted === rendered,
        `${name}: typing U+${substituted.codePointAt(0).toString(16).toUpperCase()} ` +
        `emits ${JSON.stringify(emitted)} but the key renders ${JSON.stringify(rendered)}`);
    }
  });
}

check('the reported case: apostrophe emits DEE, not an apostrophe', () => {
  for (const name of QUOTE_BINDING_LAYOUTS) {
    const emitted = layoutKeys(name)[physicalKeyFor('’')];
    assert(emitted === '\u{1045B}',
      `${name}: apostrophe emitted ${JSON.stringify(emitted)}, expected 𐑛 (U+1045B)`);
  }
});

// No layout may bind a substituted quote directly: two spellings of one key
// would let the legend and the emitted glyph drift apart again.
check('no layout binds a substituted quote as a key in its own right', () => {
  for (const file of fs.readdirSync(ROOT).filter(f => /^keyboard_layout_.*\.json$/.test(f))) {
    const keys = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')).keys || {};
    for (const substituted of Object.keys(SUBSTITUTED)) {
      assert(!(substituted in keys),
        `${file} binds U+${substituted.codePointAt(0).toString(16).toUpperCase()} directly; ` +
        `bind the ASCII key instead so rendering and emission share one entry`);
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
