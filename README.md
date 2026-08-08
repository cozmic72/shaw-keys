# Virtual Keyboard

An on-screen Shavian keyboard for the browser, with QWERTY-to-Shavian keystroke
translation, a layout picker, and a visual layout editor. No build step, no
dependencies, no bundler — plain scripts served as files.

## Architecture

Three scripts sharing one global scope, loaded in a fixed order:

- **`virtual-keyboard.js`** — the keyboard itself: rendering, dragging, layout
  loading, keystroke interception, the settings dialog. Publishes
  `window.VirtualKeyboard`.
- **`custom-layouts.js`** — the store for user-created layouts: validation,
  `localStorage` persistence, alphabet-coverage checks. Publishes
  `window.CustomLayouts`.
- **`layout-editor.js`** — the visual editor for those layouts. Publishes
  `window.LayoutEditor`.

**The three are not independent.** `virtual-keyboard.js` calls
`window.CustomLayouts` unconditionally at a dozen sites and `window.LayoutEditor`
at nine, and reaches them by lazy `window` lookup rather than by captured
reference, precisely so it can be loaded first. Omitting either sibling does not
degrade the keyboard gracefully — it throws on the first custom-layout or editor
path the user reaches. Load all three, in the order above.

The library fetches the rest of its assets at runtime relative to
`virtual-keyboard.js`'s own `src`: `virtual-keyboard.html`,
`keyboard-settings.html` and `layout-editor.html`; `keyboard_layouts.json` and
the `keyboard_layout_*.json` for whichever layout is active; the `*_base.png` /
`*_shift.png` previews the picker renders; and one `translations_*.json`.
Everything in this repository must therefore be served from one flat directory,
not just the files named in a `<script>` tag.

### Host requirements

The library has no host callbacks to wire and no configuration to supply. It
resolves custom layouts against its own store by default, so a consumer that
loads all three scripts gets a working keyboard from `init` alone. The
`setCustomLayoutResolver` and `setResourceUrlResolver` hooks exist for browser
extensions, where assets do not live at a path derived from `document`.

The `@font-face` rule in `virtual-keyboard.css` fetches Inter Alia from
`https://joro.io/fonts/InterAlia-VF.otf`. No font file ships here. Without it the
keyboard still functions, but Shavian letters carrying a variation selector (VS1)
render as their bare base letter, because no system font draws those variants.

### Cache busting, and why there is no version

`virtual-keyboard.js` reads a `?v=` parameter off its own `<script src>` and
appends it to every asset URL it fetches. That is the whole mechanism. The value
is never reported, logged, or compared against anything — and `init`'s second
parameter, despite its name, is ignored entirely; the query string is the only
input.

This is deliberate, and it is why the library needs no build step. Cache busting
asks whether an asset changed since the browser last fetched it; any value that
changes when the asset changes answers it. Versioning asks a different question —
what build is this, traceable to what commit — and a library has no occasion to
answer it, because a library is not independently deployed. Whatever ships the
library carries the version. Supply a value that changes when your own assets do,
typically your application's version:

```html
<script src="virtual-keyboard/virtual-keyboard.js?v=1.4.2"></script>
```

Omit it during development and assets are fetched unversioned.

## Getting started

Serve every file in this repository from one directory. Then:

```html
<link rel="stylesheet" href="virtual-keyboard/virtual-keyboard.css">
<link rel="stylesheet" href="virtual-keyboard/layout-editor.css">

<script src="virtual-keyboard/virtual-keyboard.js?v=1.0.0"></script>
<script src="virtual-keyboard/custom-layouts.js?v=1.0.0"></script>
<script src="virtual-keyboard/layout-editor.js?v=1.0.0"></script>

<div id="keyboardContainer"></div>
<input id="practiceInput" type="text">

<script>
    const VK = window.VirtualKeyboard;

    await VK.init(document.getElementById('keyboardContainer'), null, null, {
        script: 'shavian',
        dialect: 'british'
    });

    VK.enableKeystrokeInterception(document.getElementById('practiceInput'));
    VK.show();
</script>
```

`init` resolves to `false` if the keyboard HTML could not be fetched — a wrong
asset path is the usual cause. Keystroke translation is gated on visibility:
while the keyboard is hidden, typed Latin binds as itself.

Translation looks up the physical key, not the character delivered. A layout
binds the ASCII quote keys `'` and `"`; where an OS substitutes a typographic
quote for one of them — macOS "smart quotes" sends U+2019 for `'` — the
substitute folds back to its ASCII key first. Binding U+2018/U+2019/U+201C/U+201D
in a layout is therefore never correct: they are not keys.

