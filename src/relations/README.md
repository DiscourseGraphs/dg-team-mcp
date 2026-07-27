# Stored (reified) discourse relations

Read and write support for explicit discourse relation records in Roam.

## Two ways a relation can exist

| | inferred | stored ("reified") |
| --- | --- | --- |
| what it is | an edge that exists because block structure happens to match a grammar triple | an explicit block, one per edge |
| where it lives | implied by the shape of user prose | a child of `roam/js/discourse-graph/relations` |
| has a uid? | no | yes — editable, deletable |
| read by | `fireQueryDetailed` (the query-builder port) | `relations/read.ts` |

Both are real, and a single conceptual edge can be present as either or both.
`get_relationships` unions them and tags each result `origin: "inferred" | "stored" | "both"`.
Do not treat "both" as two edges.

## The record

```clojure
:block/string "wu-6iya5a"                          ; equals its own :block/uid
:block/props {:discourse-graph {:sourceUid      "<page uid>"
                                :destinationUid "<page uid>"
                                :hasSchema      "<relation schema block uid>"}}
```

`hasSchema` is the uid of a relation definition under
`roam/js/discourse-graph > grammar > relations`. That definition block's string is
the relation label, and its children are `source` / `destination` / `complement` / `If`,
where `source` and `destination` hold node-type **page uids**, not names.

Conveniently, `discourse-config.ts` already parses those definitions with
`id: r.uid` — so `hasSchema === InternalDiscourseRelationType.id`, and schema
resolution needs no new parser.

## WRITE POLICY

1. **One direction only.** The complement is derived at query time. A stored
   reverse record double-counts the edge.
2. **Dedup first.** Enforced in the module: `ensureStoredRelation()` (the only
   exported create path) checks `findExactRelation()` before writing. Duplicates
   already exist in live graphs (`K8fAIwrqz` and `XTk0-7_rs` in sandbox-dg are
   the same triple, both from Nov 2025) — the extension is not a reliable guard.
3. **Roll back a failed two-step write.** Creation is `data.block.fromMarkdown`
   then `data.block.update`; if the update fails, delete the block. Live graphs
   carry orphans from interrupted writes (`T7M33Kmil` — uid-shaped string, no
   props) and we must not add to them.
4. **Refuse, do not guess.** Relation labels are not unique: sandbox-dg defines
   "Supports" and "Addresses" twice each, differing in endpoint types. When the
   label plus both node types still leave more than one candidate, return the
   candidate list and make the caller pin `relation_schema_uid`.
5. **Validate before writing.** Both uids must exist, both must resolve to a
   configured discourse node type, and the pairing must be legal for the schema.
6. **Never write anything but the relation block.** No touching user prose, no
   editing the grammar.
7. **Write exactly these three keys — no more.** The extension's own dedup
   (`strictQueryForReifiedBlocks`) post-filters on an *exact key count*, so a
   record carrying an extra key does not match and the plugin will happily write
   a duplicate alongside it. This is the constraint that blocks adding provenance
   ("Joel says that x supports y") unilaterally: the schema change has to happen
   on the extension side first.

## READ POLICY

1. **Destructure props inside the query with keyword `get` constants.** Never
   return `?props` from `:find` — it yields `[null]` via `data.fast.q`. Every
   query in `model.ts` follows this, which is why `datalogQuery()` works here and
   the raw `q` action is not needed.
2. **String keys silently return zero rows.** `[(get ?props "discourse-graph")]`
   matches nothing against known-good data. Use `:discourse-graph`. See ADR-019.
3. **Report stale records, don't hide them.** Records whose `hasSchema` no longer
   resolves are dropped (the extension does the same) but counted into
   `stale_schema_records`. 124 of 404 sandbox-dg records are in this state; a
   silent drop would read as "this node has no relations".
4. **Read regardless of the user's extension setting.** `use-reified-relations`
   gates the extension's own UI, not the data. The records are always there.
5. **Match on `:block/page`, not `:block/children`.** The extension reads records
   at any depth on the relations page, so a nested record (stray indent,
   interrupted write) is still live to it. Matching only direct children would
   make us blind to relations the plugin honors. Note the extension is itself
   inconsistent here — `countReifiedRelations` counts direct children only, so
   its own count can disagree with its own read.

## Files

- `model.ts` — the contract: constants, types, and every datalog query
- `read.ts` — stored relations for a node, and exact-triple lookup for dedup
- `write.ts` — idempotent `ensureStoredRelation` over the two-step create, with rollback
- `merge.ts` — the inferred/stored union with `origin` tagging

Tool surface: `get_relationships` (read, always on) and
`create_discourse_relation` (write, gated behind `DG_MCP_RELATION_WRITE`).
See ADR-018 and ADR-019.
