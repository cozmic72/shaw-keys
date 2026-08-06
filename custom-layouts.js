// Custom keyboard layouts — user-created, locally stored, and shareable.
//
// A custom layout is the same JSON shape as a built-in
// (src/virtual-keyboard/keyboard_layout_*.json): { keys, ligatures }.
// We wrap that bare layout in a small record carrying a
// display name and timestamps, store the records in one localStorage blob
// keyed by slug, and address them app-wide by the id "custom:<slug>".
//
// This module is a plain script (no modules/bundler), exposing its helpers on
// window like utils.js / game-state.js do, so it can be <script src>'d before
// main.js.

const CUSTOM_LAYOUTS_KEY = 'customLayouts';
const CUSTOM_LAYOUT_SCHEMA = 1;
const CUSTOM_ID_PREFIX = 'custom:';

// ---------------------------------------------------------------------------
// Recognized physical key tokens.
//
// These are EXACTLY the tokens a layout's `keys` may bind, derived from what
// the renderer (updateKeyboardLabels in virtual-keyboard.js) and the scorer
// (build_reverse_map / SHIFTED_SYMBOL_BASE in tools/kbd_score/score_layout.py)
// accept: the unshifted character keys plus their shifted forms. Modifier keys
// (Shift, Tab, Enter, Backspace, CapsLock) carry no binding and are excluded.
// ---------------------------------------------------------------------------

// Unshifted base keys: digits, the punctuation block, and the space bar. Kept
// in sync with the data-key set in virtual-keyboard.html.
const BASE_PUNCT_KEYS = [
    '`', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=',
    '[', ']', '\\', ';', '\'', ',', '.', '/', ' '
];

// Unshifted base key -> its US-ANSI shifted form. Mirrors the shiftMap in
// updateKeyboardLabels (and the inverse of SHIFTED_SYMBOL_BASE in the scorer).
const SHIFTED_SYMBOL = {
    '1': '!', '2': '@', '3': '#', '4': '$', '5': '%',
    '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
    '`': '~', '-': '_', '=': '+',
    '[': '{', ']': '}', '\\': '|',
    ';': ':', '\'': '"',
    ',': '<', '.': '>', '/': '?'
};

// Build the full allowed-token set once: base letters a–z, their uppercase
// (shift) forms, the punctuation/digit/space keys, and the shifted symbols.
const ALLOWED_KEY_TOKENS = (function buildAllowedKeyTokens() {
    const tokens = new Set(BASE_PUNCT_KEYS);
    for (let code = 97; code <= 122; code++) {           // 'a'..'z'
        const lower = String.fromCharCode(code);
        tokens.add(lower);
        tokens.add(lower.toUpperCase());
    }
    for (const shifted of Object.values(SHIFTED_SYMBOL)) {
        tokens.add(shifted);
    }
    return tokens;
})();

// The shift-layer token for an unshifted token: uppercase for a letter, the
// US-ANSI shifted symbol for a punctuation/digit key, or null when there is none
// (e.g. space). The ONE canonical definition — the editor and the roster coverage
// both consume this so their shift maps can't drift.
function shiftedTokenOf(token) {
    if (token >= 'a' && token <= 'z') {
        return token.toUpperCase();
    }
    return SHIFTED_SYMBOL[token] || null;
}

// ---------------------------------------------------------------------------
// Alphabet coverage — does a layout let you TYPE the game's minimum character
// set? This measures PRODUCIBLE CHARACTERS, not empty key positions (a complete
// layout legitimately has empty keys). The ONE canonical computation behind BOTH
// the roster badge and the editor coverage line, so they can't drift.
// ---------------------------------------------------------------------------

const VS1_SELECTOR = '︀';  // variation selector 1, glued onto a base letter

// The required target set: the 48 Shavian letters (U+10450–U+1047F) + the namer
// dot '·' + the period '.'. Computed from the range, not a magic 50.
const SHAVIAN_BLOCK_START = 0x10450;
const SHAVIAN_BLOCK_END = 0x1047F;
const REQUIRED_CHARS = (function buildRequiredChars() {
    const out = [];
    for (let cp = SHAVIAN_BLOCK_START; cp <= SHAVIAN_BLOCK_END; cp++) {
        out.push(String.fromCodePoint(cp));
    }
    out.push('·');  // namer dot
    out.push('.');       // period
    return out;
})();

