// Regression test: tapping an on-screen key into a contenteditable destination.
//
// enableInterception has understood contenteditable since it was written — the
// beforeinput handler branches on it and drives the live Selection. The TAP path
// never learned: insertTappedGlyph and both Backspace branches read .value and
// .selectionStart unconditionally, so a tap into a contenteditable div threw
// "Cannot read properties of undefined (reading 'length')" while PHYSICALLY
// TYPING into the same element worked. setDestination refused one outright.
// The asymmetry was the defect: one path learned contenteditable, the other did
// not, so this test pins BOTH routes onto the one shared insertion routine.
//
// Drives the shipped click handler through _internal.makeKeysClickable, so it
// constrains the emission path rather than restating it.
//
// What the stub does NOT prove: this is a hand-rolled Selection/Range over a
// single text node, not a browser's. It cannot show that execCommand('insertText')
// or execCommand('delete') behave correctly in a real contenteditable, that undo
// works, or that the caret survives across element boundaries — the stub omits
// execCommand entirely, which is exactly what routes these cases through the
// insertTextAtCaret / deleteBackwardInContentEditable fallbacks. It proves the
// tap path reaches a contenteditable element and does not throw on it. Cross-node
// ranges and real execCommand semantics need a browser.
//
// Usage: node tools/contenteditable_tap_test.mjs

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

const PEEP = '\u{10450}';
const TOT = '\u{10451}';

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

// A stand-in for a contenteditable <div>: no .value and no .selectionStart, so
// any code that reaches for them fails exactly as it did in the browser. Its
// content is one text node, which the shared Selection model below edits.
function fakeContentEditable(id) {
  const textNode = { nodeType: 3, data: '' };
  return {
    id,
    tagName: 'DIV',
    isContentEditable: true,
    textNode,
    get text() { return textNode.data; },
    contains: (node) => node === textNode,
    getAttribute: (name) => (name === 'contenteditable' ? 'true' : null),
    hasAttribute: () => false,
    removeAttribute() {},
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  };
}

// The minimum Selection/Range model insertTextAtCaret, formLigaturesInContent-
// Editable and deleteBackwardInContentEditable actually exercise: a collapsed
// caret in one text node. deleteContents and insertNode are implemented as
// string surgery on that node rather than as tree operations.
function selectionOver(host) {
  const node = host.textNode;
  const range = {
    startContainer: node,
    startOffset: 0,
    endOffset: 0,
    collapsed: true,
    setStart(container, offset) { this.startContainer = container; this.startOffset = offset; this.collapsed = this.startOffset === this.endOffset; },
    setStartAfter() { this.startOffset = this.endOffset; this.collapsed = true; },
    collapse() { this.endOffset = this.startOffset; this.collapsed = true; },
    deleteContents() {
      const from = Math.min(this.startOffset, this.endOffset);
      const to = Math.max(this.startOffset, this.endOffset);
      node.data = node.data.substring(0, from) + node.data.substring(to);
      this.startOffset = this.endOffset = from;
      this.collapsed = true;
    },
    insertNode(inserted) {
      node.data = node.data.substring(0, this.startOffset) + inserted.data + node.data.substring(this.startOffset);
      this.endOffset = this.startOffset + inserted.data.length;
    },
  };
  return {
    range,
    rangeCount: 1,
    getRangeAt: () => range,
    removeAllRanges() {},
    addRange(added) { Object.assign(range, { startContainer: added.startContainer, startOffset: added.startOffset, endOffset: added.startOffset, collapsed: true }); },
  };
}

// A stand-in for one on-screen key. makeKeysClickable clones each key and swaps
// the clone in to shed old listeners, so cloneNode returns the same object and
// replaceChild is a no-op — the handlers then land where the test can fire them.
function fakeKey(dataKey, shavian) {
  const listeners = {};
  const key = {
    cloneNode: () => key,
    parentNode: { replaceChild() {} },
    classList: { add() {}, remove() {} },
    getAttribute: (name) => {
      if (name === 'data-key') return dataKey;
      if (name === 'data-shavian') return shavian;
      return null;
    },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    tap() { (listeners.click || []).forEach(fn => fn({ preventDefault() {} })); },
  };
  return key;
}

// Each call re-imports the library under a unique query string: module instances
// are cached per URL, and these tests need the module-scope state (focus
// tracking, the destination override) reset between them.
//
// window.getSelection is set per destination by useSelection(). document has no
// execCommand, which routes insertion and deletion through the library's
// Selection-based fallbacks — the branches this stub can actually observe.
let loadCount = 0;
async function loadVirtualKeyboard() {
  const listeners = {};
  const byId = {};
  let keys = [];
  const document = {
    activeElement: null,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === '.key[data-key]' ? keys : []),
    getElementsByTagName: () => [],
    getElementById: (id) => byId[id] || null,
    contains: (el) => !!el && el.attached !== false,
    createTextNode: (data) => ({ nodeType: 3, data }),
    createRange: () => ({ setStart(container, offset) { this.startContainer = container; this.startOffset = offset; }, collapse() {} }),
  };
  globalThis.window = {};
  globalThis.document = document;
  globalThis.Node = { TEXT_NODE: 3 };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.InputEvent = class { constructor(type, init) { Object.assign(this, init); this.type = type; } };
  Object.defineProperty(globalThis, 'navigator', {
    value: { platform: 'MacIntel', userAgent: 'node' }, configurable: true });
  const { VirtualKeyboard: api } = await import(`../virtual-keyboard.js?t=${++loadCount}`);
  assert(api && api._internal, 'virtual-keyboard.js did not export VirtualKeyboard._internal');

  const focus = (el) => {
    document.activeElement = el;
    (listeners.focusin || []).forEach((fn) => fn({ target: el }));
  };
  // Install the shipped click handlers on `keyList`, the way applyLayout does.
  const wireKeys = (keyList) => { keys = keyList; api._internal.makeKeysClickable({}); };
  // ONE Selection per host, so the caret persists across taps the way a browser's
  // does. A fresh one per call would reset the caret to 0 and hide every ordering
  // and deletion bug this test exists to catch.
  const useSelection = (host) => {
    const selection = selectionOver(host);
    globalThis.window.getSelection = () => selection;
  };
  return { api, focus, wireKeys, useSelection, document };
}

