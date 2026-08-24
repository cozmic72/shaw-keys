// The ligature suppressor (U+205E). A key may bind it alone, or prefixed to one
// letter ("⁞𐑩" on JAFL's shift+D), and it stops the letters either side of it
// combining. The fold consumes it, so the buffer stays comparable with target
// text that contains none. See docs/decisions.md, "The ligature suppressor".
//
// Usage: node tools/ligature_suppressor_test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// shaw-keys.js touches `window`/`document`/`localStorage` at module scope. The
// two functions under test are pure, so the barest stub gets the module loaded.
globalThis.window = globalThis;
globalThis.document = {
    addEventListener() {}, removeEventListener() {},
    querySelectorAll: () => [], querySelector: () => null,
    getElementById: () => null, createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
};
globalThis.localStorage = {
    _v: {}, getItem(k) { return this._v[k] ?? null; },
    setItem(k, v) { this._v[k] = String(v); }, removeItem(k) { delete this._v[k]; },
};

const { formLigatures } = await import(pathToFileURL(path.join(HERE, 'shaw-keys.js')));
const { CustomLayouts } = await import(pathToFileURL(path.join(HERE, 'custom-layouts.js')));
const { LayoutEditor } = await import(pathToFileURL(path.join(HERE, 'layout-editor.js')));

