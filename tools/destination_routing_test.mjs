// Tests for where a tapped on-screen key inserts.
//
// Taps used to reach only #typingInput — one host's element id baked into the
// shared library — so three of the four consumers had dead virtual keys while
// physical typing worked. Keyboard-enabling an element (enableInterception) now
// also makes it a tap destination while it holds focus, which is what lets those
// hosts route taps without adding a call.
//
// Loads virtual-keyboard.js under a window/document stub, so it constrains the
// shipped code rather than a restatement of it.
//
// Usage: node tools/destination_routing_test.mjs

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); passed++; }
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
function loadVirtualKeyboard() {
  const file = path.join(ROOT, 'virtual-keyboard.js');
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
  const sandbox = {
    window: {},
    document,
    navigator: { platform: 'MacIntel', userAgent: 'node' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    InputEvent: class { constructor(type, init) { Object.assign(this, init); this.type = type; } },
    Intl,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }).runInContext(sandbox);
  const api = sandbox.window.VirtualKeyboard;
  assert(api && api._internal, 'virtual-keyboard.js did not publish window.VirtualKeyboard._internal');

  // Drive focus the way a browser would: set activeElement, then fire focusin.
  const focus = (el) => {
    document.activeElement = el;
    (listeners.focusin || []).forEach((fn) => fn({ target: el }));
  };
  const register = (id, el) => { byId[id] = el; };
  return { api, focus, register, document };
}

check('with nothing registered, taps still target #typingInput', () => {
  const { api, register } = loadVirtualKeyboard();
  const practice = fakeInput('typingInput');
  register('typingInput', practice);
  assert(api.getDestinationInput() === practice,
    'the practice input must stay the default so shaw-type is unaffected');
});

check('with nothing registered and no #typingInput, there is no destination', () => {
  const { api } = loadVirtualKeyboard();
  assert(api.getDestinationInput() === null,
    'a page with neither must report no destination rather than inventing one');
});

check('keyboard-enabling a field makes taps follow focus to it', () => {
  const { api, focus } = loadVirtualKeyboard();
  const field = fakeInput('hostField');
  api.enableInterception(field);
  focus(field);
  assert(api.getDestinationInput() === field,
    'a registered, focused field must receive taps — this is the whole feature');
});

check('taps follow focus between two keyboard-enabled fields', () => {
  const { api, focus } = loadVirtualKeyboard();
  const first = fakeInput('first');
  const second = fakeInput('second');
  api.enableInterception(first);
  api.enableInterception(second);
  focus(first);
  assert(api.getDestinationInput() === first, 'taps should land in the focused field');
  focus(second);
  assert(api.getDestinationInput() === second, 'taps must follow the caret to the second field');
});

check('focusing a field that never opted in does not capture taps', () => {
  const { api, focus, register } = loadVirtualKeyboard();
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
check('an opted-out field never becomes the destination', () => {
  const { api, focus } = loadVirtualKeyboard();
  const shavianName = fakeInput('layoutEditorShavianName');
  const latinName = fakeInput('layoutEditorName');
  api.enableInterception(shavianName);
  focus(shavianName);
  focus(latinName);
  assert(api.getDestinationInput() !== latinName,
    'the Latin name field opted out; taps must never insert Shavian into it');
});

check('registering an already-focused field captures it', () => {
  const { api, document } = loadVirtualKeyboard();
  const field = fakeInput('lateAttach');
  document.activeElement = field;   // focused BEFORE the host wired it up
  api.enableInterception(field);
  assert(api.getDestinationInput() === field,
    'hosts attach on focusin, so the triggering field is already focused');
});

check('setDestination still overrides focus', () => {
  const { api, focus } = loadVirtualKeyboard();
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

check('releasing interception stops taps reaching the field', () => {
  const { api, focus, register } = loadVirtualKeyboard();
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
check('a detached field is not used as a destination', () => {
  const { api, focus, register } = loadVirtualKeyboard();
  const practice = fakeInput('typingInput');
  register('typingInput', practice);
  const field = fakeInput('removed');
  api.enableInterception(field);
  focus(field);
  field.attached = false;
  assert(api.getDestinationInput() === practice,
    'taps must fall back rather than insert into a removed element');
});

check('setDestination still rejects a non-value-bearing element', () => {
  const { api } = loadVirtualKeyboard();
  assertThrows(() => api.setDestination({ tagName: 'DIV' }),
    'setDestination must fail loudly on an element it cannot drive');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
