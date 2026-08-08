# virtual-keyboard

**Read [`README.md`](README.md) first.** It is the authority on the architecture, the supported
API surface, the asset-loading contract and how to run a test. This file does not summarise it.

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