let passed = 0, failed = 0;
function check(name, fn) {
    try { fn(); console.log('  ok  ' + name); passed++; }
    catch (e) { console.log('FAIL  ' + name + '\n        ' + e.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const SUP = '⁞';

// JAFL's own table, so these tests fail if the layout's ligatures move.
const JAFL = JSON.parse(fs.readFileSync(path.join(HERE, 'keyboard_layout_jafl.json'), 'utf8'));
const FOLD = (() => {
    const map = {};
    for (const [result, spellings] of Object.entries(JAFL.ligatures)) {
        for (const spelling of spellings) map[spelling.join('')] = result;
    }
    return map;
})();

// Typing is one insertion at a time, and the fold runs after each — the state a
// suppressor has to survive. Folding the finished string in one go would not
// exercise it.
function type(strokes) {
    let buffer = '';
    for (const stroke of strokes) buffer = formLigatures(buffer + stroke, FOLD);
    return buffer;
}

// ---- The two ligatures the JAFL bindings exist to suppress ----

check('𐑦 then 𐑩 forms 𐑾 — the fold this suppresses is real', () => {
    assert(type(['𐑦', '𐑩']) === '𐑾', 'got ' + JSON.stringify(type(['𐑦', '𐑩'])));
});

check('𐑦 then ⁞𐑩 does NOT form 𐑾', () => {
    const got = type(['𐑦', SUP + '𐑩']);
    assert(got === '𐑦𐑩', 'got ' + JSON.stringify(got));
});

check('𐑩 then 𐑮 forms 𐑼 — the fold this suppresses is real', () => {
    assert(type(['𐑩', '𐑮']) === '𐑼', 'got ' + JSON.stringify(type(['𐑩', '𐑮'])));
});

for (const [left, compound] of [['𐑩', '𐑼'], ['𐑷', '𐑹'], ['𐑭', '𐑸']]) {
    check(`${left} then ⁞𐑮 does NOT form ${compound}`, () => {
        const got = type([left, SUP + '𐑮']);
        assert(got === left + '𐑮', 'got ' + JSON.stringify(got));
    });
}

// ---- Chained folds. JAFL builds 𐑽 from 𐑾, which is itself built from 𐑦+𐑩, so
// a barrier must bite at the step it sits at and leave the others alone. ----

check('CHAIN: 𐑦 𐑩 𐑮 folds all the way to 𐑽 unsuppressed', () => {
    assert(type(['𐑦', '𐑩', '𐑮']) === '𐑽', 'got ' + JSON.stringify(type(['𐑦', '𐑩', '𐑮'])));
});

check('CHAIN: suppressing the FIRST link leaves the second folding', () => {
    const got = type(['𐑦', SUP + '𐑩', '𐑮']);
    assert(got === '𐑦𐑼', 'got ' + JSON.stringify(got));
});

check('CHAIN: suppressing the SECOND link keeps the first fold', () => {
    const got = type(['𐑦', '𐑩', SUP + '𐑮']);
    assert(got === '𐑾𐑮', 'got ' + JSON.stringify(got));
});

// ---- A key bound to a BARE suppressor. It blocks nothing on the keystroke that
// inserts it, so it has to stay in the buffer until a letter follows. ----

check('a bare ⁞ typed between two letters suppresses their fold', () => {
    const got = type(['𐑦', SUP, '𐑩']);
    assert(got === '𐑦𐑩', 'got ' + JSON.stringify(got));
});

check('a trailing bare ⁞ stays armed in the buffer', () => {
    assert(formLigatures('𐑦' + SUP, FOLD) === '𐑦' + SUP);
});

check('a suppressor never reaches a settled buffer', () => {
    assert(!type(['𐑦', SUP + '𐑩', '𐑮']).includes(SUP), 'the suppressor was retained');
});

// ---- The JAFL layout itself ----

check('JAFL binds shift+D and shift+J to the suppressed vowel and R', () => {
    assert(JAFL.keys.D === SUP + '𐑩', 'shift+D is ' + JSON.stringify(JAFL.keys.D));
    assert(JAFL.keys.J === SUP + '𐑮', 'shift+J is ' + JSON.stringify(JAFL.keys.J));
    assert(JAFL.keys.d === '𐑩' && JAFL.keys.j === '𐑮', 'the unshifted keys must be unchanged');
});

check('𐑩 and 𐑮 are exactly the right-hand sides JAFL ligatures fold on', () => {
    const rightHandSides = new Set();
    for (const spellings of Object.values(JAFL.ligatures)) {
        for (const spelling of spellings) rightHandSides.add(spelling[spelling.length - 1]);
    }
    // 𐑵 is the RHS of 𐑿 (𐑘+𐑵), which needs no suppressor key of its own.
    assert(rightHandSides.has('𐑩') && rightHandSides.has('𐑮'),
        'expected 𐑩 and 𐑮 among the right-hand sides, got ' + [...rightHandSides].join(''));
});

// ---- Validation: the suppressor is the ONE multi-character binding. ----

check('validateLayout accepts a bare ⁞ binding', () => {
    CustomLayouts.validateLayout({ keys: { a: SUP } });
});

check('validateLayout accepts a ⁞-prefixed binding', () => {
    CustomLayouts.validateLayout({ keys: { a: SUP + '𐑩' } });
});

check('validateLayout accepts a ⁞-prefixed VS1 cluster', () => {
    CustomLayouts.validateLayout({ keys: { a: SUP + '𐑻︀' } });
});

check('validateLayout REJECTS a two-letter binding that is not ⁞-prefixed', () => {
    let threw = false;
    try { CustomLayouts.validateLayout({ keys: { a: '𐑩𐑮' } }); } catch (e) { threw = true; }
    assert(threw, 'a plain multi-letter binding must fail loudly');
});

check('validateLayout REJECTS ⁞ followed by more than one character', () => {
    let threw = false;
    try { CustomLayouts.validateLayout({ keys: { a: SUP + '𐑩𐑮' } }); } catch (e) { threw = true; }
    assert(threw, '⁞ licenses ONE following character, not a string');
});

check('validateLayout REJECTS a suppressor in the MIDDLE of a binding', () => {
    let threw = false;
    try { CustomLayouts.validateLayout({ keys: { a: '𐑩' + SUP } }); } catch (e) { threw = true; }
    assert(threw, 'the suppressor is a prefix, not an infix');
});

// ---- Coverage: a suppressed key still produces its letter, and the suppressor
// itself is never counted as a producible character. ----

check('coverage counts the letter under a ⁞ prefix, not the binding string', () => {
    const withSuppressor = CustomLayouts.coverage({ keys: { a: SUP + '𐑩' }, ligatures: {} });
    const plain = CustomLayouts.coverage({ keys: { a: '𐑩' }, ligatures: {} });
    assert(withSuppressor.produced === plain.produced,
        `suppressed produced ${withSuppressor.produced}, plain ${plain.produced}`);
});

check('a bare ⁞ binding produces no character at all', () => {
    const bare = CustomLayouts.coverage({ keys: { a: SUP }, ligatures: {} });
    const none = CustomLayouts.coverage({ keys: { a: '𐑩' }, ligatures: {} });
    assert(bare.produced === none.produced - 1, 'a bare suppressor must produce nothing');
});

// ---- Export/import round-trip. Export is JSON.stringify of the bare layout and
// import is JSON.parse + validateLayout, so the round-trip is over that pair. ----

check('a ⁞ binding survives an export/import round-trip', () => {
    const exported = { keys: { a: SUP + '𐑩', s: SUP, d: '𐑮' }, ligatures: {} };
    const reimported = JSON.parse(JSON.stringify(exported));
    CustomLayouts.validateLayout(reimported);
    assert(reimported.keys.a === SUP + '𐑩', 'the prefixed binding did not survive');
    assert(reimported.keys.s === SUP, 'the bare suppressor did not survive');
    assert(formLigatures('𐑦' + reimported.keys.a, FOLD) === '𐑦𐑩',
        'the re-imported binding no longer suppresses');
});

// ---- The editor trims a key's field to what one key may bind. The suppressor is
// the one binding wider than a grapheme, so the trim must keep its prefix. ----

check('the editor trim keeps a ⁞ prefix on the last glyph', () => {
    assert(LayoutEditor._lastGrapheme(SUP + '𐑩') === SUP + '𐑩',
        'got ' + JSON.stringify(LayoutEditor._lastGrapheme(SUP + '𐑩')));
});

check('the editor trim keeps a bare ⁞ as a binding in its own right', () => {
    assert(LayoutEditor._lastGrapheme(SUP) === SUP,
        'got ' + JSON.stringify(LayoutEditor._lastGrapheme(SUP)));
});

check('the editor trim still reduces a run under a ⁞ prefix to its last glyph', () => {
    assert(LayoutEditor._lastGrapheme(SUP + '𐑐𐑚𐑑') === SUP + '𐑑',
        'got ' + JSON.stringify(LayoutEditor._lastGrapheme(SUP + '𐑐𐑚𐑑')));
});

check('the editor trim leaves an unsuppressed value alone', () => {
    assert(LayoutEditor._lastGrapheme('𐑐𐑚𐑑') === '𐑑', 'the ordinary trim must be unchanged');
    assert(LayoutEditor._lastGrapheme('𐑐𐑻︀') === '𐑻︀', 'a VS1 cluster must survive whole');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
