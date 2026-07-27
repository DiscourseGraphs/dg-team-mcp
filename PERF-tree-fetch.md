# Why every discourse tool took 35 seconds, and what changed

Branch `perf/tree-fetch-single-query`, cut from `main`. One commit, independent of
`discourse-relations`.

**TL;DR** — Reading a block tree cost one Roam API round trip *per block*. Every
discourse tool loads the graph config before it does anything, and that load was
~2,200 round trips. Fixed by fetching a whole subtree in one query. Chasing the
latency also turned up a silent correctness bug: seven of dg-team's node types
were invisible to every tool.

---

## 1. The symptom

Every MCP tool call against sandbox-dg took ~35 seconds. Long enough that the
relations smoke script started dying partway through on the MCP SDK's 60s default
request timeout — which read like a relations bug and wasn't.

Profiling one call:

```
getConfigPageUid                   103ms      1 API call
getBasicTreeByParentUid(config)  10406ms    712 API calls
getNodePages                     25548ms   1518 API calls
                                           ────────────────
                                           ~2,230 round trips
per-call Local API latency         35.2ms
```

The datalog doing the actual work — reading stored relations — was 16–45ms. All
of the time was round trips.

## 2. Root cause: an N+1 in the tree fetcher

`getBasicTreeByParentUidWithMeta` fetched **one level of children per query** and
recursed into each child:

```ts
// before
const children = await datalogQuery(client, `[:find ?text ?uid ?order
  :where [?parent :block/uid "${uid}"] [?parent :block/children ?child] ...]`);

const nodes = await Promise.all(
  sorted.map(async (child) => {
    const subtree = await getBasicTreeByParentUidWithMeta(client, child.uid, maxDepth - 1);
    //                     ^ one more query per block, all the way down
```

So reading a tree cost one API call per block in it. The config page is ~700
blocks; the node pages another ~1,500 between them.

This was always an N+1 — it just wasn't fatal until per-call latency reached
~35ms. The config itself did not grow (the plugin update added 2 blocks). 2,230
round trips × 35ms ≈ 78s of latency budget, and the request timeout is 60s. The
same code at 5ms/call is 11 seconds and merely annoying.

**The fix.** Roam's datascript exposes `:block/parents` — transitive ancestors.
One query matches every descendant at any depth; joining `:block/children` back
recovers each block's *direct* parent, which is all you need to rebuild the
nesting locally:

```ts
// after
`[:find ?uid ?text ?order ?parentUid
  :where
  [?root :block/uid "${uid}"]
  [?b :block/parents ?root]      ; every descendant, any depth
  [?b :block/uid ?uid]
  [?b :block/string ?text]
  [?b :block/order ?order]
  [?parent :block/children ?b]   ; ...and who its direct parent is
  [?parent :block/uid ?parentUid]]`
```

`assembleTree()` then walks down from the root, grouping by parent. Depth capping
and the `truncated` flag work the same as before — they just happen in memory
instead of by not issuing more queries.

Same page, same output, byte for byte: **712 calls / 10,449ms → 1 call / 166ms**.

## 3. The bug this uncovered: `data.ai.search` caps at 20

`getNodePages` discovered node pages through Roam's search API and parsed the
title back out of the returned markdown:

```ts
// before
const response = await client.call("data.ai.search", [
  { query: "discourse-graph/nodes/", scope: "pages" },
]);
const searchResults = response.result?.results ?? [];   // <- trusted blindly
```

`data.ai.search` returns `{ total, results }` and **caps `results` at 20**, while
`total` reports the truth. Measured:

| graph | `total` | `results.length` |
|---|---|---|
| sandbox-dg | 16 | 16 |
| dg-team | **27** | **20** |

So on dg-team, seven node types — **Hypothesis, Experiment, Milestone,
Opportunity, Experience, UserProfile, Initiative** — did not exist as far as any
discourse tool was concerned. Not degraded, not warned about: absent.

sandbox-dg has 16 node pages, under the cap. That is exactly why this survived
every round of testing. The bug was only reachable on the graph nobody tests
against.

Discovery now goes through `:node/title` instead, and blocks for all node pages
come back in one collection-bound query:

