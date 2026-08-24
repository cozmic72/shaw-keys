# Decision log

Durable decisions for `shaw-keys`, each with its rationale and where it lives in the code.
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
PROPOSED (built; `SHAW_KEYS_VERSION`, `getShawKeysBasePath` and `versionedUrl` in
[`shaw-keys.js`](../shaw-keys.js)).

The library fetches assets — layout JSON, the settings HTML, the string tables — at runtime, so a
browser that cached them under a previous release serves stale ones. `getShawKeysBasePath`
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

## The consumer supplies the font URL when staging

**PROPOSED** (built; `{{FONT_URL}}` in [`shaw-keys.css`](../shaw-keys.css),
[`tools/stage.sh`](../tools/stage.sh)).

`shaw-keys.css` hardcoded `https://joro.io/fonts/InterAlia-VF.otf`, so every host fetched
that origin even when it already served the same file — `shave` ships `InterAlia-VF.otf` and
fetched a remote copy of it anyway. The family's other repositories take the font URL per
invocation (`shaw-type`'s `--font-url`, `shaw-spell`'s `FONT_URL`), and every consumer of this
library already copies its files into a docroot rather than serving them from here.

Chosen option: the CSS carries a `{{FONT_URL}}` token and `tools/stage.sh` substitutes it during
the copy consumers already perform, because it makes this library take its font URL the same way
the rest of the family does, and the substitution point already existed on the consumer side —
`shaw-type/tools/deploy.py` had been substituting a font token into this stylesheet for as long as
the token has been missing from it.

