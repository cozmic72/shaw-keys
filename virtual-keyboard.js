// Virtual Keyboard Functionality

// Version for cache busting
let VIRTUAL_KEYBOARD_VERSION = '';

// Optional URL resolver callback for browser extensions
let resourceUrlResolver = null;

// Resolver for user-created custom layouts. dataFn(id) -> bareLayoutObject|null
// for ids of the form "custom:<slug>"; nameFn(id) -> display name|null.
// Defaults self-register against the library's own CustomLayouts store (ships in
// custom-layouts.js, loaded right after this file), so a host needs no wiring.
// Lazy window lookups, not captured refs: CustomLayouts loads AFTER this file.
// A host (e.g. an extension) can replace either via setCustomLayoutResolver.
let customLayoutResolver = (id) => window.CustomLayouts.getCustomLayoutData(id);
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

// Where tapped keys insert. Default: the game's practice input. The layout
// editor repoints it at its glyph-capture input so the on-screen keyboard acts
// as a glyph picker, then resets to null (default) on close.
let destinationInputEl = null;

function setDestination(el) {
    // The tap path drives .value/selectionStart directly, so the destination
    // must be a value-bearing control. Fail here rather than silently no-op later.
    if (el !== null && !('value' in el && 'selectionStart' in el)) {
        throw new Error('setDestination requires an <input> or <textarea>');
    }
    destinationInputEl = el;
}

function getDestinationInput() {
    return destinationInputEl || document.getElementById('typingInput');
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

// Insert a tapped glyph at the caret, folding the run before the caret into its
// compound — the keyboard emits the RESULT (𐑼), not the components (𐑩+𐑮), the
// way an IME would. The synthetic input event still reports the raw glyph as
// e.data: that is the keystroke the user made, and a host with its own input
// pipeline (the game) tracks components from it for backspace-splitting.
function insertTappedGlyph(input, glyph) {
    withEditableInput(input, () => {
        const start = input.selectionStart || input.value.length;
        const end = input.selectionEnd || input.value.length;
        const before = input.value.substring(0, start) + glyph;
        const folded = formLigatures(before, getTapFoldTable());
        input.value = folded + input.value.substring(end);
        setSelectionSafe(input, folded.length);
    });
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

// Canonical registry of the built-in layouts, in menu order. The single source
// of truth for "which names are built in" and their plain display names — the
// editor's base picker (listBuiltInLayouts) and isBuiltInLayoutName both derive
// from it so they can never drift. displayName is the plain-English fallback; the
// dialog's bilingual names come from BUILT_IN_LAYOUT_NAME_KEYS via vkString.
const BUILT_IN_LAYOUTS = [
    { id: 'imperial', displayName: 'Shaw Imperial' },
    { id: 'igc', displayName: 'Imperial Good Companion' },
    { id: 'qwerty', displayName: 'Shaw QWERTY' },
    { id: '2layer', displayName: 'Shaw 2-layer (shift)' },
    { id: 'jafl', displayName: 'Shaw-JAFL' },
];

// The built-in ids as a Set for O(1) membership tests.
const BUILT_IN_LAYOUT_IDS = new Set(BUILT_IN_LAYOUTS.map(l => l.id));

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

// A copy of the built-in registry, for hosts building a layout picker (e.g. the
// editor's base list = built-ins + custom layouts). displayName is resolved
// through the shared translation table (the registry's English is the fallback).
// Returns fresh objects so a caller can't mutate the canonical table.
function listBuiltInLayouts() {
    return BUILT_IN_LAYOUTS.map(l => ({
        id: l.id,
        displayName: vkString(builtInLayoutNameKey(l.id), l.displayName),
    }));
}

// The built-in layouts' display-name translation keys (values live in the host's
// translation table, keyed here so there is ONE bilingual mechanism — the shared
// translation pipeline — not a second split-string map). Consumed by vkString via
// builtInLayoutNameKey.
const BUILT_IN_LAYOUT_NAME_KEYS = {
    'imperial': 'vkLayoutImperial',
    'igc': 'vkLayoutIgc',
    'qwerty': 'vkLayoutQwerty',
    '2layer': 'vkLayout2layer',
    'jafl': 'vkLayoutJafl',
};

function builtInLayoutNameKey(layoutId) {
    return BUILT_IN_LAYOUT_NAME_KEYS[layoutId] || null;
}

// ---------------------------------------------------------------------------
// Dialog UI strings (bilingual). The library SHIPS its own vk* tables
// (translations_{latin,british,american}.json beside this file, generated from
// translations.csv) and loads them via setScript. A host with its own pipeline
// may override them with setUiStrings. Resolution order, highest first:
//   1. host override (setUiStrings active, then its base)
//   2. the library's own table for the selected script/dialect
//   3. the hardcoded English fallback passed to each vkString call
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

const VK_TRANSLATION_FILES = {
    latin: 'translations_latin.json',
    british: 'translations_british.json',
    american: 'translations_american.json',
};

// Look up a UI string by key, walking the resolution order above.
// {{token}} placeholders are filled from `vars`.
function vkString(key, fallback, vars) {
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
        el.textContent = vkString(el.getAttribute('data-i18n'), el.textContent);
    });
    root.querySelectorAll('[data-i18n-title]').forEach(el => {
        el.title = vkString(el.getAttribute('data-i18n-title'), el.title);
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        el.placeholder = vkString(el.getAttribute('data-i18n-placeholder'), el.placeholder);
    });
}

