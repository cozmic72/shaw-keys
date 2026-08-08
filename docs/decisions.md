# Decision log

Durable decisions for `virtual-keyboard`, each with its rationale and where it lives in the code.
States, scope and lifecycle follow
[`meta/docs/decision-log-convention.md`](../../meta/docs/decision-log-convention.md).

Architecture — the API surface, the asset-loading contract, the `localStorage` keys — is
[`README.md`](../README.md). This file records only decisions whose rationale is worth preserving,
and does not restate that document.

**Every entry below is PROPOSED**: an agent distilled each from the code, the README and
`shaw-type`'s history, and the owner has not ratified any of them as a decision-log entry.

⚠ This repository's history begins at the extraction from `shaw-type` (`0f3b101`). The reasoning
behind decisions taken before that is in `shaw-type`'s history, which a clone of this repository
does not carry.

---

## Versioning

**We will take a cache-busting token from our own script tag and have no version of our own** —
PROPOSED (built; `VIRTUAL_KEYBOARD_VERSION`, `getVirtualKeyboardBasePath` and `versionedUrl` in
[`virtual-keyboard.js`](../virtual-keyboard.js)).

The library fetches assets — layout JSON, the settings HTML, the string tables — at runtime, so a
browser that cached them under a previous release serves stale ones. `getVirtualKeyboardBasePath`
scrapes `?v=` off the `<script src>` that loaded it, and `versionedUrl` appends that value to every
asset URL. The value is never reported, logged, or compared. `init`'s second parameter is named
`resourceVersion` and is ignored; the query string is the only input.

Chosen: cache busting only. Cache busting asks whether an asset changed since the browser last
fetched it, and any value that changes when the asset changes answers it. Versioning asks what
build this is, traceable to what commit — a question a library has no occasion to answer, because
it is not independently deployed. Whatever ships the library carries the version.

Consequences:

- **No build step and no generated file.** This is what makes the library droppable into a host as
  plain `<script src>`, and it is the property to protect if versioning is ever revisited.
- Nothing here is traceable to a commit. A bug report naming a `?v=` value identifies the host's
  release, not this library's revision, so reproducing it means asking the host what its submodule
  pointer was.
- The token is the host's to supply and the host's to get wrong. Omitting it during development is
  intended; forgetting it in production ships stale assets silently, and the library cannot detect
  that.
- `resourceVersion` remains in `init`'s signature doing nothing — a parameter that reads as though
  it feeds the mechanism and does not.

Considered and rejected: a `current-version` file with build-time interpolation, as `shaw-type` and
`shaw-spell` use. It answers a provenance question this library does not have, and costs the build
step that keeps it reusable.

