// Tests for the one-shot migration of the settings key across the rename from
// "virtual keyboard" to Shaw Keys.
//
// The library was renamed after it had been deployed, and the settings key is a
// STORED VALUE rather than an identifier: renaming it without moving the data
// silently resets every existing user's layout and dragged position. The
// migration moves the value once, on load.
//
// Only this key moved. `customLayouts` is unprefixed, never contained the old
// name, and was not renamed — so custom layouts, the costliest thing a user
// owns, are untouched by the rename and are asserted here to stay put.
//
// Imports the shipped shaw-keys.js under a window/document stub, so it
// constrains the real module-scope migration rather than a restatement of it.
//
// Usage: node tools/settings_migration_test.mjs

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { console.log('FAIL  ' + name + '\n        ' + e.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const LEGACY_KEY = 'io.joro.virtual-keyboard.Settings';
const CURRENT_KEY = 'io.joro.shaw-keys.Settings';
const LAYOUTS_KEY = 'customLayouts';

// Each call re-imports the library under a unique query string: module instances
// are cached per URL, and the migration runs at module scope, so it would run
// only once across the whole file otherwise.
let loadCount = 0;
async function loadWithStorage(seed) {
  const storage = new Map(Object.entries(seed));
  globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
  globalThis.document = {
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    getElementsByTagName: () => [], getElementById: () => null,
    contains: () => false, createElement: () => ({ style: {}, classList: { add() {}, remove() {} },
      appendChild() {}, setAttribute() {}, addEventListener() {} }),
  };
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); },
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { platform: 'MacIntel', userAgent: 'node' }, configurable: true });
  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => '', json: async () => ({}) });

  await import(`../shaw-keys.js?m=${++loadCount}`);
  return storage;
}

const OLD_SETTINGS = { layout: 'igc', position: { x: 120, y: 40 } };

console.log('\nSettings-key migration\n');

await check('old key present, new key absent: value moves and the old key is removed', async () => {
  const storage = await loadWithStorage({ [LEGACY_KEY]: JSON.stringify(OLD_SETTINGS) });
  assert(storage.has(CURRENT_KEY), 'the new key was not written');
  assert(!storage.has(LEGACY_KEY), 'the old key survived the migration');
  const moved = JSON.parse(storage.get(CURRENT_KEY));
  assert(moved.layout === 'igc', `layout not carried across: got ${moved.layout}`);
  assert(moved.position.x === 120 && moved.position.y === 40, 'position not carried across');
});

await check('the moved value is byte-identical to what was stored', async () => {
  const raw = JSON.stringify(OLD_SETTINGS);
  const storage = await loadWithStorage({ [LEGACY_KEY]: raw });
  assert(storage.get(CURRENT_KEY) === raw, 'the value was rewritten rather than moved');
});

await check('both keys present: the new value wins and is left untouched', async () => {
  const current = JSON.stringify({ layout: 'qwerty', position: { x: 5, y: 5 } });
  const storage = await loadWithStorage({
    [LEGACY_KEY]: JSON.stringify(OLD_SETTINGS),
    [CURRENT_KEY]: current,
  });
  assert(storage.get(CURRENT_KEY) === current, 'stale legacy data overwrote current settings');
  // The old key is deliberately NOT removed here: this run migrated nothing, so
  // it has no successful move to clean up after.
  assert(storage.has(LEGACY_KEY), 'the old key was removed by a run that migrated nothing');
});

await check('neither key present: nothing is created', async () => {
  const storage = await loadWithStorage({});
  assert(!storage.has(CURRENT_KEY), 'the migration invented a settings key from nothing');
  assert(!storage.has(LEGACY_KEY), 'the migration invented a legacy key from nothing');
});

await check('unparseable legacy value: fails loudly and does not destroy the old data', async () => {
  let threw = false;
  try {
    await loadWithStorage({ [LEGACY_KEY]: '{not json' });
  } catch (e) {
    threw = true;
    assert(globalThis.localStorage.getItem(LEGACY_KEY) === '{not json',
      'the corrupt legacy value was discarded instead of left for inspection');
    assert(globalThis.localStorage.getItem(CURRENT_KEY) === null,
      'a corrupt legacy value was written to the new key');
  }
  assert(threw, 'a corrupt legacy value was swallowed instead of raising');
});

// Values that PARSE as JSON but are not a settings object. JSON.parse accepts
// every one, so only the shape check can reject them — these are what prove that
// check exists, rather than the unparseable case above, which JSON.parse catches
// on its own whether the migration validates anything or not.
for (const [label, raw] of [
  ['array', '[1,2,3]'],
  ['null', 'null'],
  ['string', '"imperial"'],
  ['number', '42'],
]) {
  await check(`legacy value that parses but is a ${label} is rejected, not migrated`, async () => {
    let threw = false;
    try {
      await loadWithStorage({ [LEGACY_KEY]: raw });
    } catch (e) {
      threw = true;
      assert(/corrupt/i.test(e.message), `unhelpful error for a ${label}: ${e.message}`);
      assert(globalThis.localStorage.getItem(CURRENT_KEY) === null,
        `a ${label} was written to the new settings key`);
      assert(globalThis.localStorage.getItem(LEGACY_KEY) === raw,
        `the legacy ${label} was discarded instead of left for inspection`);
    }
    assert(threw, `a JSON ${label} passed as valid settings`);
  });
}

await check('custom layouts are not touched: the rename never moved that key', async () => {
  const layouts = JSON.stringify({ mine: { displayName: 'Mine' } });
  const storage = await loadWithStorage({
    [LEGACY_KEY]: JSON.stringify(OLD_SETTINGS),
    [LAYOUTS_KEY]: layouts,
  });
  assert(storage.get(LAYOUTS_KEY) === layouts, 'the migration disturbed the custom layouts blob');
});

await check('migration is one-shot: a second load leaves the migrated value alone', async () => {
  const storage = await loadWithStorage({ [LEGACY_KEY]: JSON.stringify(OLD_SETTINGS) });
  const afterFirst = storage.get(CURRENT_KEY);
  // Re-run the module against the storage the first load left behind.
  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); },
  };
  await import(`../shaw-keys.js?m=${++loadCount}`);
  assert(storage.get(CURRENT_KEY) === afterFirst, 'a second load rewrote the migrated settings');
  assert(!storage.has(LEGACY_KEY), 'a second load resurrected the old key');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