await check('tapping a glyph into a contenteditable destination inserts it', async () => {
  const { api, focus, wireKeys, useSelection } = await loadVirtualKeyboard();
  const editor = fakeContentEditable('richEditor');
  api.enableInterception(editor);
  focus(editor);
  useSelection(editor);
  assert(api.getDestinationInput() === editor, 'the contenteditable must be the destination');

  const key = fakeKey('q', PEEP);
  wireKeys([key]);
  key.tap();   // threw "Cannot read properties of undefined (reading 'length')"
  assert(editor.text === PEEP,
    `a tapped glyph must reach a contenteditable destination; it holds ${JSON.stringify(editor.text)}`);
});

await check('tapping twice into a contenteditable appends rather than overwrites', async () => {
  const { api, focus, wireKeys, useSelection } = await loadVirtualKeyboard();
  const editor = fakeContentEditable('richEditor');
  api.enableInterception(editor);
  focus(editor);
  useSelection(editor);
  const first = fakeKey('q', PEEP);
  const second = fakeKey('w', TOT);
  wireKeys([first, second]);
  first.tap();
  second.tap();
  assert(editor.text === PEEP + TOT,
    `two taps must leave both glyphs; got ${JSON.stringify(editor.text)}`);
});

await check('backspace into a contenteditable destination removes a glyph', async () => {
  const { api, focus, wireKeys, useSelection } = await loadVirtualKeyboard();
  const editor = fakeContentEditable('richEditor');
  api.enableInterception(editor);
  focus(editor);
  useSelection(editor);
  const glyph = fakeKey('q', PEEP);
  const backspace = fakeKey('Backspace', null);
  wireKeys([glyph, backspace]);
  glyph.tap();
  glyph.tap();
  assert(editor.text === PEEP + PEEP, 'setup: two glyphs before the backspace');
  backspace.tap();   // threw on typingInput.value.length
  assert(editor.text === PEEP,
    `backspace must remove exactly one glyph; left ${JSON.stringify(editor.text)}`);
});

// A Shavian letter is a surrogate pair. Deleting by UTF-16 unit would leave half
// of one behind, which is the bug the value-bearing branch already avoids by
// splitting with Array.from.
await check('backspace on a contenteditable deletes a whole Shavian letter', async () => {
  const { api, focus, wireKeys, useSelection } = await loadVirtualKeyboard();
  const editor = fakeContentEditable('richEditor');
  api.enableInterception(editor);
  focus(editor);
  useSelection(editor);
  const glyph = fakeKey('q', PEEP);
  const backspace = fakeKey('Backspace', null);
  wireKeys([glyph, backspace]);
  glyph.tap();
  backspace.tap();
  assert(editor.text === '',
    `one backspace must clear one Shavian letter, not half a surrogate pair; left ${JSON.stringify(editor.text)}`);
});

// The <input> route is the one every existing host relies on. Sharing one
// insertion routine between the two element kinds must not have moved it.
await check('the <input> path still inserts glyphs at the caret', async () => {
  const { api, focus, wireKeys } = await loadVirtualKeyboard();
  const field = fakeInput('hostField');
  api.enableInterception(field);
  focus(field);
  const first = fakeKey('q', PEEP);
  const second = fakeKey('w', TOT);
  wireKeys([first, second]);
  first.tap();
  second.tap();
  assert(field.value === PEEP + TOT,
    `two taps into an <input> must leave both glyphs; got ${JSON.stringify(field.value)}`);
});

// Latin, not Shavian: backspace on an <input> indexes an Array.from() grapheme
// split with a UTF-16 selectionStart, so it silently does nothing once the value
// holds a surrogate pair. That is a SEPARATE, pre-existing defect this change
// does not touch — pinning the ASCII case here keeps the <input> route honest
// without asserting the broken one either way.
await check('the <input> path still backspaces identically', async () => {
  const { api, focus, wireKeys } = await loadVirtualKeyboard();
  const field = fakeInput('hostField');
  api.enableInterception(field);
  focus(field);
  const glyph = fakeKey('q', 'a');
  const backspace = fakeKey('Backspace', null);
  wireKeys([glyph, backspace]);
  glyph.tap();
  glyph.tap();
  assert(field.value === 'aa',
    `two taps into an <input> must leave both characters; got ${JSON.stringify(field.value)}`);
  backspace.tap();
  assert(field.value === 'a',
    `backspace on an <input> must remove one character; left ${JSON.stringify(field.value)}`);
});

await check('setDestination accepts a contenteditable element', async () => {
  const { api } = await loadVirtualKeyboard();
  const editor = fakeContentEditable('pinnedEditor');
  api.setDestination(editor);
  assert(api.getDestinationInput() === editor,
    'a host must be able to pin taps to a contenteditable, not just an <input>');
});

await check('setDestination still rejects a plain DIV', async () => {
  const { api } = await loadVirtualKeyboard();
  assertThrows(() => api.setDestination({ tagName: 'DIV' }),
    'a non-editable element must still fail loudly rather than no-op on every tap');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