// Re-apply strings to every currently-mounted vk surface (the dialog + any
// embedded mount) and re-render the dynamic bits (picker list, editor). Called by
// setUiStrings so a live script/dialect change updates open surfaces immediately.
function refreshUiStrings() {
    document.querySelectorAll('#vk-settings-dialog, [data-vk-group]').forEach(root => {
        applyUiStrings(root);
    });
    // Dynamic content (rows, coverage, editor line) is rebuilt from vkString, so
    // re-render the mounted pickers and the editor if open.
    document.querySelectorAll('[data-vk-group]').forEach(container => {
        if (container.querySelector('#vk-layout-list')) {
            renderPickerList(container);
            // The base-picker overlay is rebuilt from vkString each time it opens
            // (openBasePicker/listCloneBases), so no persistent relabel here.
        }
    });
    const dialogTitle = document.querySelector('#vk-dialog-title');
    if (dialogTitle) dialogTitle.textContent = vkString(
        isEditorViewActive() ? 'vkEditorTitle' : 'vkDialogTitle', dialogTitle.textContent);
    const dialogBack = document.querySelector('#vk-dialog-back');
    if (dialogBack) dialogBack.textContent = vkString('vkDialogBack', dialogBack.textContent);
    if (window.LayoutEditor && typeof window.LayoutEditor.refreshStrings === 'function') {
        window.LayoutEditor.refreshStrings();
    }
    // The docked keyboard title tracks the active script too — retitle in place
    // (no full relabel; that needs the layout map, reloaded elsewhere on switch).
    const kbTitle = document.querySelector('.keyboard-title');
    if (kbTitle && currentLayoutName) {
        const nameKey = builtInLayoutNameKey(currentLayoutName);
        kbTitle.textContent = nameKey
            ? vkString(nameKey, currentLayoutName)
            : ((customDisplayNameResolver && customDisplayNameResolver(currentLayoutName)) || currentLayoutName);
    }
}

