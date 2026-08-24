// Shaw Keys Functionality

import { CustomLayouts } from './custom-layouts.js';
import { LayoutEditor } from './layout-editor.js';

// Cache-busting value, read from this module's own URL query string (?v=...).
const SHAW_KEYS_VERSION = new URL(import.meta.url).searchParams.get('v') || '';

// Optional URL resolver callback for browser extensions
let resourceUrlResolver = null;

// Resolver for user-created custom layouts. dataFn(id) -> bareLayoutObject|null
// for ids of the form "custom:<slug>"; nameFn(id) -> display name|null.
// Defaults self-register against the library's own CustomLayouts store, so a
// host needs no wiring. A host (e.g. an extension) can replace either via
// setCustomLayoutResolver.
let customLayoutResolver = (id) => CustomLayouts.getCustomLayoutData(id);
let customDisplayNameResolver = (id) => customLayoutLabel(id);

// Optional callback when keyboard state changes (visibility, position, layout)
let onStateChange = null;

// Host subscribers notified after the library's set of layouts changes — a
// custom layout saved/deleted in the editor, or the active layout switched for a
// library-internal reason (first-save activation, delete-fallback). The game
// registers one to repopulate its layout dropdown and re-apply the active layout
// (word lists etc.). `activeChanged` tells it whether the current layout moved.
const layoutsChangedListeners = [];

function onLayoutsChanged(callback) {
    layoutsChangedListeners.push(callback);
}

// The host's default built-in layout, applied when the ACTIVE custom is deleted.
// The library persists this fallback synchronously in rosterDelete BEFORE notifying
// so every picker re-render (dialog onExit + embedded refreshMount) reads a settled,
// existing layout — otherwise a re-render racing the host's async apply shows an
// empty selection. null until the host sets it; rosterDelete requires it then.
let hostDefaultLayout = null;
function setDefaultLayout(layoutId) {
    if (!isBuiltInLayoutName(layoutId)) {
        throw new Error(`setDefaultLayout: ${layoutId} is not a built-in layout`);
    }
    hostDefaultLayout = layoutId;
}

// Fire the layouts-changed event, forwarding the caller's detail object to every
// listener. Shape: { activeChanged, activeRemoved? } — activeChanged is true when
// the active layout switched as part of this change (so the host re-applies);
// activeRemoved is true when the active layout was deleted (host falls back to
// its default).
function notifyLayoutsChanged(detail) {
    for (const listener of layoutsChangedListeners) {
        listener(detail);
    }
}

// Optional predicate; when it returns true the keyboard suppresses its global
// keydown handling (focus-steal, key highlighting, shift tracking). The host app
// uses this to silence the keyboard while a modal dialog is open, without the
// keyboard module needing to know about the app's modals.
let suppressKeydownPredicate = null;

function setSuppressKeydownPredicate(predicate) {
    suppressKeydownPredicate = predicate;
}

function shouldSuppressKeydown() {
    return typeof suppressKeydownPredicate === 'function' && suppressKeydownPredicate();
}

// Where tapped keys insert, in precedence order:
//   1. An explicit setDestination() override, for a host that must pin taps to
//      one field regardless of focus.
//   2. The keyboard-enabled element that most recently held focus, so tapped keys
//      follow the caret the way a physical keyboard does.
//   3. #typingInput, the practice input shaw-type has always relied on.
let destinationInputEl = null;

function setDestination(el) {
    // Insertion drives either .value/selectionStart or the live Selection, so the
    // destination must be one of those two kinds. Fail here rather than silently
    // no-op later.
    if (el !== null && !isEditableDestination(el)) {
        throw new Error('setDestination requires an <input>, <textarea> or contenteditable element');
    }
    destinationInputEl = el;
}

// Elements that opted in, and the last one focused. Registration is what
// enableInterception already performs for physical typing; tracking focus over
// that set is what lets tapped keys reach the same fields with no further call.
// A WeakSet so a removed element (the editor rebuilds its dialog) is collectable.
const keyboardEnabledEls = new WeakSet();
let focusedEnabledEl = null;
let destinationFocusListenerAttached = false;

// Taps land in whatever the host declared keyboard-enabled and the user focused.
// Bound once, lazily: a host that never registers anything keeps the old
// #typingInput behaviour and pays for no listener.
function trackDestinationFocus() {
    if (destinationFocusListenerAttached) return;
    document.addEventListener('focusin', (e) => {
        if (keyboardEnabledEls.has(e.target)) {
            focusedEnabledEl = e.target;
        }
    });
    destinationFocusListenerAttached = true;
}

// Registered elements are tap destinations from the moment they are registered,
// including one already focused when the host wired it up (hosts attach on
// focusin, so the field that triggered it is focused before this runs).
function registerKeyboardEnabled(el) {
    keyboardEnabledEls.add(el);
    trackDestinationFocus();
    if (document.activeElement === el) {
        focusedEnabledEl = el;
    }
}

function unregisterKeyboardEnabled(el) {
    keyboardEnabledEls.delete(el);
    if (focusedEnabledEl === el) {
        focusedEnabledEl = null;
    }
}

// A destination must still be in the document: hosts tear dialogs down without
// unregistering, and inserting into a detached node writes into nothing.
function getDestinationInput() {
    if (destinationInputEl) {
        return destinationInputEl;
    }
    if (focusedEnabledEl && document.contains(focusedEnabledEl)) {
        return focusedEnabledEl;
    }
    return document.getElementById('typingInput');
}

// The ligature table tapped keys fold against. Default: the ACTIVE layout's, so
// the keyboard emits the same compound a physical keystroke would. The editor
// overrides it with the layout UNDER EDIT (whose rows are unsaved and are not
// the active layout), so a ligature just defined folds immediately.
let foldLigaturesProvider = null;

function setFoldLigatures(provider) {
    if (provider !== null && typeof provider !== 'function') {
        throw new Error('setFoldLigatures expects a function or null');
    }
    foldLigaturesProvider = provider;
}

// Component->compound table for tapped-key folding. An empty table folds nothing.
function getTapFoldTable() {
    if (foldLigaturesProvider) {
        return getComponentToLigature({ ligatures: foldLigaturesProvider() });
    }
    return getComponentToLigature(KEYBOARD_MAPS[currentLayoutName]);
}

// A tap has no browser event behind it, so unlike an intercepted keystroke it
// must strip `readonly` around the write itself. The caller's synthetic input
// event still reports the RAW glyph as e.data even when insertion folded it into
// a compound: that is the keystroke the user made, and a host with its own input
// pipeline (the game) tracks components from it for backspace-splitting.
function insertTappedGlyph(input, glyph) {
    withEditableInput(input, () => insertGlyphAtCaret(input, glyph, true));
}

function deleteTappedGlyph(input) {
    withEditableInput(input, () => deleteBackwardAtCaret(input));
}

// Auto-show keyboard when editable content has focus
let autoShowOnFocus = false;
let focusListenerAttached = false;

// Whether the host's input pipeline currently forms ligatures, so the live
// preview only arms keys when completing a ligature would actually do something.
// The host (which owns the input pipeline) keeps this in sync via
// setLigaturePreviewActive().
let ligaturePreviewActive = false;

function setLigaturePreviewActive(active) {
    ligaturePreviewActive = active;
    if (!active) {
        clearLigaturePreview();
    }
}

// Track current layout name
let currentLayoutName = null;

// Canonical registry of the built-in layout IDS, in menu order — the single
// source of truth for which layouts are built in, and the order they appear in.
// It deliberately carries NO names: a layout names itself, in the same metadata
// fields a custom layout uses, so no surface needs a built-in special case.
const BUILT_IN_LAYOUT_IDS_IN_MENU_ORDER = [
    'imperial', 'igc', 'qwerty', '2layer', 'jafl',
];

// The built-in ids as a Set for O(1) membership tests.
const BUILT_IN_LAYOUT_IDS = new Set(BUILT_IN_LAYOUT_IDS_IN_MENU_ORDER);

// Longest custom layout name, in GRAPHEMES (not UTF-16 units — a Shavian letter
// is a surrogate pair, a VS1 variant two codepoints). Custom names reach the
// leaderboard verbatim, so the editor caps what is typed and cloneName truncates
// to fit; both measure with toGraphemes so one policy has one counter.
const NAME_CAP_GRAPHEMES = 20;

// U+FE00 VARIATION SELECTOR-1, glued onto a Shavian base to name a VS1 variant
// (𐑺︀ "yeah", 𐑻︀ "oeuvre"). This is exactly how the rest of the app carries such
// a glyph — a bare JS string of base codepoint + U+FE00 (see custom-layouts.js's
// isSingleGrapheme), so binding one this way round-trips identically through
// validateLayout and save. Named for the shared global scope: the site's main.js
// already owns a top-level `VS1`.
const VS1_VARIATION_SELECTOR = '︀';

// The ligature suppressor. A key may bind it alone, or prefixed to one letter
// ("⁞𐑩" on JAFL's shift+D), and it means: whatever precedes me must not
// combine with whatever follows me. It is a fold BARRIER, not text — the fold
// pass consumes it, because the player types against target text that contains
// none, and a retained one would mismatch every target on the first suppressed
// letter. See docs/decisions.md, "The ligature suppressor".
const LIGATURE_SUPPRESSOR = '⁞';

// Typographic quotes an OS or editor substitutes for the ASCII key the user
// actually pressed, mapped back to that key. Layouts bind the physical keys
// ' and " (U+0027, U+0022); macOS "smart quotes" and equivalents rewrite a
// keystroke to U+2018/U+2019/U+201C/U+201D before it reaches beforeinput, so a
// lookup on the delivered character misses and the quote binds as itself —
// which is why the apostrophe key rendered 𐑛 but typed '. Key legends are
// stamped from the layout's own tokens and were never affected.
const SUBSTITUTED_QUOTE_KEYS = {
    '‘': "'",
    '’': "'",
    '“': '"',
    '”': '"'
};

function physicalKeyFor(typedText) {
    return SUBSTITUTED_QUOTE_KEYS[typedText] || typedText;
}

// Split text into GRAPHEMES, not codepoints, so a VS1 variant (base + U+FE00) or
// an IME-composed cluster counts as ONE unit rather than being torn apart. The
// library's one grapheme counter: the editor's key bindings and name inputs and
// cloneName's truncation all measure with it. Intl.Segmenter is the correct tool
// where available; the fallback covers exactly the app's real case (a base +
// U+FE00), gluing a trailing U+FE00 onto the preceding codepoint. No other
// combining marks occur in Shavian input, so a fuller cluster algorithm would be
// dead weight.
function toGraphemes(text) {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
        return Array.from(segmenter.segment(text), part => part.segment);
    }
    const graphemes = [];
    for (const codePoint of Array.from(text)) {  // Array.from splits on codepoints
        if (codePoint === VS1_VARIATION_SELECTOR && graphemes.length > 0) {
            graphemes[graphemes.length - 1] += codePoint;  // glue onto the base
        } else {
            graphemes.push(codePoint);
        }
    }
    return graphemes;
}

// The built-ins as {id, displayName}, for hosts building a layout picker.
// Requires the layouts to be loaded — see preloadBuiltInLayouts.
function listBuiltInLayouts() {
    return BUILT_IN_LAYOUT_IDS_IN_MENU_ORDER.map(id => ({
        id,
        displayName: layoutDisplayName(id),
    }));
}

// A built-in layout's own metadata, read from the loaded layout. Throws rather
// than degrading to the id — an id on screen is the defect this replaced.
function builtInLayoutMetadata(layoutId) {
    const layout = KEYBOARD_MAPS[layoutId];
    if (!layout) {
        throw new Error(`Layout ${layoutId} is not loaded; cannot resolve its name`);
    }
    if (!layout.displayName || !layout.displayName.trim()) {
        throw new Error(`Layout ${layoutId} carries no displayName`);
    }
    return layout;
}

// A built-in layout's name in LATIN, whatever script the UI is in — safe to
// store or slugify, unlike a script-dependent label.
function builtInLatinName(layoutId) {
    return builtInLayoutMetadata(layoutId).displayName;
}

// THE name-resolution point for every layout and every surface — title bar,
// picker, editor, clone-base list — so a change to one can never miss another.
function layoutDisplayName(layoutId) {
    if (!isBuiltInLayoutName(layoutId)) {
        const custom = customDisplayNameResolver && customDisplayNameResolver(layoutId);
        if (!custom || !custom.trim()) {
            throw new Error(`Cannot resolve a display name for layout ${layoutId}`);
        }
        return custom;
    }
    const layout = builtInLayoutMetadata(layoutId);
    return preferredScriptLabel(layout.displayName, layout.shavianDisplayName);
}

// Load every built-in layout so the SYNCHRONOUS naming surfaces can read names
// straight from them. Awaited by the async seams that precede a render.
//
// Throws if any built-in is absent: loadKeyboardLayout answers a failed fetch
// with null, so without this check a missing file resolves the preload
// successfully and the first naming call throws instead — deep inside a render,
// where the mount seam's catch turns it into a blank panel.
async function preloadBuiltInLayouts() {
    const loaded = await Promise.all(
        BUILT_IN_LAYOUT_IDS_IN_MENU_ORDER.map(id => loadKeyboardLayout(id)));
    const missing = BUILT_IN_LAYOUT_IDS_IN_MENU_ORDER.filter((id, i) => !loaded[i]);
    if (missing.length > 0) {
        throw new Error(`Built-in layouts failed to load: ${missing.join(', ')}`);
    }
}

// ---------------------------------------------------------------------------
// Dialog UI strings (bilingual). The library SHIPS its own sk* tables
// (translations_{latin,british,american}.json beside this file, generated from
// translations.csv) and loads them via setScript. A host with its own pipeline
// may override them with setUiStrings. Resolution order, highest first:
//   1. host override (setUiStrings active, then its base)
//   2. the library's own table for the selected script/dialect
//   3. the hardcoded English fallback passed to each skString call
// The library renders keys into its OWN dialog DOM using the SAME
// key→textContent pattern as the host's updateUIWithTranslations. One pipeline.
// ---------------------------------------------------------------------------

// Host override: { active, base } — the active-script table and a base table
// filling keys the active one lacks. Empty until the host calls setUiStrings.
let uiStrings = { active: {}, base: {} };

// The library's own table for the current script/dialect, loaded by setScript.
let libraryStrings = {};

// Which script the library renders in ('latin' until the host says otherwise).
// Drives the user-authored Shavian labels on custom layouts, which no string
// table can carry.
let libraryScript = 'latin';

const SK_TRANSLATION_FILES = {
    latin: 'translations_latin.json',
    british: 'translations_british.json',
    american: 'translations_american.json',
};

// Look up a UI string by key, walking the resolution order above.
// {{token}} placeholders are filled from `vars`.
function skString(key, fallback, vars) {
    let text = (uiStrings.active && uiStrings.active[key] != null)
        ? uiStrings.active[key]
        : (uiStrings.base && uiStrings.base[key] != null ? uiStrings.base[key]
            : (libraryStrings[key] != null ? libraryStrings[key] : fallback));
    if (text == null) text = fallback != null ? fallback : key;
    if (vars) {
        for (const [name, value] of Object.entries(vars)) {
            text = text.split('{{' + name + '}}').join(value);
        }
    }
    return text;
}

// Apply the UI strings to a subtree: [data-i18n] -> textContent,
// [data-i18n-title] -> title attr, [data-i18n-placeholder] -> placeholder attr.
// The SAME id/key→element idea as the host's updateUIWithTranslations, via an
// attribute so JS-built and static elements share one applier.
// Nothing uses [data-i18n-placeholder] today (the editor's name/description
// placeholders are fixed literals — each one's SCRIPT signals what it expects);
// kept so the three attributes stay one symmetric contract.
function applyUiStrings(root) {
    if (!root) return;
    root.querySelectorAll('[data-i18n]').forEach(el => {
        el.textContent = skString(el.getAttribute('data-i18n'), el.textContent);
    });
    root.querySelectorAll('[data-i18n-title]').forEach(el => {
        el.title = skString(el.getAttribute('data-i18n-title'), el.title);
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        el.placeholder = skString(el.getAttribute('data-i18n-placeholder'), el.placeholder);
    });
}