This does **not** reverse [Versioning](#versioning)'s no-build-step consequence. Nothing is
generated here, no artefact is produced, and no step runs before this repository's files are usable
as plain files. `stage.sh` is a copy that a consumer runs, in place of the `cp -R` each already
ran.

Consequences:

- A consumer that copies the files without staging gets a literal `{{FONT_URL}}` and no Shavian
  font. That is deliberate: `--font-url` is mandatory and staging fails when a token survives, so
  the failure lands on whoever ran the copy instead of on a reader seeing a fallback face.
- The drop-in flow now has a prerequisite. `README.md`'s Getting Started leads with `stage.sh`, and
  a host that ignores it no longer gets a working font by default — the previous behaviour, a
  silent remote fetch, is gone.
- Hosts must declare the family as `Inter-Alia`. Pointing the token at a local copy is inert if the
  host's own `@font-face` spells the family differently, which is why `shave`'s `InterAlia` was
  renamed alongside this.
- The OFL position is unchanged in substance but restated: no font file ships here, and a consumer
  pointing the token at its own copy is the one redistributing. See [`LICENSE.md`](../LICENSE.md).

Considered and rejected: a CSS custom property with a remote fallback
(`url(var(--sk-font-url, …))`) — **tested in Chromium 141 and WebKit 26.0 and it does not work in
either**; the `@font-face` is dropped and the text renders in the fallback face, and
`document.fonts.check()` still reports `true`, so nothing detects it. A separately linkable
`shaw-keys-font.css` — no logic, but it keeps a hardcoded production URL in this repository
and a host that forgets the second `<link>` fails silently. Resolving the font through
`setResourceUrlResolver` — the resolver runs at `init`, long after the browser has parsed the
stylesheet, and a page that loads the CSS without calling `init` (`shave`'s extension popup does)
would never reach it.

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

**We will curate the public surface on `window.ShawKeys` while leaving the global scope
uncontrolled** — PROPOSED (built; `window.ShawKeys` in
[`shaw-keys.js`](../shaw-keys.js), `window.CustomLayouts` in
[`custom-layouts.js`](../custom-layouts.js), `window.LayoutEditor` in
[`layout-editor.js`](../layout-editor.js)).

The three files are plain scripts with no module system and no bundler, sharing one global scope.
`window.ShawKeys` names 26 host-facing entry points plus an `_internal` sub-object of 28
more, each of the 26 carrying a comment on what a host uses it for. The split was a deliberate act,
not drift: `5d8b00b` in `shaw-type` moved library-internal entry points behind `_internal` under its
own heading.

The enforcement is asymmetric, and that is the part worth recording. `layout-editor.js` wraps
itself in an IIFE, for the reason its header comment gives: a bare top-level `function open` would
clobber `window.open`, and generic names risk a fatal duplicate-`const` collision across files
sharing one scope. `shaw-keys.js` and `custom-layouts.js` are not wrapped, so every
top-level declaration in them — `CUSTOM_LAYOUTS_KEY`, `versionedUrl`, the lot — is a global
alongside the curated object.

Chosen: the curated object is the documented contract; the leaked globals are not part of it and
carry no guarantee. A host, and the sibling files, reach the library only through
`window.ShawKeys` and `window.CustomLayouts`.

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
`document.scripts` for a `src` containing `shaw-keys.js` — correct by construction rather
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
error with nothing to swap. `shave/extensions/safari/manifest.json` injects `shaw-keys.js`
exactly this way, in the `content_scripts` entry matching `<all_urls>`.

The globals are not the problem. The module build still assigns all three —
`window.ShawKeys` in [`shaw-keys.js`](../shaw-keys.js),
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
own `SK_SETTINGS_KEY` settings in [`shaw-keys.js`](../shaw-keys.js) were already
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

---

## The ligature suppressor is a consumed fold barrier, special-cased to one character

PROPOSED — added 2026-08-24 (agent). The special-casing over general multi-character key support
is the owner's decision; the consumed-not-retained behaviour below is the agent's, and the owner
did not specify it.

A layout that folds `𐑦`+`𐑩` into `𐑾` gives the typist no way to write the two letters side by
side, and JAFL folds on both `𐑩` and `𐑮` — the right-hand sides of `𐑾`, `𐑼`, `𐑹`, `𐑸`, `𐑽`,
`𐑻` and `𐑺`. Some words need the unfolded pair. Supporting one required a key value wider than
the single grapheme [`custom-layouts.js`](../custom-layouts.js) `isSingleGrapheme` had enforced
everywhere.

We will treat U+205E `⁞` as a fold barrier rather than as text, and admit it as the ONLY
multi-character key binding: a key may bind it alone, or prefixed to one grapheme (`⁞𐑩`). Any
other multi-character binding stays an error — [`custom-layouts.js`](../custom-layouts.js)
`isValidKeyBinding`.

**The barrier is consumed by the fold, not retained in the buffer.** The typist is entering
target text that contains no suppressor, so a retained one would mismatch the target on the first
suppressed letter and make the word unenterable. It is also not a producible character, so
`producibleChars` strips it before counting coverage.

`formLigatures` ([`shaw-keys.js`](../shaw-keys.js)) folds only the run after the last barrier and
joins the earlier text with its own barriers already spent, so a barrier bites at exactly the
fold it sits at. Chained ligatures still resolve around it: on JAFL, `𐑦` `⁞𐑩` `𐑮` gives `𐑦𐑼` —
the first link blocked, the second still folding.

Consequences:

- A **trailing** barrier is the one that must survive: a key bound to a bare `⁞` blocks nothing on
  the keystroke that inserts it, so it stays in the buffer until a letter follows. A buffer can
  therefore end in a suppressor, and any consumer reading a partial buffer sees it.
- The site keeps its own fold engine (`InputHandler.formLigatures` in `shaw-type`'s
  `src/site/input-handler.js`) and needed the same barrier logic written twice. The two engines
  were already duplicated; this widens the cost of that.
- The editor's trim-to-one-glyph keeps a `⁞` prefix — [`layout-editor.js`](../layout-editor.js)
  `lastGrapheme` — so the one function enforcing "a key binds one glyph" now has an exception in it.
- An OLD build importing a layout with a `⁞` binding fails loudly at `validateLayout` with
  "not a single character", shown in the import alert. It does not silently mangle the binding.
- `⁞` is on no layout but JAFL's shift+D and shift+J, so the editor's glyph palette is the only
  route to it in a custom layout. It sits in the palette's punctuation tail beside `.` and `·`,
  not in the letter grid, because it is not a Shavian letter.
- **`pickGlyph` composes on a lone suppressor**: picking `⁞`, then a letter, yields `⁞<letter>`.
  Every other pick replaces the binding whole, so this is the one composing pair — a general
  composing pick would silently concatenate two ordinary glyphs into an invalid binding.
- The palette renders in `Inter-Alia`, which is chosen for the Shavian block and the VS1 variants.
  Whether it carries U+205E is **unverified** — if it does not, the cell falls back to a system
  font or shows a missing-glyph box. It stays pickable either way.

Considered and rejected: general multi-character key values and ligature right-hand sides (the
owner chose special-casing, so an arbitrary string on a key stays an error); retaining `⁞` in the
buffer (unenterable target text, and two backspaces to undo one keypress).

→ [`shaw-keys.js`](../shaw-keys.js) `LIGATURE_SUPPRESSOR`, `formLigatures`;
[`custom-layouts.js`](../custom-layouts.js) `isValidKeyBinding`, `producibleChars`;
[`keyboard_layout_jafl.json`](../keyboard_layout_jafl.json) keys `D`/`J`;
`tools/ligature_suppressor_test.mjs`.
