// Tests for how a keyboard layout is NAMED on screen.
//
// The reported defect: the docked keyboard's title bar read "igc" and "2layer"
// — the internal layout ids — instead of "Imperial Good Companion" and
// "Shaw 2-layer (shift)". The settings dialog and the editor's base picker were
// correct at the same moment, which is what located the bug: three surfaces
// each resolved the name themselves, and the title bar was the one that passed
// the id as its fallback, so it rendered the id whenever no string table was
// loaded. Names now live in the layout JSONs and every surface reads them
// through one resolver (layoutDisplayName).
//
// Imports shaw-keys.js under a window/document stub and serves the real
// layout JSONs from disk, so it constrains the shipped code and the shipped data
// rather than a restatement of either.
//
// Usage: node tools/layout_name_test.mjs

import { readFileSync } from 'node:fs';

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { console.log('FAIL  ' + name + '\n        ' + e.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
async function assertRejects(fn, msg) {
  let threw = false;
  try { await fn(); } catch (e) { threw = true; }
  assert(threw, msg || 'expected a throw');
}

// The five user-facing built-ins and the names the owner wrote for them.
const EXPECTED_NAMES = {
  imperial: 'Shaw Imperial',
  igc: 'Imperial Good Companion',
  qwerty: 'Shaw QWERTY',
  '2layer': 'Shaw 2-layer (shift)',
  jafl: 'Shaw-JAFL',
};

// The Shavian names, now carried by the layouts themselves. Transcribed from the
// skLayout* translation keys they replaced, which have since been retired.
const EXPECTED_SHAVIAN_NAMES = {
  imperial: '𐑖𐑷 𐑦𐑥𐑐𐑽𐑾𐑤',
  igc: '𐑦𐑥𐑐𐑽𐑾𐑤 𐑜𐑫𐑛 𐑒𐑩𐑥𐑐𐑨𐑯𐑘𐑩𐑯',
  qwerty: '𐑖𐑷 QWERTY',
  '2layer': '𐑖𐑷 2-𐑤𐑱𐑼 (𐑖𐑦𐑓𐑑)',
  jafl: '·𐑖𐑷-JAFL',
};

const REPO = new URL('../', import.meta.url);

// Each call re-imports the library under a unique query string: module instances
// are cached per URL, and these tests need module-scope state (the layout cache,
// the loaded string table) reset between them.
//
// `storedCustomLayouts` seeds the localStorage the bundled CustomLayouts store
// reads, so a test can present a custom layout the built-ins cannot: one whose
// author left the Shavian name blank.
let loadCount = 0;
async function loadShawKeys(storedCustomLayouts = null) {
  const titleEl = { className: 'keyboard-title', textContent: '' };
  const bodyEl = { className: '', classList: { add() {}, remove() {}, toggle() {} } };
  const document = {
    addEventListener() {}, removeEventListener() {},
    querySelector(sel) {
      if (sel === '.keyboard-title') return titleEl;
      if (sel === '.keyboard-body') return bodyEl;
      return null;
    },
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    getElementById: () => null,
    contains: () => false,
  };
  document.createElement = (tag) => stubElement(tag);
  globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
  globalThis.document = document;
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value; } };
  const storage = new Map();
  if (storedCustomLayouts) {
    storage.set('customLayouts', JSON.stringify(storedCustomLayouts));
  }
  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); },
  };
  globalThis.InputEvent = class { constructor(type, init) { Object.assign(this, init); this.type = type; } };
  Object.defineProperty(globalThis, 'navigator', {
    value: { platform: 'MacIntel', userAgent: 'node' }, configurable: true });
  // Serve the repo's real files, the way the browser fetches them.
  const fetched = [];
  globalThis.fetch = async (url) => {
    const file = String(url).split('/').pop().split('?')[0];
    fetched.push(file);
    try {
      const text = readFileSync(new URL(file, REPO), 'utf8');
      return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
    } catch {
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    }
  };
  const { ShawKeys: api } = await import(`../shaw-keys.js?t=${++loadCount}`);
  assert(api && api._internal, 'shaw-keys.js did not export ShawKeys._internal');
  return { api, internal: api._internal, titleEl, fetched };
}