// Public: OVERRIDE the dialog's UI strings with the host's own tables, taking
// precedence over the library's shipped ones. `active` is the current-script
// table; `base` fills any vk* key the active table doesn't carry. Re-applies to
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
        ? VK_TRANSLATION_FILES[dialect]
        : VK_TRANSLATION_FILES[script];
    if (!file) throw new Error(`Unknown virtual-keyboard script/dialect: ${script}/${dialect}`);

    const url = getResourceUrl(file);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to load ${file}: ${response.status}`);
    libraryStrings = await response.json();
    libraryScript = script;
    refreshUiStrings();
}

// A custom layout's label in the ACTIVE script, falling back to the Latin one
// when the author left the Shavian counterpart blank — Latin is canonical, so a
// layout is never unidentifiable. `latin` is the caller's already-resolved Latin
// value; `shavian` its optional counterpart.
function preferredScriptLabel(latin, shavian) {
    return libraryScript === 'shavian' && shavian ? shavian : latin;
}

// A custom layout's display name in the active script, or null when `id` names
// no known custom. The single name-resolution point for every vk surface, so the
// picker, the clone-base list and the docked title can't disagree.
function customLayoutLabel(id) {
    const CL = window.CustomLayouts;
    const latin = CL.getCustomLayoutDisplayName(id);
    return latin === null
        ? null
        : preferredScriptLabel(latin, CL.getCustomLayoutShavianDisplayName(id));
}

// Compact one-line descriptions for the picker detail panel, keyed by built-in id.
// (Trimmed from the old multi-sentence panel copy — the live preview now carries
// the visual detail the screenshots used to.)
// Built-in id -> { key, en }: the description's translation key + its English
// fallback (so it still reads before the vk* keys are regenerated into Shavian).
const LAYOUT_DESCRIPTIONS = {
    'imperial': { key: 'vkDescImperial', en: 'The original Imperial Good Companion typewriter layout, with every compound on its own key.' },
    'igc': { key: 'vkDescIgc', en: 'Imperial, made compact: most compounds are built from their parts rather than given a key.' },
    'qwerty': { key: 'vkDescQwerty', en: 'Familiar QWERTY positions — easiest transition from an existing habit.' },
    '2layer': { key: 'vkDesc2layer', en: 'Compact: Shift reaches the full set, related glyphs paired on a key.' },
    'jafl': { key: 'vkDescJafl', en: 'Just Another Friggin’ Layout — key placement tuned for English letter frequency.' },
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
// validateLayout uses to reject a custom layout's unknown `base`. Derived from
// BUILT_IN_LAYOUTS (the single registry) so the two never drift.
function isBuiltInLayoutName(name) {
    return BUILT_IN_LAYOUT_IDS.has(name);
}

// Get current keyboard state
function getKeyboardState() {
    const keyboard = document.getElementById('virtualKeyboard');
    const isVisible = keyboard && keyboard.style.display !== 'none';
    const settings = loadVirtualKeyboardSettings();

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

// Detect the base path of this script and extract version parameter
function getVirtualKeyboardBasePath() {
    const scripts = document.getElementsByTagName('script');
    for (let script of scripts) {
        if (script.src && script.src.includes('virtual-keyboard.js')) {
            const src = script.src;
            const lastSlash = src.lastIndexOf('/');

            // Extract version from query string if present
            const versionMatch = src.match(/[?&]v=([^&]+)/);
            if (versionMatch && !VIRTUAL_KEYBOARD_VERSION) {
                VIRTUAL_KEYBOARD_VERSION = versionMatch[1];
            }

            return src.substring(0, lastSlash + 1);
        }
    }
    return ''; // Fallback to current directory
}

// Get resource URL - uses custom resolver if provided (for browser extensions)
function getResourceUrl(relativePath) {
    if (resourceUrlResolver) {
        return resourceUrlResolver(relativePath);
    }
    const basePath = getVirtualKeyboardBasePath();
    return versionedUrl(`${basePath}${relativePath}`);
}

// Add version parameter to URL for cache busting
function versionedUrl(url) {
    if (VIRTUAL_KEYBOARD_VERSION) {
        const separator = url.includes('?') ? '&' : '?';
        return `${url}${separator}v=${VIRTUAL_KEYBOARD_VERSION}`;
    }
    return url;
}

// Initialize virtual keyboard - loads HTML and sets up
// Parameters:
//   containerElement - DOM element to contain the keyboard
//   resourceVersion - version string (unused, kept for compatibility)
//   urlResolver - optional function(relativePath) => absoluteUrl for browser extensions
//   options - optional object with configuration:
//     - autoShowOnFocus: boolean - automatically show/hide keyboard based on input focus
//     - script: 'latin' | 'shavian' - which shipped UI-string table to load
//     - dialect: 'british' | 'american' - dialect for script: 'shavian'
async function initVirtualKeyboard(containerElement, resourceVersion, urlResolver, options) {
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
        const url = getResourceUrl('virtual-keyboard.html');
        const response = await fetch(url);
        if (!response.ok) {
            console.error('Failed to load virtual keyboard HTML');
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
                hideVirtualKeyboard();
            });
        }

        // Set up auto-show/hide on focus if requested
        if (autoShowOnFocus && !focusListenerAttached) {
            setupAutoShowOnFocus();
            focusListenerAttached = true;
        }

        return true;
    } catch (error) {
        console.error('Error loading virtual keyboard:', error);
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
    console.log('[Virtual Keyboard] Setting up auto-show on focus');

    // Use event delegation on document for better performance
    document.addEventListener('focusin', (e) => {
        if (isEditableElement(e.target)) {
            console.log('[Virtual Keyboard] Editable element focused, showing keyboard');
            showVirtualKeyboard();
        }
    }, true); // Use capture phase

    document.addEventListener('focusout', (e) => {
        // If focus is moving to another editable element, keep the keyboard up
        if (!isEditableElement(e.relatedTarget)) {
            // Small delay to allow focus to settle
            setTimeout(() => {
                // Double-check that no editable element has focus
                if (!isEditableElement(document.activeElement)) {
                    console.log('[Virtual Keyboard] No editable element focused, hiding keyboard');
                    hideVirtualKeyboard();
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

// Apply a layout to the keyboard (loads, updates labels, makes clickable, updates interception)
async function setKeyboardLayout(layoutName) {
    console.log('[Virtual Keyboard] Applying layout:', layoutName);

    // Load the layout data FIRST, and only persist the choice once it succeeds —
    // otherwise a failed switch (e.g. a custom layout deleted in another tab)
    // would leave a poisoned saved layout. A custom layout resolves via the host
    // and throws if missing; treat that like the built-in load-failure path.
    let layout;
    try {
        layout = await getKeyboardLayout(layoutName);
    } catch (error) {
        console.error('[Virtual Keyboard] Failed to load layout:', layoutName, error);
        return false;
    }
    if (!layout || !layout.keys) {
        console.error('[Virtual Keyboard] Failed to load layout:', layoutName);
        return false;
    }

    // Persist the (now known-good) layout choice.
    saveVirtualKeyboardLayout(layoutName);

    // Track current layout
    currentLayoutName = layoutName;

    // Update keyboard display
    updateKeyboardLabels(layout.keys, layoutName, layout);
    makeKeysClickable(layout.keys);

    // Update interception for any active inputs
    setInterceptionLayout(layoutName);

    console.log('[Virtual Keyboard] Layout applied successfully:', layoutName);
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
function translateInputEvent(e, browserInput, currentLayout, useVirtualKeyboard, debugFn) {
    let eventData = e.data || '';

    // Virtual keyboard: translate QWERTY input to Shavian if needed
    if (useVirtualKeyboard && e.inputType === 'insertText' && eventData.length > 0) {
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
// (see the `@media (max-width: 768px)` block in virtual-keyboard.css, which
// pins it with position:fixed; bottom:0; left:0; right:0). In that docked
// mode the drag transform must NOT displace it, or the top (number) row is
// clipped. This query must stay in sync with that CSS breakpoint.
const KEYBOARD_DOCKED_MEDIA_QUERY = '(max-width: 768px)';
function isKeyboardDocked() {
    return window.matchMedia(KEYBOARD_DOCKED_MEDIA_QUERY).matches;
}

const VK_SETTINGS_KEY = 'io.joro.virtual-keyboard.Settings';

// Default settings
const VK_DEFAULT_SETTINGS = {
    layout: 'imperial',
    position: { x: 0, y: 0 }
};

// Load keyboard state from localStorage (using unified settings)
function loadKeyboardState() {
    try {
        const saved = localStorage.getItem(VK_SETTINGS_KEY);
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
        const saved = localStorage.getItem(VK_SETTINGS_KEY);
        let settings = VK_DEFAULT_SETTINGS;
        if (saved) {
            settings = { ...VK_DEFAULT_SETTINGS, ...JSON.parse(saved) };
        }
        settings.position = keyboardPosition;
        localStorage.setItem(VK_SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
        console.error('Failed to save keyboard state:', e);
    }
}

// Reset keyboard state (called when virtual keyboard is toggled off)
function resetKeyboardState() {
    keyboardPosition = { x: 0, y: 0 };
    saveKeyboardState(); // Save the reset position
    const keyboard = document.getElementById('virtualKeyboard');
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
    const keyboard = document.getElementById('virtualKeyboard');
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
function showVirtualKeyboard() {
    const keyboard = document.getElementById('virtualKeyboard');
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

function hideVirtualKeyboard() {
    const keyboard = document.getElementById('virtualKeyboard');
    if (keyboard) {
        keyboard.style.display = 'none';
        clearLigaturePreview();
        notifyStateChange();
    }
}

function toggleVirtualKeyboard() {
    const keyboard = document.getElementById('virtualKeyboard');
    if (keyboard) {
        const isVisible = keyboard.style.display !== 'none';
        if (isVisible) {
            hideVirtualKeyboard();
        } else {
            showVirtualKeyboard();
        }
    }
}

// Set callback for state changes (replaces old visibility callback)
function setVirtualKeyboardStateCallback(callback) {
    onStateChange = callback;
}

// Deprecated: kept for backwards compatibility
function setVirtualKeyboardVisibilityCallback(callback) {
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

    // Update title to show keyboard name (in the active UI script, via the shared
    // translation table for built-ins; custom names are the user's own text).
    const titleElement = document.querySelector('.keyboard-title');
    if (titleElement) {
        const nameKey = builtInLayoutNameKey(layoutName);
        const displayName = nameKey
            ? vkString(nameKey, layoutName)
            : ((customDisplayNameResolver && customDisplayNameResolver(layoutName)) || layoutName);
        const shiftIndicator = isShiftActive ? ' (Shift)' : '';
        titleElement.textContent = displayName + shiftIndicator;
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
// #virtualKeyboard .keyboard-body) and the ONE legend renderer (renderKeyLegends)
// so a preview cap is structurally + stylistically identical to the live
// keyboard, minus input. Works for built-ins and customs alike (both are a bare
// { keys } map). Shift-flip is a pure re-stamp of the same clone.
// ---------------------------------------------------------------------------

// The shift-layer physical token for an unshifted one, via CustomLayouts'
// canonical map (so preview shift forms can't drift from the editor's/coverage's).
function previewShiftedToken(token) {
    return window.CustomLayouts.shiftedTokenOf(token);
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
    const template = document.querySelector('#virtualKeyboard .keyboard-body');
    if (!template) {
        throw new Error('renderLayoutPreview: keyboard template unavailable ' +
            '(no #virtualKeyboard .keyboard-body).');
    }
    const clone = template.cloneNode(true);
    for (const cls of clone.className.split(/\s+/)) {
        if (cls.indexOf('layout-') === 0) clone.classList.remove(cls);
    }
    const isImperial = structuralFamilyOf(layoutName, bareLayout) === 'imperial';
    clone.classList.toggle('structure-imperial', isImperial);
    clone.classList.add('vk-preview-body');

    stampPreviewLayer(clone, bareLayout, layer);

    hostEl.textContent = '';
    const scaler = document.createElement('div');
    scaler.className = 'vk-preview-scaler';
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

            // Notify that user is using virtual keyboard (to prevent OS keyboard)
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
                // Delete character using helper
                withEditableInput(typingInput, () => {
                    const start = typingInput.selectionStart || typingInput.value.length;
                    const end = typingInput.selectionEnd || typingInput.value.length;

                    if (start !== end) {
                        // Delete selection
                        typingInput.value = typingInput.value.substring(0, start) +
                                           typingInput.value.substring(end);
                        setSelectionSafe(typingInput, start);
                    } else if (start > 0) {
                        // Delete one character before cursor
                        const chars = Array.from(typingInput.value);
                        typingInput.value = chars.slice(0, start - 1).join('') +
                                           chars.slice(start).join('');
                        setSelectionSafe(typingInput, start - 1);
                    }
                });

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

            // Notify that user is using virtual keyboard (to prevent OS keyboard)
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
                // Delete character using helper
                withEditableInput(typingInput, () => {
                    const start = typingInput.selectionStart || typingInput.value.length;
                    const end = typingInput.selectionEnd || typingInput.value.length;

                    if (start !== end) {
                        // Delete selection
                        typingInput.value = typingInput.value.substring(0, start) +
                                           typingInput.value.substring(end);
                        setSelectionSafe(typingInput, start);
                    } else if (start > 0) {
                        // Delete one character before cursor
                        const chars = Array.from(typingInput.value);
                        typingInput.value = chars.slice(0, start - 1).join('') +
                                           chars.slice(start).join('');
                        setSelectionSafe(typingInput, start - 1);
                    }
                });

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
// Note: makeKeyboardDraggable() is called from initVirtualKeyboard() after HTML loads
const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

// How the show/hide shortcut is written on this platform, for the host to append
// to its "Show virtual keyboard" label. Not a translated string: it names a
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
            toggleVirtualKeyboard();
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
// Virtual Keyboard Settings Management
// ============================================================================

// Load settings from localStorage
function loadVirtualKeyboardSettings() {
    try {
        const stored = localStorage.getItem(VK_SETTINGS_KEY);
        if (stored) {
            const settings = JSON.parse(stored);
            return { ...VK_DEFAULT_SETTINGS, ...settings };
        }
    } catch (error) {
        console.error('Error loading virtual keyboard settings:', error);
    }
    return { ...VK_DEFAULT_SETTINGS };
}

// Save settings to localStorage
function saveVirtualKeyboardSettings(settings) {
    try {
        localStorage.setItem(VK_SETTINGS_KEY, JSON.stringify(settings));
    } catch (error) {
        console.error('Error saving virtual keyboard settings:', error);
    }
}

// Save keyboard layout choice
function saveVirtualKeyboardLayout(layout) {
    const settings = loadVirtualKeyboardSettings();
    settings.layout = layout;
    saveVirtualKeyboardSettings(settings);
    notifyStateChange();
}

// Get current keyboard layout
function getVirtualKeyboardLayout() {
    const settings = loadVirtualKeyboardSettings();
    return settings.layout;
}

// Per-surface radio-group name so multiple mounted pickers (dialog + embedded
// tab) never merge into one document-scope group. loadVirtualKeyboardSettingsHTML
// mints a unique name once and stamps it on the mount container (data-vk-group);
// every reader resolves it by walking up to that container, so the built-in
// radios and roster radios of ONE surface always share a name — and it stays
// stable whether the outer container or the #vk-view-picker child is passed.
let radioGroupSeq = 0;
function mintRadioGroupName(containerElement) {
    const name = 'vk-layout--' + (++radioGroupSeq);
    containerElement.dataset.vkGroup = name;
    return name;
}
function layoutRadioGroupName(el) {
    return pickerMount(el).dataset.vkGroup;
}

// The canonical mount element for a picker surface: the [data-vk-group] host that
// mintRadioGroupName stamped. Callers may hand us the outer mount OR the
// #vk-view-picker child (showPickerView passes the child); both must resolve to
// the ONE element that carries the geo class, ResizeObserver, and picker-state
// WeakMap key — otherwise the dialog surface silently forks a second identity and
// its geometry/preview-layer/pulse wiring goes missing.
function pickerMount(el) {
    const host = el.closest('[data-vk-group]');
    if (!host) {
        throw new Error('pickerMount: element is not inside a mounted vk picker');
    }
    return host;
}

// Load settings HTML snippet (view 1 + the empty view-2 host) into a container,
// build the flat radio list (built-in + custom rows) with the inline preview, and
// wire the create/import bar. Selecting any radio applies the layout and fires
// onLayoutsChanged so the host re-applies (word lists etc.).
async function loadVirtualKeyboardSettingsHTML(containerElement) {
    try {
        const url = getResourceUrl('keyboard-settings.html');
        const response = await fetch(url);
        if (!response.ok) {
            console.error('Failed to load keyboard settings HTML');
            return false;
        }
        const html = await response.text();
        containerElement.innerHTML = html;

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
    const ok = await loadVirtualKeyboardSettingsHTML(containerElement);
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

// Observe the mount's size: recompute the geometry (stamp a vk-geo-* class), and
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
        containerElement.classList.remove('vk-geo-wide', 'vk-geo-narrow', 'vk-geo-mobile');
        containerElement.classList.add('vk-geo-' + geometry);
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
    const host = containerElement.querySelector('.vk-preview-host');
    const scaler = host && host.querySelector('.vk-preview-scaler');
    const body = scaler && scaler.querySelector('.vk-preview-body');
    if (host && scaler && body) scalePreviewToWidth(host, scaler, body);
}

// The compact description text for any layout id: the built-in's canned copy, or
// a custom's user-authored description ('' when unset — the slot then renders
// nothing, leaving only the coverage badge from renderCoverageBadge). A custom's
// description NEVER overrides a built-in's canned text.
function previewDescription(layoutId) {
    const desc = LAYOUT_DESCRIPTIONS[layoutId];
    if (desc !== undefined) return vkString(desc.key, desc.en);
    const record = window.CustomLayouts.getCustomLayout(layoutId);
    if (!record) return vkString('vkCustomUnavailable', 'Custom keyboard (unavailable).');
    return preferredScriptLabel(record.description || '', record.shavianDescription);
}

// Fill `descEl` with a custom layout's coverage badge: a green ✓ when complete,
// or a ⚠ + "incomplete" when not. Built-ins carry no coverage badge (they're
// always complete by construction). The full missing-glyph list stays in the
// editor's own coverage line (renderCoverage), not here — the overview is a
// glance, not a diagnostic.
function renderCoverageBadge(descEl, layoutId) {
    if (LAYOUT_DESCRIPTIONS[layoutId] !== undefined) return;
    const record = window.CustomLayouts.getCustomLayout(layoutId);
    if (!record) return;
    const complete = window.CustomLayouts.coverage(record.layout).missing.length === 0;
    const badge = document.createElement('span');
    if (complete) {
        badge.className = 'vk-cov-badge vk-cov-complete';
        badge.textContent = '✓';
        badge.setAttribute('aria-label', vkString('vkCovCompleteLabel', 'Complete'));
        badge.title = badge.getAttribute('aria-label');
    } else {
        badge.className = 'vk-cov-badge vk-cov-incomplete';
        badge.textContent = '⚠ ' + vkString('vkCovIncomplete', 'incomplete');
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
    const bodyEl = sectionEl.querySelector('.vk-lig-body');
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
            item.className = 'vk-lig-item';
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
    const descEl = detailEl.querySelector('.vk-detail-desc');
    descEl.textContent = previewDescription(layoutId);
    renderCoverageBadge(descEl, layoutId);
    const bare = await getKeyboardLayout(layoutId);
    if (!bare) throw new Error(`renderInlineDetail: layout ${layoutId} did not resolve`);
    const host = detailEl.querySelector('.vk-preview-host');
    renderLayoutPreview(host, layoutId, bare, state.layer);
    // The Shift CAPS (left + right) are rebuilt by renderLayoutPreview every
    // render, so their click listeners must be (re)bound here. Bind BOTH so a tap
    // on either shift flips the layer. The host keydown listener is bound ONCE at
    // mount (mountInlineDetail) since the host persists across flip re-renders —
    // binding it per-render would accumulate and double-flip physical Shift.
    for (const shiftKey of host.querySelectorAll('.vk-preview-body .key[data-key="Shift"]')) {
        shiftKey.addEventListener('click', () => flipPreviewLayer(containerElement, detailEl, layoutId));
    }
    if (pulseShift) armShiftPulse(host);
    renderLigatureSection(detailEl.querySelector('.vk-lig-section'), bare);
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
    const shiftKey = host.querySelector('.vk-preview-body .key[data-key="Shift"]');
    if (!shiftKey) return;
    shiftKey.classList.add('vk-shift-pulse');
    shiftKey.addEventListener('animationend', () => shiftKey.classList.remove('vk-shift-pulse'), { once: true });
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
// - inside #vk-settings-dialog: swap the open dialog's views in place.
// - embedded in a host container (game's Keyboard tab): open the dialog THEN
//   switch to editor view (openLayoutEditor). Never a second editor.
function editorEntryFor(containerElement) {
    const inDialog = !!(containerElement && containerElement.closest('#vk-settings-dialog'));
    return inDialog ? openEditorView : openLayoutEditor;
}

// All selectable layouts as {id, displayName, isCustom}, built-ins first. Both
// kinds are labelled in the active script.
function listAllLayouts() {
    const builtIns = listBuiltInLayouts().map(l => ({ ...l, isCustom: false }));
    const customs = window.CustomLayouts.listCustomLayouts().map(
        l => ({ id: l.id, displayName: customLayoutLabel(l.id), isCustom: true }));
    return builtIns.concat(customs);
}

// (Re)build the picker from the built-in registry + the custom store and re-render
// the inline detail for the active layout. In MOBILE geometry this is a <select>
// dropdown; otherwise a flat radio list. Called on load, on a geometry flip, and
// after any layout mutation (refreshMount / showPickerView). The geometry class is
// applied by installPickerResponsiveness before this runs.
function renderPickerList(containerElement) {
    const list = containerElement.querySelector('#vk-layout-list');
    if (!list) throw new Error('renderPickerList: #vk-layout-list not found');
    const activeId = getVirtualKeyboardLayout();
    clearInlineDetails(containerElement, false);   // deregister before the subtree wipe
    list.textContent = '';
    if (pickerMount(containerElement).classList.contains('vk-geo-mobile')) {
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
    if (active) mountInlineDetail(containerElement, active.closest('.vk-layout-choice'), activeId, false);
}

// Dropdown selector (MOBILE): a <select> of all layouts + a compact Edit button
// (enabled only when a custom is selected), with the inline detail rendered below.
function renderPickerDropdown(containerElement, list, activeId) {
    const bar = document.createElement('div');
    bar.className = 'vk-dropdown-bar';

    const select = document.createElement('select');
    select.className = 'vk-dropdown';
    select.name = layoutRadioGroupName(containerElement);   // preserve per-surface group name
    const customTag = vkString('vkCustomChip', 'custom');
    for (const { id, displayName, isCustom } of listAllLayouts()) {
        const opt = new Option(isCustom ? `${displayName} (${customTag})` : displayName, id);
        opt.selected = id === activeId;
        select.appendChild(opt);
    }
    bar.appendChild(select);

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'vk-edit-btn vk-dropdown-edit';
    edit.textContent = vkString('vkEditBtn', '✏️ Edit');
    edit.title = vkString('vkEditSelectedTitle', 'Edit the selected custom layout');
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
    row.className = 'vk-layout-choice';

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
    name.className = 'vk-choice-name';
    name.textContent = displayName;
    row.appendChild(name);

    if (isCustom) {
        const chip = document.createElement('span');
        chip.className = 'vk-custom-chip';
        chip.textContent = vkString('vkCustomChip', 'custom');
        row.appendChild(chip);

        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'vk-edit-btn';
        edit.title = vkString('vkEditThisTitle', 'Edit this layout');
        edit.textContent = vkString('vkEditIcon', '✏️');
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
// keyboard-settings.html (.vk-detail-grid / .vk-inline-detail).
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
    detail.classList.add('vk-detail-collapsed');
    setTimeout(() => detail.remove(), DETAIL_ANIM_MS);
}

// Remove any inline detail currently mounted in this surface (only one shows).
// `animate` collapses the outgoing detail (used on a user layout switch); the
// instant path is used by full re-renders (refreshMount / geometry flip).
// Deregistering here (not on the delayed removal) takes the outgoing detail out
// of the physical-Shift driver immediately, so a collapsing detail can't re-render.
function clearInlineDetails(containerElement, animate) {
    containerElement.querySelectorAll('.vk-inline-detail').forEach(el => {
        mountedPreviews.delete(el);
        if (animate) collapseInlineDetail(el); else el.remove();
    });
}

// Animate an inline detail expanding to its content's intrinsic height. The one
// rAF is load-bearing: the collapsed state has to be the element's rendered style
// for a frame, or the browser sees no start value and jumps straight to expanded.
function expandInlineDetail(detail) {
    if (prefersReducedMotion()) return;
    detail.classList.add('vk-detail-collapsed');
    requestAnimationFrame(() => detail.classList.remove('vk-detail-collapsed'));
}

// Clone the detail template, insert it after `row`, and render it for `layoutId`.
// Fire-and-forget render (fail-fast inside renderInlineDetail). Registering in
// mountedPreviews is what puts this preview under the document-level physical-
// Shift driver; clearInlineDetails deregisters it. `animateIn` expands the detail
// from collapsed so a layout switch reads as continuous.
function mountInlineDetail(containerElement, row, layoutId, pulseShift, animateIn) {
    if (!row) return;
    const tpl = containerElement.querySelector('#vk-detail-template');
    if (!tpl) throw new Error('mountInlineDetail: #vk-detail-template not found');
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

// A built-in layout's display name in LATIN, whatever script the UI is in. The
// registry's own English — the Shavian labels are translated UI strings, which
// must never be laundered into a stored data field (or into the slug).
function builtInLatinName(layoutId) {
    const layout = BUILT_IN_LAYOUTS.find(l => l.id === layoutId);
    return layout ? layout.displayName : null;
}

// The clone-source set offered by the New… base picker: built-ins + existing
// customs, labelled in the active UI script (customs carry the "custom" chip).
// Same set the old inline base <select> offered.
function listCloneBases() {
    const bases = listBuiltInLayouts().map(l => ({ id: l.id, label: l.displayName }));
    const customTag = vkString('vkCustomChip', 'custom');
    for (const c of window.CustomLayouts.listCustomLayouts()) {
        bases.push({ id: c.id, label: `${customLayoutLabel(c.id)} (${customTag})` });
    }
    return bases;
}

// A promoted base-picker overlay and where it came from, so closeBasePicker can
// put it back. Keyed by the picker mount: each surface has its own overlay, and
// two mounted surfaces both carry an element with id "vk-base-overlay" — hence
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
    const dialog = document.getElementById('vk-settings-dialog');
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
    const list = overlay.querySelector('#vk-base-list');
    if (!list) throw new Error('openBasePicker: base-picker list markup missing');

    list.textContent = '';
    for (const { id, label } of listCloneBases()) {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'vk-base-option';
        option.textContent = label;
        option.addEventListener('click', () => {
            closeBasePicker(containerElement);
            rosterNewFromClone(id, containerElement);
        });
        list.appendChild(option);
    }

    promoteBasePicker(pickerMount(containerElement), overlay);
    overlay.hidden = false;
    const first = list.querySelector('.vk-base-option');
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
    const overlay = home ? home.overlay : mount.querySelector('#vk-base-overlay');
    if (!overlay) throw new Error('basePickerOverlay: base-picker overlay markup missing');
    return overlay;
}

// Create/import bar: New… (opens the base-picker overlay), Import… + hidden file
// input, and the overlay's own dismiss wiring. Wired once per HTML load. The other
// manage verbs (download/delete) live in the editor (reached via ✏️).
function wireCreateControls(containerElement) {
    const newBtn = containerElement.querySelector('#vk-create-new');
    if (newBtn) {
        newBtn.addEventListener('click', () => openBasePicker(containerElement));
    }
    const importBtn = containerElement.querySelector('#vk-create-import');
    const fileInput = containerElement.querySelector('#vk-create-file');
    if (importBtn && fileInput) {
        importBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => rosterImport(fileInput));
    }

    const overlay = containerElement.querySelector('#vk-base-overlay');
    const cancel = containerElement.querySelector('#vk-base-cancel');
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
    const CL = window.CustomLayouts;
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
    const CL = window.CustomLayouts;
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
    const CL = window.CustomLayouts;
    const record = CL.getCustomLayout(id);
    if (!record) return;
    if (!window.confirm(vkString('vkConfirmDelete', 'Delete custom keyboard "{{name}}"? This cannot be undone.', { name: record.displayName }))) {
        return;
    }
    const wasActive = getVirtualKeyboardLayout() === id;
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
    const CL = window.CustomLayouts;
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
    const CL = window.CustomLayouts;
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
// Two-view dialog controller. #vk-settings-dialog holds view 1 (picker+roster)
// and view 2 (editor); this swaps which shows, without a second showModal. The
// header's Back button + title reflect the current view. openEditorView loads
// the editor into #vk-view-editor; showPickerView returns to view 1 and refreshes
// the roster.
// ---------------------------------------------------------------------------

// Swap to the editor view, opening the editor locked to `id`. The editor renders
// into #vk-view-editor and calls `onExit` on Back/Done. The ENTRY POINT owns the
// Back target: a dialog-entry (default) returns to the dialog picker view; a
// mount-entry (openLayoutEditor) passes an onExit that closes the dialog so the
// user lands back on the game's own Keyboard tab, not the dialog's picker.
function openEditorView(id, onExit) {
    const dialog = document.getElementById('vk-settings-dialog');
    if (!dialog) return;
    const picker = dialog.querySelector('#vk-view-picker');
    const editorHost = dialog.querySelector('#vk-view-editor');
    if (!picker || !editorHost) return;
    window.LayoutEditor.open(id, {
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
    const dialog = document.getElementById('vk-settings-dialog');
    if (!dialog) return;
    const picker = dialog.querySelector('#vk-view-picker');
    const editorHost = dialog.querySelector('#vk-view-editor');
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
    const editorHost = document.querySelector('#vk-settings-dialog #vk-view-editor');
    return !!editorHost && editorHost.style.display !== 'none';
}

// Toggle the dialog header between the two views: the editor view shows a Back
// affordance (dirty-checked, delegated to the editor) and an editor title.
function setDialogViewChrome(view) {
    const dialog = document.getElementById('vk-settings-dialog');
    if (!dialog) return;
    const back = dialog.querySelector('#vk-dialog-back');
    const title = dialog.querySelector('#vk-dialog-title');
    if (back) {
        back.style.display = view === 'editor' ? '' : 'none';
        back.textContent = vkString('vkDialogBack', '← Back');
    }
    if (title) title.textContent = view === 'editor'
        ? vkString('vkEditorTitle', 'Edit keyboard')
        : vkString('vkDialogTitle', 'Virtual Keyboard Settings');
}

// Show settings in a modal/dialog (example implementation)
function showVirtualKeyboardSettings(dialogElement) {
    if (!dialogElement) {
        console.error('No dialog element provided to showVirtualKeyboardSettings');
        return;
    }

    loadVirtualKeyboardSettingsHTML(dialogElement).then(success => {
        if (success && dialogElement.showModal) {
            dialogElement.showModal();
        } else if (success) {
            dialogElement.style.display = 'block';
        }
    });
}

// Open keyboard settings dialog (creates dialog if needed)
async function openVirtualKeyboardSettings() {
    // Check if dialog already exists
    let dialog = document.getElementById('vk-settings-dialog');

    if (!dialog) {
        // Create dialog
        dialog = document.createElement('dialog');
        dialog.id = 'vk-settings-dialog';
        // Centre via inset+margin:auto, NOT transform: a transformed dialog becomes
        // the containing block for its position:fixed descendants, which would trap
        // the promoted glyph-picker vk inside the dialog box (clipping it). Native
        // <dialog> centering (inset 0 + margin auto) leaves the vk's fixed position
        // resolving against the viewport, so it floats free above the backdrop.
        dialog.style.cssText = 'width: 800px; max-width: 95%; border: none; border-radius: 12px; padding: 0; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3); z-index: 999999; position: fixed; inset: 0; margin: auto;';

        // Add backdrop blur styles
        const style = document.createElement('style');
        style.textContent = `
            #vk-settings-dialog::backdrop {
                background-color: rgba(0, 0, 0, 0.5);
                backdrop-filter: blur(4px);
                -webkit-backdrop-filter: blur(4px);
            }
        `;
        document.head.appendChild(style);

        const header = document.createElement('div');
        header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 16px; border-bottom: 1px solid #ddd;';

        // Back affordance (editor view only). Delegates to the editor so the
        // dirty check happens there; the editor's onExit returns to view 1.
        const backBtn = document.createElement('button');
        backBtn.id = 'vk-dialog-back';
        backBtn.textContent = vkString('vkDialogBack', '← Back');
        backBtn.style.cssText = 'border: none; background: none; font-size: 15px; cursor: pointer; color: #007bff; display: none;';
        backBtn.addEventListener('click', () => window.LayoutEditor.back());

        const title = document.createElement('h2');
        title.id = 'vk-dialog-title';
        title.textContent = vkString('vkDialogTitle', 'Virtual Keyboard Settings');
        title.style.cssText = 'margin: 0; font-size: 18px; flex: 1; text-align: center;';

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = 'width: 28px; height: 28px; border: none; border-radius: 14px; background-color: #eee; font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center;';
        // In editor view, ✕ must run the editor's dirty check (it routes through
        // back() → confirm → onExit to picker), NOT close outright — otherwise
        // unsaved edits vanish. .close() does not fire the `cancel` event, so this
        // redirect is the only guard for the ✕ path. In picker view ✕ just closes.
        closeBtn.addEventListener('click', () => {
            if (isEditorViewActive()) {
                window.LayoutEditor.back();
            } else {
                dialog.close();
            }
        });

        header.appendChild(backBtn);
        header.appendChild(title);
        header.appendChild(closeBtn);

        const container = document.createElement('div');
        container.id = 'vk-settings-container';
        container.style.cssText = 'padding: 16px;';

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
            && window.LayoutEditor.isDirty()
            && !window.LayoutEditor.hasFocusTarget();
        dialog.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape' && escapeShouldDirtyCheck()) {
                ev.preventDefault();
                ev.stopPropagation();
                window.LayoutEditor.back();
            }
        }, true);
        dialog.addEventListener('cancel', (ev) => {
            if (escapeShouldDirtyCheck()) {
                ev.preventDefault();
                window.LayoutEditor.back();
            }
        });

        // GAME SAFETY: one dialog = one close path. On close (✕ in picker view, or
        // Escape when not blocked above), tear the editor down — its close()
        // releases the vk destination back to the game input unconditionally — and
        // reset to the picker view so the next open starts clean.
        // LayoutEditor.close() is a no-op-safe teardown when never opened.
        dialog.addEventListener('close', () => {
            window.LayoutEditor.close();
            const picker = dialog.querySelector('#vk-view-picker');
            const editorHost = dialog.querySelector('#vk-view-editor');
            if (editorHost) editorHost.style.display = 'none';
            if (picker) picker.style.display = '';
            setDialogViewChrome('picker');
        });

        // Load settings HTML
        const success = await loadVirtualKeyboardSettingsHTML(container);
        if (!success) {
            console.error('[Virtual Keyboard] Failed to load settings HTML');
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
    await openVirtualKeyboardSettings();
    // Mount-entry Back target: close the dialog so the user returns to the game's
    // own Keyboard tab they came from, NOT the dialog's picker view (that picker
    // is a different surface than where they started). The dialog's `close`
    // handler runs the editor's game-safe teardown + resets to picker view for the
    // next open. See editorEntryFor / openEditorView.
    openEditorView(startId, () => {
        const dialog = document.getElementById('vk-settings-dialog');
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

// Form ligatures in the input value
function formLigatures(value, componentToLigature) {
    if (!value || Object.keys(componentToLigature).length === 0) {
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
 * Only translates when virtual keyboard is visible
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

// Translate latin keystrokes to glyphs in `inputElement`, folding ligatures as
// they complete. Host contract:
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

    let currentLayout = options.layout || getVirtualKeyboardLayout();

    // <input>/<textarea> expose .value + setSelectionRange. contenteditable
    // elements don't — their insertion is driven by the active Selection
    // and Range. Detect once at attach time; the handler branches on it.
    const isContentEditable = inputElement.isContentEditable === true
        || inputElement.getAttribute && inputElement.getAttribute('contenteditable') === 'true';

    const beforeInputHandler = (e) => {
        // The visible keyboard IS the latin->glyph map the user reads off, so
        // hidden it translates nothing and typed latin binds as itself.
        if (!isVirtualKeyboardVisible()) {
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

        if (!isShavian && keyboardMap[physicalKey]) {
            // Prevent the original character from being inserted
            e.preventDefault();

            // Insert the translated character
            const translatedChar = keyboardMap[physicalKey];

            if (isContentEditable) {
                // contenteditable path: use the live Selection. Ligatures
                // need the prefix already in the DOM to fire, so insert
                // first via execCommand (handles undo + cursor placement
                // for free) and then run the ligature pass over the run
                // we just wrote.
                if (document.execCommand) {
                    document.execCommand('insertText', false, translatedChar);
                } else {
                    insertTextAtCaret(translatedChar);
                }
                // Forming is a no-op when the layout defines no ligatures.
                formLigaturesInContentEditable(inputElement, getTapFoldTable());
                dispatchInputEvent(inputElement, 'insertText', translatedChar);
                return;
            }

            const selectionStart = inputElement.selectionStart;
            const selectionEnd = inputElement.selectionEnd;
            const before = inputElement.value.substring(0, selectionStart);
            const after = inputElement.value.substring(selectionEnd);

            let newValue = before + translatedChar + after;
            let cursorPos = before.length + translatedChar.length;

            // Forming is a no-op when the layout defines no ligatures.
            const beforeWithChar = before + translatedChar;
            const formedBefore = formLigatures(beforeWithChar, getTapFoldTable());
            if (formedBefore !== beforeWithChar) {
                newValue = formedBefore + after;
                cursorPos = formedBefore.length;
            }

            inputElement.value = newValue;
            inputElement.setSelectionRange(cursorPos, cursorPos);
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

    inputElement._vkLayoutChangeHandler = layoutChangeHandler;

    return () => {
        inputElement.removeEventListener('beforeinput', beforeInputHandler);
        delete inputElement._vkLayoutChangeHandler;
    };
}

/**
 * Change the layout for an intercepted input element
 * @param {string} layoutName - The new layout name
 */
function setInterceptionLayout(layoutName) {
    saveVirtualKeyboardLayout(layoutName);
    // Notify all inputs that might be listening
    document.querySelectorAll('input, textarea, [contenteditable]').forEach(el => {
        if (el._vkLayoutChangeHandler) {
            el._vkLayoutChangeHandler(layoutName);
        }
    });
}

// Set URL resolver (can be called separately from initVirtualKeyboard)
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
// clears the whole cache.
function invalidateLayoutCache(layoutName) {
    if (layoutName === undefined) {
        for (const key of Object.keys(KEYBOARD_MAPS)) {
            delete KEYBOARD_MAPS[key];
        }
    } else {
        delete KEYBOARD_MAPS[layoutName];
    }
}

// Helper to check if keyboard is visible
function isVirtualKeyboardVisible() {
    const keyboard = document.getElementById('virtualKeyboard');
    return keyboard && keyboard.style.display !== 'none';
}

// Destroy/cleanup function
function destroyVirtualKeyboard() {
    // Remove keyboard from DOM
    const container = document.getElementById('virtualKeyboard');
    if (container) {
        container.remove();
    }

    // Clear state
    currentLayoutName = null;
    isShiftActive = false;
    onStateChange = null;

    console.log('[Virtual Keyboard] Destroyed');
}

// New namespaced API - cleaner and more organized
window.VirtualKeyboard = {
    // Lifecycle
    init: initVirtualKeyboard,
    destroy: destroyVirtualKeyboard,

    // Visibility
    show: showVirtualKeyboard,
    hide: hideVirtualKeyboard,
    toggle: toggleVirtualKeyboard,
    isVisible: isVirtualKeyboardVisible,

    // The platform's show/hide shortcut ("⌘K" / "Ctrl+K"), for a host to append
    // to its own toggle label. See toggleShortcutLabel.
    toggleShortcutLabel: toggleShortcutLabel,

    // Layout management
    getLayout: getVirtualKeyboardLayout,
    setLayout: setKeyboardLayout,

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
    onStateChange: setVirtualKeyboardStateCallback,
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
        loadSettingsHTML: loadVirtualKeyboardSettingsHTML,
        showSettings: showVirtualKeyboardSettings,
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
        // UI-string helpers for the sibling editor: vkString resolves a key in the
        // active script (Latin fallback); applyUiStrings stamps [data-i18n] etc.
        vkString: vkString,
        applyUiStrings: applyUiStrings,
        // Active-script label resolution for the user-AUTHORED labels no string
        // table can carry (a custom layout's Shavian name/description), Latin
        // fallback. The editor's header line resolves through the same helper.
        preferredScriptLabel: preferredScriptLabel,
        customLayoutLabel: customLayoutLabel,
        // Editor/roster entry points and the built-in layout registry — opened
        // by editorEntryFor/roster internally, not part of the host contract.
        openLayoutEditor: openLayoutEditor,
        openSettings: openVirtualKeyboardSettings,
        listBuiltInLayouts: listBuiltInLayouts,
        // Structural-family split + built-in-name check; validateLayout uses
        // isBuiltInLayoutName to reject an unknown custom-layout `base`.
        structuralFamilyOf: structuralFamilyOf,
        isBuiltInLayoutName: isBuiltInLayoutName,
        // Picker description resolution + the import splitter — exposed for tests.
        previewDescription: previewDescription,
        splitImportedLayout: splitImportedLayout,
        // Manage verbs for a stored custom — hosted by the editor (per-open
        // layout) now that they've left the picker. Each re-renders every surface
        // via notifyLayoutsChanged.
        downloadCustomLayout: rosterDownload,
        deleteCustomLayout: rosterDelete
    }
};

