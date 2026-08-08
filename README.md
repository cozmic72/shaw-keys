# Virtual Keyboard

An on-screen Shavian keyboard for the browser, with QWERTY-to-Shavian keystroke
translation, a layout picker, and a visual layout editor. No build step, no
dependencies, no bundler — ES modules served as files.

## Architecture

Three ES modules. A host loads **one**:

- **`virtual-keyboard.js`** — the keyboard itself: rendering, dragging, layout
  loading, keystroke interception, the settings dialog. The entry point.
- **`custom-layouts.js`** — the store for user-created layouts: validation,
  `localStorage` persistence, alphabet-coverage checks.
- **`layout-editor.js`** — the visual editor for those layouts.

The three depend on each other by `import`, including a cycle: `custom-layouts.js`
derives its VS1 bonus targets from the editor's `SHAVIAN_PALETTE`, and the editor
imports the store back. The browser resolves the whole graph before any module
body runs, so importing `virtual-keyboard.js` brings the other two with it and a
host cannot load a partial library.

The library fetches the rest of its assets at runtime relative to its own
`import.meta.url`: `virtual-keyboard.html`, `keyboard-settings.html` and
`layout-editor.html`; `keyboard_layouts.json` and the `keyboard_layout_*.json`
for whichever layout is active; and one `translations_*.json`. Everything in this
repository must therefore be served from one flat directory, not just the file
named in the `<script>` tag.

**Module scripts are fetched with CORS, which `file://` cannot satisfy.** The
library must be served over `http(s)://` or a custom scheme; an app embedding it
in a web view has to serve its bundle rather than load it off disk. `shave`'s iOS
app registers a `WKURLSchemeHandler` for exactly this reason.

### Host requirements

The library has no host callbacks to wire and no configuration to supply. It
resolves custom layouts against its own store by default, so a consumer gets a
working keyboard from `init` alone. The `setCustomLayoutResolver` and
`setResourceUrlResolver` hooks exist for browser extensions, where assets do not
live at a path derived from the library's own URL.

### Fonts and staging

No font file ships here. The `@font-face` rule in `virtual-keyboard.css` carries a
`{{FONT_URL}}` token that `tools/stage.sh` resolves while copying the library into
a consumer's docroot:

```sh
virtual-keyboard/tools/stage.sh --font-url /fonts path/to/docroot/virtual-keyboard
```

`--font-url` names the directory serving `InterAlia-VF.otf`. It is mandatory and
has no default: the right value is a property of the consumer's docroot, and a
wrong guess renders in a fallback face without failing. Staging then verifies that
no token survived, so a missed substitution stops the build rather than shipping
CSS the browser silently discards.

Copying the files without staging leaves the token unresolved, and no Shavian font
loads. Without the font the keyboard still works, but letters carrying a variation
selector (VS1) render as their bare base letter, because no system font draws
those variants.

### Cache busting, and why there is no version

`virtual-keyboard.js` reads a `?v=` parameter off its own `import.meta.url` and
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
<script type="module" src="virtual-keyboard/virtual-keyboard.js?v=1.4.2"></script>
```

The value rides on the entry point's URL and every asset fetched through
`getResourceUrl`. It does **not** reach `custom-layouts.js` or `layout-editor.js`:
they are imported by bare relative specifier, so a host that changes only a
sibling must rely on normal HTTP cache headers to see it. Serve the directory
with sensible `Cache-Control` rather than depending on `?v=` alone.

Omit it during development and assets are fetched unversioned.

## Getting started

Stage the library into one directory served over `http(s)://` — not `file://` —
passing the URL under which that host serves `InterAlia-VF.otf`:

```sh
virtual-keyboard/tools/stage.sh --font-url /fonts public/virtual-keyboard
```

Then:

```html
<link rel="stylesheet" href="virtual-keyboard/virtual-keyboard.css">
<link rel="stylesheet" href="virtual-keyboard/layout-editor.css">

<div id="keyboardContainer"></div>
<input id="practiceInput" type="text">

<script type="module">
    import { VirtualKeyboard as VK }
        from './virtual-keyboard/virtual-keyboard.js?v=1.0.0';

    await VK.init(document.getElementById('keyboardContainer'), null, null, {
        script: 'shavian',
        dialect: 'british'
    });

    VK.enableInterception(document.getElementById('practiceInput'));
    VK.show();
</script>
```

The two stylesheets are still the host's to include; only the scripts collapsed
to one.

`init` resolves to `false` if the keyboard HTML could not be fetched — a wrong
asset path is the usual cause. Keystroke translation is gated on visibility:
while the keyboard is hidden, typed Latin binds as itself.