// Node has no DOM, and the point of the cold-cache test is the LOAD the mount
// performs, so these elements only need to absorb what the picker does to them.
function stubElement(tag = 'div') {
  return {
    tagName: String(tag).toUpperCase(),
    id: '', className: '', textContent: '', innerHTML: '', value: '', name: '',
    checked: false, dataset: {}, children: [], style: {},
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); },
      contains(c) { return this._s.has(c); },
    },
    clientWidth: 900, clientHeight: 600,
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    removeChild(child) { this.children = this.children.filter(c => c !== child); },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() {}, scrollIntoView() {},
    getBoundingClientRect: () => ({ width: 900, height: 600, top: 0, left: 0 }),
  };
}

// Run `fn` with one layout file answering 404, the way a build that shipped
// without it would. Restores the real fetch afterwards.
async function withMissingLayoutFile(layoutId, fn) {
  const realFetch = globalThis.fetch;
  const absent = `keyboard_layout_${layoutId}.json`;
  globalThis.fetch = async (url) => {
    if (String(url).includes(absent)) {
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    }
    return realFetch(url);
  };
  try { await fn(); } finally { globalThis.fetch = realFetch; }
}

// The settings mount's container: the picker looks up #sk-layout-list inside it,
// and pickerMount walks back up to the [data-sk-group] host.
function pickerContainerStub() {
  const list = stubElement('div');
  const container = stubElement('div');
  container.querySelector = (sel) => (sel === '#sk-layout-list' ? list : null);
  list.closest = (sel) => (sel === '[data-sk-group]' ? container : null);
  container.closest = (sel) => (sel === '[data-sk-group]' ? container : null);
  return container;
}

// --- the shipped data carries the names -----------------------------------

await check('every user-facing built-in layout JSON carries its displayName', async () => {
  for (const [id, expected] of Object.entries(EXPECTED_NAMES)) {
    const layout = JSON.parse(readFileSync(new URL(`keyboard_layout_${id}.json`, REPO), 'utf8'));
    assert(layout.displayName === expected,
      `keyboard_layout_${id}.json displayName is ${JSON.stringify(layout.displayName)}, expected ${JSON.stringify(expected)}`);
  }
});

// Built-ins carry the SAME metadata shape as custom layouts, so no surface needs
// a built-in special case. The name fields must also be non-blank: `typeof
// === 'string'` alone admits "", which reaches a Shavian title bar as nothing.
const BUILT_IN_REQUIRED_NON_BLANK = ['displayName', 'shavianDisplayName'];

await check('built-in layouts carry the custom-layout metadata shape', async () => {
  for (const id of Object.keys(EXPECTED_NAMES)) {
    const layout = JSON.parse(readFileSync(new URL(`keyboard_layout_${id}.json`, REPO), 'utf8'));
    for (const field of ['displayName', 'description', 'shavianDisplayName', 'shavianDescription']) {
      assert(typeof layout[field] === 'string',
        `keyboard_layout_${id}.json is missing the ${field} field`);
    }
    for (const field of BUILT_IN_REQUIRED_NON_BLANK) {
      assert(layout[field].trim() !== '',
        `keyboard_layout_${id}.json has a blank ${field} — a built-in must carry a name in both scripts`);
    }
  }
});

// --- the reported defect ---------------------------------------------------

await check('the reported case: the title bar shows the name, never the id', async () => {
  const { internal, titleEl } = await loadShawKeys();
  await internal.preloadBuiltInLayouts();
  for (const [id, expected] of Object.entries(EXPECTED_NAMES)) {
    titleEl.textContent = '';
    internal.updateKeyboardLabels({}, id, { keys: {} });
    assert(titleEl.textContent === expected,
      `title for ${id} was ${JSON.stringify(titleEl.textContent)}, expected ${JSON.stringify(expected)}`);
  }
});