// Re-apply strings to every currently-mounted Shaw Keys surface (the dialog + any
// embedded mount) and re-render the dynamic bits (picker list, editor). Called by
// setUiStrings so a live script/dialect change updates open surfaces immediately.
function refreshUiStrings() {
    document.querySelectorAll('#sk-settings-dialog, [data-sk-group]').forEach(root => {
        applyUiStrings(root);
    });
    // Dynamic content (rows, coverage, editor line) is rebuilt from skString, so
    // re-render the mounted pickers and the editor if open.
    document.querySelectorAll('[data-sk-group]').forEach(container => {
        if (container.querySelector('#sk-layout-list')) {
            renderPickerList(container);
            // The base-picker overlay is rebuilt from skString each time it opens
            // (openBasePicker/listCloneBases), so no persistent relabel here.
        }
    });
    const dialogTitle = document.querySelector('#sk-dialog-title');
    if (dialogTitle) dialogTitle.textContent = skString(
        isEditorViewActive() ? 'skEditorTitle' : 'skDialogTitle', dialogTitle.textContent);
    const dialogBack = document.querySelector('#sk-dialog-back');
    if (dialogBack) dialogBack.textContent = skString('skDialogBack', dialogBack.textContent);
    LayoutEditor.refreshStrings();
    // The docked keyboard title tracks the active script too — retitle in place
    // (no full relabel; that needs the layout map, reloaded elsewhere on switch).
    const kbTitle = document.querySelector('.keyboard-title');
    if (kbTitle && currentLayoutName) {
        kbTitle.textContent = layoutDisplayName(currentLayoutName);
    }
}

// Public: OVERRIDE the dialog's UI strings with the host's own tables, taking
// precedence over the library's shipped ones. `active` is the current-script
// table; `base` fills any sk* key the active table doesn't carry. Re-applies to
// open surfaces.
function setUiStrings(active, base) {
    uiStrings = { active: active || {}, base: base || active || {} };
    refreshUiStrings();
}

// Public: select the script/dialect the library renders its OWN UI in, loading
// the matching shipped table. script: 'latin' | 'shavian'; dialect (shavian
// only): 'british' | 'american'. Re-applies to open surfaces.
async function setScript(script, dialect) {
    const file = script === 'shavian'
        ? SK_TRANSLATION_FILES[dialect]
        : SK_TRANSLATION_FILES[script];
    if (!file) throw new Error(`Unknown Shaw Keys script/dialect: ${script}/${dialect}`);

    const url = getResourceUrl(file);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to load ${file}: ${response.status}`);
    libraryStrings = await response.json();
    libraryScript = script;
    refreshUiStrings();
}

// A layout's label in the ACTIVE script, falling back to the Latin one when the
// Shavian counterpart is blank — Latin is canonical, so a layout is never
// unidentifiable. Built-ins and customs both resolve through here: they carry the
// same metadata shape (LAYOUT_METADATA_FIELDS), so neither needs a special case.
function preferredScriptLabel(latin, shavian) {
    return libraryScript === 'shavian' && shavian && shavian.trim() ? shavian : latin;
}

// A custom layout's display name in the active script, or null when `id` names
// no known custom. The single name-resolution point for every Shaw Keys surface, so the
// picker, the clone-base list and the docked title can't disagree.
function customLayoutLabel(id) {
    const CL = CustomLayouts;
    const latin = CL.getCustomLayoutDisplayName(id);
    return latin === null
        ? null
        : preferredScriptLabel(latin, CL.getCustomLayoutShavianDisplayName(id));
}

// Compact one-line descriptions for the picker detail panel, keyed by built-in id.
// (Trimmed from the old multi-sentence panel copy — the live preview now carries
// the visual detail the screenshots used to.)
// Built-in id -> { key, en }: the description's translation key + its English
// fallback (so it still reads before the sk* keys are regenerated into Shavian).
const LAYOUT_DESCRIPTIONS = {
    'imperial': { key: 'skDescImperial', en: 'The original Imperial Good Companion typewriter layout, with every compound on its own key.' },
    'igc': { key: 'skDescIgc', en: 'Imperial, made compact: most compounds are built from their parts rather than given a key.' },
    'qwerty': { key: 'skDescQwerty', en: 'Familiar QWERTY positions — easiest transition from an existing habit.' },
    '2layer': { key: 'skDesc2layer', en: 'Compact: Shift reaches the full set, related glyphs paired on a key.' },
    'jafl': { key: 'skDescJafl', en: 'Just Another Friggin’ Layout — key placement tuned for English letter frequency.' },
};

// Built-in layouts whose physical shape is the imperial family (a distinct row
// geometry). Every other built-in is "compact". This set is the single place
// that decides which base names are imperial-structured; the resolver below is
// the only reader. Keyed by base name (not a boolean flag on each layout) so a
// future layout can declare its structure by naming the built-in it descends
// from — see structuralFamilyOf.
const IMPERIAL_STRUCTURE_BASES = new Set(['imperial', 'igc']);

// Resolve a layout's structural family — the single source of truth for the
// imperial-vs-compact split that rendering keys off. A custom layout records the
// built-in it was cloned from as `layout.base`; built-ins carry no base, so we
// fall back to their own name. Unknown names collapse to 'compact' (the default
// geometry) rather than throwing: validation (custom-layouts.validateLayout) is
// what rejects an unknown base, so by the time a layout reaches here its base is
// already known-good or deliberately absent.
function structuralFamilyOf(layoutName, layout) {
    const base = (layout && layout.base) || layoutName;
    return IMPERIAL_STRUCTURE_BASES.has(base) ? 'imperial' : 'compact';
}

// Whether `name` is a known built-in layout — the authoritative check that
// validateLayout uses to reject a custom layout's unknown `base`.
function isBuiltInLayoutName(name) {
    return BUILT_IN_LAYOUT_IDS.has(name);
}

// Get current keyboard state
function getKeyboardState() {
    const keyboard = document.getElementById('shawKeys');
    const isVisible = keyboard && keyboard.style.display !== 'none';
    const settings = loadShawKeysSettings();

    return {
        visible: isVisible,
        layout: settings.layout,
        position: { ...keyboardPosition }
    };
}

// Notify state change if callback is set
function notifyStateChange() {
    if (onStateChange) {
        onStateChange(getKeyboardState());
    }
}

// Get resource URL - uses custom resolver if provided (for browser extensions)
function getResourceUrl(relativePath) {
    if (resourceUrlResolver) {
        return resourceUrlResolver(relativePath);
    }
    return versionedUrl(new URL(relativePath, import.meta.url).href);
}

// Add version parameter to URL for cache busting
function versionedUrl(url) {
    if (SHAW_KEYS_VERSION) {
        const separator = url.includes('?') ? '&' : '?';
        return `${url}${separator}v=${SHAW_KEYS_VERSION}`;
    }
    return url;
}

// Initialize Shaw Keys - loads HTML and sets up
// Parameters:
//   containerElement - DOM element to contain the keyboard
//   resourceVersion - version string (unused, kept for compatibility)
//   urlResolver - optional function(relativePath) => absoluteUrl for browser extensions
//   options - optional object with configuration:
//     - autoShowOnFocus: boolean - automatically show/hide keyboard based on input focus
//     - script: 'latin' | 'shavian' - which shipped UI-string table to load
//     - dialect: 'british' | 'american' - dialect for script: 'shavian'
async function initShawKeys(containerElement, resourceVersion, urlResolver, options) {
    // Set the resolver if provided
    if (urlResolver) {
        resourceUrlResolver = urlResolver;
    }

    // Handle options
    if (options) {
        if (options.autoShowOnFocus) {
            autoShowOnFocus = true;
        }
        // Outside the catch below: a bad script or an unreachable table is a real
        // failure, not the "keyboard HTML didn't load" degrade.
        if (options.script) {
            await setScript(options.script, options.dialect);
        }
    }

    try {
        const url = getResourceUrl('shaw-keys.html');
        const response = await fetch(url);
        if (!response.ok) {
            console.error('Failed to load Shaw Keys HTML');
            return false;
        }
        const html = await response.text();
        containerElement.innerHTML = html;

        // Now that the HTML is loaded, make it draggable
        makeKeyboardDraggable();

        // Attach close button handler programmatically (inline onclick may not work in extensions)
        const closeButton = document.querySelector('.keyboard-close');
        if (closeButton) {
            closeButton.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                hideShawKeys();
            });
        }

        // Set up auto-show/hide on focus if requested
        if (autoShowOnFocus && !focusListenerAttached) {
            setupAutoShowOnFocus();
            focusListenerAttached = true;
        }

        return true;
    } catch (error) {
        console.error('Error loading Shaw Keys:', error);
        return false;
    }
}

// True if the element is a text-editable field (an input, textarea, or
// contenteditable). Used to decide whether to show the keyboard and whether to
// steal focus back to the practice input.
function isEditableElement(el) {
    return !!el && (
        (el.tagName === 'INPUT' && ['text', 'search', 'email', 'url', 'tel'].includes(el.type)) ||
        el.tagName === 'TEXTAREA' ||
        el.isContentEditable
    );
}

// Set up listeners to auto-show/hide keyboard based on input focus
function setupAutoShowOnFocus() {
    console.log('[Shaw Keys] Setting up auto-show on focus');

    // Use event delegation on document for better performance
    document.addEventListener('focusin', (e) => {
        if (isEditableElement(e.target)) {
            console.log('[Shaw Keys] Editable element focused, showing keyboard');
            showShawKeys();
        }
    }, true); // Use capture phase

    document.addEventListener('focusout', (e) => {
        // If focus is moving to another editable element, keep the keyboard up
        if (!isEditableElement(e.relatedTarget)) {
            // Small delay to allow focus to settle
            setTimeout(() => {
                // Double-check that no editable element has focus
                if (!isEditableElement(document.activeElement)) {
                    console.log('[Shaw Keys] No editable element focused, hiding keyboard');
                    hideShawKeys();
                }
            }, 10);
        }
    }, true); // Use capture phase
}

// Keyboard layouts - loaded from JSON
// Keyboard layout cache (lazy loaded)
let KEYBOARD_MAPS = {};

// Lazy load a keyboard layout
async function loadKeyboardLayout(layoutName) {
    // Check if already loaded
    if (KEYBOARD_MAPS[layoutName]) {
        return KEYBOARD_MAPS[layoutName];
    }

    // Custom layouts come from the host's resolver, not the server. Fail fast:
    // a custom id that doesn't resolve is a real error (e.g. a deleted layout),
    // so throw rather than mimicking the built-in path's catch-and-return-null.
    if (layoutName.startsWith('custom:')) {
        if (!customLayoutResolver) {
            throw new Error(`No custom layout resolver registered for ${layoutName}`);
        }
        const data = customLayoutResolver(layoutName);
        if (!data) {
            throw new Error(`Custom layout not found: ${layoutName}`);
        }
        KEYBOARD_MAPS[layoutName] = data;
        return data;
    }

    // Load from server - use getResourceUrl for correct path resolution
    try {
        const url = getResourceUrl(`keyboard_layout_${layoutName}.json`);
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to load layout ${layoutName}: ${response.status}`);
        }
        const data = await response.json();

        // Cache it
        KEYBOARD_MAPS[layoutName] = data;
        return data;
    } catch (error) {
        console.error(`Failed to load keyboard layout ${layoutName}:`, error);
        return null;
    }
}

// Get a keyboard layout (async - lazy loads if needed)
async function getKeyboardLayout(layoutName) {
    return await loadKeyboardLayout(layoutName);
}

// An ALREADY-LOADED layout's data, for the synchronous paths that cannot await:
// a host's per-keystroke ligature lookup runs inside an `input` handler, where
// awaiting would reorder text mutation against the browser's own processing.
// Throws rather than returning empty — a layout absent here means the caller
// skipped the async load (setLayout/preloadBuiltInLayouts), and answering with
// no ligatures would silently spell words wrong instead.
function loadedLayout(layoutName) {
    const layout = KEYBOARD_MAPS[layoutName];
    if (!layout) {
        throw new Error(`Layout ${layoutName} is not loaded; load it before reading it synchronously`);
    }
    return layout;
}

// Apply a layout to the keyboard (loads, updates labels, makes clickable, updates interception)
async function setKeyboardLayout(layoutName) {
    console.log('[Shaw Keys] Applying layout:', layoutName);

    // Load the layout data FIRST, and only persist the choice once it succeeds —
    // otherwise a failed switch (e.g. a custom layout deleted in another tab)
    // would leave a poisoned saved layout. A custom layout resolves via the host
    // and throws if missing; treat that like the built-in load-failure path.
    let layout;
    try {
        layout = await getKeyboardLayout(layoutName);
    } catch (error) {
        console.error('[Shaw Keys] Failed to load layout:', layoutName, error);
        return false;
    }
    if (!layout || !layout.keys) {
        console.error('[Shaw Keys] Failed to load layout:', layoutName);
        return false;
    }

    // Persist the (now known-good) layout choice.
    saveShawKeysLayout(layoutName);

    // Track current layout
    currentLayoutName = layoutName;

    // Update keyboard display
    updateKeyboardLabels(layout.keys, layoutName, layout);
    makeKeysClickable(layout.keys);

    // Update interception for any active inputs
    setInterceptionLayout(layoutName);

    console.log('[Shaw Keys] Layout applied successfully:', layoutName);
    return true;
}

// Helper: Execute function with input temporarily editable (removes readonly)
function withEditableInput(input, fn) {
    const wasReadonly = input.hasAttribute('readonly');
    if (wasReadonly) input.removeAttribute('readonly');
    try {
        fn();
    } finally {
        if (wasReadonly) input.setAttribute('readonly', 'readonly');
    }
}

// Helper: Set selection safely (ignores errors on readonly inputs)
function setSelectionSafe(input, pos) {
    try {
        input.setSelectionRange(pos, pos);
    } catch (e) {
        // Selection may fail on readonly/unfocused inputs - ignore
    }
}

// Helper: Dispatch input event
function dispatchInputEvent(input, type, data = null) {
    const event = new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: type,
        data: data
    });
    input.dispatchEvent(event);
}

// Translate input event data from Latin to Shavian if needed
// This is a decorator function that index.html can use
// Returns: { eventData: string, browserInput: string }
function translateInputEvent(e, browserInput, currentLayout, useShawKeys, debugFn) {
    let eventData = e.data || '';

    // Shaw Keys: translate QWERTY input to Shavian if needed
    if (useShawKeys && e.inputType === 'insertText' && eventData.length > 0) {
        const layout = KEYBOARD_MAPS[currentLayout];
        const keyboardMap = layout ? layout.keys : null;
        if (keyboardMap) {
            // Check if the input data is a Latin character that needs translation
            const codePoint = eventData.codePointAt(0);
            const isShavian = codePoint >= 0x10450 && codePoint <= 0x1047F;
            const physicalKey = physicalKeyFor(eventData);

            if (!isShavian && keyboardMap[physicalKey]) {
                // Input is Latin and has a mapping - translate it
                const translatedChar = keyboardMap[physicalKey];
                if (debugFn) {
                    debugFn('⌨️  Translating: "' + eventData + '" → "' + translatedChar + '" [' +
                           eventData.split('').map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ') +
                           ' → ' + translatedChar.split('').map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ') + ']');
                }

                // Remove the Latin character that was inserted and replace with Shavian
                const originalLength = eventData.length;
                const selectionPos = e.target.selectionStart;
                const before = browserInput.substring(0, selectionPos - originalLength);
                const after = browserInput.substring(selectionPos);
                browserInput = before + after; // Remove the original character

                eventData = translatedChar;
            }
        }
    }

    return { eventData, browserInput };
}

// Track shift state
let isShiftActive = false;

// Track keyboard position
let keyboardPosition = { x: 0, y: 0 };

// On narrow screens the keyboard is docked to the bottom edge by CSS
// (see the `@media (max-width: 768px)` block in shaw-keys.css, which
// pins it with position:fixed; bottom:0; left:0; right:0). In that docked
// mode the drag transform must NOT displace it, or the top (number) row is
// clipped. This query must stay in sync with that CSS breakpoint.
const KEYBOARD_DOCKED_MEDIA_QUERY = '(max-width: 768px)';
function isKeyboardDocked() {
    return window.matchMedia(KEYBOARD_DOCKED_MEDIA_QUERY).matches;
}

