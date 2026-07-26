# Handoff: discourse-relations branch

Branch `discourse-relations`, cut from `main` (NOT from `feat/canvas-mcp` — canvas is
still unmerged and this work is independent of it).

Goal: teach dg-team-mcp to **read** and **create** reified ("stored") discourse
relations in Roam. Prior to this branch the MCP could do neither: `get_relationships`
was inference-only, and no tool could write `:block/props` at all.

---

## 1. The verified contract

A reified relation is **one block per relation**, a direct child of the page
`roam/js/discourse-graph/relations`, whose `:block/string` equals its own
`:block/uid`, with the entire payload in props:

```clojure
:block/props {:discourse-graph {:sourceUid      "<page uid>"
                                :destinationUid "<page uid>"
                                :hasSchema      "<relation schema block uid>"}}
```

- Exactly **one directed record** per relation. The complement is resolved at query
  time — never write a second reverse record.
- `hasSchema` is the uid of the relation-definition block under
  `roam/js/discourse-graph > grammar > relations`. That block's `:block/string` **is**
  the relation label ("Supports", "Addresses"), and its children are
  `source` / `destination` / `complement` / `If`.
- `source` and `destination` values are node-type **page uids** (e.g. `OmlJ7NBaC`),
  not type names. Validation is a uid comparison, not a string match.
- Written by the plugin in `apps/roam/src/utils/createReifiedBlock.ts`.

Verified live: sandbox-dg has 404 such records, dg-team ~614.

## 2. Two traps that cost real time — do not re-derive these

**Trap A — string-write / keyword-read.** Write props with plain **string** keys
(they go over the wire as JSON). Read them in datalog with **keyword** constants:

```clojure
[(get ?props :discourse-graph) ?dg]   ; CORRECT
[(get ?props "discourse-graph") ?dg]  ; returns ZERO rows against known-good data
```

Roam keywordizes on persist, but the JSON round-trip back through the Local API
renders the keys as *strings* again — so dumping a props map tells you nothing about
which form the index wants. A string-key `get` silently returns 0 rows, which is
indistinguishable from a failed write. This is the same class of silent failure as
ADR-004. Confirmed the keyword form is what the plugin itself uses
(`registerDiscourseDatalogTranslators.ts:529`).

**Trap B — never return a props map from `:find`.** Measured against sandbox-dg:

| query form | raw `q` | `data.fast.q` |
| --- | --- | --- |
| `[:find ?props ...]` (returns the map) | 403 rows | `[null]` |
| `[(get ?props :k) ?v]` then `:find ?v` | 404 rows | 404 rows |

So relation reads can use the ordinary `datalogQuery()` helper (which prefers
`data.fast.q`) **provided every query destructures with `get` and never returns a raw
map**. Only `src/canvas/props.ts` needs the raw `q` action, because it genuinely wants
the whole map back.

## 3. Why this is cheap: `hasSchema` == `relation.id`

`src/discourse-config.ts:45` already parses relation definitions with `id: r.uid` —
the schema block uid. So `hasSchema` maps 1:1 onto `relation.id` from the existing
`getInternalDiscourseConfig()`. No new grammar parser was needed; schema resolution
reuses the config the read path already loads.

## 4. Data-integrity hazards found in live graphs

A create tool must defend against all of these — they are present today:

- **Dangling `hasSchema`**: 124 of 404 sandbox-dg relations point at schema uids that
  no longer exist (`zzZcKmOy-` x87, `AEUmK1C9m` x31, `DsPnlBeGF` x6). Grammar edits
  orphan them. The plugin drops these with a `console.warn`.
- **Labels are not unique**: sandbox-dg's grammar has two "Supports" and two
  "Addresses" definitions, differing in source/destination types. A tool API keyed on
  label alone is ambiguous and must refuse rather than guess.
- **Dedup is unenforced**: `9BgaW-PkW` and `a8yvdCuqU` are the same exact triple, live
  in sandbox-dg. The plugin dedups before writing; so must we.
- **Partial-write orphans**: the relations page carries a child with a uid-shaped
  string but no props (`T7M33Kmil`), and an empty child. Almost certainly an
  interrupted two-step write. Our writer must roll back on failure.
- **Per-user visibility**: records are invisible to any user whose extension setting
  `use-reified-relations` is off (default-on for configs created after 2026-03-01).

## 5. Write mechanics

`data.block.fromMarkdown` can set neither uid nor props, so creation is two calls:

1. `data.block.fromMarkdown` -> `{uids: [...]}`
2. `data.block.update` with `{block: {uid, string: uid, props: {...}}}`
   (string and props can be set in the same call)

If step 2 fails, delete the block from step 1 — otherwise you add to the orphan pile
described above.

## 6. Status

See `src/relations/README.md` for the durable module contract, and the ADRs
(ADR-003 superseded by ADR-018; ADR-019 records the props mechanics).

Progress is tracked in the checklist at the bottom of this file.

### Checklist

- [x] Phase 0 spike: confirm `:block/props` is writable via the Local API
- [x] Branch cut from `main`
- [x] `src/relations/` module (model, read, write)
- [x] `get_relationships` reads stored relations + inferred, merged and tagged
- [x] `create_discourse_relation` tool, env-gated behind `DG_MCP_RELATION_WRITE`
- [x] ADR-003 superseded; ADR-018/019 written
- [x] README updated
- [x] Smoke script against sandbox-dg — 13/13 passing, graph restored to baseline
- [ ] ARCHITECTURE.md not yet updated
- [ ] Unit tests (`tests/`) — only the live smoke script exists so far
- [ ] Not yet exercised against dg-team (production, ~614 stored relations)

## 7. One more trap, found during implementation

`getInternalDiscourseConfig()` returns **each relation definition more than once**
(one entry per triple set). sandbox-dg's two "Supports" definitions come back as four
entries. Any code matching on relation identity must call `getDedupedRelations()`
first — without it, pinning an unambiguous `relation_schema_uid` *still* resolves to
multiple candidates and the tool refuses a request it should have accepted.
`get-relationships.ts` had always done this; the new create tool initially did not,
and the smoke script caught it.

After deduping, "Supports" between a Result and a Hypothesis resolves uniquely even
though the grammar defines "Supports" twice — the endpoint types disambiguate. The
ambiguity path is still live for genuinely ambiguous cases.