await check('the title bar keeps the name when Shift is held', async () => {
  const { api, internal, titleEl } = await loadShawKeys();
  await internal.preloadBuiltInLayouts();
  internal.updateKeyboardLabels({}, 'igc', { keys: {} });
  assert(!titleEl.textContent.includes('igc'),
    `the title leaked the layout id: ${JSON.stringify(titleEl.textContent)}`);
  assert(titleEl.textContent.startsWith('Imperial Good Companion'),
    `expected the name to lead the title, got ${JSON.stringify(titleEl.textContent)}`);
});

// --- one resolver, so no surface can drift from another --------------------

await check('the title bar and the settings picker agree on every name', async () => {
  const { internal, titleEl } = await loadShawKeys();
  await internal.preloadBuiltInLayouts();
  for (const { id, displayName } of internal.listBuiltInLayouts()) {
    titleEl.textContent = '';
    internal.updateKeyboardLabels({}, id, { keys: {} });
    assert(titleEl.textContent === displayName,
      `${id}: title says ${JSON.stringify(titleEl.textContent)} but the picker says ${JSON.stringify(displayName)}`);
  }
});

// The order is the owner's, not alphabetical and not the file order — Object.keys
// on EXPECTED_NAMES would only restate whatever listBuiltInLayouts returned, so
// the sequence is spelled out here.
const EXPECTED_MENU_ORDER = ['imperial', 'igc', 'qwerty', '2layer', 'jafl'];

await check('the settings picker lists the names, in menu order', async () => {
  const { internal } = await loadShawKeys();
  await internal.preloadBuiltInLayouts();
  const listed = internal.listBuiltInLayouts();
  assert(listed.length === 5, `expected 5 built-ins, got ${listed.length}`);
  const order = listed.map(l => l.id);
  assert(order.join() === EXPECTED_MENU_ORDER.join(),
    `the picker listed ${JSON.stringify(order)}, expected ${JSON.stringify(EXPECTED_MENU_ORDER)}`);
  for (const { id, displayName } of listed) {
    assert(displayName === EXPECTED_NAMES[id],
      `picker labels ${id} as ${JSON.stringify(displayName)}, expected ${JSON.stringify(EXPECTED_NAMES[id])}`);
  }
});

// --- the Shavian names survive, and the layout can take them over ----------

// The layouts carry the Shavian names themselves, so a Shavian UI names every
// built-in with no translation key involved. The names were transcribed from the
// retired skLayout* keys, so this also guards against a lossy transcription.
await check('a Shavian UI names every built-in from the layouts themselves', async () => {
  const { api, internal } = await loadShawKeys();
  await internal.preloadBuiltInLayouts();
  await api.setScript('shavian', 'british');
  for (const { id, displayName } of internal.listBuiltInLayouts()) {
    assert(displayName === EXPECTED_SHAVIAN_NAMES[id],
      `${id} in Shavian was ${JSON.stringify(displayName)}, expected ${JSON.stringify(EXPECTED_SHAVIAN_NAMES[id])}`);
  }
});

// The retired keys must not come back: a regenerated table carrying them again
// would reinstate the second copy of every name that FIX 1 removed.
await check('the retired skLayout* name keys are gone from every shipped table', async () => {
  const retired = ['skLayoutImperial', 'skLayoutIgc', 'skLayoutQwerty', 'skLayout2layer', 'skLayoutJafl'];
  for (const file of ['translations_latin.json', 'translations_british.json', 'translations_american.json']) {
    const table = JSON.parse(readFileSync(new URL(file, REPO), 'utf8'));
    for (const key of retired) {
      assert(!(key in table), `${file} still carries the retired ${key}`);
    }
    assert('skDescImperial' in table, `${file} lost skDescImperial — descriptions stay in the tables`);
  }
});