// The two VS1 letters (a base Shavian letter + VS1) are OPTIONAL bonus, never
// required. Derived from whichever base letters carry VS1 variants in the palette
// the editor ships (SHAVIAN_PALETTE), so this stays in sync with what's typeable.
function vs1TargetChars() {
    const palette = (window.LayoutEditor && window.LayoutEditor.SHAVIAN_PALETTE) || [];
    return palette.filter(ch => Array.from(ch).length === 2 && ch.endsWith(VS1_SELECTOR));
}

// The set of characters a layout can PRODUCE: every char bound directly on a key
// (either layer — `keys` is a flat token→glyph map covering both), UNION every
// ligature result whose components are themselves producible (folded via the
// canonical engine, iterated to a fixpoint so chained compounds resolve).
function producibleChars(bare) {
    const keys = (bare && bare.keys) || {};
    const ligatures = (bare && bare.ligatures) || {};
    const produced = new Set(Object.values(keys));
    const componentToLigature = window.VirtualKeyboard.getComponentToLigature({ ligatures });
    // Fixpoint: a compound becomes producible once all its components are, which
    // may in turn unlock a compound built from it. Loop until nothing new appears.
    let grew = true;
    while (grew) {
        grew = false;
        for (const [result, spellings] of Object.entries(ligatures)) {
            if (produced.has(result)) continue;
            for (const spelling of spellings) {
                if (spelling.every(component => produced.has(component)) &&
                    window.VirtualKeyboard.formLigatures(spelling.join(''), componentToLigature) === result) {
                    produced.add(result);
                    grew = true;
                    break;
                }
            }
        }
    }
    return produced;
}

// Alphabet coverage of a bare layout: which of the REQUIRED_CHARS the layout can
// produce (directly or via ligature), the missing ones by name, and the OPTIONAL
// VS1 letters as a separate bonus tally. `missing` lists the actual absent glyphs
// so the UI can name them — not a key count.
function coverage(bare) {
    const produced = producibleChars(bare);
    const missing = REQUIRED_CHARS.filter(ch => !produced.has(ch));
    const vs1 = vs1TargetChars();
    return {
        required: REQUIRED_CHARS.length,
        produced: REQUIRED_CHARS.length - missing.length,
        missing: missing,
        vs1Optional: { produced: vs1.filter(ch => produced.has(ch)).length, total: vs1.length },
    };
}