const SK_SETTINGS_KEY = 'io.joro.shaw-keys.Settings';

// The settings key before the library was renamed from "virtual keyboard" to
// Shaw Keys. Deployed installations hold their layout and position under it.
const LEGACY_SETTINGS_KEY = 'io.joro.virtual-keyboard.Settings';

// Move the pre-rename settings to the current key, once. A corrupt legacy value
// raises and is left in place: discarding it would destroy the only copy of the
// user's settings. Only the settings key moved in the rename — `customLayouts`
// is unprefixed and was never renamed, so custom layouts need no migration.
function migrateLegacySettings() {
    const legacy = localStorage.getItem(LEGACY_SETTINGS_KEY);
    if (legacy === null || localStorage.getItem(SK_SETTINGS_KEY) !== null) return;

    const parsed = JSON.parse(legacy);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Legacy settings under ${LEGACY_SETTINGS_KEY} are corrupt (expected a JSON object).`);
    }
    localStorage.setItem(SK_SETTINGS_KEY, legacy);
    localStorage.removeItem(LEGACY_SETTINGS_KEY);
}

migrateLegacySettings();

// Default settings
const SK_DEFAULT_SETTINGS = {
    layout: 'imperial',
    position: { x: 0, y: 0 }
};

// Load keyboard state from localStorage (using unified settings)
function loadKeyboardState() {
    try {
        const saved = localStorage.getItem(SK_SETTINGS_KEY);
        if (saved) {
            const settings = JSON.parse(saved);
            keyboardPosition = settings.position || { x: 0, y: 0 };
        }
    } catch (e) {
        console.error('Failed to load keyboard state:', e);
    }
}

// Save keyboard state to localStorage (using unified settings)
function saveKeyboardState() {
    try {
        const saved = localStorage.getItem(SK_SETTINGS_KEY);
        let settings = SK_DEFAULT_SETTINGS;
        if (saved) {
            settings = { ...SK_DEFAULT_SETTINGS, ...JSON.parse(saved) };
        }
        settings.position = keyboardPosition;
        localStorage.setItem(SK_SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
        console.error('Failed to save keyboard state:', e);
    }
}

// Reset keyboard state (called when Shaw Keys is toggled off)
function resetKeyboardState() {
    keyboardPosition = { x: 0, y: 0 };
    saveKeyboardState(); // Save the reset position
    const keyboard = document.getElementById('shawKeys');
    if (keyboard) {
        updateKeyboardTransform(keyboard);
    }
}

// Update keyboard transform based on current position.
// When docked (narrow screens), CSS owns positioning; applying the drag
// translate here would push the docked keyboard off its bottom anchor and
// clip the top row, so the transform is cleared instead.
function updateKeyboardTransform(el) {
    if (isKeyboardDocked()) {
        el.style.transform = '';
        return;
    }
    el.style.transform = `translate(${keyboardPosition.x}px, ${keyboardPosition.y}px)`;
}

// Make keyboard draggable
function makeKeyboardDraggable() {
    const keyboard = document.getElementById('shawKeys');
    const header = keyboard.querySelector('.keyboard-header');
    let isDragging = false;
    let startX, startY;

    // Apply saved state
    loadKeyboardState();
    updateKeyboardTransform(keyboard);

    header.addEventListener('mousedown', dragStart);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', dragEnd);

    // Touch events for mobile
    header.addEventListener('touchstart', dragStart);
    document.addEventListener('touchmove', drag);
    document.addEventListener('touchend', dragEnd);

    function dragStart(e) {
        // When docked (narrow screens) CSS owns positioning; dragging must be a
        // no-op so an accidental title-bar swipe can't displace/clip the
        // keyboard or mutate keyboardPosition. Bailing here keeps isDragging
        // false, so drag()/dragEnd() also do nothing.
        if (isKeyboardDocked()) {
            return;
        }
        if (e.target === header || header.contains(e.target)) {
            if (e.target.classList.contains('keyboard-close')) {
                return; // Don't drag when clicking close button
            }
            isDragging = true;

            if (e.type === 'touchstart') {
                startX = e.touches[0].clientX - keyboardPosition.x;
                startY = e.touches[0].clientY - keyboardPosition.y;
            } else {
                startX = e.clientX - keyboardPosition.x;
                startY = e.clientY - keyboardPosition.y;
            }
        }
    }

    function drag(e) {
        if (isDragging) {
            e.preventDefault();

            if (e.type === 'touchmove') {
                keyboardPosition.x = e.touches[0].clientX - startX;
                keyboardPosition.y = e.touches[0].clientY - startY;
            } else {
                keyboardPosition.x = e.clientX - startX;
                keyboardPosition.y = e.clientY - startY;
            }

            updateKeyboardTransform(keyboard);
        }
    }

    function dragEnd(e) {
        if (isDragging) {
            isDragging = false;
            notifyStateChange();
        }
    }
}

// Show/hide keyboard - these are now just UI helpers called from main script
function showShawKeys() {
    const keyboard = document.getElementById('shawKeys');
    if (keyboard) {
        keyboard.style.display = 'block';

        // Ensure keyboard is within viewport
        const rect = keyboard.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        // Check if keyboard is outside viewport and adjust position
        let adjusted = false;
        if (keyboardPosition.x + rect.width < 0 || keyboardPosition.x > viewportWidth) {
            // Keyboard is horizontally outside viewport - reset to left edge
            keyboardPosition.x = 0;
            adjusted = true;
        }
        if (keyboardPosition.y + rect.height < 0 || keyboardPosition.y > viewportHeight) {
            // Keyboard is vertically outside viewport - reset to bottom
            keyboardPosition.y = 0;
            adjusted = true;
        }

        if (adjusted) {
            updateKeyboardTransform(keyboard);
        }

        notifyStateChange();
    }
}

function hideShawKeys() {
    const keyboard = document.getElementById('shawKeys');
    if (keyboard) {
        keyboard.style.display = 'none';
        clearLigaturePreview();
        notifyStateChange();
    }
}

function toggleShawKeys() {
    const keyboard = document.getElementById('shawKeys');
    if (keyboard) {
        const isVisible = keyboard.style.display !== 'none';
        if (isVisible) {
            hideShawKeys();
        } else {
            showShawKeys();
        }
    }
}

// Set callback for state changes (replaces old visibility callback)
function setShawKeysStateCallback(callback) {
    onStateChange = callback;
}

// Deprecated: kept for backwards compatibility
function setShawKeysVisibilityCallback(callback) {
    onStateChange = (state) => callback(state.visible);
}

// Render a key's dual-legend structure: a prominent main legend with the
// secondary (shift) legend above it. Single source of truth for the
// dual-legend HTML so the label and ligature-preview paths stay in sync.
function renderKeyLegends(key, mainLegend, shiftLegend) {
    key.innerHTML = `<span class="key-main">${mainLegend}</span><span class="key-shift">${shiftLegend}</span>`;
}

// Update keyboard labels with Shavian characters based on current layout
// Parameters passed from main script to avoid timing issues
function updateKeyboardLabels(keyboardMap, layoutName, layout) {
    // Update keyboard body class for layout-specific styling
    const keyboardBody = document.querySelector('.keyboard-body');
    if (keyboardBody) {
        // Remove all existing layout classes
        keyboardBody.className = keyboardBody.className.replace(/layout-\S+/g, '').trim();
        // Add current layout class (convert to lowercase and remove spaces).
        // Kept for identification/theming; the mobile structural CSS no longer
        // keys off this name — see the structure-imperial class below.
        const layoutClass = 'layout-' + layoutName.toLowerCase().replace(/\s+/g, '-');
        keyboardBody.classList.add(layoutClass);

        // Stamp the structural family so the mobile CSS shows the imperial
        // number row + extra side keys by geometry, not by name. Resolving via
        // structuralFamilyOf means a custom layout cloned from imperial/igc
        // (carrying layout.base) gets the imperial structure, which name-based
        // gating never did (its name is 'custom:<slug>', matching no rule).
        const isImperialStructure =
            structuralFamilyOf(layoutName, layout) === 'imperial';
        keyboardBody.classList.toggle('structure-imperial', isImperialStructure);
    }

    const titleElement = document.querySelector('.keyboard-title');
    if (titleElement) {
        const shiftIndicator = isShiftActive ? ' (Shift)' : '';
        titleElement.textContent = layoutDisplayName(layoutName) + shiftIndicator;
    }

    // Update key labels
    const keys = document.querySelectorAll('.key[data-key]');
    keys.forEach(key => {
        let keyValue = key.getAttribute('data-key');

        // Re-rendering a key's legend invalidates any ligature-preview armed on
        // it, so drop the armed highlight here (e.g. on a shift toggle or layout
        // change). The next keystroke re-arms via refreshLigaturePreview.
        key.classList.remove('armed');

        // Get base character
        const baseChar = keyboardMap[keyValue];

        // Get shifted character
        let shiftedKey = keyValue;
        if (keyValue.length === 1) {
            if (keyValue.match(/[a-z]/)) {
                shiftedKey = keyValue.toUpperCase();
            } else {
                // Map number row and punctuation to their shifted equivalents
                const shiftMap = {
                    '1': '!', '2': '@', '3': '#', '4': '$', '5': '%',
                    '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
                    '`': '~', '-': '_', '=': '+',
                    '[': '{', ']': '}', '\\': '|',
                    ';': ':', '\'': '"',
                    ',': '<', '.': '>', '/': '?'
                };
                if (shiftMap[keyValue]) {
                    shiftedKey = shiftMap[keyValue];
                }
            }
        }
        const shiftChar = keyboardMap[shiftedKey];

        // Special keys (non-character keys)
        const specialKeys = {
            'Backspace': '⌫',
            'Tab': '⇥',
            'CapsLock': '⇪',
            'Enter': '⏎',
            'Shift': '⇧'
        };

        if (specialKeys[keyValue]) {
            // Special keys don't have dual legends
            key.innerHTML = specialKeys[keyValue];
            key.removeAttribute('data-shavian');
            key.removeAttribute('data-shavian-shift');
        } else if (baseChar || shiftChar) {
            // In shift mode the shift legend is the prominent (main) one.
            if (isShiftActive) {
                renderKeyLegends(key, shiftChar || '', baseChar || '');
            } else {
                renderKeyLegends(key, baseChar || '', shiftChar || '');
            }

            // Store both characters as data attributes
            key.setAttribute('data-shavian', baseChar || '');
            key.setAttribute('data-shavian-shift', shiftChar || '');
        } else {
            // No mapping for this key
            key.innerHTML = '';
            key.removeAttribute('data-shavian');
            key.removeAttribute('data-shavian-shift');
        }
    });
}

// ---------------------------------------------------------------------------
// Layout preview — a scaled, non-interactive HTML render of a bare layout, for
// the settings picker and the roster. Reuses the ONE keyboard template (clone of
// #shawKeys .keyboard-body) and the ONE legend renderer (renderKeyLegends)
// so a preview cap is structurally + stylistically identical to the live
// keyboard, minus input. Works for built-ins and customs alike (both are a bare
// { keys } map). Shift-flip is a pure re-stamp of the same clone.
// ---------------------------------------------------------------------------

// The shift-layer physical token for an unshifted one, via CustomLayouts'
// canonical map (so preview shift forms can't drift from the editor's/coverage's).
function previewShiftedToken(token) {
    return CustomLayouts.shiftedTokenOf(token);
}

// Stamp a cloned keyboard body's caps from a bare layout's `keys` map for one
// layer ('base' | 'shift'). Same dual-legend HTML as the live keyboard; special
// caps keep their glyphs. No event wiring — this is display only.
function stampPreviewLayer(clone, bareLayout, layer) {
    const keys = bareLayout.keys || {};
    const specialKeys = { 'Backspace': '⌫', 'Tab': '⇥', 'CapsLock': '⇪', 'Enter': '⏎', 'Shift': '⇧' };
    for (const key of clone.querySelectorAll('.key[data-key]')) {
        const token = key.getAttribute('data-key');
        if (specialKeys[token]) {
            key.innerHTML = specialKeys[token];
            continue;
        }
        const baseChar = keys[token] || '';
        const shifted = previewShiftedToken(token);
        const shiftChar = shifted ? (keys[shifted] || '') : '';
        if (layer === 'shift') {
            renderKeyLegends(key, shiftChar, baseChar);
        } else {
            renderKeyLegends(key, baseChar, shiftChar);
        }
    }
}

// Render a bare layout into `hostEl` as a scaled, non-interactive keyboard for
// `layer`. Clones the live template (fail-fast if absent), gates its structure on
// the layout's family, stamps the layer's legends, and scales the clone to the
// host's width via transform. The scale wrapper reserves the scaled height so the
// preview never overlaps siblings. Returns nothing; re-call to flip layers.
// `layoutName` is required: a BUILT-IN carries no `layout.base`, so its family is
// only resolvable from its name (see structuralFamilyOf).
function renderLayoutPreview(hostEl, layoutName, bareLayout, layer) {
    if (!hostEl) throw new Error('renderLayoutPreview: host element is required');
    if (!layoutName) throw new Error('renderLayoutPreview: layout name is required');
    if (!bareLayout || !bareLayout.keys) {
        throw new Error('renderLayoutPreview: bare layout with keys is required');
    }
    const template = document.querySelector('#shawKeys .keyboard-body');
    if (!template) {
        throw new Error('renderLayoutPreview: keyboard template unavailable ' +
            '(no #shawKeys .keyboard-body).');
    }
    const clone = template.cloneNode(true);
    for (const cls of clone.className.split(/\s+/)) {
        if (cls.indexOf('layout-') === 0) clone.classList.remove(cls);
    }
    const isImperial = structuralFamilyOf(layoutName, bareLayout) === 'imperial';
    clone.classList.toggle('structure-imperial', isImperial);
    clone.classList.add('sk-preview-body');

    stampPreviewLayer(clone, bareLayout, layer);

    hostEl.textContent = '';
    const scaler = document.createElement('div');
    scaler.className = 'sk-preview-scaler';
    scaler.appendChild(clone);
    hostEl.appendChild(scaler);
    // Defer the measure to the next frame: a just-appended clone can report a
    // pre-layout (collapsed) width, which would leave the preview under-filled and
    // never corrected (the ResizeObserver only re-fires on a CONTAINER resize, not
    // on content mount). rAF lets the clone lay out first.
    requestAnimationFrame(() => scalePreviewToWidth(hostEl, scaler, clone));
}

// Upscale cap: a preview may grow to fill a wider host than its natural width, but
// not without limit (a tiny alpha-only layout blown up huge reads badly).
const PREVIEW_MAX_UPSCALE = 2;

// Scale `clone` to FILL the host's available width via a CSS transform. The scaler
// is absolutely positioned (out of flow), so the host takes its width from the
// column, not the keyboard's intrinsic width — we then set the host's HEIGHT to
// the scaled keyboard height so it reserves the right space. Scales down to fit
// AND up to fill (capped by PREVIEW_MAX_UPSCALE) so narrow layouts don't leave big
// side margins on a mobile panel.
function scalePreviewToWidth(hostEl, scaler, clone) {
    const available = hostEl.clientWidth;
    const natural = clone.offsetWidth;
    if (!available || !natural) return;  // not laid out yet; a ResizeObserver re-runs this
    const scale = Math.min(PREVIEW_MAX_UPSCALE, available / natural);
    scaler.style.transform = `scale(${scale})`;
    hostEl.style.height = (clone.offsetHeight * scale) + 'px';
}

// Highlight key when pressed
// keyCode is optional - used to distinguish left/right shift
function highlightKey(keyValue, keyCode) {
    let key;
    if (keyCode) {
        // Try to find by code first (for left/right shift distinction)
        key = document.querySelector(`.key[data-code="${keyCode}"]`);
    }
    if (!key) {
        // Fall back to data-key
        key = document.querySelector(`.key[data-key="${keyValue}"]`);
    }
    if (key) {
        key.classList.add('active');
    }
}