// A sentinel no oracle could produce: proves the Shavian name is DERIVED from the
// loaded layout, not from a table or a switch that happens to know the right five.
await check("a layout's own Shavian name is what reaches the screen", async () => {
  const { api, internal, titleEl } = await loadShawKeys();
  await internal.preloadBuiltInLayouts();
  await api.setScript('shavian', 'british');
  const ownShavian = '𐑑𐑧𐑕𐑑 𐑖𐑨𐑝𐑰𐑩𐑯';
  const layout = await internal.getKeyboardLayoutData('igc');
  layout.shavianDisplayName = ownShavian;
  titleEl.textContent = '';
  internal.updateKeyboardLabels({}, 'igc', { keys: {} });
  assert(titleEl.textContent === ownShavian,
    `expected the layout's own Shavian name to win, got ${JSON.stringify(titleEl.textContent)}`);
});

// The Latin counterpart of the sentinel above. Without this, reverting
// layoutDisplayName to a hardcoded id->name switch passes the whole suite: every
// other Latin assertion compares against the five real names, which such a switch
// reproduces exactly. A sentinel can only come from the layout.
await check("a layout's own Latin name is what reaches the screen", async () => {
  const { internal, titleEl } = await loadShawKeys();
  await internal.preloadBuiltInLayouts();
  const sentinel = 'Sentinel Latin Name';
  const layout = await internal.getKeyboardLayoutData('imperial');
  layout.displayName = sentinel;
  titleEl.textContent = '';
  internal.updateKeyboardLabels({}, 'imperial', { keys: {} });
  assert(titleEl.textContent === sentinel,
    `expected the layout's own displayName to reach the title, got ${JSON.stringify(titleEl.textContent)}`);
  const listed = internal.listBuiltInLayouts().find(l => l.id === 'imperial');
  assert(listed.displayName === sentinel,
    `expected the picker to read the layout too, got ${JSON.stringify(listed.displayName)}`);
});

// The owner's requirement: "Shavian version is optional, show fall back to
// 'displayName' if shavian one is blank." All five built-ins ship a Shavian name,
// so only a custom layout reaches the blank branch — and a custom layout with no
// Shavian name is exactly what an author who types only the Latin one produces.
// Without this, dropping the blank check from preferredScriptLabel passes the
// suite, and the consequence is an EMPTY title bar rather than the Latin name.
const CUSTOM_LAYOUTS_WITH_AND_WITHOUT_SHAVIAN = {
  'latin-only': {
    name: 'latin-only',
    displayName: 'Latin Only Layout',
    shavianDisplayName: '',
    description: '',
    shavianDescription: '',
  },
  'both-scripts': {
    name: 'both-scripts',
    displayName: 'Both Scripts Layout',
    shavianDisplayName: '𐑚𐑴𐑔 𐑕𐑒𐑮𐑦𐑐𐑑𐑕',
    description: '',
    shavianDescription: '',
  },
};

await check('a blank Shavian name falls back to the Latin one, not to nothing', async () => {
  const { api, internal, titleEl } = await loadShawKeys(CUSTOM_LAYOUTS_WITH_AND_WITHOUT_SHAVIAN);
  await internal.preloadBuiltInLayouts();
  await api.setScript('shavian', 'british');

  // The layout that DOES carry a Shavian name proves the UI is really in Shavian,
  // or the fallback below would pass for the wrong reason.
  assert(internal.layoutDisplayName('custom:both-scripts') === '𐑚𐑴𐑔 𐑕𐑒𐑮𐑦𐑐𐑑𐑕',
    'the UI was not in Shavian — this test proves nothing');

  assert(internal.layoutDisplayName('custom:latin-only') === 'Latin Only Layout',
    `a blank Shavian name resolved to ${JSON.stringify(internal.layoutDisplayName('custom:latin-only'))}, expected the Latin name`);

  titleEl.textContent = '';
  internal.updateKeyboardLabels({}, 'custom:latin-only', { keys: {} });
  assert(titleEl.textContent === 'Latin Only Layout',
    `the title bar showed ${JSON.stringify(titleEl.textContent)} — a blank Shavian name must not empty the title`);
});

