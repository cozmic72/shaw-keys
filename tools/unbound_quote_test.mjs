// Regression test: on a layout that does not bind the quote keys, pressing '
// must put an ASCII apostrophe in the document, not the typographic quote the
// OS substituted for it.
//
// Folding the substitute back to its ASCII key (physicalKeyFor, tools/
// quote_substitution_test.mjs) only redirects the LOOKUP. Where the lookup
// misses, the guard that calls preventDefault never runs and the browser
// inserts whatever it was handed — so on the eight layouts with no ' binding,
// a press of ' arrived as U+2019. An unbound key inserting itself is correct
// and deliberate; inserting a character the user did not press is not.
//
// Drives the shipped beforeinput handler through enableInterception, with the
// layout JSON read off disk, so it constrains the emission path rather than
// restating the fold table.
//
// Usage: node tools/unbound_quote_test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { console.log('FAIL  ' + name + '\n        ' + e.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const APOSTROPHE = "'";
const DOUBLE_QUOTE = '"';
const RIGHT_SINGLE = '’';
const RIGHT_DOUBLE = '”';
const DEE = '\u{1045B}';

// Every shipped layout with no binding for the ' key. Each one let U+2019 reach
// the document. Derived from the layout files at run time rather than listed, so
// a layout that gains or loses the binding moves itself between the two cases.
function layoutNames() {
  return fs.readdirSync(ROOT)
    .map(f => /^keyboard_layout_(.*)\.json$/.exec(f))
    .filter(Boolean).map(m => m[1]).sort();
}
function layoutKeys(name) {
  return JSON.parse(
    fs.readFileSync(path.join(ROOT, `keyboard_layout_${name}.json`), 'utf8')).keys;
}

// A stand-in for a focused <input>, carrying the selection surface the insertion
// path drives and recording the beforeinput listener interception attaches.
function fakeInput() {
  const listeners = {};
  return {
    tagName: 'INPUT', type: 'text', value: '',
    selectionStart: 0, selectionEnd: 0, isContentEditable: false,
    setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; },
    getAttribute: () => null, hasAttribute: () => false,
    removeAttribute() {}, setAttribute() {},
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener() {}, dispatchEvent: () => true,
    _fire(type, ev) { (listeners[type] || []).forEach(fn => fn(ev)); },
  };
}

// Module instances are cached per URL and the library keeps layout state at
// module scope, so each case gets its own import.
let loadCount = 0;
async function loadLibrary() {
  const keyboardElement = { id: 'virtualKeyboard', style: { display: 'block' } };
  globalThis.window = {};
  globalThis.document = {
    activeElement: null,
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    getElementsByTagName: () => [],
    getElementById: (id) => (id === 'virtualKeyboard' ? keyboardElement : null),
    contains: () => true,
  };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.InputEvent = class {
    constructor(type, init) { Object.assign(this, init); this.type = type; this.defaultPrevented = false; }
    preventDefault() { this.defaultPrevented = true; }
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { platform: 'MacIntel', userAgent: 'node' }, configurable: true });
  // The library fetches layout JSON; serve the shipped files off disk so the
  // test runs against real bindings.
  globalThis.fetch = async (url) => {
    const file = path.join(ROOT, path.basename(String(url).split('?')[0]));
    if (!fs.existsSync(file)) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
  };
  const { VirtualKeyboard } = await import(`../virtual-keyboard.js?t=${++loadCount}`);
  assert(VirtualKeyboard, 'virtual-keyboard.js did not export VirtualKeyboard');
  return VirtualKeyboard;
}

// Press one key on `layout` and report what the document is left holding.
// A browser inserts e.data itself when the handler does not preventDefault,
// which is the step that delivered the substituted quote.
async function press(layout, typedText) {
  const api = await loadLibrary();
  // enableInterception only names the layout; the keys come from the load cache,
  // which setLayout fills. It narrates its progress to the console, which would
  // bury the results.
  const narrate = console.log;
  console.log = () => {};
  let applied;
  try { applied = await api.setLayout(layout); } finally { console.log = narrate; }
  assert(applied, `setLayout failed for ${layout}`);
  const field = fakeInput();
  api.enableInterception(field, { layout });
  assert(api.isVisible(), 'the keyboard must be visible or translation is gated off');
  const event = new globalThis.InputEvent('beforeinput',
    { bubbles: true, cancelable: true, inputType: 'insertText', data: typedText });
  field._fire('beforeinput', event);
  if (!event.defaultPrevented) field.value += typedText;
  return field.value;
}

const unbound = layoutNames().filter(n => !layoutKeys(n)[APOSTROPHE]);
const bound = layoutNames().filter(n => layoutKeys(n)[APOSTROPHE]);

await check('there are layouts of both kinds to test', async () => {
  assert(unbound.length, 'no layout lacks a ' + APOSTROPHE + ' binding — this test has nothing to guard');
  assert(bound.length, 'no layout binds ' + APOSTROPHE + ' — the translating case is untested');
});

// The defect. Without the fix each of these inserts U+2019.
for (const name of unbound) {
  await check(`${name}: an unbound ' key inserts the apostrophe pressed, not U+2019`, async () => {
    const got = await press(name, RIGHT_SINGLE);
    assert(got === APOSTROPHE,
      `typing ' on ${name} left ` +
      `${[...got].map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase()).join(' ') || '(nothing)'}` +
      `, expected U+27 — the key the user pressed`);
  });
}

await check(`an unbound " key inserts the quote pressed, not U+201D`, async () => {
  const name = unbound[0];
  const got = await press(name, RIGHT_DOUBLE);
  assert(got === DOUBLE_QUOTE,
    `typing " on ${name} left ${JSON.stringify(got)}, expected ${JSON.stringify(DOUBLE_QUOTE)}`);
});

// The fix must not reach past the substituted quotes: an unbound key that was
// delivered as itself still inserts itself, untouched.
await check('other unbound punctuation still passes through untouched', async () => {
  const name = unbound.find(n => !layoutKeys(n)['!']) || unbound[0];
  const keys = layoutKeys(name);
  for (const ch of ['!', '#', '(', '~']) {
    if (keys[ch]) continue;
    const got = await press(name, ch);
    assert(got === ch, `${name}: unbound ${JSON.stringify(ch)} became ${JSON.stringify(got)}`);
  }
});

// And a bound quote key still translates, which is what 54daee2 fixed.
for (const name of bound) {
  await check(`${name}: a bound ' key still emits its glyph`, async () => {
    const expected = layoutKeys(name)[APOSTROPHE];
    const got = await press(name, RIGHT_SINGLE);
    assert(got === expected,
      `${name}: typing ' emitted ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  });
}

await check('the originally reported case still holds: imperial emits DEE', async () => {
  assert(await press('imperial', RIGHT_SINGLE) === DEE, 'imperial must still emit 𐑛 for the ' + APOSTROPHE + ' key');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