// Remove highlight from key
// keyCode is optional - used to distinguish left/right shift
function unhighlightKey(keyValue, keyCode) {
    let key;
    if (keyCode) {
        // Try to find by code first (for left/right shift distinction)
        key = document.querySelector(`.key[data-code="${keyCode}"]`);
    }
    if (!key) {
        // Fall back to data-key
        key = document.querySelector(`.key[data-key="${keyValue}"]`);
    }
    if (key) {
        key.classList.remove('active');
    }
}


// Update keyboard labels to reflect current shift state
async function updateLabelsForShift() {
    if (currentLayoutName) {
        const layout = await getKeyboardLayout(currentLayoutName);
        if (layout && layout.keys) {
            updateKeyboardLabels(layout.keys, currentLayoutName, layout);
        }
    }
}

// Toggle shift state (when clicking virtual shift key)
async function toggleShift() {
    isShiftActive = !isShiftActive;
    await updateLabelsForShift();
}

// Handle key clicks to type characters
// keyboardMap passed from main script
function makeKeysClickable(keyboardMap) {
    const keys = document.querySelectorAll('.key[data-key]');
    const SLIDE_THRESHOLD = 15; // pixels to slide down before activating shift

    keys.forEach(key => {
        // Remove existing event listeners
        const newKey = key.cloneNode(true);
        key.parentNode.replaceChild(newKey, key);

        // Track touch state for slide-down gesture
        let touchState = {
            active: false,
            startY: 0,
            isSlideDown: false
        };

        // Touch start handler
        newKey.addEventListener('touchstart', (e) => {
            e.preventDefault();
            const keyValue = newKey.getAttribute('data-key');

            // Notify that user is using Shaw Keys (to prevent OS keyboard)
            if (typeof activateVirtualKeyboardMode === 'function') {
                activateVirtualKeyboardMode();
            }

            // Handle shift key specially
            if (keyValue === 'Shift') {
                toggleShift();
                return;
            }

            // Initialize touch state
            touchState.active = true;
            touchState.startY = e.touches[0].clientY;
            touchState.isSlideDown = false;

            // Highlight the key
            highlightKey(keyValue);
        });

        // Touch move handler - detect slide-down gesture
        newKey.addEventListener('touchmove', (e) => {
            if (!touchState.active) return;

            // Only allow slide-down if there's a shift character available
            const shiftChar = newKey.getAttribute('data-shavian-shift');
            if (!shiftChar || shiftChar === '') return;

            const currentY = e.touches[0].clientY;
            const deltaY = currentY - touchState.startY;

            // Check if user has slid down beyond threshold
            if (deltaY > SLIDE_THRESHOLD && !touchState.isSlideDown) {
                touchState.isSlideDown = true;
                newKey.classList.add('slide-down');
            } else if (deltaY <= SLIDE_THRESHOLD && touchState.isSlideDown) {
                // User slid back up - restore to normal
                touchState.isSlideDown = false;
                newKey.classList.remove('slide-down');
            }
        });

        // Touch end handler - type the appropriate character
        newKey.addEventListener('touchend', (e) => {
            if (!touchState.active) return;
            e.preventDefault();

            const keyValue = newKey.getAttribute('data-key');
            const typingInput = getDestinationInput();

            // Remove slide-down class
            newKey.classList.remove('slide-down');

            // Remove highlight
            setTimeout(() => unhighlightKey(keyValue), 150);

            if (!typingInput) {
                touchState.active = false;
                return;
            }

            // Determine which character to type based on slide state and shift layer
            let shavianChar;
            if (touchState.isSlideDown) {
                // Slide-down: type shift character
                shavianChar = newKey.getAttribute('data-shavian-shift');
            } else if (isShiftActive) {
                // Shift layer is showing: use shift character (blank if no mapping)
                shavianChar = newKey.getAttribute('data-shavian-shift');
            } else {
                // Normal: type base character
                shavianChar = newKey.getAttribute('data-shavian');
            }

            if (shavianChar) {
                insertTappedGlyph(typingInput, shavianChar);

                // Trigger input event so the game logic processes it
                dispatchInputEvent(typingInput, 'insertText', shavianChar);

                // Auto-release shift after typing a character
                if (isShiftActive) {
                    isShiftActive = false;
                    if (typeof updateVirtualKeyboardLabels === 'function') {
                        updateVirtualKeyboardLabels();
                    }
                }

            } else if (keyValue === 'Backspace') {
                deleteTappedGlyph(typingInput);
                dispatchInputEvent(typingInput, 'deleteContentBackward');

                // Auto-release shift after backspace
                if (isShiftActive) {
                    isShiftActive = false;
                    if (typeof updateVirtualKeyboardLabels === 'function') {
                        updateVirtualKeyboardLabels();
                    }
                }
            }

            // Reset touch state
            touchState.active = false;
        });

        // Click handler for desktop/mouse users
        newKey.addEventListener('click', (e) => {
            e.preventDefault();
            const keyValue = newKey.getAttribute('data-key');

            // Notify that user is using Shaw Keys (to prevent OS keyboard)
            if (typeof activateVirtualKeyboardMode === 'function') {
                activateVirtualKeyboardMode();
            }

            // Handle shift key specially
            if (keyValue === 'Shift') {
                toggleShift();
                return;
            }

            const typingInput = getDestinationInput();
            if (!typingInput) return;

            // Highlight the key briefly for click feedback
            highlightKey(keyValue);
            setTimeout(() => unhighlightKey(keyValue), 150);

            // Get the Shavian character for this key (use base character for clicks)
            const shavianChar = newKey.getAttribute('data-shavian');

            if (shavianChar) {
                insertTappedGlyph(typingInput, shavianChar);

                // Trigger input event so the game logic processes it
                dispatchInputEvent(typingInput, 'insertText', shavianChar);

                // Auto-release shift after typing a character
                if (isShiftActive) {
                    isShiftActive = false;
                    if (typeof updateVirtualKeyboardLabels === 'function') {
                        updateVirtualKeyboardLabels();
                    }
                }

            } else if (keyValue === 'Backspace') {
                deleteTappedGlyph(typingInput);
                dispatchInputEvent(typingInput, 'deleteContentBackward');

                // Auto-release shift after backspace
                if (isShiftActive) {
                    isShiftActive = false;
                    if (typeof updateVirtualKeyboardLabels === 'function') {
                        updateVirtualKeyboardLabels();
                    }
                }
            }
        });
    });
}

// Initialize keyboard UI
// Note: makeKeyboardDraggable() is called from initShawKeys() after HTML loads
const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

// How the show/hide shortcut is written on this platform, for the host to append
// to its "Show Shaw Keys" label. Not a translated string: it names a
// modifier key, which is platform-dependent and identical in every language.
function toggleShortcutLabel() {
    return isMac ? '⌘K' : 'Ctrl+K';
}

// Set up keyboard shortcut handler (works even if DOMContentLoaded already fired)
function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Cmd+K (Mac) / Ctrl+K (Windows, Linux) toggles the keyboard.
        if (e.key === 'k' && (isMac ? e.metaKey : e.ctrlKey)) {
            e.preventDefault();
            toggleShawKeys();
            return;
        }

        // Stay out of the way while a modal dialog is open (the host decides).
        if (shouldSuppressKeydown()) {
            return;
        }

        const typingInput = document.getElementById('typingInput');

        // If the user presses a key and the practice input doesn't have focus,
        // focus it (they're using the OS keyboard, not tapping virtual keys).
        // But don't steal focus from another editable field, e.g. the name
        // input in the leaderboard-submission modal.
        if (typingInput && document.activeElement !== typingInput &&
            !isEditableElement(document.activeElement)) {
            typingInput.focus();
        }

        // Highlight the key being pressed (pass e.code to distinguish left/right shift)
        highlightKey(e.key, e.code);

        // Check modifier state on every keypress
        const shouldShowShift = e.shiftKey || e.getModifierState('CapsLock');
        if (shouldShowShift !== isShiftActive) {
            isShiftActive = shouldShowShift;
            // Update keyboard labels to reflect shift state
            updateLabelsForShift();
        }
    });

    document.addEventListener('keyup', (e) => {
        // Remove highlight from released key (pass e.code to distinguish left/right shift)
        unhighlightKey(e.key, e.code);

        // Check modifier state when keys are released
        const shouldShowShift = e.shiftKey || e.getModifierState('CapsLock');
        if (shouldShowShift !== isShiftActive) {
            isShiftActive = shouldShowShift;
            // Update keyboard labels to reflect shift state
            updateLabelsForShift();
        }
    });
}

// Call setup immediately if DOM already loaded, otherwise wait
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupKeyboardShortcuts);
} else {
    setupKeyboardShortcuts();
}

// ============================================================================
// Shaw Keys Settings Management
// ============================================================================

// Load settings from localStorage
function loadShawKeysSettings() {
    try {
        const stored = localStorage.getItem(SK_SETTINGS_KEY);
        if (stored) {
            const settings = JSON.parse(stored);
            return { ...SK_DEFAULT_SETTINGS, ...settings };
        }
    } catch (error) {
        console.error('Error loading Shaw Keys settings:', error);
    }
    return { ...SK_DEFAULT_SETTINGS };
}

// Save settings to localStorage
function saveShawKeysSettings(settings) {
    try {
        localStorage.setItem(SK_SETTINGS_KEY, JSON.stringify(settings));
    } catch (error) {
        console.error('Error saving Shaw Keys settings:', error);
    }
}

// Save keyboard layout choice
function saveShawKeysLayout(layout) {
    const settings = loadShawKeysSettings();
    settings.layout = layout;
    saveShawKeysSettings(settings);
    notifyStateChange();
}

// Get current keyboard layout
function getShawKeysLayout() {
    const settings = loadShawKeysSettings();
    return settings.layout;
}

// Per-surface radio-group name so multiple mounted pickers (dialog + embedded
// tab) never merge into one document-scope group. loadShawKeysSettingsHTML
// mints a unique name once and stamps it on the mount container (data-sk-group);
// every reader resolves it by walking up to that container, so the built-in
// radios and roster radios of ONE surface always share a name — and it stays
// stable whether the outer container or the #sk-view-picker child is passed.
let radioGroupSeq = 0;
function mintRadioGroupName(containerElement) {
    const name = 'sk-layout--' + (++radioGroupSeq);
    containerElement.dataset.skGroup = name;
    return name;
}
function layoutRadioGroupName(el) {
    return pickerMount(el).dataset.skGroup;
}

// The canonical mount element for a picker surface: the [data-sk-group] host that
// mintRadioGroupName stamped. Callers may hand us the outer mount OR the
// #sk-view-picker child (showPickerView passes the child); both must resolve to
// the ONE element that carries the geo class, ResizeObserver, and picker-state
// WeakMap key — otherwise the dialog surface silently forks a second identity and
// its geometry/preview-layer/pulse wiring goes missing.
function pickerMount(el) {
    const host = el.closest('[data-sk-group]');
    if (!host) {
        throw new Error('pickerMount: element is not inside a mounted Shaw Keys picker');
    }
    return host;
}

// Load settings HTML snippet (view 1 + the empty view-2 host) into a container,
// build the flat radio list (built-in + custom rows) with the inline preview, and
// wire the create/import bar. Selecting any radio applies the layout and fires
// onLayoutsChanged so the host re-applies (word lists etc.).
async function loadShawKeysSettingsHTML(containerElement) {
    try {
        const url = getResourceUrl('keyboard-settings.html');
        const response = await fetch(url);
        if (!response.ok) {
            console.error('Failed to load keyboard settings HTML');
            return false;
        }
        const html = await response.text();
        containerElement.innerHTML = html;

        // renderPickerList names every row straight from its layout, so the
        // layouts must be in hand before it runs.
        await preloadBuiltInLayouts();

        // Scope the radio group to THIS surface: two mounted fragments (dialog +
        // embedded tab) at document scope would otherwise collapse into one group
        // and steal each other's selection. renderPickerList stamps this name onto
        // every row it builds. See mintRadioGroupName / layoutRadioGroupName.
        mintRadioGroupName(containerElement);

        applyUiStrings(containerElement);   // static data-i18n chrome (heading, New/Import)
        installPickerResponsiveness(containerElement);
        renderPickerList(containerElement);
        wireCreateControls(containerElement);

        return true;
    } catch (error) {
        console.error('Error loading keyboard settings HTML:', error);
        return false;
    }
}

// Public: render the SAME view-1 picker+roster UI into an arbitrary host
// container (e.g. the game's Keyboard tab) — one renderer, no fork. The embedded
// mount is a PICKER/roster only: radio-select applies the layout (host hears
// onLayoutsChanged); Edit / New-from-clone open the library's OWN dialog in
// editor view (editorEntryFor → openLayoutEditor), so there is still exactly one
// editor. Fail-fast: throws on a missing container or a failed HTML load — no
// silent no-op mount.
async function mountSettings(containerElement) {
    if (!containerElement) {
        throw new Error('mountSettings: container element is required');
    }
    const ok = await loadShawKeysSettingsHTML(containerElement);
    if (!ok) {
        throw new Error('mountSettings: failed to load keyboard settings HTML');
    }
}

// Public: re-sync an already-mounted picker (rows + active selection + inline
// preview) after a layout-set change, without refetching HTML. The host calls
// this from its onLayoutsChanged handler so the embedded mount reflects
// saves/deletes/renames — the same refresh showPickerView does for the dialog's
// own picker. renderPickerList rebuilds from the store and re-selects the active.
function refreshMount(containerElement) {
    if (!containerElement) {
        throw new Error('refreshMount: container element is required');
    }
    // Skip the rebuild a switch's own notify provokes — it would wipe the
    // animating details and the rows are already correct (see pickerSwitching).
    if (pickerSwitching.has(pickerMount(containerElement))) return;
    renderPickerList(containerElement);
}

// Apply a layout chosen in the settings dialog (built-in radio or custom roster
// row) and tell the host so it re-applies (word lists etc.). The host's
// onLayoutsChanged handler owns the game-side reaction.
async function selectLayoutFromDialog(layoutId) {
    await setKeyboardLayout(layoutId);
    notifyLayoutsChanged({ activeChanged: true });
}

// ---------------------------------------------------------------------------
// Picker preview + responsiveness. Per-surface state (which layer the preview
// shows) lives in a WeakMap keyed by the mount container, so the dialog and the
// embedded tab keep independent preview state.
// ---------------------------------------------------------------------------

// Three picker geometries (see pickerGeometry):
//  - WIDE  : ample width — roomy radio list + a wider inline preview.
//  - NARROW: limited width, adequate height — stacked radios, inline preview.
//  - MOBILE: tight width AND constrained height — a <select> dropdown replaces the
//            radio list, preview below. Chosen because a full radio list (5 built-
//            ins + N customs) would be too tall for the room a phone/landscape
//            sheet actually has.
const PICKER_WIDE_AT_PX = 560;     // at/above this width: WIDE, else NARROW/MOBILE
const PICKER_MOBILE_MAX_WIDTH_PX = 480;   // MOBILE requires width below this AND…
// …available vertical space below this. Viewport-height proxy (see
// pickerAvailableHeight): a phone-portrait viewport is a fair bit taller than the
// space the picker really gets once the browser chrome + on-screen keyboard eat
// in, so this sits above a bare list's height on purpose. TUNABLE — chosen so a
// ~390×740 phone portrait goes MOBILE while a ~430×900 tall phone stays NARROW.
const PICKER_MOBILE_MAX_HEIGHT_PX = 780;

const pickerPreviewState = new WeakMap();  // container -> { layer, layoutId }

function getPickerState(containerElement) {
    const mount = pickerMount(containerElement);   // canonical key: outer mount == child picker
    let state = pickerPreviewState.get(mount);
    if (!state) {
        state = { layer: 'base', layoutId: null };
        pickerPreviewState.set(mount, state);
    }
    return state;
}

// The available vertical space for the picker: viewport height is the honest
// ceiling on a phone (the dialog/tab can't exceed it), and cheaper/steadier to
// read than the mount's own laid-out height (which the list itself inflates).
function pickerAvailableHeight() {
    return window.innerHeight || document.documentElement.clientHeight || 0;
}