await check('the layout name is used when no translation carries that key', async () => {
  const { api, internal, titleEl } = await loadShawKeys();
  await internal.preloadBuiltInLayouts();
  api.setUiStrings({ skDialogTitle: 'unrelated' });
  titleEl.textContent = '';
  internal.updateKeyboardLabels({}, 'jafl', { keys: {} });
  assert(titleEl.textContent === 'Shaw-JAFL',
    `expected the layout's own name, got ${JSON.stringify(titleEl.textContent)}`);
});

// --- production loads the layouts itself, on a COLD cache ------------------

// Every other test preloads by hand, so they prove the preload WORKS, never that
// the mount seam CALLS it. Deleting the await from loadShawKeysSettingsHTML
// passes them all. This drives the real seam with nothing cached: the naming path
// is synchronous, so if production doesn't load the layouts first, it cannot name
// a single row.
await check('the settings mount loads the layouts itself, with a cold cache', async () => {
  const { internal, fetched } = await loadShawKeys();
  // Confirm the cache really is cold, or the rest of this proves nothing.
  let namedWhileCold = true;
  try { internal.listBuiltInLayouts(); } catch { namedWhileCold = false; }
  assert(!namedWhileCold, 'the cache was not cold — this test proves nothing');

  fetched.length = 0;
  await internal.loadSettingsHTML(pickerContainerStub());

  for (const id of Object.keys(EXPECTED_NAMES)) {
    assert(fetched.includes(`keyboard_layout_${id}.json`),
      `the mount never fetched keyboard_layout_${id}.json — it did not preload the layouts`);
  }
  for (const { id, displayName } of internal.listBuiltInLayouts()) {
    assert(displayName === EXPECTED_NAMES[id],
      `after the mount, ${id} named ${JSON.stringify(displayName)}`);
  }
});

// Clearing the whole cache must not brick naming: the documented no-argument form
// is what an open picker's host calls after a bulk custom-layout change.
await check('invalidateLayoutCache() leaves every built-in nameable', async () => {
  const { internal } = await loadShawKeys();
  await internal.preloadBuiltInLayouts();
  internal.invalidateLayoutCache();
  for (const { id, displayName } of internal.listBuiltInLayouts()) {
    assert(displayName === EXPECTED_NAMES[id],
      `${id} after a full cache clear named ${JSON.stringify(displayName)}`);
  }
});

// The per-name form must honour the same exemption as the bulk form above.
// Evicting one built-in bricks naming just as thoroughly as evicting all five,
// and the editor calls this form with whatever id it just saved.
await check('invalidateLayoutCache(id) leaves a built-in nameable', async () => {
  const { internal } = await loadShawKeys();
  await internal.preloadBuiltInLayouts();
  internal.invalidateLayoutCache('igc');
  assert(internal.layoutDisplayName('igc') === EXPECTED_NAMES.igc,
    `igc after a per-name cache clear named ${JSON.stringify(internal.layoutDisplayName('igc'))}`);
});

// A custom must still be evictable by name, or the per-name form does nothing —
// the exemption above would pass just as well if the function had no body. The
// resolver counts its calls: a cache hit never reaches it, an eviction does.
await check('invalidateLayoutCache(id) still evicts a custom layout', async () => {
  const { internal } = await loadShawKeys();
  let resolveCount = 0;
  internal.setCustomLayoutResolver((id) => { resolveCount++; return { keys: {} }; }, () => 'Name');
  await internal.getKeyboardLayoutData('custom:evictable');
  await internal.getKeyboardLayoutData('custom:evictable');
  assert(resolveCount === 1, `expected the second read to hit the cache, resolver ran ${resolveCount} times`);
  internal.invalidateLayoutCache('custom:evictable');
  await internal.getKeyboardLayoutData('custom:evictable');
  assert(resolveCount === 2, 'the per-name form did not evict a custom layout');
});

// --- a missing built-in file fails loudly rather than blanking the panel ----

