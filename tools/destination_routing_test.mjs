// Tests for where a tapped on-screen key inserts.
//
// Taps used to reach only #typingInput — one host's element id baked into the
// shared library — so three of the four consumers had dead virtual keys while
// physical typing worked. Keyboard-enabling an element (enableInterception) now
// also makes it a tap destination while it holds focus, which is what lets those
// hosts route taps without adding a call.
//
// Imports shaw-keys.js under a window/document stub, so it constrains the
// shipped code rather than a restatement of it.
//
// Usage: node tools/destination_routing_test.mjs

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { console.log('FAIL  ' + name + '\n        ' + e.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertThrows(fn, msg) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; }
  assert(threw, msg || 'expected a throw');
}

// A stand-in for an <input>: value-bearing, with the selection surface the
// insertion path drives and the listener surface interception attaches to.
function fakeInput(id) {
  return {
    id,
    tagName: 'INPUT',
    type: 'text',
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    isContentEditable: false,
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    getAttribute: () => null,
    hasAttribute: () => false,
    removeAttribute() {},
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  };
}

// Enough of a document for the library's focus tracking: focusin listeners, an
// activeElement, and containment. `attached` models a node removed from the DOM.
//
// Each call re-imports the library under a unique query string: module instances
// are cached per URL, and these tests need the module-scope state (focus
// tracking, the destination override) reset between them.
let loadCount = 0;
async function loadShawKeys() {
  const listeners = {};
  const byId = {};
  const document = {
    activeElement: null,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    getElementById: (id) => byId[id] || null,
    contains: (el) => !!el && el.attached !== false,
  };
  globalThis.window = {};
  globalThis.document = document;
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.InputEvent = class { constructor(type, init) { Object.assign(this, init); this.type = type; } };
  // Node defines navigator as a getter-only global, so plain assignment throws.
  Object.defineProperty(globalThis, 'navigator', {
    value: { platform: 'MacIntel', userAgent: 'node' }, configurable: true });
  const { ShawKeys: api } = await import(`../shaw-keys.js?t=${++loadCount}`);
  assert(api && api._internal, 'shaw-keys.js did not export ShawKeys._internal');

  // Drive focus the way a browser would: set activeElement, then fire focusin.
  const focus = (el) => {
    document.activeElement = el;
    (listeners.focusin || []).forEach((fn) => fn({ target: el }));
  };
  const register = (id, el) => { byId[id] = el; };
  return { api, focus, register, document };
}

await check('with nothing registered, taps still target #typingInput', async () => {
  const { api, register } = await loadShawKeys();
  const practice = fakeInput('typingInput');
  register('typingInput', practice);
  assert(api.getDestinationInput() === practice,
    'the practice input must stay the default so shaw-type is unaffected');
});

await check('with nothing registered and no #typingInput, there is no destination', async () => {
  const { api } = await loadShawKeys();
  assert(api.getDestinationInput() === null,
    'a page with neither must report no destination rather than inventing one');
});

await check('keyboard-enabling a field makes taps follow focus to it', async () => {
  const { api, focus } = await loadShawKeys();
  const field = fakeInput('hostField');
  api.enableInterception(field);
  focus(field);
  assert(api.getDestinationInput() === field,
    'a registered, focused field must receive taps — this is the whole feature');
});

await check('taps follow focus between two keyboard-enabled fields', async () => {
  const { api, focus } = await loadShawKeys();
  const first = fakeInput('first');
  const second = fakeInput('second');
  api.enableInterception(first);
  api.enableInterception(second);
  focus(first);
  assert(api.getDestinationInput() === first, 'taps should land in the focused field');
  focus(second);
  assert(api.getDestinationInput() === second, 'taps must follow the caret to the second field');
});

await check('focusing a field that never opted in does not capture taps', async () => {
  const { api, focus, register } = await loadShawKeys();
  const practice = fakeInput('typingInput');
  register('typingInput', practice);
  const enabled = fakeInput('enabled');
  api.enableInterception(enabled);
  focus(enabled);
  focus(fakeInput('notEnabled'));
  assert(api.getDestinationInput() === enabled,
    'an unregistered field must not steal taps; the last enabled one keeps them');
});

// The editor's Latin name field is deliberately NOT keyboard-enabled: it drives
// the slug and download filename and must stay Latin. Opting out has to mean
// taps never reach it, even when it is the focused element.
await check('an opted-out field never becomes the destination', async () => {
  const { api, focus } = await loadShawKeys();
  const shavianName = fakeInput('layoutEditorShavianName');
  const latinName = fakeInput('layoutEditorName');
  api.enableInterception(shavianName);
  focus(shavianName);
  focus(latinName);
  assert(api.getDestinationInput() !== latinName,
    'the Latin name field opted out; taps must never insert Shavian into it');
});

await check('registering an already-focused field captures it', async () => {
  const { api, document } = await loadShawKeys();
  const field = fakeInput('lateAttach');
  document.activeElement = field;   // focused BEFORE the host wired it up
  api.enableInterception(field);
  assert(api.getDestinationInput() === field,
    'hosts attach on focusin, so the triggering field is already focused');
});

await check('setDestination still overrides focus', async () => {
  const { api, focus } = await loadShawKeys();
  const pinned = fakeInput('pinned');
  const focused = fakeInput('focused');
  api.enableInterception(focused);
  focus(focused);
  api.setDestination(pinned);
  assert(api.getDestinationInput() === pinned,
    'an explicit destination must outrank focus');
  api.setDestination(null);
  assert(api.getDestinationInput() === focused,
    'clearing the override must fall back to the focused field');
});

await check('releasing interception stops taps reaching the field', async () => {
  const { api, focus, register } = await loadShawKeys();
  const practice = fakeInput('typingInput');
  register('typingInput', practice);
  const dialogField = fakeInput('dialogField');
  const stop = api.enableInterception(dialogField);
  focus(dialogField);
  assert(api.getDestinationInput() === dialogField);
  stop();
  assert(api.getDestinationInput() === practice,
    'a torn-down dialog must release taps back to the default');
});

// Hosts tear dialogs down without releasing first; inserting into a detached
// node writes into nothing, silently losing what the user typed.
await check('a detached field is not used as a destination', async () => {
  const { api, focus, register } = await loadShawKeys();
  const practice = fakeInput('typingInput');
  register('typingInput', practice);
  const field = fakeInput('removed');
  api.enableInterception(field);
  focus(field);
  field.attached = false;
  assert(api.getDestinationInput() === practice,
    'taps must fall back rather than insert into a removed element');
});

await check('setDestination still rejects a non-value-bearing element', async () => {
  const { api } = await loadShawKeys();
  assertThrows(() => api.setDestination({ tagName: 'DIV' }),
    'setDestination must fail loudly on an element it cannot drive');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