// The one geometry predicate. Width drives WIDE↔NARROW; MOBILE needs BOTH a tight
// width AND constrained height (the true 3-axis rule the user asked for).
function pickerGeometry(containerElement) {
    const width = containerElement.clientWidth;
    if (width < PICKER_MOBILE_MAX_WIDTH_PX && pickerAvailableHeight() < PICKER_MOBILE_MAX_HEIGHT_PX) {
        return 'mobile';
    }
    return width >= PICKER_WIDE_AT_PX ? 'wide' : 'narrow';
}

// Observe the mount's size: recompute the geometry (stamp a sk-geo-* class), and
// re-render the list when the geometry FLIPS (radios↔dropdown is a render choice,
// not just CSS). Also re-scale the live preview to the new width. One observer per
// surface; looked-up fresh each callback so it survives re-renders.
function installPickerResponsiveness(containerElement) {
    let lastGeometry = null;
    let lastWidth = -1;
    let scheduled = false;
    const apply = () => {
        scheduled = false;
        const geometry = pickerGeometry(containerElement);
        const width = containerElement.clientWidth;
        if (geometry === lastGeometry && width === lastWidth) return;
        const geometryFlipped = geometry !== lastGeometry;
        lastGeometry = geometry;
        lastWidth = width;
        containerElement.classList.remove('sk-geo-wide', 'sk-geo-narrow', 'sk-geo-mobile');
        containerElement.classList.add('sk-geo-' + geometry);
        // radios↔dropdown differ structurally — rebuild the list on a flip.
        if (geometryFlipped) {
            renderPickerList(containerElement);
            return;   // renderPickerList re-scales the fresh preview itself
        }
        rescalePreview(containerElement);
    };
    // Defer the layout mutation out of the RO callback (rAF) so mutating geometry
    // the observer watches can't re-enter it in the same frame — the source of
    // "ResizeObserver loop completed with undelivered notifications".
    const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(apply);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(containerElement);
    apply();
}

// Re-scale whichever preview is currently mounted to the surface's width.
function rescalePreview(containerElement) {
    const host = containerElement.querySelector('.sk-preview-host');
    const scaler = host && host.querySelector('.sk-preview-scaler');
    const body = scaler && scaler.querySelector('.sk-preview-body');
    if (host && scaler && body) scalePreviewToWidth(host, scaler, body);
}

// The compact description text for any layout id: the built-in's canned copy, or
// a custom's user-authored description ('' when unset — the slot then renders
// nothing, leaving only the coverage badge from renderCoverageBadge). A custom's
// description NEVER overrides a built-in's canned text.
function previewDescription(layoutId) {
    const desc = LAYOUT_DESCRIPTIONS[layoutId];
    if (desc !== undefined) return skString(desc.key, desc.en);
    const record = CustomLayouts.getCustomLayout(layoutId);
    if (!record) return skString('skCustomUnavailable', 'Custom keyboard (unavailable).');
    return preferredScriptLabel(record.description || '', record.shavianDescription);
}

// Fill `descEl` with a custom layout's coverage badge: a green ✓ when complete,
// or a ⚠ + "incomplete" when not. Built-ins carry no coverage badge (they're
// always complete by construction). The full missing-glyph list stays in the
// editor's own coverage line (renderCoverage), not here — the overview is a
// glance, not a diagnostic.
function renderCoverageBadge(descEl, layoutId) {
    if (LAYOUT_DESCRIPTIONS[layoutId] !== undefined) return;
    const record = CustomLayouts.getCustomLayout(layoutId);
    if (!record) return;
    const complete = CustomLayouts.coverage(record.layout).missing.length === 0;
    const badge = document.createElement('span');
    if (complete) {
        badge.className = 'sk-cov-badge sk-cov-complete';
        badge.textContent = '✓';
        badge.setAttribute('aria-label', skString('skCovCompleteLabel', 'Complete'));
        badge.title = badge.getAttribute('aria-label');
    } else {
        badge.className = 'sk-cov-badge sk-cov-incomplete';
        badge.textContent = '⚠ ' + skString('skCovIncomplete', 'incomplete');
    }
    // Separate from the description only when there IS one — an unset description
    // must not leave a leading space before the badge.
    if (descEl.textContent) descEl.append(' ');
    descEl.append(badge);
}

// Render a bare layout's ligatures inline as "components → result" chips, always
// expanded. A layout with NO ligatures (e.g. 2layer) renders no section at all —
// the whole label+body block is hidden, no dead heading.
function renderLigatureSection(sectionEl, bare) {
    const bodyEl = sectionEl.querySelector('.sk-lig-body');
    bodyEl.textContent = '';
    const ligatures = bare.ligatures || {};
    const results = Object.keys(ligatures);
    if (results.length === 0) {
        sectionEl.style.display = 'none';
        return;
    }
    sectionEl.style.display = '';
    for (const result of results) {
        for (const seq of ligatures[result]) {
            const item = document.createElement('span');
            item.className = 'sk-lig-item';
            item.textContent = `${seq.join(' + ')} → ${result}`;
            bodyEl.appendChild(item);
        }
    }
}

// Render the inline detail (description + live preview + ligatures) under the
// selected row's host. Resolves the bare layout (built-in or custom — both a
// { keys } map); fail-fast if it can't resolve, since a blank preview would hide
// a real load bug. `pulseShift` arms the one-shot ⇧ pulse on this render.
async function renderInlineDetail(containerElement, detailEl, layoutId, pulseShift) {
    const state = getPickerState(containerElement);
    // A fresh selection (pulseShift) starts on the base layer; the ⇧-flip re-render
    // (pulseShift=false) keeps whatever layer the user toggled to.
    if (pulseShift) state.layer = 'base';
    state.layoutId = layoutId;
    const descEl = detailEl.querySelector('.sk-detail-desc');
    descEl.textContent = previewDescription(layoutId);
    renderCoverageBadge(descEl, layoutId);
    const bare = await getKeyboardLayout(layoutId);
    if (!bare) throw new Error(`renderInlineDetail: layout ${layoutId} did not resolve`);
    const host = detailEl.querySelector('.sk-preview-host');
    renderLayoutPreview(host, layoutId, bare, state.layer);
    // The Shift CAPS (left + right) are rebuilt by renderLayoutPreview every
    // render, so their click listeners must be (re)bound here. Bind BOTH so a tap
    // on either shift flips the layer. The host keydown listener is bound ONCE at
    // mount (mountInlineDetail) since the host persists across flip re-renders —
    // binding it per-render would accumulate and double-flip physical Shift.
    for (const shiftKey of host.querySelectorAll('.sk-preview-body .key[data-key="Shift"]')) {
        shiftKey.addEventListener('click', () => flipPreviewLayer(containerElement, detailEl, layoutId));
    }
    if (pulseShift) armShiftPulse(host);
    renderLigatureSection(detailEl.querySelector('.sk-lig-section'), bare);
}

// Flip the preview's shown layer for this surface and re-render (no checkbox).
async function flipPreviewLayer(containerElement, detailEl, layoutId) {
    const state = getPickerState(containerElement);
    await setPreviewLayer(containerElement, detailEl, layoutId,
        state.layer === 'shift' ? 'base' : 'shift');
}

// Show `layer` in this surface's preview, re-rendering only on a real change.
// Physical Shift drives this (not the toggle) so key autorepeat and a Shift-up
// arriving without its Shift-down can't desync the shown layer.
async function setPreviewLayer(containerElement, detailEl, layoutId, layer) {
    const state = getPickerState(containerElement);
    if (state.layer === layer) return;
    state.layer = layer;
    await renderInlineDetail(containerElement, detailEl, layoutId, false);
}

// ---------------------------------------------------------------------------
// Physical Shift → preview layer. A <div> only gets key events when focused and
// the preview host never is, so this listens on DOCUMENT (as the game keyboard
// does) and dispatches to every MOUNTED preview. Bound ONCE, lazily; the
// registry is what scopes it — no mounted preview, no effect — so Shift while
// typing in the game, the editor, or any text field is untouched.
// ---------------------------------------------------------------------------

// detailEl -> { containerElement, layoutId } for every inline detail currently in
// the DOM. mountInlineDetail registers; clearInlineDetails unregisters.
const mountedPreviews = new Map();
let shiftPreviewListenersBound = false;

function applyShiftToPreviews(shiftHeld) {
    for (const [detailEl, { containerElement, layoutId }] of mountedPreviews) {
        // A surface torn down wholesale (innerHTML replaced) never runs
        // clearInlineDetails; drop those entries rather than render into limbo.
        if (!detailEl.isConnected) {
            mountedPreviews.delete(detailEl);
            continue;
        }
        // Skip a preview that isn't on screen (picker hidden behind the editor
        // view, or its settings surface closed) — Shift there is not for us.
        if (!detailEl.offsetParent) continue;
        setPreviewLayer(containerElement, detailEl, layoutId, shiftHeld ? 'shift' : 'base');
    }
}

function bindShiftPreviewListeners() {
    if (shiftPreviewListenersBound) return;
    shiftPreviewListenersBound = true;
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Shift') applyShiftToPreviews(true);
    });
    document.addEventListener('keyup', (e) => {
        if (e.key === 'Shift') applyShiftToPreviews(false);
    });
}

// One-shot ⇧ pulse to invite the tap-to-flip gesture; the class self-removes on
// animationend so it never loops.
function armShiftPulse(host) {
    const shiftKey = host.querySelector('.sk-preview-body .key[data-key="Shift"]');
    if (!shiftKey) return;
    shiftKey.classList.add('sk-shift-pulse');
    shiftKey.addEventListener('animationend', () => shiftKey.classList.remove('sk-shift-pulse'), { once: true });
}

// ---------------------------------------------------------------------------
// Flat layout picker (view 1). Built-in + custom layouts share one radio list;
// custom rows carry a "custom" chip + an inline ✏️ edit control. The selected row
// hosts the inline detail (preview + description + ligatures). Selecting a row =
// setLayout. Create/import live in the bar below; the other manage verbs
// (download/delete) live in the editor (reached via ✏️).
// ---------------------------------------------------------------------------

// Pick the editor entry point for a picker hosted in `containerElement`. The
// editor always renders in the ONE library dialog; only the entry differs:
// - inside #sk-settings-dialog: swap the open dialog's views in place.
// - embedded in a host container (game's Keyboard tab): open the dialog THEN
//   switch to editor view (openLayoutEditor). Never a second editor.
function editorEntryFor(containerElement) {
    const inDialog = !!(containerElement && containerElement.closest('#sk-settings-dialog'));
    return inDialog ? openEditorView : openLayoutEditor;
}

// All selectable layouts as {id, displayName, isCustom}, built-ins first. Both
// kinds are labelled in the active script.
function listAllLayouts() {
    const builtIns = listBuiltInLayouts().map(l => ({ ...l, isCustom: false }));
    const customs = CustomLayouts.listCustomLayouts().map(
        l => ({ id: l.id, displayName: layoutDisplayName(l.id), isCustom: true }));
    return builtIns.concat(customs);
}

// (Re)build the picker from the built-in registry + the custom store and re-render
// the inline detail for the active layout. In MOBILE geometry this is a <select>
// dropdown; otherwise a flat radio list. Called on load, on a geometry flip, and
// after any layout mutation (refreshMount / showPickerView). The geometry class is
// applied by installPickerResponsiveness before this runs.
function renderPickerList(containerElement) {
    const list = containerElement.querySelector('#sk-layout-list');
    if (!list) throw new Error('renderPickerList: #sk-layout-list not found');
    const activeId = getShawKeysLayout();
    clearInlineDetails(containerElement, false);   // deregister before the subtree wipe
    list.textContent = '';
    if (pickerMount(containerElement).classList.contains('sk-geo-mobile')) {
        renderPickerDropdown(containerElement, list, activeId);
    } else {
        renderPickerRadios(containerElement, list, activeId);
    }
}

// Flat radio list (WIDE / NARROW): a row per layout, inline detail under the
// active one.
function renderPickerRadios(containerElement, list, activeId) {
    for (const { id, displayName, isCustom } of listAllLayouts()) {
        list.appendChild(makePickerRow(containerElement, id, displayName, activeId, isCustom));
    }
    const active = list.querySelector(`input[value="${cssEscape(activeId)}"]`);
    if (active) mountInlineDetail(containerElement, active.closest('.sk-layout-choice'), activeId, false);
}

// Dropdown selector (MOBILE): a <select> of all layouts + a compact Edit button
// (enabled only when a custom is selected), with the inline detail rendered below.
function renderPickerDropdown(containerElement, list, activeId) {
    const bar = document.createElement('div');
    bar.className = 'sk-dropdown-bar';

    const select = document.createElement('select');
    select.className = 'sk-dropdown';
    select.name = layoutRadioGroupName(containerElement);   // preserve per-surface group name
    const customTag = skString('skCustomChip', 'custom');
    for (const { id, displayName, isCustom } of listAllLayouts()) {
        const opt = new Option(isCustom ? `${displayName} (${customTag})` : displayName, id);
        opt.selected = id === activeId;
        select.appendChild(opt);
    }
    bar.appendChild(select);

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'sk-edit-btn sk-dropdown-edit';
    edit.textContent = skString('skEditBtn', '✏️ Edit');
    edit.title = skString('skEditSelectedTitle', 'Edit the selected custom layout');
    const syncEdit = () => { edit.disabled = isBuiltInLayoutName(select.value); };
    syncEdit();
    edit.addEventListener('click', () => {
        if (!isBuiltInLayoutName(select.value)) editorEntryFor(containerElement)(select.value);
    });
    bar.appendChild(edit);
    list.appendChild(bar);
    mountInlineDetail(containerElement, bar, activeId, false);

    select.addEventListener('change', async () => {
        syncEdit();
        await switchToLayout(containerElement, bar, select.value);
    });
}

// One radio row: name + (custom → chip + ✏️). Selecting it applies the layout and
// re-mounts the inline detail under this row with the ⇧-pulse armed.
function makePickerRow(containerElement, id, displayName, activeId, isCustom) {
    const row = document.createElement('label');
    row.className = 'sk-layout-choice';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = layoutRadioGroupName(containerElement);
    radio.value = id;
    radio.checked = id === activeId;
    radio.addEventListener('change', async (e) => {
        if (!e.target.checked) return;
        await switchToLayout(containerElement, row, id);
    });
    row.appendChild(radio);

    const name = document.createElement('span');
    name.className = 'sk-choice-name';
    name.textContent = displayName;
    row.appendChild(name);

    if (isCustom) {
        const chip = document.createElement('span');
        chip.className = 'sk-custom-chip';
        chip.textContent = skString('skCustomChip', 'custom');
        row.appendChild(chip);

        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'sk-edit-btn';
        edit.title = skString('skEditThisTitle', 'Edit this layout');
        edit.textContent = skString('skEditIcon', '✏️');
        // Stop the label from toggling the radio when the edit button is tapped.
        edit.addEventListener('click', (e) => { e.preventDefault(); editorEntryFor(containerElement)(id); });
        row.appendChild(edit);
    }

    return row;
}

function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Switch-animation duration; MUST match the CSS transitions in
// keyboard-settings.html (.sk-detail-grid / .sk-inline-detail).
const DETAIL_ANIM_MS = 200;

// Surfaces mid switch-animation. A user layout switch notifies the host, whose
// onLayoutsChanged calls refreshMount on this same surface — that rebuild wipes
// the list (rows + both details) in the same tick, so the exchange never ran.
// switchToLayout owns the rows for the exchange; refreshMount defers to it.
const pickerSwitching = new WeakSet();

// Animate an inline detail collapsing (content track → 0fr, fade), then remove it.
// Reduced motion removes instantly. The removal timer is the only JS left: the
// element still has to leave the DOM once it has finished collapsing.
function collapseInlineDetail(detail) {
    if (prefersReducedMotion()) { detail.remove(); return; }
    detail.classList.add('sk-detail-collapsed');
    setTimeout(() => detail.remove(), DETAIL_ANIM_MS);
}

// Remove any inline detail currently mounted in this surface (only one shows).
// `animate` collapses the outgoing detail (used on a user layout switch); the
// instant path is used by full re-renders (refreshMount / geometry flip).
// Deregistering here (not on the delayed removal) takes the outgoing detail out
// of the physical-Shift driver immediately, so a collapsing detail can't re-render.
function clearInlineDetails(containerElement, animate) {
    containerElement.querySelectorAll('.sk-inline-detail').forEach(el => {
        mountedPreviews.delete(el);
        if (animate) collapseInlineDetail(el); else el.remove();
    });
}