→ [`README.md`](../README.md#cache-busting-and-why-there-is-no-version). The family-wide comparison
of all four repositories' mechanisms is
[`meta/docs/cross-cutting-concerns.md`](../../meta/docs/cross-cutting-concerns.md) §1 — cited, not
restated, and the authority if the two disagree.

---

## Module boundary

> **SUPERSEDED** by *The library is an ES module* below. The entry as written describes the
> library before `880ef72`, and its central claim — that the files are plain scripts sharing one
> global scope — is no longer true. It is kept because the reasoning that led here explains what
> the module conversion had to solve, and because the two hazards it names, the bidirectional
> coupling, is what the conversion had to solve. The `SHAVIAN_PALETTE` guard did **not** outlive
> it: `custom-layouts.js` now imports the palette directly, so the empty-target-set condition that
> made coverage report full is unreachable — a module that loaded at all has already resolved the
> one it imports from. The hazard as described below is history, not a standing warning.

**We will curate the public surface on `window.VirtualKeyboard` while leaving the global scope
uncontrolled** — PROPOSED (built; `window.VirtualKeyboard` in
[`virtual-keyboard.js`](../virtual-keyboard.js), `window.CustomLayouts` in
[`custom-layouts.js`](../custom-layouts.js), `window.LayoutEditor` in
[`layout-editor.js`](../layout-editor.js)).

The three files are plain scripts with no module system and no bundler, sharing one global scope.
`window.VirtualKeyboard` names 26 host-facing entry points plus an `_internal` sub-object of 28
more, each of the 26 carrying a comment on what a host uses it for. The split was a deliberate act,
not drift: `5d8b00b` in `shaw-type` moved library-internal entry points behind `_internal` under its
own heading.

The enforcement is asymmetric, and that is the part worth recording. `layout-editor.js` wraps
itself in an IIFE, for the reason its header comment gives: a bare top-level `function open` would
clobber `window.open`, and generic names risk a fatal duplicate-`const` collision across files
sharing one scope. `virtual-keyboard.js` and `custom-layouts.js` are not wrapped, so every
top-level declaration in them — `CUSTOM_LAYOUTS_KEY`, `versionedUrl`, the lot — is a global
alongside the curated object.

Chosen: the curated object is the documented contract; the leaked globals are not part of it and
carry no guarantee. A host, and the sibling files, reach the library only through
`window.VirtualKeyboard` and `window.CustomLayouts`.

Consequences:

- **The boundary is convention, and nothing enforces it.** A host that reaches a leaked global
  works today and breaks on any refactor, with no deprecation path and no error to point at.
- The two unwrapped files carry the collision hazard the third file's IIFE exists to avoid. Adding
  a generically-named top-level `const` to either can fatally collide with the other.
- `_internal` is not private. It is the sibling files' access path — `layout-editor.js` resolves
  resource URLs and fires layout-change events through it — so its 28 members are effectively a
  second public surface, one that reads as though it were not.
- Load order is a hard requirement: `layout-editor.js` must come after the other two. `README.md`
  gives the three tags in order, and nothing checks it.

⚠ **The coupling between `custom-layouts.js` and `layout-editor.js` is bidirectional**, which no
load order can satisfy. `layout-editor.js` reaches `window.CustomLayouts` throughout, and
`custom-layouts.js` reaches back for `window.LayoutEditor.SHAVIAN_PALETTE` in `vs1TargetChars`.
That one call is deferred to call time and guarded — `(window.LayoutEditor && …) || []` — so the
cycle resolves without an ordering. The guard is a silent fallback, against the fail-fast rule in
`~/.claude/CLAUDE.md`, and it is wrong in a way that looks right: with no editor loaded the target
set is empty, so `vs1TargetChars` reports **full** VS1 coverage instead of none. Deleting the guard
does not fix that — it converts a wrong answer into a `TypeError` thrown from coverage computation,
which is louder but still leaves `custom-layouts.js` unusable without the editor. The fix is to
break the cycle by moving `SHAVIAN_PALETTE` to whichever file owns it; do that before touching the
guard.

Considered and rejected: ES modules with real `export` (would impose a bundler or `type="module"` on
every host, against the no-build-step decision above; a separate agent is assessing this and may
supersede the entry). **That assessment ran and reversed this — see below.**

---

## The library is an ES module

**We will use `import`/`export` between the three files, and hosts load one module script** —
PROPOSED (built in `880ef72`).

The rejection above rested on a cost nobody had counted. Counted, it was six small edits: no
consumer touches the library's globals at parse time, and module scripts execute before
`DOMContentLoaded`, so every existing call site still finds what it expects. It also needs no
bundler, so the no-build-step decision stands rather than being traded away.

What it bought is more than one fewer script tag. `import.meta.url` replaces a scan of
`document.scripts` for a `src` containing `virtual-keyboard.js` — correct by construction rather
than by convention, and immune to being confused by an injected tag. The bidirectional coupling
recorded above stops needing an ordering, because the browser resolves the cycle. And a race that
could not be worked around any other way is gone: `init` reaches `window.CustomLayouts` through
`customLayoutResolver`, so a user whose saved layout was a custom one could hit it before a
dynamically-loaded sibling had arrived — intermittently, and only for those users.

Consequences:

- **`file://` no longer works.** Modules are blocked over it by CORS. This is not theoretical: the
  iOS Safari app loaded its page with `loadFileURL` and had to move to a custom scheme handler.
  Any future host must serve over a real origin.
- The compatibility globals are kept, so the four web consumers work unchanged until their HTML is
  edited. They are a transition surface with a stated end, not part of the contract.
- Module scope stops leaking the incidental top-level declarations the superseded entry described.
  A host reaching one of those breaks now rather than later.
- **A wrong answer became unreachable rather than merely unlikely.** `custom-layouts.js` reached
  `window.LayoutEditor.SHAVIAN_PALETTE` behind a fallback, and with no editor loaded the target set
  came back empty, so VS1 coverage reported *full* instead of none. The import replaces the
  fallback, and module resolution means a file that loaded at all has already resolved what it
  imports. No test pins this: the failure needs a module graph a browser cannot produce, so a test
  would pin the stub rather than the code.
- **A host loading the library as classic scripts now fails to parse.** Top-level `import` is a
  syntax error outside a module, so a consumer that has not added `type="module"` gets nothing
  rather than a partial library. That is the intended failure — loud, immediate, and naming the
  cause — but it means each consumer breaks at the moment it next loads, not when someone
  remembers to migrate it.
- The tests import the real module instead of building a `vm` sandbox, so they exercise the graph
  a browser would.

---

## The module format excludes MV3 content scripts

**We will accept that the library cannot be consumed by a Manifest V3 content script, and leave
the remedy to whoever settles packaging** — PROPOSED (consequence of `880ef72`, found 2026-08-08 by
surveying `shave`).

A new entry rather than a bullet added to *The library is an ES module* above, because this is not
a missed item on that entry's consequence list: it names a consumer class the library **cannot
serve at all**, and carries options a reader needs to find by title. That entry stands unamended
and correct; this one supplements it.

An MV3 content script is a file a browser extension declares in `manifest.json` under
`content_scripts[].js` and the browser injects into every matching page. The injection is the
manifest entry — there is no `<script>` tag in the document to carry `type="module"`, and the array
has no per-file equivalent of that attribute. Module syntax in such a file is therefore a parse
error with nothing to swap. `shave/extensions/safari/manifest.json` injects `virtual-keyboard.js`
exactly this way, in the `content_scripts` entry matching `<all_urls>`.

The globals are not the problem. The module build still assigns all three —
`window.VirtualKeyboard` in [`virtual-keyboard.js`](../virtual-keyboard.js),
`window.CustomLayouts` in [`custom-layouts.js`](../custom-layouts.js), `window.LayoutEditor` in
[`layout-editor.js`](../layout-editor.js) (verified at `56046d1`). A consumer that reads a global
still finds it. What the format costs a **page** consumer is timing, because a module script
executes after the classic scripts around it; what it costs a **content-script** consumer is the
file itself, which never parses.

Consequences:

- **`shave`'s Safari web extension cannot consume the library**, and no edit to its script tags
  fixes it, because it has none.
- The dynamic-`import()` escape — inject a classic shim that imports the module — is not open as
  the manifest stands. Its `web_accessible_resources` lists `*.html`, `*.json`, `*.png`, `*.otf`
  and `*.ttf`; a `.js` file that is not itself a declared content script cannot be fetched by the
  page without being listed there.
- `shave`'s three GUI pages (`gui/index.html`, `gui/web.html`, `gui/ebook.html`) load the library
  as three classic tags and call into it at parse time from a bare IIFE, so swapping their tags to
  `type="module"` is not sufficient — their boot has to be deferred as well. That is `shave`'s work
  and this entry does not prescribe it; it is recorded because the tag swap looks complete and is
  not.
- The library now has two consumer shapes it serves and one it does not, and nothing in the
  repository states which is which. A future host discovers the exclusion at injection time.

The options, so this is decided once rather than re-derived:

- **Ship a classic build alongside the module** — a second artefact for extension consumers. Costs
  the build step that [Versioning](#versioning) above exists to avoid.
- **Open `web_accessible_resources` to `*.js` and load via dynamic `import()`** from a classic
  shim. Keeps one artefact; moves the cost into the consumer's manifest and its injection timing.
- **Drop MV3 content scripts as a supported consumer**, and say so in `README.md`.

Not chosen here. The choice is the owner's, and the distribution question in
[`meta/docs/vision-and-open-questions.md`](../../meta/docs/vision-and-open-questions.md) will
subsume it — a decision to publish this library through a package registry changes what "a classic
build" costs.

⚠ **Known unknown.** `shave`'s iOS app moved off `file://` to a `shavian-app://` scheme handler
(`e44c99af` in `shave`) for the module conversion's sake, and that commit states it is unbuilt and
unverified. Whether the module format works for that consumer is untested, not established.

---

## Storage

**We will not put a storage adapter between the keyboard library and `localStorage`** — PROPOSED
(built as designed in `shaw-type`, then removed there before extraction; the code now lives here).

Custom-layout storage was moved into this library alongside the editor and the roster, so they
export together to the browser extension and any other host. The design that shipped first put a
resolver-style storage adapter under it, matching the existing `setResourceUrlResolver` and
`setCustomLayoutResolver` idiom, so a host could supply its own backing store.

Chosen: the library owns `localStorage` directly. `readStore` and `writeStore` in
[`custom-layouts.js`](../custom-layouts.js) read and write the `customLayouts` blob; the library's
own `VK_SETTINGS_KEY` settings in [`virtual-keyboard.js`](../virtual-keyboard.js) were already
direct and are unchanged.

The adapter bought nothing for the only host that exists, and every read path had to be synchronous
regardless — so it was a wrapper around `localStorage` that could only ever be `localStorage`.

Consequences:

- The Safari extension's per-origin storage fragmentation is **not** solved, and returns as real
  work if the extension is refreshed. The abandoned adapter is the obvious answer at that point,
  which is why the design is kept rather than deleted.
- Storage is shared across every app on an origin, which is what makes a user's keyboards follow
  them between hosts — the benefit that paid for dropping the adapter.
- `customLayoutResolver` survives and defaults to the library's own store
  (`window.CustomLayouts.getCustomLayoutData`), so `setCustomLayoutResolver` still lets a host
  override *layout resolution*. It does not let a host override *persistence*; the two read as one
  facility and are not.
- The `customLayouts` key is unprefixed and collides with any host using that name for its own
  purposes. Nothing namespaces it. See [`README.md`](../README.md#localstorage).

→ The design and the reason it was abandoned are in `shaw-type`'s
`custom-keyboard-management-arch.md`, §"Persistence without hard-coding the host" — tracked there,
so it survives a clone of that repository, but not of this one.
