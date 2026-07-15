# Vendored dependency — GBrain

This sidecar runs the **real** [GBrain](https://github.com/garrytan/gbrain)
knowledge system (not a reimplementation).

| | |
|---|---|
| Upstream | https://github.com/garrytan/gbrain |
| License | MIT (see `GBRAIN_LICENSE`) |
| Pinned commit | `5008b287e47bf791132eedfebf66bdef11e9398c` |
| Version | `v0.42.59.0` (default branch `master`) |
| Runtime | TypeScript on **Bun** (GBrain's canonical runtime) |

## How it's pinned (not floating `main`)

`package.json` declares the dependency as a **commit-pinned** git reference:

```json
"gbrain": "github:garrytan/gbrain#5008b287e47bf791132eedfebf66bdef11e9398c"
```

`bun install` (run in the Docker build) fetches **that exact commit** and its
dependency tree into `node_modules/gbrain`, and this image redistributes it
together with GBrain's MIT license (`node_modules/gbrain/LICENSE`, copied to
`GBRAIN_LICENSE` here for attribution). Nothing tracks a moving branch.

To bump GBrain: change the `#<sha>` in `package.json`, update the commit/version
in this file and in `GBRAIN_LICENSE`, rebuild, and re-run the smoke test.

## Why a pinned git dep instead of committing the source tree

GBrain's source is ~109 MB (most of it tree-sitter WASM grammars for its
code-intelligence feature, irrelevant to a markdown KB). A commit-pinned git
dependency gives the same guarantees the task requires — an exact, reproducible,
non-floating commit, redistributed with its license in the image — without
committing ~800 files / 70 MB of upstream source into this repo.

## What we use from GBrain

The adapter (`brain.js`) drives GBrain's real operations through its `gbrain`
CLI:

- `gbrain init --pglite` — create a per-kbId PGLite brain
- `gbrain capture --file <md> --slug <slug>` — real ingest (`put_page`: chunk +
  embed + index)
- `gbrain call query {query,limit}` — real hybrid search (vector + BM25 + RRF +
  graph signals)
- `gbrain call delete_page {slug}` / `restore_page {slug}` — real soft-delete /
  restore

We do **not** patch GBrain; the adapter only translates our REST contract to and
from these real operations.