// Animate an inline detail expanding to its content's intrinsic height. The one
// rAF is load-bearing: the collapsed state has to be the element's rendered style
// for a frame, or the browser sees no start value and jumps straight to expanded.
function expandInlineDetail(detail) {
    if (prefersReducedMotion()) return;
    detail.classList.add('sk-detail-collapsed');
    requestAnimationFrame(() => detail.classList.remove('sk-detail-collapsed'));
}

// Clone the detail template, insert it after `row`, and render it for `layoutId`.
// Fire-and-forget render (fail-fast inside renderInlineDetail). Registering in
// mountedPreviews is what puts this preview under the document-level physical-
// Shift driver; clearInlineDetails deregisters it. `animateIn` expands the detail
// from collapsed so a layout switch reads as continuous.
function mountInlineDetail(containerElement, row, layoutId, pulseShift, animateIn) {
    if (!row) return;
    const tpl = containerElement.querySelector('#sk-detail-template');
    if (!tpl) throw new Error('mountInlineDetail: #sk-detail-template not found');
    const detail = tpl.content.firstElementChild.cloneNode(true);
    applyUiStrings(detail);   // the cloned template carries data-i18n (Ligatures label)
    row.after(detail);
    mountedPreviews.set(detail, { containerElement, layoutId });
    bindShiftPreviewListeners();
    // Expand immediately: with nothing measured, the 1fr track just tracks the
    // content as the preview renders into it, so waiting for the render would only
    // delay the start.
    if (animateIn) expandInlineDetail(detail);
    renderInlineDetail(containerElement, detail, layoutId, pulseShift);
}

// User-initiated layout switch (radio or dropdown): collapse the outgoing detail
// while expanding the incoming one under `row`, so the clicked row doesn't jump.
// The two animations overlap because the collapse is fire-and-forget (removes via
// its own settle timer) and the new detail mounts + expands right after the apply.
async function switchToLayout(containerElement, row, layoutId) {
    const mount = pickerMount(containerElement);
    // Own this surface's rows for the whole exchange. The host answers the switch
    // with a refreshMount here (asynchronously — it awaits its own re-apply first),
    // and that list rebuild would wipe both animating details. The rebuild is
    // redundant for a switch: only the selection moved, and the radio already has.
    pickerSwitching.add(mount);
    try {
        clearInlineDetails(containerElement, true);
        await selectLayoutFromDialog(layoutId);
        mountInlineDetail(containerElement, row, layoutId, true, true);
    } finally {
        setTimeout(() => pickerSwitching.delete(mount), DETAIL_ANIM_MS);
    }
}

// Minimal CSS.escape shim (attribute-selector safety for custom ids like
// "custom:my-layout"); CSS.escape is present on the acceptance browsers but the
// test stub isn't a browser.
function cssEscape(value) {
    return (window.CSS && window.CSS.escape) ? window.CSS.escape(value) : String(value).replace(/[^\w-]/g, '\\$&');
}

// The Latin and Shavian "copy" suffixes a clone name takes. Shavian is the user's
// own spelling, not a transliteration of the Latin one.
const CLONE_SUFFIX_LATIN = ' copy';
const CLONE_SUFFIX_SHAVIAN = ' 𐑒𐑪𐑐𐑦';

// A leaderboard-safe clone name: "<source><suffix>", truncated so the whole thing
// fits the name cap (custom names are stored verbatim on the board). Counted in
// GRAPHEMES — the same unit the editor's name inputs cap at — so a Shavian name
// keeps as many LETTERS as a Latin one and a VS1 cluster is never split. The
// source name is already name-safe (a built-in display name or a validated custom
// name); we only shorten it. Returns '' when the source has nothing to copy.
function cloneName(sourceName, suffix) {
    const room = NAME_CAP_GRAPHEMES - toGraphemes(suffix).length;
    const head = toGraphemes((sourceName || '').trim()).slice(0, room).join('').trim();
    return head ? head + suffix : '';
}

// The clone-source set offered by the New… base picker: built-ins + existing
// customs, labelled in the active UI script (customs carry the "custom" chip).
// Same set the old inline base <select> offered.
function listCloneBases() {
    const bases = listBuiltInLayouts().map(l => ({ id: l.id, label: l.displayName }));
    const customTag = skString('skCustomChip', 'custom');
    for (const c of CustomLayouts.listCustomLayouts()) {
        bases.push({ id: c.id, label: `${customLayoutLabel(c.id)} (${customTag})` });
    }
    return bases;
}

// A promoted base-picker overlay and where it came from, so closeBasePicker can
// put it back. Keyed by the picker mount: each surface has its own overlay, and
// two mounted surfaces both carry an element with id "sk-base-overlay" — hence
// the element is held here directly, never re-looked-up by id once promoted.
const basePickerHome = new WeakMap();   // mount -> { overlay, parent, next }

// The base-picker overlay must float above everything, unclipped. It is markup
// INSIDE the picker, which sits in a scroll box (the settings <dialog>'s own
// overflow, or the game modal's .scrollable-modal), so an in-flow absolute
// overlay gets clipped by that box. Fix: reparent it out, exactly as
// promoteVkAboveBackdrop does for the picker keyboard — into the settings
// <dialog> when one is open (a top-layer descendant, so it paints above
// ::backdrop), else into <body>. Paired with position:fixed in the stylesheet,
// its box then resolves against the VIEWPORT. Deliberately NOT a nested
// <dialog>.showModal: stacking a second top-layer dialog over the settings one
// gave murky focus/Escape semantics, a pitfall this project already hit.
function promoteBasePicker(mount, overlay) {
    if (basePickerHome.has(mount)) return;   // already promoted
    basePickerHome.set(mount, { overlay, parent: overlay.parentNode, next: overlay.nextSibling });
    const dialog = document.getElementById('sk-settings-dialog');
    const host = (dialog && dialog.open && dialog.contains(overlay)) ? dialog : document.body;
    host.appendChild(overlay);
}

function restoreBasePicker(mount, overlay) {
    const home = basePickerHome.get(mount);
    if (!home) return;
    home.parent.insertBefore(overlay, home.next);
    basePickerHome.delete(mount);
}

// Show the base-picker overlay for this surface, promoted clear of the scroll box
// that would clip it (see promoteBasePicker). Picking a base clones it + opens the
// editor; backdrop / Cancel / Escape dismiss without creating anything.
function openBasePicker(containerElement) {
    const overlay = basePickerOverlay(containerElement);
    const list = overlay.querySelector('#sk-base-list');
    if (!list) throw new Error('openBasePicker: base-picker list markup missing');

    list.textContent = '';
    for (const { id, label } of listCloneBases()) {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'sk-base-option';
        option.textContent = label;
        option.addEventListener('click', () => {
            closeBasePicker(containerElement);
            rosterNewFromClone(id, containerElement);
        });
        list.appendChild(option);
    }

    promoteBasePicker(pickerMount(containerElement), overlay);
    overlay.hidden = false;
    const first = list.querySelector('.sk-base-option');
    if (first) first.focus();
}

function closeBasePicker(containerElement) {
    const overlay = basePickerOverlay(containerElement);
    overlay.hidden = true;
    restoreBasePicker(pickerMount(containerElement), overlay);
}

// This surface's overlay. Once promoted it is no longer a descendant of the
// mount, so take it from the mount's home record. Fail-fast: a picker without
// its overlay markup is a broken load, not a no-op.
function basePickerOverlay(containerElement) {
    const mount = pickerMount(containerElement);
    const home = basePickerHome.get(mount);
    const overlay = home ? home.overlay : mount.querySelector('#sk-base-overlay');
    if (!overlay) throw new Error('basePickerOverlay: base-picker overlay markup missing');
    return overlay;
}

// Create/import bar: New… (opens the base-picker overlay), Import… + hidden file
// input, and the overlay's own dismiss wiring. Wired once per HTML load. The other
// manage verbs (download/delete) live in the editor (reached via ✏️).
function wireCreateControls(containerElement) {
    const newBtn = containerElement.querySelector('#sk-create-new');
    if (newBtn) {
        newBtn.addEventListener('click', () => openBasePicker(containerElement));
    }
    const importBtn = containerElement.querySelector('#sk-create-import');
    const fileInput = containerElement.querySelector('#sk-create-file');
    if (importBtn && fileInput) {
        importBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => rosterImport(fileInput));
    }

    const overlay = containerElement.querySelector('#sk-base-overlay');
    const cancel = containerElement.querySelector('#sk-base-cancel');
    if (cancel) cancel.addEventListener('click', () => closeBasePicker(containerElement));
    if (overlay) {
        // Backdrop click (the overlay itself, not the panel) dismisses.
        overlay.addEventListener('click', (ev) => {
            if (ev.target === overlay) closeBasePicker(containerElement);
        });
        // Escape dismisses only the overlay; stop it before the <dialog>'s own
        // Escape handling so closing the picker doesn't also close the dialog.
        overlay.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape') {
                ev.preventDefault();
                ev.stopPropagation();
                closeBasePicker(containerElement);
            }
        });
    }
}

// New-from-clone: save a fresh custom cloning `baseId`, then open the editor on
// it. Cloning a built-in captures it as the layout's base; cloning a custom keeps
// that custom's own base (structural ancestry survives). A unique default name is
// minted so the record is valid immediately; the user renames in the editor.
async function rosterNewFromClone(baseId, containerElement) {
    const CL = CustomLayouts;
    let data;
    try {
        data = await getKeyboardLayout(baseId);
    } catch (e) {
        console.error('[Roster] clone source load failed', baseId, e);
        return;
    }
    if (!data || !data.keys) {
        console.error('[Roster] clone source has no keys', baseId);
        return;
    }
    const bare = {
        keys: Object.assign({}, data.keys),
        ligatures: JSON.parse(JSON.stringify(data.ligatures || {})),
    };
    // base = the built-in cloned from, or the source custom's own recorded base.
    const base = isBuiltInLayoutName(baseId) ? baseId : (data.base || null);
    if (base) bare.base = base;
    // Latin from a Latin source only (it mints the slug); Shavian only when the
    // source custom carries one — a built-in has no stored Shavian name, and its
    // translated label is a UI string, not data.
    const latinSource = CL.getCustomLayoutDisplayName(baseId) || builtInLatinName(baseId);
    if (!latinSource) throw new Error(`Clone source has no display name: ${baseId}`);
    const record = CL.makeCustomLayoutRecord(bare, {
        displayName: cloneName(latinSource, CLONE_SUFFIX_LATIN),
        shavianDisplayName: cloneName(CL.getCustomLayoutShavianDisplayName(baseId), CLONE_SUFFIX_SHAVIAN),
    });
    CL.saveCustomLayout(record);
    // record.name is the slug; the cache + active-layout keys are the PREFIXED id.
    const newId = CL.CUSTOM_ID_PREFIX + record.name;
    invalidateLayoutCache(newId);
    editorEntryFor(containerElement)(newId);
}