// ---------------------------------------------------------------------------
// Validation — fail-fast: throw an Error with a human message on the FIRST
// problem, return nothing on success.
// ---------------------------------------------------------------------------

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A binding/ligature-component value must be a single base grapheme (one code
// point, optionally + VS1), a literal space, or a self-mapped punctuation
// character. Returns true for a single typeable atom; multi-letter strings are
// rejected by the caller (they belong in `ligatures`).
function isSingleGrapheme(value) {
    if (typeof value !== 'string' || value.length === 0) {
        return false;
    }
    const VS1 = '︀';  // variation selector 1, glued onto a base letter
    const chars = Array.from(value);  // code points, not UTF-16 units
    if (chars.length === 1) {
        return true;
    }
    // A base letter plus a glued VS1 (e.g. 𐑺 + VS1 = the "yeah" letter).
    if (chars.length === 2 && chars[1] === VS1) {
        return true;
    }
    return false;
}

// Reject a NON-CONVERGING ligature table. formLigatures folds the typed suffix
// to a fixpoint: each fold replaces a component sequence with one glyph, so it
// strictly shortens UNLESS the sequence is a single character — a length-1
// spelling X <- Y just renames Y to X without shrinking. Only those length-1
// spellings can drive an endless fold (e.g. X<-Y, Y<-X, or X<-X), so the
// convergence guarantee is exactly: the graph of length-1 rewrites is acyclic.
//
// A multi-character self-spelling such as "𐑺": [["𐑺","𐑮"]] (seen in several
// built-in layouts) is fine — it consumes 𐑺𐑮 and emits 𐑺, which shrinks — and
// must NOT be rejected. Throws naming the cycle path on the first true cycle.
function assertLigaturesAcyclic(ligatures) {
    const results = new Set(Object.keys(ligatures));

    // Edge result -> the single component it rewrites from, but only for
    // length-1 spellings (the non-shrinking kind) whose component is itself a
    // ligature result. Longer spellings always shrink and can't loop.
    const dependencies = result => {
        const deps = new Set();
        for (const spelling of ligatures[result]) {
            if (spelling.length === 1 && results.has(spelling[0])) {
                deps.add(spelling[0]);
            }
        }
        return deps;
    };

    const VISITING = 1, DONE = 2;
    const state = new Map();
    const path = [];

    const visit = node => {
        if (state.get(node) === DONE) {
            return;
        }
        if (state.get(node) === VISITING) {
            const cycleStart = path.indexOf(node);
            const cycle = path.slice(cycleStart).concat(node).join(' -> ');
            throw new Error(`Cyclic ligature definition: ${cycle}`);
        }
        state.set(node, VISITING);
        path.push(node);
        for (const dep of dependencies(node)) {
            visit(dep);
        }
        path.pop();
        state.set(node, DONE);
    };

    for (const result of results) {
        visit(result);
    }
}

// Validate a bare layout object ({ base?, keys, ligatures }).
// Throws on the first problem with a message safe to show the user verbatim;
// returns nothing on success. NOTE: validates the bare layout, not the wrapper
// record.
function validateLayout(layoutObj) {
    if (!isPlainObject(layoutObj)) {
        throw new Error('Layout must be a JSON object.');
    }
    if (!isPlainObject(layoutObj.keys) || Object.keys(layoutObj.keys).length === 0) {
        throw new Error('Layout "keys" must be a non-empty object.');
    }

    // (a) base, if present, names the built-in this layout was cloned from — it
    //     decides the layout's structural family (see structuralFamilyOf). A
    //     missing base is allowed (built-ins carry none; the resolver falls back
    //     to the layout's own name). But a present base that doesn't name a
    //     known built-in is a corrupt/forged record — reject it rather than let
    //     it silently resolve to the default 'compact' family.
    if (layoutObj.base !== undefined) {
        if (typeof layoutObj.base !== 'string' ||
            !window.VirtualKeyboard._internal.isBuiltInLayoutName(layoutObj.base)) {
            throw new Error(
                `Layout "base" must name a built-in layout (got ` +
                `"${layoutObj.base}").`);
        }
    }

    // (b) every keys-key is a recognized physical key token.
    // (c) every keys-value is a single grapheme, a space, or self-punctuation.
    for (const [token, value] of Object.entries(layoutObj.keys)) {
        if (!ALLOWED_KEY_TOKENS.has(token)) {
            throw new Error(`Unknown physical key "${token}" in "keys".`);
        }
        if (!isSingleGrapheme(value)) {
            throw new Error(
                `Key "${token}" maps to "${value}", which is not a single ` +
                `character (multi-letter bindings belong in "ligatures").`);
        }
    }

    // (d) ligatures, if present: object of result -> array of component-arrays,
    //     each component a non-empty string, and the whole graph acyclic.
    if (layoutObj.ligatures !== undefined) {
        if (!isPlainObject(layoutObj.ligatures)) {
            throw new Error('"ligatures" must be an object.');
        }
        for (const [result, spellings] of Object.entries(layoutObj.ligatures)) {
            // The result must be a single glyph. This is what guarantees every
            // fold strictly shrinks the buffer (a >=2-component spelling becomes
            // 1 glyph), so the engine's fixpoint fold always terminates. Without
            // it, a same-length rewrite like ab->ba could pass validation yet
            // loop forever at typing time. A single result keeps the acyclicity
            // check below (which only inspects length-1 spellings) sufficient.
            if (!isSingleGrapheme(result)) {
                throw new Error(
                    `Ligature result "${result}" must be a single character.`);
            }
            if (!Array.isArray(spellings)) {
                throw new Error(`Ligature "${result}" must map to an array of spellings.`);
            }
            for (const spelling of spellings) {
                if (!Array.isArray(spelling)) {
                    throw new Error(`Ligature "${result}" has a spelling that is not an array.`);
                }
                for (const component of spelling) {
                    if (typeof component !== 'string' || component.length === 0) {
                        throw new Error(
                            `Ligature "${result}" has an empty or non-string component.`);
                    }
                }
            }
        }
        assertLigaturesAcyclic(layoutObj.ligatures);
    }
}

// ---------------------------------------------------------------------------
// Store — one localStorage blob: { "<slug>": record, ... }.
// ---------------------------------------------------------------------------

function loadCustomLayouts() {
    const raw = localStorage.getItem(CUSTOM_LAYOUTS_KEY);
    if (!raw) {
        return {};
    }
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
        // A corrupt blob is a real fault, not something to silently paper over.
        throw new Error('Stored custom layouts are corrupt (expected a JSON object).');
    }
    return parsed;
}