```ts
// after — two queries total, however many node pages exist
const pages = (await datalogQuery(client, ALL_PAGE_TITLES_QUERY))
  .filter((row) => row?.[1]?.startsWith("discourse-graph/nodes/"));

const blocks = await datalogQuery(client, NODE_PAGE_BLOCKS_QUERY, pages.map(p => p.uid));
```

The two stay separate on purpose: a node page with no blocks yet still has to
appear, and joining pages to blocks would silently drop it.

### Why the prefix filter is in JS and not in datalog

`ARCHITECTURE.md` claimed `clojure.string/starts-with?` silently returns empty
over the Local API. That claim is **wrong** — it works on both `data.fast.q` and
`data.backend.q`, on both graphs. I verified it before writing this.

I still filter in JS, because the failure modes aren't symmetric. If the predicate
ever *did* match nothing, `getNodePages` returns empty, `configured` comes back
false, and every discourse tool quietly falls back to default node types — a wrong
answer that looks like a legitimate one. Pulling every page title (a few thousand
short rows, one query) removes the entire class of "predicate quietly matched
nothing". Given this codebase's history with silent datalog failures, that trade
is worth one cheap query.

## 4. Two smaller changes

**Sibling order is now tie-broken by uid.** `:block/order` ties exist in live data
— sandbox-dg has two blocks sharing an order under one parent. V8's sort is
stable, so the old code passed through whatever order Roam happened to return,
and two identical requests could disagree. This actually showed up as a false
failure while diffing old against new.

**`getInternalDiscourseConfig` is memoised in a `WeakMap` keyed by the client.**
`createClient()` mints a fresh client per tool call, so this deduplicates within
one request and never caches across them — a grammar edit is picked up by the
next call rather than sitting behind a TTL. Rejections are evicted so one
transient failure can't poison the rest of a request.

## 5. How it was verified

Both implementations were run side by side against sandbox-dg **and** dg-team,
with a proxy counting API calls, and the outputs `deepEqual`'d:

- config tree at depths 10, 3, 1 and 0 — identical trees, identical `truncated`
- a **block** root as well as a page root, since `:block/parents` has to work for
  both — identical
- every shared node page — identical text and children

| | before | after |
|---|---|---|
| config tree (sandbox-dg) | 712 calls / 10,449ms | 1 call / 166ms |
| config tree (dg-team) | 1,290 calls / 22,145ms | 1 call / 211ms |
| block-root subtree (dg-team) | 851 calls / 11,125ms | 1 call / 210ms |
| `getNodePages` (sandbox-dg) | 1,518 calls / 26,564ms | 2 calls / 309ms |
| `getNodePages` (dg-team) | 1,816 calls / 40,424ms | 2 calls / 558ms |
| `get_discourse_node_types` end to end | ~35s | 538ms / 759ms |

Unit tests in `tests/tree.test.ts` cover `assembleTree` (ordering, tie-break,
depth truncation, orphan handling) and assert **call counts** against a fake
client. That last part is the point: an N+1 is invisible in the output and shows
up only as latency, so the regression guard has to be about round trips, not
results. 12/12 pass.

## 6. What to expect after this merges

- **dg-team tools will report 7 node types they previously omitted.** That is a
  correction, but it is an output change, and anything that memorised the old
  20-type list will notice.
- Tool latency drops from ~35s to well under a second, so the MCP SDK's 60s
  default request timeout stops being anywhere near the line.
- `data.ai.search` is no longer on the config path at all.

## 7. Deliberately not done here

- **The relations branch is untouched.** `src/roam.ts` auto-merges with
  `discourse-relations`; the only conflicts are `ADR.md` and `ARCHITECTURE.md`,
  both from appending to the same sections. This ADR is numbered **020** to leave
  018/019 to that branch.
- **Other `data.ai.search` callers were not audited.** The 20-cap applies to all
  of them. Five tools still discover through search:
  `check-index-freshness.ts`, `extract-pilot-data.ts`, `index-pilot-pages.ts`,
  `get-pilot-users.ts`, `get-pilot-support.ts` — all pilot-side. Each is suspect
  for the same reason (a graph with more than 20 matches gets a truncated answer
  with no warning), and that sweep belongs in its own change. The cheap check for
  each: compare `results.length` against the `total` the API already returns.
- **`sortAndNormalize()` in `roam.ts` appears to be dead code.** Left alone;
  removing it is unrelated to this fix.