// Download a stored custom as keyboard_layout_<slug>.json: the bare layout with
// its wrapper metadata alongside, so a re-import keeps every label. The filename
// is minted from the LATIN name — identity stays Latin. Top-level "keys" stays
// where it is, so the file remains a drop-in for tools/kbd_score/score_layout.py.
function rosterDownload(id) {
    const CL = CustomLayouts;
    const record = CL.getCustomLayout(id);
    if (!record) return;
    const exported = Object.assign(CL.layoutMetadata(record), record.layout);
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `keyboard_layout_${CL.slugifyName(record.displayName)}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

// Delete a stored custom (confirmed). If it was active, fall back via the event.
// ID-SHAPE CONTRACT: `id` is the PREFIXED id ("custom:<slug>", the radio value
// from listCustomLayouts). getCustomLayout / deleteCustomLayout accept either
// shape (they slugOf internally); invalidateLayoutCache and the active-layout
// comparison both key on the PREFIXED id (the cache + getLayout() use it). So the
// same `id` is passed to all four — delete-of-active removes, evicts, and falls
// back. All roster actions (edit/download/delete) use this shape.
async function rosterDelete(id) {
    const CL = CustomLayouts;
    const record = CL.getCustomLayout(id);
    if (!record) return;
    if (!window.confirm(skString('skConfirmDelete', 'Delete custom keyboard "{{name}}"? This cannot be undone.', { name: record.displayName }))) {
        return;
    }
    const wasActive = getShawKeysLayout() === id;
    CL.deleteCustomLayout(id);
    invalidateLayoutCache(id);
    // Deleting the ACTIVE custom: fall back to the host default and persist it HERE,
    // before notifying, so both picker surfaces (dialog onExit → showPickerView and
    // the embedded refreshMount) re-render against a settled, existing layout — not
    // the deleted id (which would leave an empty selection + no inline preview).
    if (wasActive) {
        if (!hostDefaultLayout) {
            throw new Error('rosterDelete: host default layout not set (call setDefaultLayout)');
        }
        await setKeyboardLayout(hostDefaultLayout);
    }
    notifyLayoutsChanged({ activeChanged: wasActive, activeRemoved: wasActive });
}

// Split an imported layout JSON into its bare layout and its wrapper metadata.
// Accepts what rosterDownload writes (a bare layout carrying the metadata
// alongside), a wrapper record ({layout, ...metadata}), or a hand-authored bare
// layout with none of it. `name` is deliberately NOT consulted — on a wrapper
// record that field is the slug, not a display name. A genuinely nameless file
// gets the "Imported layout" default (a product decision, not a masked error);
// any absent label yields ''.
function splitImportedLayout(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Layout must be a JSON object.');
    }
    const CL = CustomLayouts;
    const wrapped = !!parsed.layout && typeof parsed.layout === 'object';
    const bare = wrapped ? parsed.layout : Object.assign({}, parsed);
    // The metadata rides alongside `keys` in an exported file — strip it back off
    // so it never enters the stored record's layout.
    if (!wrapped) {
        for (const field of CL.LAYOUT_METADATA_FIELDS) delete bare[field];
    }
    const metadata = CL.layoutMetadata(parsed);
    for (const field of CL.LAYOUT_METADATA_FIELDS) metadata[field] = metadata[field].trim();
    if (!metadata.displayName) metadata.displayName = 'Imported layout';
    return { bare: bare, metadata: metadata };
}

// Import a layout JSON as a new stored custom, then re-render via onLayoutsChanged.
// splitImportedLayout resolves the bare layout + its name; validates before storing.
function rosterImport(fileInput) {
    const CL = CustomLayouts;
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => window.alert('Could not read the file.');
    reader.onload = () => {
        let parsed;
        try {
            parsed = JSON.parse(reader.result);
        } catch (e) {
            window.alert('Could not parse JSON: ' + e.message);
            return;
        }
        let bare, metadata;
        try {
            ({ bare, metadata } = splitImportedLayout(parsed));
            CL.validateLayout(bare);
        } catch (e) {
            window.alert('Invalid layout: ' + e.message);
            return;
        }
        const record = CL.makeCustomLayoutRecord(bare, metadata);
        CL.saveCustomLayout(record);
        notifyLayoutsChanged({ activeChanged: false });
    };
    reader.readAsText(file);
}

// ---------------------------------------------------------------------------
// Two-view dialog controller. #sk-settings-dialog holds view 1 (picker+roster)
// and view 2 (editor); this swaps which shows, without a second showModal. The
// header's Back button + title reflect the current view. openEditorView loads
// the editor into #sk-view-editor; showPickerView returns to view 1 and refreshes
// the roster.
// ---------------------------------------------------------------------------

// Swap to the editor view, opening the editor locked to `id`. The editor renders
// into #sk-view-editor and calls `onExit` on Back/Done. The ENTRY POINT owns the
// Back target: a dialog-entry (default) returns to the dialog picker view; a
// mount-entry (openLayoutEditor) passes an onExit that closes the dialog so the
// user lands back on the game's own Keyboard tab, not the dialog's picker.
function openEditorView(id, onExit) {
    const dialog = document.getElementById('sk-settings-dialog');
    if (!dialog) return;
    const picker = dialog.querySelector('#sk-view-picker');
    const editorHost = dialog.querySelector('#sk-view-editor');
    if (!picker || !editorHost) return;
    LayoutEditor.open(id, {
        host: editorHost,
        onExit: onExit || (() => showPickerView()),
    }).then(() => {
        picker.style.display = 'none';
        editorHost.style.display = '';
        setDialogViewChrome('editor');
    }).catch(e => console.error('[Layout editor]', e));
}

// Return to view 1 (picker + roster). Refreshes the roster (a save/delete may have
// changed it) and restores the picker chrome.
function showPickerView() {
    const dialog = document.getElementById('sk-settings-dialog');
    if (!dialog) return;
    const picker = dialog.querySelector('#sk-view-picker');
    const editorHost = dialog.querySelector('#sk-view-editor');
    if (editorHost) editorHost.style.display = 'none';
    if (picker) {
        picker.style.display = '';
        refreshMount(picker);   // roster rows + active radio, same as the embedded mount
    }
    setDialogViewChrome('picker');
}

// Whether the editor view (view 2) is currently showing — read from the DOM so
// the dismissal handlers (cancel/✕) route through the dirty check only in editor
// view. The editor host is display:'' when active, 'none' otherwise.
function isEditorViewActive() {
    const editorHost = document.querySelector('#sk-settings-dialog #sk-view-editor');
    return !!editorHost && editorHost.style.display !== 'none';
}

// Toggle the dialog header between the two views: the editor view shows a Back
// affordance (dirty-checked, delegated to the editor) and an editor title.
function setDialogViewChrome(view) {
    const dialog = document.getElementById('sk-settings-dialog');
    if (!dialog) return;
    const back = dialog.querySelector('#sk-dialog-back');
    const title = dialog.querySelector('#sk-dialog-title');
    if (back) {
        back.style.display = view === 'editor' ? '' : 'none';
        back.textContent = skString('skDialogBack', '← Back');
    }
    if (title) title.textContent = view === 'editor'
        ? skString('skEditorTitle', 'Edit keyboard')
        : skString('skDialogTitle', 'Shaw Keys Settings');
}

// Show settings in a modal/dialog (example implementation)
function showShawKeysSettings(dialogElement) {
    if (!dialogElement) {
        console.error('No dialog element provided to showShawKeysSettings');
        return;
    }

    loadShawKeysSettingsHTML(dialogElement).then(success => {
        if (success && dialogElement.showModal) {
            dialogElement.showModal();
        } else if (success) {
            dialogElement.style.display = 'block';
        }
    });
}

// Open keyboard settings dialog (creates dialog if needed)
async function openShawKeysSettings() {
    // Check if dialog already exists
    let dialog = document.getElementById('sk-settings-dialog');

    if (!dialog) {
        // Create dialog
        dialog = document.createElement('dialog');
        dialog.id = 'sk-settings-dialog';
        // Centre via inset+margin:auto, NOT transform: a transformed dialog becomes
        // the containing block for its position:fixed descendants, which would trap
        // the promoted glyph-picker keyboard inside the dialog box (clipping it). Native
        // <dialog> centering (inset 0 + margin auto) leaves the keyboard's fixed position
        // resolving against the viewport, so it floats free above the backdrop.
        // Colours are NOT set here — see #sk-settings-dialog in shaw-keys.css.
        // showModal puts this in the top layer, which no z-index can raise or
        // lower, so it carries none.
        // 640px is set by the widest thing either view holds: the editor's
        // keyboard panel (~584px) plus the container's padding. The picker's
        // preview scales to any width, so it sets no floor. Going narrower puts
        // the editor keyboard into horizontal scroll.
        dialog.style.cssText = 'width: 640px; max-width: 95%; border: none; border-radius: 12px; padding: 0; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3); position: fixed; inset: 0; margin: auto;';

        // Add backdrop blur styles
        const style = document.createElement('style');
        style.textContent = `
            #sk-settings-dialog::backdrop {
                background-color: rgba(0, 0, 0, 0.5);
                backdrop-filter: blur(4px);
                -webkit-backdrop-filter: blur(4px);
            }
        `;
        document.head.appendChild(style);

        const header = document.createElement('div');
        header.className = 'sk-dialog-header';

        // Back affordance (editor view only). Delegates to the editor so the
        // dirty check happens there; the editor's onExit returns to view 1.
        const backBtn = document.createElement('button');
        backBtn.id = 'sk-dialog-back';
        backBtn.textContent = skString('skDialogBack', '← Back');
        backBtn.style.display = 'none';
        backBtn.addEventListener('click', () => LayoutEditor.back());

        const title = document.createElement('h2');
        title.id = 'sk-dialog-title';
        title.textContent = skString('skDialogTitle', 'Shaw Keys Settings');

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.className = 'sk-dialog-close';
        // In editor view, ✕ must run the editor's dirty check (it routes through
        // back() → confirm → onExit to picker), NOT close outright — otherwise
        // unsaved edits vanish. .close() does not fire the `cancel` event, so this
        // redirect is the only guard for the ✕ path. In picker view ✕ just closes.
        closeBtn.addEventListener('click', () => {
            if (isEditorViewActive()) {
                LayoutEditor.back();
            } else {
                dialog.close();
            }
        });

        header.appendChild(backBtn);
        header.appendChild(title);
        header.appendChild(closeBtn);

        const container = document.createElement('div');
        container.id = 'sk-settings-container';

        dialog.appendChild(header);
        dialog.appendChild(container);
        document.body.appendChild(dialog);

        // Escape must not silently drop unsaved editor edits. Two layers, because
        // preventing the native <dialog> Escape-close is not reliable via `cancel`
        // alone (some engines close regardless of cancel-cancelation):
        //   1) A capture-phase keydown catches Escape BEFORE the native close and,
        //      in editor view with unsaved edits (and no key/slot focused — a
        //      focused target's Escape deselects, handled by the editor), blocks it
        //      and routes through the editor's dirty check (back() → confirm; on
        //      discard it tears down + exits to picker, on keep it stays).
        //   2) `cancel` (fired before close) is also guarded, for engines where its
        //      preventDefault IS honored — belt and braces, same predicate.
        // Clean editor / picker view fall through to the normal close either way.
        const escapeShouldDirtyCheck = () =>
            isEditorViewActive()
            && LayoutEditor.isDirty()
            && !LayoutEditor.hasFocusTarget();
        dialog.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape' && escapeShouldDirtyCheck()) {
                ev.preventDefault();
                ev.stopPropagation();
                LayoutEditor.back();
            }
        }, true);
        dialog.addEventListener('cancel', (ev) => {
            if (escapeShouldDirtyCheck()) {
                ev.preventDefault();
                LayoutEditor.back();
            }
        });

        // GAME SAFETY: one dialog = one close path. On close (✕ in picker view, or
        // Escape when not blocked above), tear the editor down — its close()
        // releases the keyboard destination back to the game input unconditionally — and
        // reset to the picker view so the next open starts clean.
        // LayoutEditor.close() is a no-op-safe teardown when never opened.
        dialog.addEventListener('close', () => {
            LayoutEditor.close();
            const picker = dialog.querySelector('#sk-view-picker');
            const editorHost = dialog.querySelector('#sk-view-editor');
            if (editorHost) editorHost.style.display = 'none';
            if (picker) picker.style.display = '';
            setDialogViewChrome('picker');
        });

        // Load settings HTML
        const success = await loadShawKeysSettingsHTML(container);
        if (!success) {
            console.error('[Shaw Keys] Failed to load settings HTML');
            return;
        }
    } else {
        // Reopening an existing dialog: refresh the roster + active-radio so it
        // reflects any changes since it was last shown, and start on view 1.
        showPickerView();
    }

    // Show dialog
    if (dialog.showModal) {
        dialog.showModal();
    } else {
        dialog.style.display = 'block';
    }
}

// Open the settings dialog straight into the editor view on `startId` (a custom
// layout id). The editor is view 2 of the one dialog — never a second modal — so
// this opens the dialog then swaps views. Public entry for a host that wants to
// jump directly to editing a specific custom.
async function openLayoutEditor(startId) {
    await openShawKeysSettings();
    // Mount-entry Back target: close the dialog so the user returns to the game's
    // own Keyboard tab they came from, NOT the dialog's picker view (that picker
    // is a different surface than where they started). The dialog's `close`
    // handler runs the editor's game-safe teardown + resets to picker view for the
    // next open. See editorEntryFor / openEditorView.
    openEditorView(startId, () => {
        const dialog = document.getElementById('sk-settings-dialog');
        if (dialog) dialog.close();
    });
}

// ============================================================================
// Keystroke Interception API
// ============================================================================

// Build component-to-ligature mapping from layout ligatures
function getComponentToLigature(layout) {
    if (!layout || !layout.ligatures) {
        return {};
    }

    const mapping = {};
    Object.keys(layout.ligatures).forEach(compound => {
        layout.ligatures[compound].forEach(sequence => {
            const key = sequence.join('');
            mapping[key] = compound;
        });
    });
    return mapping;
}

// Form ligatures in the input value. A suppressor in the value is a barrier: no
// fold may span it, and it is consumed rather than left in the result. Folding
// therefore runs over the tail alone — the run after the last suppressor — and
// the head keeps only the text, with its own suppressors already spent.
function formLigatures(value, componentToLigature) {
    if (!value) {
        return value;
    }
    const lastBarrier = value.lastIndexOf(LIGATURE_SUPPRESSOR);
    if (lastBarrier !== -1) {
        const tail = value.slice(lastBarrier + LIGATURE_SUPPRESSOR.length);
        // A trailing barrier has blocked nothing yet — a key bound to a bare
        // suppressor must still be armed when the next letter lands, so it stays
        // in the buffer until something follows it.
        if (tail.length === 0) {
            return value;
        }
        const head = value.slice(0, lastBarrier).split(LIGATURE_SUPPRESSOR).join('');
        return head + formLigatures(tail, componentToLigature);
    }
    if (Object.keys(componentToLigature).length === 0) {
        return value;
    }

    // Try matching against all possible ligature component sequences
    // Start with longest matches first (to handle VS1 sequences properly)
    const sortedKeys = Object.keys(componentToLigature).sort((a, b) => {
        // Sort by length descending (longest first)
        return Array.from(b).length - Array.from(a).length;
    });

    // Fold the suffix repeatedly until no further match applies, so a ligature
    // whose component is itself a freshly-formed ligature resolves in one pass
    // (e.g. 𐑩𐑪->oo, then yea+oo->yew). Each fold replaces a multi-char suffix
    // with a single glyph, so it strictly shortens `value`; the fold count can
    // never exceed the starting length. Exceeding that bound means a cyclic/
    // non-shrinking ligature table — fail loudly rather than loop forever.
    let foldsRemaining = value.length;
    let folded = true;
    while (folded) {
        folded = false;
        for (const componentSeq of sortedKeys) {
            // Check if value ends with this component sequence
            if (value.endsWith(componentSeq)) {
                if (foldsRemaining-- <= 0) {
                    throw new Error(`Ligature folding did not converge for "${value}" — the layout's ligatures may be cyclic.`);
                }
                const prefix = value.substring(0, value.length - componentSeq.length);
                value = prefix + componentToLigature[componentSeq];
                folded = true;
                break;
            }
        }
    }

    return value;
}

// ----------------------------------------------------------------------------
// Live ligature preview
//
// When the typed text so far is the leading component(s) of a ligature, the
// key that would type the NEXT component is "armed": its main legend shows the
// eventual result glyph, so the user sees what completing the ligature yields.
// Derived strictly from the layout's `ligatures` table (same source the engine
// uses), so air/roar etc. can never be shown wrongly.
// ----------------------------------------------------------------------------

// Compute the keys to arm given the text typed so far.
//
// For every ligature whose component sequence shares a leading run with the end
// of `typedText`, the next component char is armed and mapped to the eventual
// result glyph. 2-component ligatures (the common case) arm after one match;
// longer sequences (3-component, VS1) arm progressively as more components are
// typed. Returns a Map of componentChar -> resultGlyph (may be empty).
function getArmedLigaturePreviews(typedText, ligatures) {
    const armed = new Map();
    if (!typedText || !ligatures) {
        return armed;
    }

    // If two ligatures would arm the same component key with different results,
    // the later one wins. That is ambiguous, but it cannot arise for the current
    // layouts (the only shared targets differ by a trailing VS1, which endsWith
    // distinguishes). A future custom layout could collide; the preview is then
    // merely imprecise, not wrong — the engine still folds deterministically.
    Object.keys(ligatures).forEach(result => {
        ligatures[result].forEach(sequence => {
            // Find the longest proper prefix of `sequence` that the typed text
            // ends with; the component right after it is the one to arm. Note the
            // armed component must itself sit on a key to be shown (see
            // applyLigaturePreview); a component that is another derived glyph
            // (nested ligature) has no key, so that preview step is silently skipped.
            for (let matched = sequence.length - 1; matched >= 1; matched--) {
                const typedPrefix = sequence.slice(0, matched).join('');
                if (typedText.endsWith(typedPrefix)) {
                    armed.set(sequence[matched], result);
                    return;
                }
            }
        });
    });

    return armed;
}

// Apply the armed previews to the on-screen keys: for each key whose base
// character is an armed component, replace its main legend with the result
// glyph and flag it `.armed`. Keys not currently armed are reverted.
function applyLigaturePreview(armed) {
    document.querySelectorAll('.key[data-shavian]').forEach(key => {
        const baseChar = key.getAttribute('data-shavian');
        const result = armed.get(baseChar);
        if (result) {
            const shiftChar = key.getAttribute('data-shavian-shift') || '';
            renderKeyLegends(key, result, shiftChar);
            key.classList.add('armed');
        } else if (key.classList.contains('armed')) {
            const shiftChar = key.getAttribute('data-shavian-shift') || '';
            renderKeyLegends(key, baseChar, shiftChar);
            key.classList.remove('armed');
        }
    });
}

// Refresh the preview for the run of text ending at the caret, using the
// current layout's ligature table. No-op (and clears any stale preview) when
// ligatures are inactive, shift is held, or no key is armed.
function refreshLigaturePreview(textBeforeCaret) {
    const layout = KEYBOARD_MAPS[currentLayoutName];
    if (!ligaturePreviewActive || isShiftActive || !layout) {
        clearLigaturePreview();
        return;
    }
    applyLigaturePreview(getArmedLigaturePreviews(textBeforeCaret, layout.ligatures));
}

// Revert every armed key to its normal label.
function clearLigaturePreview() {
    applyLigaturePreview(new Map());
}

/**
 * Enable keystroke interception for an input element
 * Only translates when Shaw Keys is visible
 *
 * @param {HTMLInputElement} inputElement - The input element to intercept
 * @param {Object} options - Configuration options
 * @param {string} [options.layout] - Layout name (defaults to saved layout preference)
 * @param {Function} [options.onLayoutChange] - Callback when layout changes
 * @returns {Function} - Cleanup function to remove interception
 */
// contenteditable insertion fallback when document.execCommand isn't
// available. Mirrors execCommand('insertText') semantics: replace the
// current selection (if any) with `text`, place the caret at the end.
function insertTextAtCaret(text) {
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
}

// Run a ligature pass over the text node the caret currently sits in,
// for a contenteditable host. After insertText, the caret is right
// after the freshly-inserted character; we look at the run ending at
// that point and let formLigatures() collapse any matching component
// pair. Cheap: only inspects the local text node, not the whole tree.
function formLigaturesInContentEditable(host, componentToLigature) {
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    if (!host.contains(node)) return;
    const offset = range.startOffset;
    const before = node.data.substring(0, offset);
    const after = node.data.substring(offset);
    const formedBefore = formLigatures(before, componentToLigature);
    if (formedBefore === before) return;
    node.data = formedBefore + after;
    const newOffset = formedBefore.length;
    const newRange = document.createRange();
    newRange.setStart(node, newOffset);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
}

// Backspace for a contenteditable host. execCommand keeps undo and cursor
// placement; the fallback mirrors it over the live Selection, deleting one
// GRAPHEME so a Shavian VS1 variant (base + U+FE00) goes in one press.
function deleteBackwardInContentEditable() {
    if (document.execCommand) {
        document.execCommand('delete', false, null);
        return;
    }
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) {
        range.deleteContents();
    } else {
        const node = range.startContainer;
        if (!node || node.nodeType !== Node.TEXT_NODE || range.startOffset === 0) return;
        const before = node.data.substring(0, range.startOffset);
        const lastGrapheme = toGraphemes(before).pop();
        range.setStart(node, range.startOffset - lastGrapheme.length);
        range.deleteContents();
    }
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
}