## API

**The module boundary is a convention, not a mechanism.** These are plain
scripts, not ES modules — there is no `export`, no `module.exports`, and nothing
enforces the boundary described here. `virtual-keyboard.js` and
`custom-layouts.js` leak every top-level declaration into the global scope: 118
and 26 functions respectively, all reachable as bare globals. Calling them
directly happens to work today. Do not: they are internals, they carry no
compatibility promise, and the previous README's habit of documenting a handful
of them as the API is what this section replaces.

`layout-editor.js` is the exception — it is wrapped in an IIFE, so its 77
functions stay private and only `window.LayoutEditor` is reachable.

The supported surface is **`window.VirtualKeyboard`**, and only the properties
named at its top level. Its `_internal` sub-object is exactly what it says:
present for the sibling scripts and for tests, excluded from the contract.

`window.CustomLayouts` and `window.LayoutEditor` are published for
`virtual-keyboard.js`'s use, not for yours. A consumer manages layouts through
`VirtualKeyboard.mountSettings` and the entry points below.

Read the definition of `window.VirtualKeyboard` at the foot of
`virtual-keyboard.js` for the full list. Each entry is a one-line alias to the
function that implements it, and the doc comment on that function is the
authority on its arguments. Grouped by purpose, the entry points are:

| Purpose | Entry points |
|---|---|
| Lifecycle | `init`, `destroy` |
| Visibility | `show`, `hide`, `toggle`, `isVisible`, `toggleShortcutLabel` |
| Layouts | `getLayout`, `setLayout`, `setDefaultLayout` |
| Settings UI | `mountSettings`, `refreshMount`, `onLayoutsChanged` |
| UI strings | `setScript`, `setUiStrings` |
| State | `onStateChange`, `getState`, `setSuppressKeydownPredicate` |
| Input routing | `setDestination`, `getDestinationInput`, `setFoldLigatures` |
| Keystrokes | `enableKeystrokeInterception` |
| Ligatures | `setLigaturePreviewActive`, `refreshLigaturePreview`, `getComponentToLigature`, `formLigatures` |

Two of these are easy to reach for and wrong. `enableKeystrokeInterception` is
for hosts *without* their own input pipeline; a host that owns one drives
translation itself and feeds `refreshLigaturePreview`. `setSuppressKeydownPredicate`
exists so a host showing its own modal can stop the library consuming global
keydowns — without it, the keyboard competes with the modal for the keyboard.

### Built-in layouts

Five, registered in `keyboard_layouts.json`: `imperial`, `igc`, `qwerty`,
`2layer`, `jafl`. `listBuiltInLayouts` is on `_internal`, not the supported
surface — read the JSON instead.

The other `keyboard_layout_*.json` files are experimental and not registered.
They load if named explicitly but are not offered in the picker.

## Configuration

### UI strings

The library ships its own strings — `translations.csv` and the generated
`translations_{latin,british,american}.json`. A consumer needs no translation
data. Select one with `setScript(script, dialect)` or the equivalent `init`
options; it rejects on an unknown script or an unreachable table.

`setUiStrings(active, base)` overrides them for a host with its own pipeline.
Resolution runs highest-first: `setUiStrings`'s `active`, then its `base`, then
the shipped table for the selected script, then the English fallback baked into
each `vkString` call.

### `localStorage`

Two keys, written independently:

- **`io.joro.virtual-keyboard.Settings`** — the keyboard's own settings, by
  `virtual-keyboard.js`. Currently the active `layout` and the dragged
  `position`; unknown keys in the stored object are preserved across writes.
- **`customLayouts`** — the user's saved layouts, by `custom-layouts.js`. One
  blob mapping slug to layout record.

The second name is unprefixed, so it will collide with any host that happens to
use `customLayouts` for its own purposes. Nothing namespaces it.

Neither key is migrated or versioned. Clearing them resets to `imperial` at the
default position with no custom layouts.

## Contributing

`translations.csv` is the source for the three generated
`translations_*.json` tables. The generator lives in the `shaw-type` repository
(`tools/generate_translations.py`) and has not been extracted here, so
regenerating the tables currently requires a `shaw-type` checkout. Edit the CSV
and the JSON together until it moves.

There is no test runner and no dependencies. A test is a standalone Node script
under `tools/`, run directly and reporting failure through its exit code:

```sh
node tools/quote_substitution_test.mjs
```

The wider suites that cover this code (`layout_editor_test.mjs` and its
siblings) also still live in `shaw-type/tools/` and load the library from that
checkout's copy, so they do not exercise this repository's working tree.
