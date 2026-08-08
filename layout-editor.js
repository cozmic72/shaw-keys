// Visual keyboard-layout editor. Part of the virtual-keyboard library.
//
// Lets the user rebind keys and edit ligatures by typing, then persists a
// validated bare layout ({ keys, ligatures }) through the
// library's own CustomLayouts store. It resolves everything it needs from the
// library directly — the current layout, the built-in registry, the keyboard
// template to clone, the ligature engine — so it carries no host callbacks. When
// its layout set changes it fires VirtualKeyboard's onLayoutsChanged event; the
// host (the game) reacts by repopulating selectors and re-applying if the active
// layout moved.
//
// Plain script (no modules/bundler), exposing window.LayoutEditor, matching
// virtual-keyboard.js / custom-layouts.js. Loaded AFTER those two, so it reaches
// them via window.VirtualKeyboard / window.CustomLayouts. The whole module lives
// in an IIFE so its internals (state, el, byId, open/close, …) stay private —
// these scripts share one global scope, where a bare top-level `function open`
// would clobber window.open and generic names risk a fatal duplicate-const
// collision.
(function () {
'use strict';

// ---------------------------------------------------------------------------
// Physical keyboard the editor draws. Rather than maintain its own grid, the
// editor CLONES the live on-screen keyboard markup (#virtualKeyboard
// .keyboard-body) so its styling, per-key widths, row stagger and imperial-vs-
// compact structure match the layout being cloned exactly. renderKeyboard walks
// the clone's .key[data-key] nodes and attaches the editor's binding behaviour.
//
// data-key holds the physical key each cap represents. Bindable keys carry a
// glyph binding; the special modifier keys (Tab/CapsLock/Enter/Backspace) carry
// none and are shown DISABLED so the row stagger stays faithful. Shift is the
// exception among modifiers: it carries no binding but is interactive, because
// clicking it toggles the edited layer (both Shift caps in the clone do this).
// A key's shifted form (the SHIFT layer) is derived from its token via shiftOf.
// ---------------------------------------------------------------------------
const SHIFT_KEY_TOKEN = 'Shift';  // matches on-screen keyboard's data-key="Shift"

// data-key values of the non-bindable modifier caps in virtual-keyboard.html.
// They are kept in the clone (present-but-disabled) purely for correct stagger;
// Shift is handled separately (it toggles the layer), so it is not listed here.
const SPECIAL_KEYS = new Set(['Tab', 'CapsLock', 'Enter', 'Backspace']);

// The shift-layer token for an unshifted key token — delegated to the library's
// ONE canonical map (CustomLayouts.shiftedTokenOf) so the editor's shift forms and
// the coverage computation can't drift. Space (no shift form) resolves to null.
function shiftOf(token) {
    return window.CustomLayouts.shiftedTokenOf(token);
}

// ---------------------------------------------------------------------------
// Canonical Shavian glyph inventory: the standard Shavian block
// (U+10450..U+1047F), the period and the naming dot, plus the six VS1 (U+FE00)
// variants the font draws distinctly: 𐑺︀ yeah, 𐑻︀ oeuvre, 𐑒︀ loch, 𐑜︀ argh,
// 𐑢︀ which, 𐑤︀ llan. custom-layouts.js derives its optional-VS1 target set from
// this list, so it stays the one place those variants are named. Display order
// for the popup palette is separate — see PALETTE_DISPLAY.
// ---------------------------------------------------------------------------
const PALETTE_COLUMNS = 10;

const SHAVIAN_PALETTE = [
    // consonants
    '𐑐', '𐑚', '𐑑', '𐑛', '𐑒', '𐑒︀', '𐑜', '𐑜︀', '𐑓', '𐑝', '𐑔', '𐑞',
    '𐑕', '𐑟', '𐑖', '𐑠', '𐑗', '𐑡', '𐑘', '𐑢', '𐑢︀', '𐑙', '𐑣',
    '𐑤', '𐑤︀', '𐑮', '𐑥', '𐑯',
    // simple vowels
    '𐑦', '𐑰', '𐑧', '𐑱', '𐑨', '𐑭', '𐑩', '𐑳', '𐑪', '𐑴',
    '𐑫', '𐑵', '𐑬', '𐑶', '𐑲', '𐑷',
    // r-coloured vowels + yew (the "compounds"); 𐑺/𐑻 each followed by their
    // VS1 variant (𐑺︀ "yeah", 𐑻︀ "oeuvre").
    '𐑸', '𐑹', '𐑺', '𐑺︀', '𐑻', '𐑻︀', '𐑼', '𐑽', '𐑾', '𐑿',
    // period and naming dot — both are required bindings (see REQUIRED_CHARS).
    '.', '·',
];

// Palette display order. Rows 1-4 are the first 40 block letters in codepoint
// order: Unicode encodes the ten tall (voiceless) consonants then their ten deep
// (voiced) partners, an offset of exactly +10 = the row width, so a ten-wide grid
// stands each voiceless letter directly above its voiced partner — the reader key
// from Androcles and the Lion. Row 5 is the eight compounds; row 6 is the six VS1
// variants then the period and the naming dot. Both tail rows are short and the
// grid left-aligns them (see .le-palette in layout-editor.css).
// First glyph of each short tail row — the cells that must start a fresh row.
const PALETTE_ROW_STARTS = { compounds: '𐑸', vs1: '𐑺︀' };

const PALETTE_DISPLAY = (function buildPaletteDisplay() {
    const order = [];
    for (let cp = 0x10450; cp < 0x10450 + 4 * PALETTE_COLUMNS; cp++) order.push(String.fromCodePoint(cp));
    for (let cp = 0x10450 + 4 * PALETTE_COLUMNS; cp <= 0x1047F; cp++) order.push(String.fromCodePoint(cp));
    order.push('𐑺︀', '𐑻︀', '𐑒︀', '𐑜︀', '𐑢︀', '𐑤︀', '.', '·');
    const inventory = new Set(SHAVIAN_PALETTE);
    if (order.length !== inventory.size || order.some(g => !inventory.has(g))) {
        throw new Error('Layout editor: palette display order does not match the glyph inventory.');
    }
    return order;
})();

// ---------------------------------------------------------------------------
// Editor state. Held in a module-level object for the lifetime of one open
// session; `open()` resets it. `keys` is the live binding map (token -> glyph),
// `ligRows` is the working list of {a, b, result} pairs.
// `editingSlug` is the slug when the loaded base is an existing custom layout
// (Save overwrites it, Delete is offered), or null when cloning a built-in.
// ---------------------------------------------------------------------------
const state = {
    keys: {},                 // token -> glyph (both layers, keyed by shifted token)
    ligRows: [],              // [{ a, b, result }]
    layer: 'main',            // 'main' | 'shift' — which legend drop-drag edits
    editingSlug: null,        // slug when editing an existing custom layout, else null
    // Unsaved-edits flag. Set true by any model edit (bind/clear/ligature change,
    // name edit), cleared on load and after a successful save. Drives the header's
    // "unsaved changes" note and the Back/close dirty check.
    dirty: false,
    // Host container the editor renders into (VIEW 2 of the vk dialog) and the
    // callback that returns the dialog to VIEW 1 (roster). Supplied by open().
    host: null,
    onExit: null,
    base: null,               // built-in this layout descends from (its structural
                              //   family); captured at clone time, carried through
                              //   save/export/import. See structuralFamilyOf.
    // The slot a physical key press writes into, or null. One of:
    //   { kind: 'key', bindToken }            a keyboard key (current layer)
    //   { kind: 'lig', rowIdx, field }        a ligature slot ('a'|'b'|'result')
    // Set by clicking a key/slot or by Arrow/Tab navigation; cleared on Escape,
    // save, or losing the target.
    focusTarget: null,
    // Cached reference to the editable #leGlyphInput. Held because the renderer
    // moves it into a focused key/slot, and the next render orphans it (wiping
    // that host) — an orphan is unreachable by getElementById but the reference
    // survives, and syncGlyphInput always re-appends it. Set in open().
    glyphInput: null,
};

// The order ligature slots occupy in one row, and the reading order Tab/Arrow
// navigation walks them in (a -> b -> result -> next row's a; and back).
const LIG_SLOT_ORDER = ['a', 'b', 'result'];

// ---------------------------------------------------------------------------
// DOM helpers.
// ---------------------------------------------------------------------------
function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
        for (const [k, v] of Object.entries(props)) {
            if (k === 'class') {
                node.className = v;
            } else if (k === 'text') {
                node.textContent = v;
            } else if (k === 'dataset') {
                Object.assign(node.dataset, v);
            } else if (k.startsWith('on') && typeof v === 'function') {
                node.addEventListener(k.slice(2), v);
            } else {
                node.setAttribute(k, v);
            }
        }
    }
    for (const child of children || []) {
        node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
}

function byId(id) {
    return document.getElementById(id);
}

// ---------------------------------------------------------------------------
// Library access. The editor is library code: it resolves everything it needs
// from window.VirtualKeyboard / window.CustomLayouts directly, rather than
// through injected host callbacks.
// ---------------------------------------------------------------------------

// Override for the keyboard template source (tests supply a fixture). null =
// query the live keyboard body. The editor CLONES this to build its canvas, so
// its styling/structure match the real keyboard exactly. See renderKeyboard.
let templateSource = null;

function setTemplateSource(fn) {
    templateSource = fn;
}

// The keyboard body to clone: the test override if set, else the live
// #virtualKeyboard .keyboard-body the library rendered in init.
function getTemplate() {
    return templateSource
        ? templateSource()
        : document.querySelector('#virtualKeyboard .keyboard-body');
}

// Resolve any layout id (built-in or custom:) to its bare layout data.
function getLayoutData(id) {
    return window.VirtualKeyboard._internal.getKeyboardLayoutData(id);
}

// ---------------------------------------------------------------------------
// The vk-as-glyph-picker. The editor re-shows the library's own on-screen
// keyboard and repoints tapped keys at #leGlyphInput, so a user without a
// Shavian keyboard can tap glyphs to bind them. Library-owned and ALWAYS
// offered (no host show-vk gate — this is the editor's keyboard, not the game's
// vk preference). Shown on open and toggled by Cmd/Ctrl+K thereafter; it doubles
// as a live preview of the layout under edit, which the popup palette is not.
//
// GAME SAFETY: setupPicker keyboard-enables the editor's own inputs;
// teardownPicker MUST release them on EVERY close path so the game's vk is never
// left inserting into a dialog that has gone away. teardownPicker is called
// unconditionally by close().
// ---------------------------------------------------------------------------
// Where #virtualKeyboard normally lives, so teardownPicker can put it back. A
// top-layer <dialog> (showModal) and its ::backdrop paint above ALL normal-flow
// z-index, so the vk left in <body> gets dimmed by the editor's backdrop. Moving
// it INTO the dialog subtree makes it a top-layer descendant, above ::backdrop.
let pickerVkHomeParent = null;
let pickerVkHomeNext = null;

// Detaches the library's keystroke interception from #leGlyphInput.
let stopInterception = null;

// Detaches it from the keyboard-enabled metadata fields (one per field).
let stopMetadataInterception = [];

function promoteVkAboveBackdrop() {
    const vk = document.getElementById('virtualKeyboard');
    const dialog = document.getElementById('vk-settings-dialog');
    if (!vk || !dialog || vk.parentNode === dialog) return;   // no top-layer dialog (extension), or already promoted
    pickerVkHomeParent = vk.parentNode;
    pickerVkHomeNext = vk.nextSibling;
    dialog.appendChild(vk);
}

function restoreVkHome() {
    if (!pickerVkHomeParent) return;
    const vk = document.getElementById('virtualKeyboard');
    if (vk) pickerVkHomeParent.insertBefore(vk, pickerVkHomeNext);
    pickerVkHomeParent = null;
    pickerVkHomeNext = null;
}

// Point the library's keyboard at the editor's input and lift it above the
// dialog, WITHOUT showing it: the editor opens with it hidden (it overlaps the
// very caps being edited, and the palette covers tap-to-pick), but Cmd/Ctrl+K
// must find it already wired so it types into the editor the moment it appears.

// Ligatures the picker folds tapped keys against: the layout UNDER EDIT, not the
// active one — a ligature just defined here must fold immediately. Rows still
// being filled in are skipped: a '' component matches everything.
function pickerFoldLigatures() {
    return rowsToLigatures(state.ligRows.filter(isCompleteLigRow));
}

function setupPicker() {
    const vk = window.VirtualKeyboard;
    vk.setFoldLigatures(pickerFoldLigatures);
    // Keyboard-enable the glyph input: physical typing gets latin->glyph
    // translation and folding against that same table (so typed and tapped
    // components fold alike), and tapped keys reach it while it holds focus.
    // Registration, not a pinned destination — the metadata fields below are
    // keyboard-enabled too, and taps must follow whichever the user is in.
    stopInterception = vk.enableInterception(byId('leGlyphInput'));
    stopMetadataInterception = KEYBOARD_ENABLED_METADATA_INPUTS.map(
        (id) => vk.enableInterception(byId(id))
    );
    document.body.classList.add('le-picker-open');
    promoteVkAboveBackdrop();
}

function teardownPicker() {
    const vk = window.VirtualKeyboard;
    if (stopInterception) {   // close() also runs on a dialog never opened into the editor
        stopInterception();
        stopInterception = null;
    }
    stopMetadataInterception.forEach((stop) => stop());
    stopMetadataInterception = [];
    vk.setFoldLigatures(null);          // game safety: back to the active layout's ligatures
    restoreVkHome();
    document.body.classList.remove('le-picker-open');
    vk.hide();                          // returning to the settings modal, which hides the vk
}

// ---------------------------------------------------------------------------
// Popup glyph palette. Tapping a key cap or ligature slot pops a compact grid of
// every Shavian glyph up beside that target; tapping one binds it. This is the
// primary input path on touch, where there is no physical Shavian keyboard and
// the full on-screen keyboard is a poor fit for a small screen.
//
// It opens on POINTER interaction only — someone who tabbed or arrowed here is
// typing, and a palette under their hands is noise. See pointerOpensPalette.
//
// Positioning: fixed to the viewport, on whichever side of the target (above or
// below) has more room, so it is never clipped by the dialog's scrolling body.
// It is appended to the dialog itself rather than the scroll box for the same
// reason, and because a top-layer <dialog> paints above all normal-flow z-index
// (the same constraint promoteVkAboveBackdrop works around).
// ---------------------------------------------------------------------------
const PALETTE_VIEWPORT_MARGIN = 8;   // px kept clear of the viewport edges

// The open palette element, or null. Module-level because dismissal is driven
// from several places (outside tap, Escape, focus move, close).
let paletteEl = null;

// Whether the CURRENT focus change came from a pointer. Set by the pointerdown
// that precedes the click, and consumed by setFocusTarget — distinguishing
// pointer- from keyboard-initiated focus by the event that caused it rather
// than by sniffing the device.
let focusFromPointer = false;

function markPointerFocus() {
    focusFromPointer = true;
}

// The element the palette anchors to: whichever key cap or slot is rendered
// focused. Null when the focused target's surface isn't rendered yet.
function focusedTargetEl() {
    for (const host of renderHosts()) {
        const found = host.querySelector('.le-focus');
        if (found) return found;
    }
    return null;
}

// The container the palette is appended to: the settings dialog when the editor
// runs inside one (so a top-layer dialog's ::backdrop can't cover it), else the
// body. Positioning is viewport-fixed either way.
function paletteContainer() {
    return byId('vk-settings-dialog') || document.body;
}

function buildPaletteEl() {
    const grid = el('div', { class: 'le-palette', role: 'group',
        'aria-label': t('vkEditorPaletteLabel', 'Choose a glyph') });
    grid.style.setProperty('--le-palette-columns', String(PALETTE_COLUMNS));
    const glyphBtn = glyph => el('button', {
        class: 'le-palette-glyph', type: 'button', text: glyph,
        onclick: () => pickGlyph(glyph),
    });
    // The two tail rows (compounds, then VS1 + punctuation) are shorter than the
    // grid is wide, so each becomes its own full-width strip that centres its own
    // glyphs — a shared grid column can only align them all alike.
    for (const glyph of PALETTE_DISPLAY) {
        if (glyph === PALETTE_ROW_STARTS.compounds || glyph === PALETTE_ROW_STARTS.vs1) {
            grid.appendChild(el('div', { class: 'le-palette-tail-row' }));
        }
        const tail = grid.lastElementChild;
        const row = tail && tail.classList.contains('le-palette-tail-row') ? tail : grid;
        row.appendChild(glyphBtn(glyph));
    }
    return grid;
}

// Place the palette beside `anchorEl`, on whichever side has more room, clamped
// horizontally into the viewport. Fixed positioning, so the measurements are
// viewport coordinates throughout.
function positionPalette(anchorEl) {
    const anchor = anchorEl.getBoundingClientRect();
    const palette = paletteEl.getBoundingClientRect();
    const roomAbove = anchor.top - PALETTE_VIEWPORT_MARGIN;
    const roomBelow = window.innerHeight - anchor.bottom - PALETTE_VIEWPORT_MARGIN;
    const below = roomBelow >= roomAbove;
    const top = below ? anchor.bottom + PALETTE_VIEWPORT_MARGIN
                      : anchor.top - palette.height - PALETTE_VIEWPORT_MARGIN;
    const maxLeft = window.innerWidth - palette.width - PALETTE_VIEWPORT_MARGIN;
    const left = Math.max(PALETTE_VIEWPORT_MARGIN,
        Math.min(anchor.left + anchor.width / 2 - palette.width / 2, maxLeft));
    paletteEl.style.top = Math.max(PALETTE_VIEWPORT_MARGIN, top) + 'px';
    paletteEl.style.left = left + 'px';
    paletteEl.dataset.side = below ? 'below' : 'above';
}

function openPalette() {
    closePalette();
    const anchorEl = focusedTargetEl();
    if (!anchorEl) {
        return;  // target not rendered (mid-open) — nothing to anchor to
    }
    paletteEl = buildPaletteEl();
    paletteContainer().appendChild(paletteEl);
    positionPalette(anchorEl);
    document.addEventListener('pointerdown', onPalettePointerDown, true);
}

function closePalette() {
    if (!paletteEl) {
        return;
    }
    document.removeEventListener('pointerdown', onPalettePointerDown, true);
    if (paletteEl.parentNode) paletteEl.parentNode.removeChild(paletteEl);
    paletteEl = null;
}

function isPaletteOpen() {
    return paletteEl !== null;
}

// A pointerdown anywhere outside the palette dismisses it. Capture phase, so it
// runs before the key/slot click handlers — tapping ANOTHER target closes this
// palette, and that target's own click then opens a fresh one.
function onPalettePointerDown(ev) {
    if (paletteEl && !paletteEl.contains(ev.target)) {
        closePalette();
    }
}

// Bind the tapped glyph to the focused target. The target already hosts the
// editable #leGlyphInput seeded with its binding and selected whole, so writing
// the glyph in and blurring runs the ONE commit path every other input route
// uses (commitFocusTarget) — no second insertion implementation.
function pickGlyph(glyph) {
    if (!state.focusTarget) {
        throw new Error('Layout editor: palette picked a glyph with no focused target.');
    }
    state.glyphInput.value = glyph;
    closePalette();
    clearFocusTarget();
}

// ---------------------------------------------------------------------------
// Open / build.
// ---------------------------------------------------------------------------

// Whether the editor markup has been fetched + injected into the host yet. The
// host is view 2 of the vk dialog, created once per page; the editor injects its
// markup there on first open.
let markupInjected = false;

// Fetch layout-editor.html and inject it into `hostEl` (view 2 of the vk
// dialog), via getResourceUrl so the path resolves under a host's resolver
// (extension). Idempotent — injects at most once; later opens reuse the markup.
async function ensureMarkup(hostEl) {
    if (markupInjected) {
        return;
    }
    const vk = window.VirtualKeyboard;
    const url = vk._internal.getResourceUrl('layout-editor.html');
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Layout editor: could not load markup (${url}): ${response.status}`);
    }
    hostEl.innerHTML = await response.text();
    vk._internal.applyUiStrings(hostEl);   // static data-i18n chrome
    markupInjected = true;
}

// Open the editor LOCKED to `startId` (the custom to edit in place). `opts.host`
// is the container to render into (view 2 of the vk dialog); `opts.onExit`
// returns the dialog to view 1 (roster) — the editor calls it from back()/save().
// Injects the markup on first open, resolves the active layout's input map, loads
// the layout, then shows the vk as a glyph picker. No base picker: new-from-clone
// is a roster action, so the editor only ever edits one existing custom.
async function open(startId, opts) {
    const options = opts || {};
    state.host = options.host || null;
    state.onExit = options.onExit || null;
    if (!state.host) {
        throw new Error('Layout editor: open() needs a host container (opts.host).');
    }
    await ensureMarkup(state.host);
    state.layer = 'main';
    state.focusTarget = null;
    // Cache the editable input up front: loadBase renders (calling syncGlyphInput,
    // which needs it) before the listeners below are attached.
    state.glyphInput = byId('leGlyphInput');
    await loadBase(startId);  // sets keys/ligRows/editingSlug/name/dirty, renders
    // Type-to-fill is the browser's own text editing in #leGlyphInput (which the
    // renderer moves into the focused key/slot). We listen for navigation and for
    // the one-glyph trim; latin translation and ligature folding come from the
    // library's interception (setupPicker), which guarantees one `input` per
    // insertion, already translated and folded, so the trim never sees a
    // half-formed value. Escape-to-deselect stays a document listener so it works
    // even when focus has left the input. Attaching here (not at load) keeps the module
    // loadable under the test harness's document stub.
    state.glyphInput.addEventListener('keydown', onGlyphInputKeydown);
    state.glyphInput.addEventListener('compositionend', onGlyphInputCompositionEnd);
    state.glyphInput.addEventListener('input', onGlyphInputInput);
    // Editing the name is an unsaved change too (commitFocusTarget covers the key
    // + ligature edits). The auto-select also dirties on rename in the field.
    for (const [id, handler] of Object.entries(METADATA_INPUT_HANDLERS)) {
        byId(id).addEventListener('input', handler);
    }
    document.addEventListener('keydown', onEditorKeydown);
    // Wire the library's keyboard to the editor but leave it HIDDEN: it covers
    // the caps being edited, and the palette is the primary input path. Cmd/Ctrl+K
    // brings it in for anyone who wants it (screen space, a physical keyboard).
    setupPicker();
    window.VirtualKeyboard.hide();
}

// Tear the editor down. Called on EVERY close/exit path (back, save, dialog
// close) so the shared listeners + the glyph picker are always released — game
// safety: the vk's destination must never be left pointing at the editor input.
// Detaches listeners, re-parks the editable input, and tears down the picker
// unconditionally. Does NOT touch view visibility — the dialog controller owns
// which view shows.
function close() {
    // Use the CACHED input reference, not getElementById: the renderer moves the
    // input into a focused key, and a later operation can orphan that key's
    // subtree (unreachable by getElementById) while the reference stays valid.
    // See state.glyphInput / syncGlyphInput.
    closePalette();
    const glyphInput = state.glyphInput;
    if (glyphInput) {
        glyphInput.removeEventListener('keydown', onGlyphInputKeydown);
        glyphInput.removeEventListener('compositionend', onGlyphInputCompositionEnd);
        glyphInput.removeEventListener('input', onGlyphInputInput);
        // Re-park the input into a stable, always-present host so the next open()
        // finds it by id (it may currently sit orphaned inside a former key).
        glyphInput.classList.add('le-glyph-input-parked');
        glyphInput.value = '';
        const kb = byId('layoutEditorKeyboard');
        if (kb) kb.appendChild(glyphInput);
    }
    mountedTarget = null;
    for (const [id, handler] of Object.entries(METADATA_INPUT_HANDLERS)) {
        const el = byId(id);
        if (el) el.removeEventListener('input', handler);
    }
    document.removeEventListener('keydown', onEditorKeydown);
    state.focusTarget = null;  // don't let a stale target catch the next session's keys
    // Tear down the glyph picker on EVERY close path — game safety.
    teardownPicker();
}

// Mark the working layout dirty (unsaved edits present) and refresh the header
// note. Cheap enough to fire from every edit path; renderEditingLine is a no-op
// beyond a text swap.
function markDirty() {
    if (!state.dirty) {
        state.dirty = true;
        renderEditingLine();
    }
}

// Whether the editor holds unsaved edits — the dirty check the dialog controller
// consults before letting Back/close leave the editor.
function isDirty() {
    return state.dirty;
}

// Whether a key/ligature slot is currently focused for typing. The dialog's
// Escape guard consults this: a focused target's Escape should DESELECT (handled
// by the editor's own keydown), not trigger the leave-editor dirty check.
function hasFocusTarget() {
    return state.focusTarget !== null;
}

// Wrapper-metadata field -> the input authoring it. The ONE mapping the load,
// save and teardown paths share, so a new label can't be wired into one and
// forgotten in another.
const METADATA_INPUTS = {
    displayName: 'layoutEditorName',
    description: 'layoutEditorDescription',
    shavianDisplayName: 'layoutEditorShavianName',
    shavianDescription: 'layoutEditorShavianDescription',
};

// Input id -> its `input` handler. The name fields also refresh the editing line,
// which tracks whichever name the active script shows, and enforce the name cap.
const METADATA_INPUT_HANDLERS = {
    layoutEditorName: onNameInput,
    layoutEditorDescription: markDirty,
    layoutEditorShavianName: onNameInput,
    layoutEditorShavianDescription: markDirty,
};

// Metadata fields the on-screen keyboard types into (the editor dogfooding the
// library's own opt-in). layoutEditorName is the deliberate exception: the Latin
// name is the layout's identity — it drives the slug and the download filename —
// so it stays on the OS keyboard whatever script the rest of the dialog accepts.
const KEYBOARD_ENABLED_METADATA_INPUTS = [
    'layoutEditorDescription',
    'layoutEditorShavianName',
    'layoutEditorShavianDescription',
];

// Read the authored metadata out of the inputs, trimmed. Every field is
// legitimately empty, so none is validated here — save() validates the Latin
// name alone, since that is the layout's identity.
function readMetadataInputs() {
    const metadata = {};
    for (const [field, id] of Object.entries(METADATA_INPUTS)) {
        metadata[field] = byId(id).value.trim();
    }
    return metadata;
}

// Name field edited: hold it to the cap, mark dirty, and refresh the editing line
// so "Editing: <name>" tracks the field live.
// A composition in progress is exempt: trimming mid-composition would fight the
// input method (same discipline as onGlyphInputInput).
function onNameInput(ev) {
    if (!ev.isComposing) {
        capNameInput(ev.target);
    }
    state.dirty = true;
    renderEditingLine();
}

// Hold a name input to the shared name cap. Counted in graphemes, not
// `maxlength`'s UTF-16 units, so a Shavian name (surrogate pairs, VS1 clusters)
// gets the same number of LETTERS as a Latin one rather than half.
function capNameInput(input) {
    const cap = window.VirtualKeyboard._internal.NAME_CAP_GRAPHEMES;
    const graphemes = toGraphemes(input.value);
    if (graphemes.length <= cap) {
        return;
    }
    const atEnd = input.selectionStart === input.value.length;
    input.value = graphemes.slice(0, cap).join('');
    if (atEnd) {
        input.selectionStart = input.selectionEnd = input.value.length;
    }
}

// Load a layout into the editor for edit-in-place. Always a custom id here (the
// roster only opens existing customs / fresh clones the roster just saved).
// Throws on a non-pair ligature the editor can't represent — fail loud rather
// than silently dropping it on the next save.
async function loadBase(id) {
    const data = await getLayoutData(id);
    if (!data || !data.keys) {
        throw new Error(`Could not load layout "${id}".`);
    }
    const isCustom = id.indexOf('custom:') === 0;
    state.editingSlug = isCustom ? id.slice('custom:'.length) : null;
    // Capture the structural ancestor: a custom carries its own `base` (keep
    // pointing at the original built-in); cloning a built-in makes that built-in
    // the base. A custom missing a base (older record) leaves base null, which
    // the resolver treats as the default family.
    state.base = isCustom ? (data.base || null) : id;
    state.keys = Object.assign({}, data.keys);
    state.ligRows = ligaturesToRows(data.ligatures || {});
    state.focusTarget = null;  // the target referenced a row/key of the old base
    state.dirty = false;       // a freshly-loaded layout has no unsaved edits

    // Straight from the RECORD, not the picker's script-aware label: the editor
    // authors each field, so each input must show its own field verbatim. A
    // built-in clone and any field a record never carried both load as ''.
    const record = isCustom ? window.CustomLayouts.getCustomLayout(id) : null;
    const metadata = window.CustomLayouts.layoutMetadata(record);
    for (const [field, inputId] of Object.entries(METADATA_INPUTS)) {
        byId(inputId).value = metadata[field];
    }
    setStatus('');
    renderEditingLine();
    renderLayerButtons();
    renderKeyboard();
    renderLigatures();
    renderCoverage();
}

// Flatten a ligatures table { result: [[a,b],...] } into editor rows. The
// editor only authors pairs, so a non-pair spelling can't be represented;
// throw rather than silently drop it (fail-fast — losing a binding on save
// would be worse than refusing to open).
function ligaturesToRows(ligatures) {
    const rows = [];
    for (const [result, pairs] of Object.entries(ligatures)) {
        for (const pair of pairs) {
            if (!Array.isArray(pair) || pair.length !== 2) {
                throw new Error(
                    `This layout has a non-pair ligature for "${result}" ` +
                    `(${Array.isArray(pair) ? pair.length : '?'} components). ` +
                    `The editor only supports pairs — edit it as JSON instead.`);
            }
            rows.push({ a: pair[0], b: pair[1], result: result });
        }
    }
    return rows;
}

// Switch the edited layer and refresh the keyboard + the toggle highlight. The
// editor owns this so reopening always reflects state.layer (reset to 'main' in
// open), not whatever the buttons were last left showing.
function setLayer(layer) {
    state.layer = layer;
    renderLayerButtons();
    renderKeyboard();
}

// Reflect state.layer on the Main/Shift toggle buttons.
function renderLayerButtons() {
    const main = byId('leLayerMain');
    const shift = byId('leLayerShift');
    if (main) main.classList.toggle('le-layer-active', state.layer === 'main');
    if (shift) shift.classList.toggle('le-layer-active', state.layer === 'shift');
}

// Shorthand for the library's UI-string resolver (active script, Latin fallback).
function t(key, fallback, vars) {
    return window.VirtualKeyboard._internal.vkString(key, fallback, vars);
}

// Shorthand for the library's grapheme splitter (see virtual-keyboard.js).
function toGraphemes(text) {
    return window.VirtualKeyboard._internal.toGraphemes(text);
}

// Header line: "Editing: <name>[ · unsaved changes]". The name tracks the live
// name fields in the active script (Latin when the Shavian one is blank); the
// unsaved note appears only while dirty.
function renderEditingLine() {
    const line = byId('leEditingLine');
    if (!line) {
        return;
    }
    const latin = byId('layoutEditorName');
    const shavian = byId('layoutEditorShavianName');
    const name = window.VirtualKeyboard._internal.preferredScriptLabel(
        (latin && latin.value.trim()) || '',
        (shavian && shavian.value.trim()) || ''
    ) || t('vkEditorUntitled', 'untitled');
    let text = t('vkEditorEditingLine', 'Editing: {{name}}', { name: name });
    if (state.dirty) {
        text += ' ' + t('vkEditorUnsaved', '· unsaved changes');
    }
    line.textContent = text;
    line.classList.toggle('le-dirty', state.dirty);
}

// How many missing glyphs to name inline before summarising the rest.
const COVERAGE_NAMED_MISSING_CAP = 14;

// Coverage line: can this layout TYPE the game's required character set? Uses the
// library's ONE canonical alphabet-completeness computation (CustomLayouts.
// coverage) — the same call the roster badge uses — so the line and badge are
// provably equal. Names the missing glyphs so the user knows what to bind. Never
// blocks (an incomplete layout is legitimate mid-edit).
function renderCoverage() {
    const line = byId('leCoverage');
    if (!line) {
        return;
    }
    const cov = window.CustomLayouts.coverage(buildBareLayout());
    const vs1Note = cov.vs1Optional.produced > 0
        ? ' ' + t('vkCovVs1Suffix', '· +{{n}} optional VS1', { n: cov.vs1Optional.produced })
        : '';
    if (cov.missing.length === 0) {
        line.textContent = t('vkCovAllCharsVs1', '✓ all {{n}} characters{{vs1}}',
            { n: cov.required, vs1: vs1Note });
        line.className = 'le-coverage le-coverage-ok';
        return;
    }
    const named = cov.missing.slice(0, COVERAGE_NAMED_MISSING_CAP).join(' ');
    const more = cov.missing.length > COVERAGE_NAMED_MISSING_CAP
        ? ' ' + t('vkCovMoreSuffix', '+{{n}} more', { n: cov.missing.length - COVERAGE_NAMED_MISSING_CAP })
        : '';
    line.textContent = t('vkCovMissingLine', '⚠ {{count}} of {{total}} missing: {{glyphs}}{{more}}{{vs1}}',
        { count: cov.missing.length, total: cov.required, glyphs: named, more: more, vs1: vs1Note });
    line.className = 'le-coverage le-coverage-warn';
}

// Re-apply UI strings to the editor after a live script/dialect change (called by
// the library's refreshUiStrings when the editor view is mounted). Re-stamps the
// static data-i18n chrome and re-renders the string-built dynamic lines.
function refreshStrings() {
    if (!markupInjected) return;
    window.VirtualKeyboard._internal.applyUiStrings(document.getElementById('layoutEditorModal'));
    renderEditingLine();
    renderCoverage();
}

// Back to view 1 (roster) with a dirty check — an accidental Back must not drop
// unsaved edits. Confirms when dirty, then tears down and returns via onExit.
function back() {
    if (state.dirty && !window.confirm(t('vkConfirmDiscard', 'Discard unsaved changes and go back?'))) {
        return;
    }
    close();
    if (state.onExit) {
        state.onExit();
    }
}

// The prefixed id ("custom:<slug>") of the layout open in the editor, or null
// when editing a not-yet-saved layout (no slug to manage). The manage verbs guard
// on this — you can't download/delete an unsaved draft.
function openLayoutId() {
    const CL = window.CustomLayouts;
    return state.editingSlug ? CL.CUSTOM_ID_PREFIX + state.editingSlug : null;
}

// Manage verbs for the open layout — delegate to the library's canonical roster
// helpers (one implementation, exposed via _internal). Delete leaves the editor.
function requireSavedLayout() {
    const id = openLayoutId();
    if (!id) window.alert('Save this layout first, then you can manage it.');
    return id;
}

function download() {
    const id = requireSavedLayout();
    if (id) window.VirtualKeyboard._internal.downloadCustomLayout(id);
}

async function remove() {
    const id = requireSavedLayout();
    if (!id) return;
    const before = window.CustomLayouts.getCustomLayout(id);
    // Await the delete: when the deleted layout was active it applies the host
    // default and notifies BEFORE resolving, so the onExit re-render (showPickerView)
    // below sees the settled fallback layout, not an empty selection.
    await window.VirtualKeyboard._internal.deleteCustomLayout(id);
    // deleteCustomLayout confirms + deletes; if the record is now gone, leave.
    if (before && !window.CustomLayouts.getCustomLayout(id)) {
        close();
        if (state.onExit) state.onExit();
    }
}

// ---------------------------------------------------------------------------
// Type-to-bind. Click a key or ligature slot (or navigate to it with Arrow/Tab)
// to focus it, then TYPE its glyph to fill the target — typing is the ONLY way to
// bind (the drag palette was removed). The focused target hosts the ORDINARY
// editable #leGlyphInput (see open()) and the browser/OS/IME owns everything that
// happens in it: composition, selection, autocorrect, undo, the on-screen vk's
// insertions. We neither observe nor rewrite keystrokes — that interference is
// what split an IME-composed ligature into two glyphs.
//
// Focus SEEDS the input with the target's current binding and selects it whole,
// so typing replaces it by ordinary selection semantics. The value is read and
// committed into the model exactly once, on BLUR (navigating away, Escape, Save,
// close), so a half-composed IME value is never committed. A one-glyph target is
// trimmed in the field as it is typed (see trimFocusedInputToOneGlyph), which is
// display only — the commit still happens once.
// ---------------------------------------------------------------------------

// The value the focused target's editable input currently holds. The library's
// interception has already translated and folded in place, so what is displayed
// is what commits — and with the keyboard hidden latin binds as itself.
function focusedInputValue() {
    return state.glyphInput.value;
}

// Whether the focused target holds exactly one glyph. A key cap does, and so
// does a ligature RESULT — validateLayout demands isSingleGrapheme of both.
// Ligature COMPONENTS (a/b) do not: the validator accepts any non-empty string
// there, and a multi-glyph component is how a triple composes (a row whose
// component is another row's result), so trimming one would destroy that.
function targetHoldsOneGlyph(target) {
    return target.kind === 'key' || target.field === 'result';
}

// Reduce a value to its LAST grapheme, or '' if empty. toGraphemes glues VS1 onto
// its base, so a cluster (𐑻︀) or an IME-composed ligature counts as ONE and
// survives whole. Its notion of a grapheme is what CustomLayouts.isSingleGrapheme
// accepts at Save, so trimming here means a key binding can no longer reach Save
// in a state that fails it.
function lastGrapheme(value) {
    const graphemes = toGraphemes(value);
    return graphemes.length === 0 ? '' : graphemes[graphemes.length - 1];
}

// Trim the focused target's field to one glyph once the input method has
// FINISHED — a key binds one glyph, so a longer value is a slip, and the last
// one typed is what the user meant. Never runs mid-composition: truncating a
// Keyman chain as it builds is exactly the interference 52ed833 removed.
// Rewrites the field in place so what is displayed and what commits agree.
function trimFocusedInputToOneGlyph() {
    const target = state.focusTarget;
    if (!target || !targetHoldsOneGlyph(target)) {
        return;
    }
    const input = state.glyphInput;
    const trimmed = lastGrapheme(input.value);
    if (trimmed === input.value) {
        return;
    }
    input.value = trimmed;
    input.setSelectionRange(trimmed.length, trimmed.length);
}

// compositionend: the input method has finished and delivered its result, so it
// is now safe to trim (see trimFocusedInputToOneGlyph). Per-keystroke trimming
// would truncate a composition in progress.
function onGlyphInputCompositionEnd() {
    trimFocusedInputToOneGlyph();
}

// input: a plain insertion has landed, so the field must already show just the
// one glyph — waiting for the blur commit would let a run of glyphs pile up
// visibly as the user types. The library guarantees one `input` per insertion,
// already translated and folded, whether typed or tapped.
// A composition in progress is exempt — onGlyphInputCompositionEnd trims it once
// the input method delivers.
function onGlyphInputInput(ev) {
    if (ev.isComposing) {
        return;
    }
    trimFocusedInputToOneGlyph();
}

// The binding the focused target currently holds in the model — what the input
// was seeded with, so comparing against it tells us whether the user changed
// anything. Absent key bindings read as '' (the input's empty value).
function focusTargetBinding(target) {
    return target.kind === 'key'
        ? (state.keys[target.bindToken] || '')
        : state.ligRows[target.rowIdx][target.field];
}

// Commit the focused target's edited value into the model. Called on blur only.
// A key with an empty value drops its binding; a non-empty value binds it; a
// ligature component takes the value verbatim (a component may span several
// glyphs). Merely focusing a target and leaving
// without typing is a no-op — the value still matches the binding it was seeded
// with. Does NOT re-render — the caller re-renders once after focus has moved.
function commitFocusTarget() {
    const target = state.focusTarget;
    if (!target) {
        return;
    }
    trimFocusedInputToOneGlyph();  // backstop for a value that never composed
    const value = focusedInputValue();
    if (value === focusTargetBinding(target)) {
        return;  // untouched (or edited back) — nothing to write, nothing to dirty
    }
    if (target.kind === 'key') {
        if (value) {
            state.keys[target.bindToken] = value;
        } else {
            delete state.keys[target.bindToken];
        }
    } else {
        state.ligRows[target.rowIdx][target.field] = value;
    }
    markDirty();
    renderCoverage();  // a key binding changed — refresh the coverage count
}

// Focus a target for typing: commit the PREVIOUS target (its blur), then move to
// the new one and re-render both surfaces so the editable input relocates into it
// (syncGlyphInput seeds + selects its current binding). A pointer-initiated focus
// change also pops the glyph palette open at the new target; a keyboard-initiated
// one (Tab/arrows) does not — see focusFromPointer.
function setFocusTarget(target) {
    const byPointer = focusFromPointer;
    focusFromPointer = false;
    closePalette();   // any focus move dismisses the palette the old target owned
    commitFocusTarget();
    state.focusTarget = target;
    renderKeyboard();
    renderLigatures();
    if (byPointer && target) {
        openPalette();
    }
}

// Deselect (Escape). Escaping out of a ligature row that is still entirely blank
// quietly discards it, so the "+" placeholder the user opened by mistake reverts
// to a "+" instead of leaving an empty row behind. Discarding restores the dirty
// flag to what it was before the row was added: a row that was only ever blank is
// not a change to the layout.
function clearFocusTarget() {
    if (!state.focusTarget) {
        return;
    }
    const blankRowIdx = focusedBlankLigRowIndex();
    setFocusTarget(null);   // commits first, so a typed-in row is no longer blank
    if (blankRowIdx !== null && isBlankLigRow(state.ligRows[blankRowIdx])) {
        removeBlankLigRow(blankRowIdx);
    }
}

function isBlankLigRow(row) {
    return !row.a && !row.b && !row.result;
}

function isCompleteLigRow(row) {
    return Boolean(row.a && row.b && row.result);
}

// The index of the ligature row the focus target sits in, but only while that row
// is blank — otherwise null. Read BEFORE the commit that Escape triggers, so a
// row the user actually typed into is never a candidate for discarding.
function focusedBlankLigRowIndex() {
    const target = state.focusTarget;
    if (!target || target.kind !== 'lig') {
        return null;
    }
    return isBlankLigRow(state.ligRows[target.rowIdx]) ? target.rowIdx : null;
}

// Drop a blank ligature row and undo the dirty flag addLigRow set for it, unless
// something else had already dirtied the layout. Discarding a row that never held
// anything must leave the layout exactly as clean (or as dirty) as it was.
function removeBlankLigRow(rowIdx) {
    state.ligRows.splice(rowIdx, 1);
    state.dirty = dirtyBeforeAddLigRow;
    renderEditingLine();
    renderLigatures();
}

function isFocused(target) {
    const current = state.focusTarget;
    if (!current || current.kind !== target.kind) {
        return false;
    }
    if (target.kind === 'key') {
        return current.bindToken === target.bindToken;
    }
    return current.rowIdx === target.rowIdx && current.field === target.field;
}

// The bindToken (active-layer token) of every bindable key, in keyboard reading
// order — left-to-right along each row, top row first — so typing can advance
// from one key to the next. DOM order of the cloned .key[data-key] caps IS
// reading order; a cap is bindable exactly when decorateKeyEl would make it a
// focus target: not Shift, not a disabled modifier (Tab/CapsLock/Enter/
// Backspace), and its active-layer form exists (space has none on the shift
// layer). Derived from a fresh template clone rather than the rendered surface
// so it doesn't depend on the current .le-focus render state.
function bindableKeyTokens() {
    const template = getTemplate();
    if (!template) {
        throw new Error('Layout editor: keyboard template unavailable ' +
            '(no #virtualKeyboard .keyboard-body).');
    }
    const tokens = [];
    for (const keyEl of template.querySelectorAll('.key[data-key]')) {
        const token = keyEl.getAttribute('data-key');
        // Skip the non-bindable caps: Shift (the layer toggle), the disabled
        // modifiers (Tab/CapsLock/Enter/Backspace), and the space bar (not a
        // glyph target). Everything else — letters, punctuation, digits — is in
        // the sequence, in DOM (reading) order.
        if (token === SHIFT_KEY_TOKEN || SPECIAL_KEYS.has(token) || token === ' ') {
            continue;
        }
        const bindToken = activeToken(token);
        if (bindToken !== null) {  // shifted form may not exist (skip on that layer)
            tokens.push(bindToken);
        }
    }
    return tokens;
}

// The full, ordered list of focus targets the editor navigates through: every
// bindable key in reading order, then every ligature slot (a -> b -> result, row
// by row). One continuous sequence, so Tab / arrows walk the whole editor with
// no dead ends between the keyboard and the ligature list.
function orderedFocusTargets() {
    const targets = bindableKeyTokens().map(bindToken => ({ kind: 'key', bindToken }));
    state.ligRows.forEach((_, rowIdx) => {
        for (const field of LIG_SLOT_ORDER) {
            targets.push({ kind: 'lig', rowIdx, field });
        }
    });
    return targets;
}

// Index of the current focus target within orderedFocusTargets, or -1 if none.
function focusTargetIndex(targets) {
    return targets.findIndex(t => isFocused(t));
}

// Move focus by `step` (+1 next, -1 previous) through orderedFocusTargets,
// committing the current target first (via setFocusTarget). This is the ONLY way
// focus moves while typing: there is no auto-advance. Bound to Arrow keys and
// Tab/Shift-Tab.
//
// The forward end of the order IS the last slot of the last ligature row, so
// stepping past it means "the user finished the last pair and wants another":
// add a row and land in it, the same thing the "+" placeholder does. Every other
// overrun clamps.
function navigateFocus(step) {
    const targets = orderedFocusTargets();
    const idx = focusTargetIndex(targets);
    if (idx < 0) {
        return;  // nothing focused (or the target vanished) — nowhere to step from
    }
    const next = idx + step;
    if (next >= targets.length) {
        addLigRow();
        return;
    }
    if (next < 0) {
        return;  // at the start — stay put
    }
    setFocusTarget(targets[next]);
}

// Which way a navigation key moves focus through orderedFocusTargets: +1 to the
// next target, -1 to the previous. Tab/Shift-Tab and the arrow keys all resolve
// to one of these (arrows and Tab share the linear order — simple + predictable).
const FOCUS_STEP_BY_KEY = {
    ArrowRight: 1, ArrowDown: 1,
    ArrowLeft: -1, ArrowUp: -1,
};

// Escape peels exactly ONE layer: the palette if it is open (the target stays
// focused, so typing can carry on), otherwise the focus target. Returns whether
// it consumed the key — false means nothing was open and Escape belongs to the
// dialog. Shared by both Escape handlers so the two can't disagree about the
// order, and so the input's handler and the document's don't peel twice for one
// press (the input's keydown bubbles to the document).
function escapePeelOneLayer() {
    if (isPaletteOpen()) {
        closePalette();
        return true;
    }
    if (state.focusTarget) {
        clearFocusTarget();
        return true;
    }
    return false;
}

// Keydown on #leGlyphInput: TARGET navigation only. Tab/Shift-Tab and the arrow
// keys move between targets (committing the current one first, via
// setFocusTarget); Escape peels one layer. Everything else — typing, Backspace,
// Delete, selection, IME composition — is left entirely to the browser, which
// owns the input's text. Handled keys are prevented so they don't also trigger
// the browser's own Tab focus move.
function onGlyphInputKeydown(ev) {
    if (ev.key === 'Escape') {
        if (escapePeelOneLayer()) {
            ev.preventDefault();
            ev.stopPropagation();  // don't let onEditorKeydown peel a second layer
        }
        return;
    }
    const step = ev.key === 'Tab'
        ? (ev.shiftKey ? -1 : 1)  // Shift-Tab goes back
        : FOCUS_STEP_BY_KEY[ev.key];
    if (step) {
        ev.preventDefault();
        navigateFocus(step);
    }
}

// Document keydown while the editor is open (listener attached only then, so no
// visibility guard is needed): the catch-all for an Escape that never reached
// #leGlyphInput. It peels one layer and swallows the key; with nothing left to
// peel it falls through to the dialog's own close.
// Stays on the BUBBLE phase deliberately: a document-level CAPTURE keydown
// listener suppresses WebKit's native <dialog> Escape close outright, which would
// leave the dialog un-dismissable by Escape.
function onEditorKeydown(ev) {
    if (ev.key === 'Escape' && escapePeelOneLayer()) {
        ev.preventDefault();
        ev.stopPropagation();
    }
}

// ---------------------------------------------------------------------------
// Keyboard rendering. Each key shows the binding for the ACTIVE layer. Dragging
// a palette glyph onto a key binds it; dragging a key's glyph to the tray
// clears it (or to another key copies it — a glyph may sit on several keys).
// Clicking a key focuses it so a physical key press can fill it (see above).
// ---------------------------------------------------------------------------
function renderKeyboard() {
    const template = getTemplate();
    if (!template) {
        // The clone is the editor's entire keyboard surface; without it there is
        // nothing sensible to draw. Fail loud rather than fall back to an empty
        // or hardcoded grid, which would mask a missing-keyboard bug.
        throw new Error('Layout editor: keyboard template unavailable ' +
            '(no #virtualKeyboard .keyboard-body).');
    }
    const clone = template.cloneNode(true);
    // The template is the LIVE keyboard body, so the clone inherits whatever
    // layout-<name> class the active layout stamped on it (e.g. layout-qwerty).
    // That class identifies a layout the editor is NOT necessarily showing; if any
    // structural CSS keys off it, the clone would render the wrong structure. Strip
    // it so the clone's structure is decided solely by the structure-imperial class
    // we set next, from the editor's base — never by the incidental live layout.
    for (const cls of clone.className.split(/\s+/)) {
        if (cls.indexOf('layout-') === 0) clone.classList.remove(cls);
    }
    // Gate the clone's structure (number row + imperial extras) on the base's
    // family, exactly as the live keyboard does. state.base already holds the
    // relevant name — the recorded base of a custom being edited, or the built-in
    // being cloned — so it is the resolver's layoutName directly; a null base
    // (older custom lacking one) resolves to the default 'compact' family.
    const isImperial =
        window.VirtualKeyboard._internal.structuralFamilyOf(state.base) === 'imperial';
    clone.classList.toggle('structure-imperial', isImperial);

    // Decorate every real key cap with the editor's binding behaviour.
    for (const keyEl of clone.querySelectorAll('.key[data-key]')) {
        decorateKeyEl(keyEl, keyEl.getAttribute('data-key'));
    }

    const host = byId('layoutEditorKeyboard');
    host.textContent = '';
    host.appendChild(clone);
    syncGlyphInput();
}

// The two render hosts a focus target can live on: the keyboard surface (keys)
// and the ligature list (slots). syncGlyphInput searches both for the focused
// element, so it doesn't depend on a wrapping modal being queryable.
function renderHosts() {
    return [byId('layoutEditorKeyboard'), byId('layoutEditorLigatures')];
}

// The target #leGlyphInput is currently mounted in, so a re-render of the SAME
// target can re-home the input without re-seeding it from the model and throwing
// away what the user has typed. Null while the input is parked.
let mountedTarget = null;

// The dirty flag as it stood just before the most recent addLigRow, so escaping
// out of a still-blank row can restore it — adding and abandoning an empty row is
// not an edit. See clearFocusTarget / removeBlankLigRow.
let dirtyBeforeAddLigRow = false;

// Move the single editable #leGlyphInput into whichever key/slot is focused so
// its text and the OS's native caret/selection show right in that target; park it
// (off-screen but in the DOM) when nothing is focused. Called at the end of each
// render, since re-rendering rebuilds the surface the input was living in and
// detaches it. The focused element is marked .le-focus by the renderers; for a key
// the input goes into its .key-main (the glyph area), for a slot the slot element
// itself. Re-homing drops focus, so focus is restored after the move.
function syncGlyphInput() {
    // Use the cached reference, not getElementById: once the input has been moved
    // into a key, the next render wipes that key's host and orphans the input —
    // an orphaned node is unreachable by getElementById, but the reference stays
    // valid, and we always re-append it below.
    const input = state.glyphInput;
    const keyboardHost = byId('layoutEditorKeyboard');
    if (!state.focusTarget) {
        input.classList.add('le-glyph-input-parked');
        input.value = '';                 // the parked input holds no binding
        mountedTarget = null;
        keyboardHost.appendChild(input);  // park in a stable, always-present host
        return;
    }
    let focusedEl = null;
    for (const host of renderHosts()) {
        focusedEl = host.querySelector('.le-focus');
        if (focusedEl) break;
    }
    if (!focusedEl) {
        // The focused target's surface hasn't been rendered yet (e.g. mid-open).
        // Nothing to mount into; a later render will place the input.
        return;
    }
    const mountPoint = focusedEl.classList.contains('key')
        ? focusedEl.querySelector('.key-main')
        : focusedEl;
    input.classList.remove('le-glyph-input-parked');
    // Seed + select ONLY when the target changed. A re-render of the same target
    // must not clobber what the user (or their IME) has typed since — the input's
    // own text is authoritative until blur.
    const seeding = mountedTarget === null || !isFocused(mountedTarget);
    if (seeding) {
        input.value = focusTargetBinding(state.focusTarget);
    }
    mountedTarget = state.focusTarget;
    mountPoint.appendChild(input);
    input.focus();
    if (seeding) {
        input.select();  // typing replaces the whole binding by ordinary selection
    }
}

// The token whose binding the active layer edits: the base token on the main
// layer, its shifted form on the shift layer. Space has no shift form.
function activeToken(token) {
    return state.layer === 'shift' ? shiftOf(token) : token;
}

// Turn a cloned Shift cap into the layer toggle: it carries no binding, but
// clicking it toggles the edited layer (alongside the Main/Shift buttons —
// reusing setLayer, no duplicated logic) and highlights when the Shift layer is
// active so the user can see which layer their edits land on. Both Shift caps in
// the clone (desktop + mobile) get this treatment.
function decorateShiftKeyEl(keyEl) {
    const active = state.layer === 'shift';
    keyEl.classList.add('le-key-shift-toggle');
    keyEl.classList.toggle('le-shift-active', active);
    keyEl.title = active
        ? 'Editing the Shift layer — click for Main'
        : 'Click to edit the Shift layer';
    keyEl.addEventListener('click', () => setLayer(active ? 'main' : 'shift'));
}

// Decorate a cloned .key cap in place with the editor's behaviour, dispatching
// on `token` (the cap's data-key). Shift toggles the layer; the other special
// modifier caps are shown disabled (present for stagger, not bindable); every
// remaining cap shows the ACTIVE layer's binding and is a drag/drop + click-to-
// focus target. Legends are (re)built here so a re-render reflects state.keys.
function decorateKeyEl(keyEl, token) {
    if (token === SHIFT_KEY_TOKEN) {
        decorateShiftKeyEl(keyEl);
        return;
    }
    if (SPECIAL_KEYS.has(token)) {
        keyEl.classList.add('le-key-disabled');
        return;  // Tab/CapsLock/Enter/Backspace: kept for stagger, not bindable
    }

    const bindToken = activeToken(token);
    const hasShiftLayer = bindToken !== null;  // e.g. space has no shift form
    const glyph = hasShiftLayer ? (state.keys[bindToken] || '') : '';
    const isSpace = token === ' ';
    const focused = hasShiftLayer && isFocused({ kind: 'key', bindToken: bindToken });

    // Rebuild the legends: the dim corner (.key-shift) shows the physical key
    // being bound, .key-main shows its glyph for this layer. The live keyboard's
    // own renderer fills these differently, so replace whatever the clone held.
    // When focused, .key-main is left EMPTY — syncGlyphInput moves the editable
    // input into it, seeded with this glyph and selected whole, so the browser's
    // own editing shows in place. The binding commits on blur.
    keyEl.textContent = '';
    keyEl.appendChild(el('div', {
        class: 'key-shift le-key-cap', text: isSpace ? '␣' : (bindToken || token),
    }));
    keyEl.appendChild(el('div', { class: 'key-main' }, focused ? [] : [glyph]));

    keyEl.classList.toggle('le-focus', focused);
    // Per-key legibility: a bindable-but-unbound cap on this layer gets a
    // dashed/tinted style so the gaps are visible at a glance (round 1). Not while
    // focused — the input sits in the cap then.
    keyEl.classList.toggle('le-key-unbound', hasShiftLayer && !glyph && !focused);

    if (!hasShiftLayer) {
        keyEl.classList.add('le-key-disabled');
        return;  // e.g. space on the shift layer: nothing to bind
    }

    // Click focuses this key so a physical key press fills it (type-to-bind); the
    // pointerdown flags the focus as pointer-initiated, which also pops the palette.
    keyEl.addEventListener('pointerdown', markPointerFocus);
    keyEl.addEventListener('click', () => setFocusTarget({ kind: 'key', bindToken: bindToken }));
}

// ---------------------------------------------------------------------------
// Ligature editor. Each row is A + B -> R; click a slot to focus it, then type
// its glyph. Pairs only: triples are composed via pair + single (a row whose A
// or B is itself another row's result). The Save step validates that each slot
// holds a single glyph and the whole table converges (delegated to
// CustomLayouts.validateLayout).
// ---------------------------------------------------------------------------
function renderLigatures() {
    const host = byId('layoutEditorLigatures');
    host.textContent = '';
    state.ligRows.forEach((row, idx) => {
        host.appendChild(makeLigRowEl(row, idx));
    });
    const addEl = makeLigAddEl();
    if (addEl) {
        host.appendChild(addEl);
    }
    syncGlyphInput();
}

// The "+" placeholder that sits in the grid cell after the last row — where the
// row it creates will appear. Clicking it adds that row and focuses its first
// slot, so the list grows in place. Null until the last row is complete: there is
// nothing to invite while a pair is still half-entered, and stepping off the last
// slot appends a row anyway (see navigateFocus).
function makeLigAddEl() {
    const rows = state.ligRows;
    if (rows.length > 0 && !isCompleteLigRow(rows[rows.length - 1])) {
        return null;
    }
    return el('button', {
        class: 'le-lig-add', text: '+',
        title: t('vkEditorAddPair', 'Add a ligature pair'),
        'aria-label': t('vkEditorAddPair', 'Add a ligature pair'),
        onclick: addLigRow,
    });
}

function makeLigSlot(row, rowIdx, field) {
    const focused = isFocused({ kind: 'lig', rowIdx: rowIdx, field: field });
    // When focused, the slot is left EMPTY — syncGlyphInput moves the editable
    // input into it, seeded with row[field] and selected whole. The slot commits
    // on blur.
    const slot = el('div', {
        class: 'le-slot' + (row[field] ? '' : ' le-slot-empty') + (focused ? ' le-focus' : ''),
    }, focused ? [] : [row[field] || '']);
    // Click focuses this slot so typing lands here (no auto-advance; navigate
    // with Arrow/Tab); the pointerdown also pops the palette (see setFocusTarget).
    slot.addEventListener('pointerdown', markPointerFocus);
    slot.addEventListener('click', () => setFocusTarget({ kind: 'lig', rowIdx: rowIdx, field: field }));
    return slot;
}

function makeLigRowEl(row, idx) {
    return el('div', { class: 'le-lig-row' }, [
        makeLigSlot(row, idx, 'a'),
        el('span', { class: 'le-lig-op', text: '+' }),
        makeLigSlot(row, idx, 'b'),
        el('span', { class: 'le-lig-op', text: '→' }),
        makeLigSlot(row, idx, 'result'),
        el('button', {
            class: 'le-lig-del', text: '✕', title: 'remove this pair',
            // Deleting a row shifts indices, which would leave focusTarget.rowIdx
            // pointing at the wrong (or a removed) row — clear it to stay honest.
            onclick: () => { state.ligRows.splice(idx, 1); state.focusTarget = null; markDirty(); renderLigatures(); },
        }),
    ]);
}

function addLigRow() {
    dirtyBeforeAddLigRow = state.dirty;
    state.ligRows.push({ a: '', b: '', result: '' });
    markDirty();
    // Focus the new row's first slot so the user can type the pair immediately.
    // The ligature list now renders inline (no inner scroll box), so the new row
    // is in normal dialog flow and needs no scrollIntoView — the dialog's own
    // scroll container handles reaching it.
    setFocusTarget({ kind: 'lig', rowIdx: state.ligRows.length - 1, field: LIG_SLOT_ORDER[0] });
}

// ---------------------------------------------------------------------------
// Save. Assemble the bare layout, validate, hand off. Fail-fast: validation
// errors surface verbatim and nothing is persisted.
// ---------------------------------------------------------------------------

// Fold the working rows back into a ligatures table { result: [[a,b],...] }.
// Drops fully-empty rows (a convenience the user can leave lying around);
// partial rows are kept so validation flags them rather than silently vanishing.
// Exact-duplicate pairs under the same result are collapsed — cloning a layout
// and re-saving must not let identical pairs accumulate.
function rowsToLigatures(rows) {
    const out = {};
    for (const row of rows) {
        if (!row.a && !row.b && !row.result) {
            continue;
        }
        if (!out[row.result]) {
            out[row.result] = [];
        }
        const already = out[row.result].some(p => p[0] === row.a && p[1] === row.b);
        if (!already) {
            out[row.result].push([row.a, row.b]);
        }
    }
    return out;
}

function buildBareLayout() {
    const bare = {
        keys: Object.assign({}, state.keys),
        ligatures: rowsToLigatures(state.ligRows),
    };
    // Emit base only when known — a null/absent base is a valid "default family"
    // record, and validateLayout rejects a non-string base, so we must not write
    // base: null. See structuralFamilyOf's layoutName fallback.
    if (state.base) {
        bare.base = state.base;
    }
    return bare;
}

// Surface a save-blocking error inline (Save is the only writer, and it leaves
// the editor on success — so the status line only ever carries failures).
function setStatus(message) {
    const elx = byId('layoutEditorStatus');
    if (!message) {
        elx.style.display = 'none';
        elx.textContent = '';
        return;
    }
    elx.textContent = message;
    elx.style.color = '#d9534f';
    elx.style.display = 'block';
}

// Save the working layout — the editor's single CTA. On a clean save it persists
// and returns to view 1 (roster). All validation failures surface inline and keep
// the editor open.
function save() {
    // A target still focused holds its value in the editable input — Save is a
    // blur, so commit it before assembling the layout.
    commitFocusTarget();
    const metadata = readMetadataInputs();
    // Enforce leaderboard-safe naming at creation so a custom row (which stores
    // this name verbatim) is clean. Fail fast rather than silently mangling. Only
    // the LATIN name is checked — it alone is the layout's identity.
    const nameError = window.validatePlayerName(metadata.displayName);
    if (nameError) {
        setStatus(nameError);
        return;
    }
    // Editor-level pair check: every non-empty ligature row must have all three
    // slots filled. (Pairs only — triples are composed via pair + single.) This
    // gives a friendlier message than validateLayout's empty-component error.
    for (const row of state.ligRows) {
        const filled = [row.a, row.b, row.result].filter(Boolean).length;
        if (filled !== 0 && filled !== 3) {
            setStatus('Each ligature needs both inputs and a result. ' +
                'Complete or remove the half-filled pair.');
            return;
        }
    }

    // The same input pair must not map to two different results — the fold would
    // be ambiguous (which result wins?). validateLayout can't catch this: it
    // groups by result, so two distinct results each look well-formed.
    const seenPairs = new Map();  // "a\u0000b" -> result
    for (const row of state.ligRows) {
        if (!row.a || !row.b || !row.result) {
            continue;
        }
        const key = row.a + '\u0000' + row.b;
        const prior = seenPairs.get(key);
        if (prior !== undefined && prior !== row.result) {
            setStatus(`The pair ${row.a}+${row.b} maps to both "${prior}" and ` +
                `"${row.result}". A pair can only form one ligature.`);
            return;
        }
        seenPairs.set(key, row.result);
    }

    const bare = buildBareLayout();
    try {
        window.CustomLayouts.validateLayout(bare);
    } catch (e) {
        setStatus(e.message);
        return;
    }
    // Persist through the library's own store, then leave: the saved layout is
    // committed, so there is nothing left to keep the editor open for.
    Promise.resolve(persist(bare, metadata, state.editingSlug))
        .then(savedSlug => {
            state.editingSlug = savedSlug;
            state.dirty = false;
            close();
            if (state.onExit) {
                state.onExit();
            }
        })
        .catch(e => setStatus('Could not save: ' + (e && e.message ? e.message : e)));
}

// Persist a bare layout through the library's CustomLayouts store. `metadata` is
// the authored label set (each field may be ''), never folded into `bare`. `slug`
// is set when overwriting an existing custom in place (keep slug + createdAt,
// bump updatedAt), null when saving a fresh one. Evicts the stale keyboard cache
// and, if the saved layout is the ACTIVE one, fires onLayoutsChanged with
// activeChanged so the host re-applies it (word lists etc.). Returns the saved
// slug so the editor can switch into edit-in-place mode.
async function persist(bare, metadata, slug) {
    const CL = window.CustomLayouts;
    const vk = window.VirtualKeyboard;
    let record;
    if (slug) {
        const existing = CL.getCustomLayout(slug);
        record = Object.assign({}, existing, metadata, {
            layout: bare,
            updatedAt: new Date().toISOString(),
        });
    } else {
        record = CL.makeCustomLayoutRecord(bare, metadata);
    }
    CL.saveCustomLayout(record);

    const savedId = CL.CUSTOM_ID_PREFIX + record.name;
    vk._internal.invalidateLayoutCache(savedId);
    const activeChanged = vk.getLayout() === savedId;
    vk._internal.notifyLayoutsChanged({ activeChanged: activeChanged });
    return record.name;
}

window.LayoutEditor = {
    open: open,
    close: close,
    save: save,
    back: back,
    download: download,
    remove: remove,
    refreshStrings: refreshStrings,
    isDirty: isDirty,
    hasFocusTarget: hasFocusTarget,
    setLayer: setLayer,
    // exposed for tests
    _state: state,
    _setTemplateSource: setTemplateSource,  // test hook: supply a keyboard fixture
    _renderKeyboard: renderKeyboard,
    _buildBareLayout: buildBareLayout,
    _rowsToLigatures: rowsToLigatures,
    _pickerFoldLigatures: pickerFoldLigatures,
    _ligaturesToRows: ligaturesToRows,
    _onGlyphInputKeydown: onGlyphInputKeydown,
    _onEditorKeydown: onEditorKeydown,
    _addLigRow: addLigRow,
    _setFocusTarget: setFocusTarget,
    _commitFocusTarget: commitFocusTarget,
    _navigateFocus: navigateFocus,
    _orderedFocusTargets: orderedFocusTargets,
    _bindableKeyTokens: bindableKeyTokens,
    _capNameInput: capNameInput,
    _trimFocusedInputToOneGlyph: trimFocusedInputToOneGlyph,
    _onGlyphInputCompositionEnd: onGlyphInputCompositionEnd,
    _onGlyphInputInput: onGlyphInputInput,
    _closePalette: closePalette,
    _isPaletteOpen: isPaletteOpen,
    _markPointerFocus: markPointerFocus,
    _pickGlyph: pickGlyph,
    _makeLigAddEl: makeLigAddEl,
    SHAVIAN_PALETTE: SHAVIAN_PALETTE,
    _PALETTE_DISPLAY: PALETTE_DISPLAY,
    _PALETTE_COLUMNS: PALETTE_COLUMNS,
};

})();