// <input>/<textarea> expose .value + setSelectionRange; contenteditable elements
// don't — their insertion is driven by the active Selection and Range. The one
// spelling of that distinction, for both input routes.
function isContentEditableElement(el) {
    return el.isContentEditable === true
        || (typeof el.getAttribute === 'function' && el.getAttribute('contenteditable') === 'true');
}

function isValueBearingElement(el) {
    return 'value' in el && 'selectionStart' in el;
}

function isEditableDestination(el) {
    return isValueBearingElement(el) || isContentEditableElement(el);
}

// Where the next write goes in a value-bearing element. A physical keystroke
// arrives via beforeinput on the FOCUSED element, so selectionStart 0 means the
// caret really is at the start. A tap focuses nothing, so an untouched field
// reports 0 whatever the caret was — hence untrustedCaret, which reads 0 as
// end-of-value and makes tapping append rather than prepend.
function caretRange(element, untrustedCaret) {
    if (untrustedCaret) {
        return {
            start: element.selectionStart || element.value.length,
            end: element.selectionEnd || element.value.length
        };
    }
    return { start: element.selectionStart, end: element.selectionEnd };
}

// Insert `glyph` at the caret of either kind of editable element, folding the run
// before the caret into its compound — the keyboard emits the RESULT (𐑼), not the
// components (𐑩+𐑮), the way an IME would. The single insertion routine: tapped
// keys and intercepted keystrokes both land here, so the two routes cannot drift.
function insertGlyphAtCaret(element, glyph, untrustedCaret = false) {
    if (isContentEditableElement(element)) {
        if (document.execCommand) {
            document.execCommand('insertText', false, glyph);
        } else {
            insertTextAtCaret(glyph);
        }
        formLigaturesInContentEditable(element, getTapFoldTable());
        return;
    }
    if (!isValueBearingElement(element)) {
        throw new Error('Cannot insert into element: not an <input>, <textarea> or contenteditable');
    }
    const { start, end } = caretRange(element, untrustedCaret);
    const before = element.value.substring(0, start) + glyph;
    const folded = formLigatures(before, getTapFoldTable());
    element.value = folded + element.value.substring(end);
    setSelectionSafe(element, folded.length);
}

// Delete backwards from the caret of either kind of editable element. Only the
// tap path calls this — a physical Backspace on a keyboard-enabled field is left
// to the browser — so the caret is always the untrusted kind.
function deleteBackwardAtCaret(element) {
    if (isContentEditableElement(element)) {
        deleteBackwardInContentEditable();
        return;
    }
    if (!isValueBearingElement(element)) {
        throw new Error('Cannot delete from element: not an <input>, <textarea> or contenteditable');
    }
    const { start, end } = caretRange(element, true);
    if (start !== end) {
        element.value = element.value.substring(0, start) + element.value.substring(end);
        setSelectionSafe(element, start);
    } else if (start > 0) {
        const chars = Array.from(element.value);
        element.value = chars.slice(0, start - 1).join('') + chars.slice(start).join('');
        setSelectionSafe(element, start - 1);
    }
}

// Make `inputElement` keyboard-enabled: latin keystrokes translate to glyphs
// (folding ligatures as they complete), AND tapped on-screen keys insert here
// while it holds focus. One call covers both input routes. Host contract:
//   - Translation is gated on keyboard visibility: show()/hide()/toggle() arm and
//     disarm it (isVisible() reports the same state). A host needs no visibility
//     check of its own.
//   - Ligatures fold against setFoldLigatures()'s table when set, else the active
//     layout's — the same table tapped keys use, so both input routes agree.
//   - Composed input (isComposing) and Shavian keystrokes pass through untouched.
//     That is what leaves an IME composing its own ligatures (Keyman) alone; do
//     not widen it.
//   - A translated keystroke is written here after preventDefault(), which
//     suppresses the browser's own `input`, so one is dispatched to replace it.
//     A host therefore sees exactly one `input` per insertion — already
//     translated and folded — whichever route it came in by.
// Only for hosts WITHOUT their own input pipeline. A host that owns one drives
// translateInputEvent instead and gates translation on its own flag.
function enableKeystrokeInterception(inputElement, options = {}) {
    if (!inputElement) {
        throw new Error('Input element is required');
    }

    let currentLayout = options.layout || getShawKeysLayout();

    const beforeInputHandler = (e) => {
        // The visible keyboard IS the latin->glyph map the user reads off, so
        // hidden it translates nothing and typed latin binds as itself.
        if (!isShawKeysVisible()) {
            return;
        }

        // An IME composing its own output (Keyman) must be left entirely alone;
        // rewriting mid-composition splits an already-composed ligature.
        if (e.isComposing || e.inputType !== 'insertText' || !e.data) {
            return;
        }

        const layout = KEYBOARD_MAPS[currentLayout];
        if (!layout || !layout.keys) {
            return;
        }

        const keyboardMap = layout.keys;
        const codePoint = e.data.codePointAt(0);
        const isShavian = codePoint >= 0x10450 && codePoint <= 0x1047F;
        const physicalKey = physicalKeyFor(e.data);

        // An unbound key must still insert itself — that is how punctuation a
        // Shavian layout does not remap reaches the document — but what inserts
        // has to be the key PRESSED. Leaving it to the browser inserts what the
        // OS delivered, which for a substituted quote is U+2019 from a press of
        // '. Only a folded key can differ, so only it is written here.
        const boundGlyph = keyboardMap[physicalKey];
        const insertsItsOwnKey = !boundGlyph && physicalKey !== e.data;

        if (!isShavian && (boundGlyph || insertsItsOwnKey)) {
            e.preventDefault();

            const translatedChar = boundGlyph || physicalKey;

            insertGlyphAtCaret(inputElement, translatedChar);
            dispatchInputEvent(inputElement, 'insertText', translatedChar);
        }
    };

    inputElement.addEventListener('beforeinput', beforeInputHandler);

    const layoutChangeHandler = (newLayout) => {
        currentLayout = newLayout;
        if (options.onLayoutChange) {
            options.onLayoutChange(newLayout);
        }
    };

    inputElement._skLayoutChangeHandler = layoutChangeHandler;

    registerKeyboardEnabled(inputElement);

    return () => {
        inputElement.removeEventListener('beforeinput', beforeInputHandler);
        delete inputElement._skLayoutChangeHandler;
        unregisterKeyboardEnabled(inputElement);
    };
}

/**
 * Change the layout for an intercepted input element
 * @param {string} layoutName - The new layout name
 */
function setInterceptionLayout(layoutName) {
    saveShawKeysLayout(layoutName);
    // Notify all inputs that might be listening
    document.querySelectorAll('input, textarea, [contenteditable]').forEach(el => {
        if (el._skLayoutChangeHandler) {
            el._skLayoutChangeHandler(layoutName);
        }
    });
}

// Set URL resolver (can be called separately from initShawKeys)
function setResourceUrlResolver(resolver) {
    resourceUrlResolver = resolver;
}

// Override the default custom-layout resolver(s). The library self-registers
// defaults against its bundled CustomLayouts store; a host (e.g. an extension
// with a different backing store) can replace them here. dataFn(id) -> bare
// layout object|null; nameFn(id) -> display name|null (optional).
function setCustomLayoutResolver(dataFn, nameFn) {
    customLayoutResolver = dataFn;
    customDisplayNameResolver = nameFn || null;
}

// Evict a layout from the load cache so the next setLayout re-resolves it from
// source. The host must call this when a custom layout's stored data changes
// (edited in place) or is deleted — otherwise loadKeyboardLayout's cache hit
// keeps serving the pre-change data until a full page reload. Passing no name
// evicts every custom layout.
//
// Built-ins are never evicted, by either form: they are load-once by design, and
// their residency is a precondition of naming (layoutDisplayName reads the loaded
// layout), so dropping one bricks every naming surface until something reloads it.
function invalidateLayoutCache(layoutName) {
    if (layoutName !== undefined) {
        if (!isBuiltInLayoutName(layoutName)) delete KEYBOARD_MAPS[layoutName];
        return;
    }
    for (const key of Object.keys(KEYBOARD_MAPS)) {
        if (!isBuiltInLayoutName(key)) delete KEYBOARD_MAPS[key];
    }
}

// Helper to check if keyboard is visible
function isShawKeysVisible() {
    const keyboard = document.getElementById('shawKeys');
    return keyboard && keyboard.style.display !== 'none';
}

// Destroy/cleanup function
function destroyShawKeys() {
    // Remove keyboard from DOM
    const container = document.getElementById('shawKeys');
    if (container) {
        container.remove();
    }

    // Clear state
    currentLayoutName = null;
    isShiftActive = false;
    onStateChange = null;

    console.log('[Shaw Keys] Destroyed');
}

// Named exports for the sibling modules. The supported host surface is the
// ShawKeys object below.
export { getComponentToLigature, formLigatures, isBuiltInLayoutName };

// New namespaced API - cleaner and more organized
export const ShawKeys = {
    // Lifecycle
    init: initShawKeys,
    destroy: destroyShawKeys,

    // Visibility
    show: showShawKeys,
    hide: hideShawKeys,
    toggle: toggleShawKeys,
    isVisible: isShawKeysVisible,

    // The platform's show/hide shortcut ("⌘K" / "Ctrl+K"), for a host to append
    // to its own toggle label. See toggleShortcutLabel.
    toggleShortcutLabel: toggleShortcutLabel,

    // Layout management
    getLayout: getShawKeysLayout,
    setLayout: setKeyboardLayout,

    // A loaded layout's own data, synchronously — for a host running its own
    // input pipeline, whose per-keystroke reads cannot await. Throws if the
    // layout was never loaded; setLayout and preloadBuiltInLayouts load them.
    loadedLayout: loadedLayout,

    // The built-in layout the library falls back to when the ACTIVE custom is
    // deleted. The host sets its game default (igc) once at init; rosterDelete
    // applies + persists it before notifying so the pickers re-render settled.
    setDefaultLayout: setDefaultLayout,

    // Embed the picker+roster (view 1) into a host container — the SAME renderer
    // the dialog uses. Radio-select applies the layout; Edit / New-from-clone
    // open the library's own dialog in editor view (one editor).
    mountSettings: mountSettings,

    // Re-sync an already-mounted picker+roster (no HTML refetch); the host calls
    // it from onLayoutsChanged so the embedded mount tracks saves/deletes.
    refreshMount: refreshMount,

    // Subscribe to library layout-set changes (custom saved/deleted, active
    // layout switched internally). The host repopulates its selectors and, when
    // the event reports the active layout changed, re-applies it.
    onLayoutsChanged: onLayoutsChanged,

    // Select the script/dialect for the library's OWN shipped UI strings:
    // setScript('latin') or setScript('shavian', 'british'|'american').
    setScript: setScript,

    // Optional OVERRIDE of the shipped strings with the host's own tables
    // (`active` = current-script table, `base` = fallback table). A host with its
    // own translation pipeline calls this alongside its updateUIWithTranslations;
    // hosts without one need only setScript. Applies to open surfaces now.
    setUiStrings: setUiStrings,

    // State management
    onStateChange: setShawKeysStateCallback,
    getState: getKeyboardState,

    // Suppress global keydown handling while the host shows a modal
    setSuppressKeydownPredicate: setSuppressKeydownPredicate,

    // Repoint where tapped keys insert (glyph-picker use); null = game input
    setDestination: setDestination,
    getDestinationInput: getDestinationInput,

    // Override the ligature table tapped keys fold against (the editor supplies
    // the layout under edit); null = the active layout's.
    setFoldLigatures: setFoldLigatures,

    // Keystroke interception
    enableInterception: enableKeystrokeInterception,

    // For a host that runs its own input pipeline rather than letting the
    // library intercept: translateInputEvent maps an `input` event's Latin data
    // to Shavian under the active layout; isEditableElement decides whether a
    // global key handler should yield to a focused field; resetKeyboardState
    // clears the dragged position when the host hides the keyboard itself.
    translateInputEvent: translateInputEvent,
    isEditableElement: isEditableElement,
    resetKeyboardState: resetKeyboardState,

    // Live ligature preview, driven by the host's input pipeline. The host
    // tells the keyboard whether its current layout forms ligatures
    // (setLigaturePreviewActive) and feeds the text run before the caret on
    // each effective keystroke (refreshLigaturePreview).
    setLigaturePreviewActive: setLigaturePreviewActive,
    refreshLigaturePreview: refreshLigaturePreview,

    // Ligature-forming engine, exposed so hosts (the layout editor) can fold a
    // typed component run into its compound glyph using the SAME algorithm the
    // keyboard uses. getComponentToLigature builds the component->compound table
    // from a layout's `ligatures`; formLigatures folds a value against it.
    getComponentToLigature: getComponentToLigature,
    formLigatures: formLigatures,

    // Advanced/internal (exposed for compatibility, and for sibling library
    // files — layout-editor.js resolves resource URLs and fires layout-change
    // events through here).
    _internal: {
        getKeyboardLayoutData: getKeyboardLayout,
        updateKeyboardLabels: updateKeyboardLabels,
        makeKeysClickable: makeKeysClickable,
        loadSettingsHTML: loadShawKeysSettingsHTML,
        showSettings: showShawKeysSettings,
        getResourceUrl: getResourceUrl,
        setResourceUrlResolver: setResourceUrlResolver,
        setCustomLayoutResolver: setCustomLayoutResolver,
        invalidateLayoutCache: invalidateLayoutCache,
        notifyLayoutsChanged: notifyLayoutsChanged,
        NAME_CAP_GRAPHEMES: NAME_CAP_GRAPHEMES,
        toGraphemes: toGraphemes,
        physicalKeyFor: physicalKeyFor,
        cloneName: cloneName,
        builtInLatinName: builtInLatinName,
        layoutDisplayName: layoutDisplayName,
        preloadBuiltInLayouts: preloadBuiltInLayouts,
        // UI-string helpers for the sibling editor: skString resolves a key in the
        // active script (Latin fallback); applyUiStrings stamps [data-i18n] etc.
        skString: skString,
        applyUiStrings: applyUiStrings,
        // Active-script label resolution for the user-AUTHORED labels no string
        // table can carry (a custom layout's Shavian name/description), Latin
        // fallback. The editor's header line resolves through the same helper.
        preferredScriptLabel: preferredScriptLabel,
        customLayoutLabel: customLayoutLabel,
        // Editor/roster entry points and the built-in layout registry — opened
        // by editorEntryFor/roster internally, not part of the host contract.
        openLayoutEditor: openLayoutEditor,
        openSettings: openShawKeysSettings,
        listBuiltInLayouts: listBuiltInLayouts,
        // Structural-family split + built-in-name check; validateLayout uses
        // isBuiltInLayoutName to reject an unknown custom-layout `base`.
        structuralFamilyOf: structuralFamilyOf,
        isBuiltInLayoutName: isBuiltInLayoutName,
        // Picker description resolution + the import splitter — exposed for tests.
        previewDescription: previewDescription,
        splitImportedLayout: splitImportedLayout,
        // Seams for a consumer's test harness. KEYBOARD_MAPS and libraryScript
        // are module-scoped, so a test importing this file cannot reach them the
        // way it could when the library was a classic script sharing one scope.
        // The public routes are async and fetch (loadKeyboardLayout, setScript),
        // which a synchronous test cannot drive.
        registerLayout: (name, layout) => { KEYBOARD_MAPS[name] = layout; },
        setScriptDirect: (script) => { libraryScript = script; },
        // Manage verbs for a stored custom — hosted by the editor (per-open
        // layout) now that they've left the picker. Each re-renders every surface
        // via notifyLayoutsChanged.
        downloadCustomLayout: rosterDownload,
        deleteCustomLayout: rosterDelete
    }
};

// Transition surface: the consumers still reach the library through globals.
// Delete these three assignments (here, custom-layouts.js and layout-editor.js)
// once every consumer imports instead.
window.ShawKeys = ShawKeys;