Translation looks up the physical key, not the character delivered. Where an OS
substitutes a typographic quote for one of the ASCII quote keys `'` and `"` —
macOS "smart quotes" sends U+2019 for `'` — the substitute folds back to its
ASCII key first. Binding U+2018/U+2019/U+201C/U+201D in a layout is therefore
never correct: they are not keys.

A key the layout does not bind inserts itself, which is how punctuation a
Shavian layout does not remap reaches the document. What inserts is the key
**pressed**, so a layout with no `'` binding still yields U+0027 rather than the
U+2019 the OS delivered.

## API

**The module boundary is now a mechanism.** Each file is an ES module, so its
top-level declarations are private to it and only what it `export`s is reachable.
The bare globals the previous plain scripts leaked — 118 functions from
`virtual-keyboard.js`, 26 from `custom-layouts.js` — are gone. Anything that
called one directly must move to the supported surface.

The supported surface is the **`VirtualKeyboard`** export, and only the
properties named at its top level. Its `_internal` sub-object is exactly what it
says: present for the sibling modules and for tests, excluded from the contract.

`CustomLayouts` and `LayoutEditor` are exported for `virtual-keyboard.js`'s use,
not for yours. A consumer manages layouts through `VirtualKeyboard.mountSettings`
and the entry points below.

### The `window` globals are a transition surface

Each module also assigns its export to `window` — `window.VirtualKeyboard`,
`window.CustomLayouts`, `window.LayoutEditor` — so a consumer that has not yet
moved to `import` keeps working. **These three assignments exist only to let the
consumers migrate one at a time, and are to be deleted once all of them
`import` instead.** Do not write new code against them.

Read the definition of `VirtualKeyboard` at the foot of `virtual-keyboard.js` for
the full list. Each entry is a one-line alias to the function that implements it,
and the doc comment on that function is the authority on its arguments. Grouped
by purpose, the entry points are:

| Purpose | Entry points |
|---|---|
| Lifecycle | `init`, `destroy` |
| Visibility | `show`, `hide`, `toggle`, `isVisible`, `toggleShortcutLabel` |
| Layouts | `getLayout`, `setLayout`, `setDefaultLayout` |
| Settings UI | `mountSettings`, `refreshMount`, `onLayoutsChanged` |
| UI strings | `setScript`, `setUiStrings` |
| State | `onStateChange`, `getState`, `setSuppressKeydownPredicate` |
| Input routing | `setDestination`, `getDestinationInput`, `setFoldLigatures` |
| Keystrokes | `enableInterception` |
| Ligatures | `setLigaturePreviewActive`, `refreshLigaturePreview`, `getComponentToLigature`, `formLigatures` |

Two of these are easy to reach for and wrong. `enableInterception` is
for hosts *without* their own input pipeline; a host that owns one drives
translation itself and feeds `refreshLigaturePreview`. `setSuppressKeydownPredicate`
exists so a host showing its own modal can stop the library consuming global
keydowns — without it, the keyboard competes with the modal for the keyboard.

### Where tapped keys insert

`enableInterception(el)` is the opt-in for both input routes: it translates
physical keystrokes in `el`, **and** makes `el` receive taps on the on-screen
keys while it holds focus. Hosts that already call it for typing get tap routing
without a further call.

Taps follow focus across every element a host has enabled, so a page wires up
each editable field once and the keyboard tracks the caret from there. Opting in
is per element and deliberate: a field left unregistered never receives taps,
which is how a form mixes Shavian fields with ones that must stay Latin. The
editor dialog does exactly that — its description and Shavian name/description
fields are enabled, while the Latin name is not, because that field is the
layout's identity and drives the slug and the download filename.

Insertion goes in at the caret and replaces the selection, folds ligatures the
way a physical keystroke would, and dispatches an `input` event, so a host's own
validation and reactive state see tapped input exactly as they see typed input.
A destination may be an `<input>`, a `<textarea>` or a contenteditable element;
both routes share one insertion routine, so taps and keystrokes agree on all
three. Anything else is rejected by `setDestination` rather than silently
swallowing every tap.

Release matters: the teardown function returned by `enableInterception` also
withdraws the element as a destination. A host that removes a field without
calling it is covered — a detached element is skipped — but a dialog that may
reopen should release on close.

Precedence is override, then focus, then `#typingInput`. `setDestination` pins
taps to one field regardless of focus and is the exception, not the normal path;
`#typingInput` is a legacy default predating this mechanism, retained so
shaw-type keeps working, and new hosts should not rely on it.

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
node tools/unbound_quote_test.mjs
node tools/destination_routing_test.mjs
```

The wider suites that cover this code (`layout_editor_test.mjs` and its
siblings) also still live in `shaw-type/tools/` and load the library from that
checkout's copy, so they do not exercise this repository's working tree.
