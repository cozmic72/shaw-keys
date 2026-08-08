# virtual-keyboard

**Read [`README.md`](README.md) first.** It is the authority on the architecture, the supported
API surface, the asset-loading contract and how to run a test. This file does not summarise it.

**Check [`docs/decisions.md`](docs/decisions.md) before re-deriving a settled answer** — why there
is no version and no build step, why storage is not behind an adapter.

The library is an **ES module graph**: `virtual-keyboard.js` imports its two siblings, so a host
loads that one file. Two consequences bite immediately:

- **A host must serve it over `http(s)://`.** Module scripts are fetched with CORS and `file://`
  cannot satisfy it, so an app embedding the library in a web view serves its bundle rather than
  loading it off disk.
- **The `window.VirtualKeyboard` / `CustomLayouts` / `LayoutEditor` globals are a transition
  surface**, kept only until every consumer imports instead. The README's "transition surface"
  section governs when they go. Do not write new code against them.

This repository is a **library, consumed as a git submodule** by `shaw-type` (at
`src/virtual-keyboard`), and by `shave`. Two things follow, and neither is visible from inside this
checkout:

- **Landing a change takes two commits.** One here, pushed; then one in each consumer moving its
  submodule pointer. A commit only in the consumer pins a revision nobody else can fetch.
- **Generators that write into this repository live elsewhere.** The keyboard images, the
  translation tables and `tools/generate_translations.py` are in `shaw-type`. Ask the owner to run
  them; do not hand-edit their output.

`shaw-type`'s own `tools/` still holds the wider suites covering this code, and they load the
library from that checkout — so a green run there is not evidence about this working tree.
