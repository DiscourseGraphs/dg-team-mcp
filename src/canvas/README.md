# canvas tools

Agentic read/write of discourse-graph **canvases** — the tldraw 2.4.6 boards the
Roam extension persists in page props. On by default (disable with `DG_MCP_CANVAS_TOOLS=off`).
No browser required: reads/writes go through the Roam Desktop Local API, and live
canvas clients pick up writes as if from a remote collaborator.

## How it works

A canvas page stores its board at `props["roamjs-query-builder"].tldraw = {store, schema}`
with a `stateId` nonce. The extension's pull-watch merges any props change carrying an
unknown `stateId` into open canvases, record by record. So a props write with a fresh
`stateId` behaves exactly like another collaborator's edit.

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

1. Node shapes use the **legacy convention** (`shape.type = <nodeTypeId>`), not the newer
   `discourse-node` type — the deployed client has no util registered for the latter.
   Relations are arrow-fork shapes (`shape.type = <relationId>`) plus two binding records.
2. Arrow props are exactly tldraw 2.4.6's `arrowShapeProps` key set — do not add keys
   (validators are strict).
3. Preserve the persisted `schema` verbatim; preserve every sibling props key
   (`data.page.update` replaces the whole `:block/props`, and the app treats record ids
   absent from the incoming store as **deletions**). Every write fresh-reads immediately
   before mutating to keep that window minimal.
4. Fresh `stateId` per write.
5. Writes go **directly** through `data.page.update`, not the markdown-branch
   write-visibility bridge (which only models block appends under a parent).

Revisit `records.ts` if/when the team ships the `discourse-node` migration to production.

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

## Dev

```sh
npx tsx scripts/canvas-e2e.ts [graph]     # end-to-end against a live graph (default sandbox-dg)
npx tsx scripts/canvas-smoke.ts [graph]   # MCP stdio layer, DG_MCP_CANVAS_TOOLS enabled
npm test                                   # pure-function unit tests (no live Roam)
```