function writeCustomLayouts(map) {
    localStorage.setItem(CUSTOM_LAYOUTS_KEY, JSON.stringify(map));
}

// Strip the "custom:" prefix if present, returning the bare slug.
function slugOf(id) {
    return id.startsWith(CUSTOM_ID_PREFIX) ? id.slice(CUSTOM_ID_PREFIX.length) : id;
}

function getCustomLayout(slug) {
    const map = loadCustomLayouts();
    return map[slugOf(slug)] || null;
}

// Resolve an id (the "custom:<slug>" form or a bare slug) to its bare layout
// object, or null if no such custom layout exists. This is the resolver the
// keyboard module registers — it must return null (not throw) for a missing
// layout so the keyboard branch can decide how to fail.
function getCustomLayoutData(id) {
    if (typeof id !== 'string' || !id.startsWith(CUSTOM_ID_PREFIX)) {
        return null;
    }
    const record = getCustomLayout(slugOf(id));
    return record ? record.layout : null;
}

function saveCustomLayout(record) {
    const map = loadCustomLayouts();
    map[record.name] = record;
    writeCustomLayouts(map);
}

function deleteCustomLayout(slug) {
    const map = loadCustomLayouts();
    delete map[slugOf(slug)];
    writeCustomLayouts(map);
}

// Array of { id, displayName } for selector population.
function listCustomLayouts() {
    const map = loadCustomLayouts();
    return Object.values(map).map(record => ({
        id: CUSTOM_ID_PREFIX + record.name,
        displayName: record.displayName
    }));
}

// Resolve any layout id to a human display name, or null if it's not a known
// custom layout (built-ins are handled by the keyboard module's own table).
function getCustomLayoutDisplayName(id) {
    if (typeof id !== 'string' || !id.startsWith(CUSTOM_ID_PREFIX)) {
        return null;
    }
    const record = getCustomLayout(slugOf(id));
    return record ? record.displayName : null;
}

// The user-authored description for a custom layout, '' when unset. Records
// stored before the field existed simply read as empty — no migration, no
// seeding. Returns null only when `id` names no known custom.
function getCustomLayoutDescription(id) {
    return getCustomLayoutMetadata(id, 'description');
}

// The Shavian counterpart of the display name, '' when the author left it unset.
function getCustomLayoutShavianDisplayName(id) {
    return getCustomLayoutMetadata(id, 'shavianDisplayName');
}

// The Shavian counterpart of the description, '' when the author left it unset.
function getCustomLayoutShavianDescription(id) {
    return getCustomLayoutMetadata(id, 'shavianDescription');
}

// One metadata field of a stored custom, '' when unset; null when `id` names no
// known custom (the caller distinguishes "unavailable" from "left blank").
function getCustomLayoutMetadata(id, field) {
    if (typeof id !== 'string' || !id.startsWith(CUSTOM_ID_PREFIX)) {
        return null;
    }
    const record = getCustomLayout(slugOf(id));
    return record ? (record[field] || '') : null;
}

// ---------------------------------------------------------------------------
// Wrapper metadata — the author-supplied labels carried BESIDE the bare layout.
// Latin is canonical (identity: slug, filename, leaderboard); the Shavian pair
// is optional and reads as '' when unset. Named once here so the record builder,
// the editor's save path and the export/import round-trip can never drift.
// ---------------------------------------------------------------------------