// The reproduced defect: loadKeyboardLayout answers a 404 with null, so
// Promise.all resolved the preload SUCCESSFULLY with a built-in absent. The
// first naming call then threw from inside renderPickerList, the mount seam's
// catch logged "Error loading keyboard settings HTML", and the user got a
// settings panel that never rendered — no visible error, one missing file.
await check('a missing built-in layout file makes the preload fail loudly', async () => {
  const { internal } = await loadShawKeys();
  await withMissingLayoutFile('qwerty', async () => {
    await assertRejects(async () => internal.preloadBuiltInLayouts(),
      'the preload resolved with a built-in absent — a 404 must not resolve successfully');
  });
});

// The failure must name the file that is missing, or the log leaves whoever
// reads it no better off than the silent blank panel did.
await check('the preload failure names the built-in that is missing', async () => {
  const { internal } = await loadShawKeys();
  await withMissingLayoutFile('qwerty', async () => {
    let message = '';
    try { await internal.preloadBuiltInLayouts(); } catch (e) { message = e.message; }
    assert(message.includes('qwerty'),
      `the failure did not name the missing layout: ${JSON.stringify(message)}`);
  });
});

// --- a nameless layout fails loudly rather than showing an id --------------

await check('a layout with no displayName raises, rather than rendering its id', async () => {
  const { internal } = await loadShawKeys();
  await assertRejects(async () => internal.layoutDisplayName('spill'),
    'a nameless layout must raise — falling back to the id is the defect being fixed');
});

await check('an unresolvable custom layout raises, rather than rendering its id', async () => {
  const { internal } = await loadShawKeys();
  await assertRejects(async () => internal.layoutDisplayName('custom:no-such-layout'),
    'an unknown custom id must raise rather than reaching the screen as an id');
});

// A name that is only whitespace is not a name, and unlike a blank one it
// survives every falsiness guard ("   " is truthy) and every
// `typeof === 'string'` assertion. Both routes must refuse it, or the same
// fault degrades two different ways.
await check('a whitespace-only built-in name raises, rather than blanking the title', async () => {
  const { internal } = await loadShawKeys();
  await internal.preloadBuiltInLayouts();
  (await internal.getKeyboardLayoutData('igc')).displayName = '   ';
  await assertRejects(async () => internal.layoutDisplayName('igc'),
    'a whitespace-only displayName must raise — it renders as an empty title bar');
});

// The throw above only helps if the surfaces let it out. A retitle that catches
// it and writes on regardless puts the blank title bar back with no error, so
// drive the real seam and require the sentinel to survive.
await check('a retitle refuses a whitespace-only name rather than emptying the title', async () => {
  const { api, internal, titleEl } = await loadShawKeys();
  await internal.preloadBuiltInLayouts();
  await api.setLayout('igc');
  (await internal.getKeyboardLayoutData('igc')).displayName = '   ';
  titleEl.textContent = 'untouched';
  await assertRejects(async () => api.setScript('shavian', 'british'),
    'the retitle swallowed the naming throw');
  assert(titleEl.textContent === 'untouched',
    `the title bar was written with a whitespace-only name: ${JSON.stringify(titleEl.textContent)}`);
});

await check('a whitespace-only custom name raises, like the built-in route', async () => {
  const { internal } = await loadShawKeys();
  internal.setCustomLayoutResolver(() => ({ keys: {} }), () => '   ');
  await assertRejects(async () => internal.layoutDisplayName('custom:whitespace-name'),
    'a whitespace-only custom name must raise, exactly as the built-in route does');
});

// The Shavian side of the same fault: a whitespace-only Shavian name is truthy,
// so it WINS over a perfectly good Latin name and empties the title in a Shavian
// UI. It must fall back to Latin, as a blank one already does.
await check('a whitespace-only Shavian name falls back to the Latin one', async () => {
  const { api, internal } = await loadShawKeys();
  await internal.preloadBuiltInLayouts();
  await api.setScript('shavian', 'british');
  (await internal.getKeyboardLayoutData('igc')).shavianDisplayName = '   ';
  assert(internal.layoutDisplayName('igc') === EXPECTED_NAMES.igc,
    `expected the Latin name, got ${JSON.stringify(internal.layoutDisplayName('igc'))}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
