# canvas tools

Agentic read/write of discourse-graph **canvases** — the tldraw 2.4.6 boards the
Roam extension persists in page props. On by default (disable with `DG_MCP_CANVAS_TOOLS=off`).
No browser required: reads/writes go through the Roam Desktop Local API, and live
canvas clients pick up writes as if from a remote collaborator.

## How it works

A canvas page stores its board at `props["roamjs-query-builder"].tldraw = {store, schema}`
with a `stateId` nonce. By design, the extension's pull-watch merges any props change
carrying an unknown `stateId` into open canvases, record by record — a props write with a
fresh `stateId` is *supposed to* behave like another collaborator's edit. **In practice the
watch does not fire reliably for Local-API props-only writes**, so after every successful
props write these tools also create and then delete a throwaway block on the canvas page.
The watch pattern covers `:block/children`, so the touch fires it deterministically and any
open client ingests the new records promptly (see the open-canvas note under limitations).

These tools do read-modify-write of that blob via `data.page.update`, authoring records
that match the **deployed** extension's conventions, and validating them headlessly
against tldraw 2.4.6's schema before every write.

## Reuse (what this layer does NOT reimplement)

- **Roam client + datalog** — `../roam.ts` (`createClient`, `datalogQuery`).
- **Discourse config discovery** — `../discourse-config.ts` (`getInternalDiscourseConfig`);
  `context.ts` only reshapes it into id-keyed maps and adds the canvas page format.
- Brought fresh (no repo equivalent): props read/normalize, canvas snapshot + summary,
  record authoring, headless tlschema validation, the props writer.

One deliberate exception to reuse: **props reads use the `q` action directly** (`props.ts`),
not the shared `datalogQuery`. The shared path uses `data.fast.q`, whose backend index
returns `null` for `:block/props`; only `q` returns props.

## WRITE POLICY (important)

1. Node shapes use the **unified convention**: `shape.type = "discourse-node"` with the
   node type id in `props.nodeTypeId`. Relations are arrow-fork shapes
   (`shape.type = <relationId>`) plus two binding records; that per-type convention is
   still what the client registers for relations. The conventions are NOT symmetric.
   History: until 2026-08 these tools wrote the legacy node convention
   (`shape.type = <nodeTypeId>`), which the client stopped registering at discourse
   schema v5 (`MigrateNodeTypeToDiscourseNode` in the plugin's
   `discourseRelationMigrations.ts`). The client only rewrites legacy node shapes when
   the snapshot declares v4 or below. Writing one into a v5 snapshot fails the client's
   `shape.type` validation, and one invalid record keeps the WHOLE canvas from opening.
   That corrupted a real canvas on 2026-08-26 (fixed by deleting the shapes).
2. Every mutation passes two gates before the props write: headless tldraw 2.4.6 record
   validation, and a loadability check (`assertRecordsLoadable` in `schema.ts`) that
   refuses any shape or binding type the current client would reject given the
   snapshot's declared discourse schema version.
3. Arrow props are exactly tldraw 2.4.6's `arrowShapeProps` key set — do not add keys
   (validators are strict).
4. Preserve the persisted `schema` verbatim; preserve every sibling props key
   (`data.page.update` replaces the whole `:block/props`, and the app treats record ids
   absent from the incoming store as **deletions**). Every write fresh-reads immediately
   before mutating to keep that window minimal. Bootstrap schemas (new canvases) mirror
   a current client save: discourse sequence v5, `discourse-node`/`discourse-relation`
   plus per-relation and "Add <Token>" sequences, and no per-node-type sequences.
5. Fresh `stateId` per write.
6. Writes go **directly** through `data.page.update`, not the markdown-branch
   write-visibility bridge (which only models block appends under a parent).
7. Node card sizing mirrors the app's measurement (Inter 16px, line-height 1.35, 40px
   padding, 400px max width) so MCP-created cards match app-created ones.

`canvas_read` runs the same loadability check and returns a `warnings` array when any
record would keep the canvas from opening. Without a warning, a clean read-back means
the app can load the canvas; read-back alone is NOT proof that a write is visually
correct.

## Known limitations (v1)

- **Legacy-raw canvases are read-only** (pre-`{store,schema}` snapshots). Open them in Roam
  and accept the upgrade prompt to make them writable.
- Node creation substitutes `{content}` only; `{Source}`-style referenced tokens are dropped
  and node templates are not inserted yet.
- Config discovery (inherited from `../discourse-config.ts`) reads the **legacy** grammar-tree
  regime, not the new block-props settings store; graphs on the new store may fall back to
  default relations.
- Concurrent same-canvas edits race at the whole-props level (last write wins). Fine for
  normal use; don't point two agents at one canvas simultaneously.
- **Writes to a canvas that is OPEN in Roam** (limitation recorded 2026-08-11, mitigated
  2026-08-25). The extension's save path serializes its entire in-memory store on any user
  edit, with no stateId check against what's in props (`useRoamStore.ts` in the plugin) —
  and its pull-watch is unreliable for our props-only writes, so an open client that never
  ingested an MCP write used to drop it on the user's next edit (MCP write lands in props →
  open client stays stale → user nudges any shape → client whole-snapshot-saves → MCP
  records silently gone). Mitigation, implemented in `write.ts` and verified live: every
  mutating write now wakes the watch by creating and then deleting a throwaway block on the
  canvas page, so open clients ingest promptly; mutating tools also report
  `canvasOpenInRoam` (this machine's Roam only) and `clientNudged` in their results.
  Residual risk: a human edit within the ~1 s around the MCP write can still race the
  merge. The client's merge treats record ids absent from the incoming props as deletions,
  so a human record created in that window can be reverted. The real fix is a
  merge-before-save guard in the plugin.
  Full analysis: `dg-prototypes/nested-pages/ROAM-CANVAS-CONCURRENCY.md`.

## Dev

```sh
npx tsx scripts/canvas-e2e.ts [graph]     # end-to-end against a live graph (default sandbox-dg)
npx tsx scripts/canvas-smoke.ts [graph]   # MCP stdio layer, DG_MCP_CANVAS_TOOLS enabled
npm test                                   # pure-function unit tests (no live Roam)
```