const LAYOUT_METADATA_FIELDS = [
    'displayName', 'description', 'shavianDisplayName', 'shavianDescription'
];

// Pick the metadata fields out of `source` (a record, an imported file, or the
// editor's field values), normalising every absent or non-string one to ''.
function layoutMetadata(source) {
    const metadata = {};
    for (const field of LAYOUT_METADATA_FIELDS) {
        const value = source ? source[field] : undefined;
        metadata[field] = typeof value === 'string' ? value : '';
    }
    return metadata;
}

// ---------------------------------------------------------------------------
// Slug — a URL/filename-safe, unique key derived from the display name.
// ---------------------------------------------------------------------------

// Lowercase, ASCII-fold to [a-z0-9-], collapse/trim dashes. Falls back to
// "layout" when the name has no usable characters (e.g. all Shavian).
function slugifyName(displayName) {
    const base = (displayName || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return base || 'layout';
}

// A slug not already used by a stored layout, suffixing -2, -3, ... on clash.
function uniqueSlug(displayName) {
    const existing = loadCustomLayouts();
    const base = slugifyName(displayName);
    if (!existing[base]) {
        return base;
    }
    let n = 2;
    while (existing[`${base}-${n}`]) {
        n++;
    }
    return `${base}-${n}`;
}

// Build a fresh wrapper record from a (validated) bare layout and its metadata.
// Metadata lives on the WRAPPER, never inside `layout` — the bare layout stays
// the portable keyboard definition validateLayout checks and tools/kbd_score
// consumes. The slug is minted from the Latin displayName alone: it is the
// identity used for filenames and leaderboard rows.
function makeCustomLayoutRecord(layoutObj, metadata) {
    const now = new Date().toISOString();
    return Object.assign({
        schema: CUSTOM_LAYOUT_SCHEMA,
        name: uniqueSlug((metadata || {}).displayName),
    }, layoutMetadata(metadata), {
        createdAt: now,
        updatedAt: now,
        layout: layoutObj
    });
}

// True for the "custom:<slug>" id form.
function isCustomLayoutId(id) {
    return typeof id === 'string' && id.startsWith(CUSTOM_ID_PREFIX);
}

// Expose on window, matching the plain-script pattern of the other modules.
// analyticsLayoutId/leaderboardLayoutName intentionally live in the site
// (utils.js) — they're leaderboard/analytics concerns, not keyboard-store ones.
window.CustomLayouts = {
    CUSTOM_ID_PREFIX: CUSTOM_ID_PREFIX,
    validateLayout: validateLayout,
    loadCustomLayouts: loadCustomLayouts,
    saveCustomLayout: saveCustomLayout,
    deleteCustomLayout: deleteCustomLayout,
    getCustomLayout: getCustomLayout,
    getCustomLayoutData: getCustomLayoutData,
    getCustomLayoutDisplayName: getCustomLayoutDisplayName,
    getCustomLayoutDescription: getCustomLayoutDescription,
    getCustomLayoutShavianDisplayName: getCustomLayoutShavianDisplayName,
    getCustomLayoutShavianDescription: getCustomLayoutShavianDescription,
    layoutMetadata: layoutMetadata,
    LAYOUT_METADATA_FIELDS: LAYOUT_METADATA_FIELDS,
    listCustomLayouts: listCustomLayouts,
    slugifyName: slugifyName,
    uniqueSlug: uniqueSlug,
    makeCustomLayoutRecord: makeCustomLayoutRecord,
    isCustomLayoutId: isCustomLayoutId,
    // The canonical US-ANSI unshifted->shifted symbol map, reused by the layout
    // editor's shift layer so the two never drift.
    SHIFTED_SYMBOL: SHIFTED_SYMBOL,
    // The full set of bindable physical-key tokens (both layers).
    ALLOWED_KEY_TOKENS: ALLOWED_KEY_TOKENS,
    // Canonical helpers — coverage is the SINGLE alphabet-completeness source both
    // the roster badge and the editor line consume, so they can't drift.
    shiftedTokenOf: shiftedTokenOf,
    coverage: coverage
};
