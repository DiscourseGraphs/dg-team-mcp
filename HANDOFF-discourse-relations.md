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
- [x] README + ARCHITECTURE updated
- [x] Smoke script against sandbox-dg — all checks passing, graph restored to baseline
- [x] Unit tests — `tests/relations.test.ts` (10 tests; full suite 22/22 incl. main's tree tests)
- [x] Read path validated against dg-team production, **read-only**
- [ ] **No writes have ever been made to dg-team.** Only sandbox-dg has been
      written to, and every test record was deleted. Writing to production needs
      an explicit decision, not just flipping the env var.
- [ ] Relation *deletion* / retraction has no tool. `deleteStoredRelation()` exists
      as a primitive but is deliberately not exposed.
- [ ] No provenance on the record (who asserted this, and why). Roam's
      `:create/user` is all we get. The stated 1-year goal on
      `Project/Reifying Relations` — "store assertions like 'Joel says that x
      supports y'" — needs a props schema change, and should be agreed with the
      extension team rather than invented here.
- [ ] Cross-app sync: `reifiedRelationToCrossApp` lives on the unmerged branch
      `eng-1865-publish-roam-stored-relations-for-shared-nodes`. Relations written
      here are Roam-local until that lands. Keep the props shape exactly canonical
      so they are picked up unchanged.

### Production read-only validation (dg-team, 2026-07-26)

```
node types=22  relation defs=32 (raw 34 — note the duplication)
stored relation records: 614
dangling hasSchema: 124 across 3 missing schema uid(s)
exact-duplicate triples: 1
busiest node 6ibf7YBPF (degree 38): 21 resolved, 17 stale, 282ms
```

dg-team and sandbox-dg share the same 3 orphaned schema uids, so sandbox is a
copy of production's grammar lineage. That 17-of-38 stale fraction on the busiest
node is why stale records are counted in the response rather than dropped in
silence — a bare "21 relations" would badly misrepresent that node.

## 7. One more trap, found during implementation

`getInternalDiscourseConfig()` returns **each relation definition more than once**
(one entry per triple set). sandbox-dg's two "Supports" definitions come back as four
entries. Any code matching on relation identity must call `dedupeRelations()`
(exported by `discourse-config.ts`) first — without it, pinning an unambiguous
`relation_schema_uid` *still* resolves to multiple candidates and the tool
refuses a request it should have accepted.
`get-relationships.ts` had always done this; the new create tool initially did not,
and the smoke script caught it.

After deduping, "Supports" between a Result and a Hypothesis resolves uniquely even
though the grammar defines "Supports" twice — the endpoint types disambiguate. The
ambiguity path is still live for genuinely ambiguous cases.

## 8. Re-verified against the CURRENT plugin (2026-07-27)

Everything above was first proven against sandbox-dg while it was running a ~3-month-old
build of the extension. The graph has since been updated to current. Re-checked:

**Format is unchanged.** `createReifiedBlock.ts` has had exactly one commit touching it
since 2025-11-27, and that commit deleted an eslint comment. Keys, nesting, parent page,
and the string-equals-uid convention are all identical. Confirmed empirically too: records
written by the old plugin, by the new plugin, and by this MCP all carry byte-identical
props — `{discourse-graph: {sourceUid, destinationUid, hasSchema}}`, three keys, no more.

**The update ran a backfill.** 34 new records appeared in a 16-second window on update,
reifying previously inference-only edges (405 -> 439). It introduced no duplicates, no
self-relations, and no dangling schemas. It did *not* clean up the 124 pre-existing
dangling `hasSchema` records, so `stale_schema_records` stays necessary.

A consequence worth noting: edges that used to read `origin: "inferred"` now read
`origin: "both"`. Verified on a backfilled node — reported once each, not twice.

**Add / read / remove all still work**, end to end, against the updated plugin: deleted a
record written under the old plugin, re-created it under the new one, confirmed dedup and
complement read-back.

**Delete needs nothing more than deleting the block.** The extension's own delete path
(`ResultsTable.tsx:265-311`) resolves the uid by props query, calls `deleteBlock`, and then
only refreshes UI. No tombstone, no props clearing, no sync notification. The one caveat is
an in-process, short-TTL, per-tab result cache — an external delete cannot touch it and
does not need to; it self-expires.

**No cross-app sync fires on write.** `discourseRelationDataToLocalConcept` exists but has
zero callers; the Supabase layer is a 5-minute poll, not a write hook. So a Local-API write
is behaviorally equivalent to a plugin write today. (`packages/database` was being
refactored two commits before the checkout's HEAD, so re-check after a fetch.)

### One fix this shook out

`model.ts` matched relation blocks with `[?relPage :block/children ?rel]`. The extension
matches with `:block/page` — any depth on the page. A record that ends up nested stays
live to the plugin but was invisible to us. Fixed, with a test. Currently latent: both
forms return 439 on sandbox-dg, so nothing was actually being missed.

### Config N+1 — resolved on `main` by ADR-020 while this branch was in flight

**Resolution (2026-07-27):** everything below was fixed by PR #3 / ADR-020: subtrees now
fetch in one `:block/parents` query, node pages are discovered via Datalog instead of
`data.ai.search`, and `getInternalDiscourseConfig` is memoised per client (per request).
`get_discourse_node_types` went ~35s → 538ms (sandbox) / 759ms (dg-team), and after
rebasing this branch onto that fix, `relations-smoke.ts` passes end-to-end within the
default 60s client timeout. The measurements below are kept as the record of what the
N+1 looked like from this branch.

Measured on sandbox-dg after the update: **~35s per MCP tool call**, of which ~35.7s is
`getInternalDiscourseConfig` alone. The relation datalog itself is 16-45ms.

```
getConfigPageUid                   103ms     1 API call
getBasicTreeByParentUid(config)  10406ms   712 API calls
getNodePages                     25548ms  1518 API calls
per-call Local API latency         35.2ms
```

`getBasicTreeByParentUidWithMeta` (`src/roam.ts:114`) recurses one datalog query per block.
~2,230 round trips per tool invocation. The config did not grow — the update added just 2
blocks to the config page — so what changed is per-call Local API latency (~35ms now), which
multiplies the pre-existing N+1 into something that blows past the MCP SDK's 60s default
request timeout. The stock `relations-smoke.ts` now dies partway through for this reason,
not because of a relations bug.

This was shared `main`-branch code used by every discourse tool, not just relations,
which is why it was fixed in its own PR (see the resolution note above) rather than on
this branch.
