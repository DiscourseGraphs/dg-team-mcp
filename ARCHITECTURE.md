# Discourse Graph MCP Server — Architecture & Implementation

## What This Is

A standalone MCP server that gives AI assistants full access to a live Roam Research graph with Discourse Graph support. 48 tools total: 23 Roam base tools (re-exported from `@roam-research/roam-tools-core`) + 21 Discourse Graph tools + 4 buffered write-visibility tools for multi-batch Roam-native write approval.

**Runtime:** Node.js + TypeScript (ESM), runs as a subprocess of Claude Code/Desktop
**Transport:** stdio (JSON-RPC 2.0)
**Data source:** Live Roam graph via `@roam-research/roam-tools-core` RoamClient

---

## Architecture

```
Agent Session              MCP Server (Node.js)            Roam Plugin (browser)
─────────────             ──────────────────────          ──────────────────────
propose_write() ────▶     pendingBatches Map              polls GET /current
                          (accumulates multiple)           every 1.2s
                                                           │
get_pending_             HTTP Bridge :3597                 resolves each batch
write_batch() ◀───       GET  /current → all batches      (lookup parent in graph,
                         POST /clear   → resolve           parse markdown → tree)
                                                           │
                         recentResolutions Map             renders virtual DOM blocks
                         (stores approved/rejected)        at each parent's location
                                                           │
                                                          [Approve] / [Reject]
                                                           per batch
                                                           │
                                                          POST /clear
                                                          {batchId, resolution}


Claude (any MCP client)
    |
    | stdio (JSON-RPC 2.0)
    v
discourse-graph-mcp
    |-- 23 Roam base tools (re-exported from roam-tools-core)
    |-- 21 Discourse Graph tools
    |-- 4 buffered write-visibility tools
    |-- Knowledge index (~/.discourse-graph-mcp/pilot-index.json)
    |-- Write-visibility bridge (127.0.0.1:3597)
    |
    | HTTP to 127.0.0.1:{port}
    v
Roam Desktop Local API        Roam Plugin (apps/roam/)
    v                              |
Roam Graph (live data)             polls bridge, renders virtual blocks,
                                   approve/reject per batch
```

### Dependencies
- `@modelcontextprotocol/sdk` — MCP protocol (server, stdio transport)
- `@roam-research/roam-tools-core` — RoamClient, graph resolution, auth, AND the 23 Roam base tools (`tools` + `routeToolCall` exports)
- `zod` — tool input schema validation

### Auth
Reuses roam-mcp's auth. User runs `roam-mcp connect` once → token stored in `~/.roam-tools.json` → our server reads the same config.

### Roam Base Tool Re-export
The server imports `tools` and `routeToolCall` from `@roam-research/roam-tools-core` and registers all 23 Roam tools on our server. This means users only need one MCP server — no separate `@roam-research/roam-mcp` install.

### Buffered Write Visibility (Multi-Batch, Roam-Native Approval)
The server exposes four tools for a Roam-native write approval workflow:
- `propose_write_batch` — buffer a same-parent append batch. Multiple batches to different parents can coexist simultaneously.
- `propose_write` — convenience wrapper for a single branch (creates a one-branch batch).
- `get_pending_write_batch` — check status of a batch by ID. Returns `{status: "pending"}` while waiting, or `{status: "resolved", resolution: "approved"|"rejected"}` after the user acts in Roam.
- `clear_pending_write_batch` — manually clear a batch (rarely needed; Roam plugin handles resolution).

**Architecture:** Proposals accumulate in an in-memory `pendingBatches` Map. The write-visibility HTTP bridge (`127.0.0.1:3597`) serves them to the Roam plugin, which polls `GET /write-visibility/current` every 1.2s. The plugin renders virtual DOM blocks inline at each parent's location with approve/reject buttons per batch. When the user approves or rejects, the plugin sends `POST /write-visibility/clear` with `{batchId, resolution}`. The server stores the resolution in a `recentResolutions` Map so agents can poll via `get_pending_write_batch`.

**Bridge endpoints:**
- `GET /write-visibility/current` — all pending batches (or 204 if none)
- `POST /write-visibility/clear` — resolve a batch: `{batchId, resolution: "approved"|"rejected"}`
- `GET /write-visibility/health` — bridge status: `{ok, pendingCount, port}`

These tools do not replace Roam's base write tools. Direct writes like `create_block` remain available and execute immediately. The buffered tools are the preferred path when the workflow wants Roam-side approval before the actual write.

---

## Roam Local API — What Works and What Doesn't

The extension code uses `window.roamAlphaAPI` (browser context). The Local API exposes some of the same operations, but with significant limitations.

### What Works
| API | Use Case |
|---|---|
| `data.ai.search` | Page/block search. Returns `{ total, results: [{ uid, markdown }] }` |
| `data.ai.getPage` | Get page by title/uid. Returns `{ uid, markdown }` |
| `data.ai.getBlock` | Get block by uid. Returns `{ uid, markdown, path }` |
| Simple Datalog (tuple results) | `[:find ?var1 ?var2 :where ...]` — works reliably |
| Datalog with `get-else` | Default value fallback — works |
| Datalog with `:in` params | Parameterized queries — works |
| Datalog with `>`, `<` | Numeric comparison — works |

### What Does NOT Work
| API / Feature | Failure Mode |
|---|---|
| `(pull ?x [...])` in `:find` | Silently returns empty |
| `:keys` syntax | Silently returns empty |
| `clojure.string/lower-case` | `Unknown function` error |
| `clojure.string/starts-with?` | Silently returns empty |
| `clojure.string/includes?` | Unsafe / avoided in current implementation |
| `re-pattern` / `re-find` in Datalog | Works |
| `data.fast.q` action | May not be available (falls back to `data.backend.q`) |

### Our Workarounds
1. **Page discovery:** Use `data.ai.search` instead of Datalog prefix queries
2. **Block trees:** Recursive simple Datalog (one query per level, no `pull`), with truncation metadata for deep trees
3. **Text matching:** Use `re-pattern` / `re-find` in Datalog where possible, JS filtering otherwise
4. **Page UIDs:** Use `data.ai.getPage` instead of Datalog lookups
5. **All query results:** Use tuple format `[:find ?a ?b :where ...]`, map to objects in JS — never use `:keys` or `pull`
6. **Discourse graph semantics:** Register discourse-specific translators from the live graph config per request

---

## File Structure

```
src/
├── index.ts                          # MCP server entry, registers all tools
├── write-visibility.ts               # In-memory pending/resolved batch store + HTTP bridge
├── roam.ts                           # RoamClient wrapper, Datalog helpers, tree fetching
├── discourse-config.ts               # Config parsing (node types + relations)
├── tree-utils.ts                     # Pure utils (from roamjs-components)
├── defaults.ts                       # Default nodes + relations
├── types.ts                          # Output types (DiscourseNodeType, etc.)
├── format-expression.ts              # Node format → regex (from extension)
├── pilot-index.ts                    # Index types + file I/O for knowledge index
├── tools/
│   ├── get-node-types.ts             # get_discourse_node_types
│   ├── get-all-discourse-nodes.ts    # get_all_discourse_nodes
│   ├── run-query.ts                  # run_discourse_query
│   ├── search-nodes.ts              # search_nodes
│   ├── get-node.ts                  # get_node
│   ├── get-linked-nodes.ts          # get_linked_nodes
│   ├── get-relationships.ts         # get_relationships
│   ├── get-node-images.ts           # get_node_images
│   ├── get-node-neighborhood.ts     # get_node_neighborhood
│   ├── get-researcher-contributions.ts # get_researcher_contributions
│   ├── get-node-section.ts          # get_node_section
│   ├── catch-me-up.ts               # catch_me_up
│   ├── get-users.ts                 # get_users
│   ├── get-pilot-users.ts           # get_pilot_users
│   ├── get-pilot-support.ts         # search_pilots_live (renamed from get_pilot_support)
│   ├── index-pilot-pages.ts         # index_pilot_pages (auto-paginated indexing)
│   ├── extract-pilot-data.ts        # extract_pilot_data (internal, used during indexing)
│   ├── save-pilot-index.ts          # save_pilot_index (internal, used during indexing)
│   ├── query-pilot-insights.ts      # query_pilot_insights
│   ├── check-index-freshness.ts     # check_index_freshness
│   ├── deep-search.ts              # deep_pilot_search
│   └── proposed-writes.ts          # propose_write*, pending batch utilities
└── query/
    ├── types.ts                      # Datalog AST + QB types
    ├── compile-datalog.ts            # COPY — Datalog AST → string
    ├── gather-variables.ts           # COPY — variable extraction
    ├── condition-to-datalog.ts       # MODIFIED — conditions → Datalog clauses
    ├── parse-query.ts                # MODIFIED — block tree → conditions
    ├── discourse-node-utils.ts       # NEW — richer node matching helpers
    ├── register-discourse-translators.ts # NEW — dynamic DG translator registration
    └── fire-query.ts                 # MODIFIED — build + execute query
apps/roam/
├── src/
│   ├── index.ts                      # Roam plugin: polls bridge, renders virtual blocks, approve/reject
│   └── styles.css                    # Virtual block + pill bar styling
├── scripts/
│   └── build.ts                      # Builds dist/extension.js
└── dist/
    └── extension.js                  # Load this in Roam Developer Tools
```

---

## Code Provenance

Every ported function has inline annotations:

```typescript
// COPY-START from apps/roam/src/utils/fireQuery.ts:68-173
const optimizeQuery = (...) => { ... };
// COPY-END

// MODIFIED-START from apps/roam/src/utils/parseQuery.ts:57-115
// — Takes a TreeNode instead of parentUid string
// — Removed getOrCreateUid (no block creation in MCP)
export const parseQuery = (...) => { ... };
// MODIFIED-END
```

| Category | Files |
|---|---|
| **COPY** (exact) | `compile-datalog.ts`, `gather-variables.ts`, `format-expression.ts` |
| **MODIFIED** (adapted for Node.js/Local API) | `condition-to-datalog.ts`, `parse-query.ts`, `fire-query.ts`, `tree-utils.ts`, `discourse-config.ts`, `defaults.ts` |
| **NEW** (MCP-specific glue built around extension semantics) | `index.ts`, `roam.ts`, `pilot-index.ts`, all tool files, `types.ts`, `query/discourse-node-utils.ts`, `query/register-discourse-translators.ts` |

---

## Tools — Discourse Graph (21)

### Core Config
| Tool | What | Data Source |
|---|---|---|
| `get_discourse_node_types` | Node type definitions + relations | `data.ai.search` + recursive Datalog |
| `get_users` | All graph contributors | Simple Datalog (`:user/uid`) |

### Node Discovery
| Tool | What | Data Source |
|---|---|---|
| `get_all_discourse_nodes` | All instances of a node type | Tuple Datalog + embedded block-node query |
| `search_nodes` | Keyword search across titles | Simple Datalog, JS text filter |
| `get_node` | Full node details by UID | Datalog metadata + recursive tree |

### Graph Exploration
| Tool | What | Data Source |
|---|---|---|
| `get_linked_nodes` | Outgoing refs + incoming backlinks | Datalog `block/refs` joins |
| `get_relationships` | Typed discourse relations | Shared DG translators + `fireQueryDetailed` |
| `get_node_neighborhood` | K-hop BFS traversal | Repeated `block/refs` queries |
| `get_node_images` | Image URLs from content | Recursive tree scan, regex |

### Analysis
| Tool | What | Data Source |
|---|---|---|
| `get_researcher_contributions` | Nodes by author / contributor stats | Datalog `:create/user` |
| `get_node_section` | Extract template section | Tree fetch, section name match |
| `catch_me_up` | User's recent activity | Datalog blocks-since + daily note detection |

### Query Builder
| Tool | What | Data Source |
|---|---|---|
| `run_discourse_query` | Execute query builder by block UID | Ported pipeline: parseQuery → shared DG translators → conditionToDatalog → `fireQueryDetailed` |

### Pilot Analysis — User-facing
| Tool | What | Data Source |
|---|---|---|
| `get_pilot_users` | List all pilot pages | `data.ai.search` by format prefix |
| `search_pilots_live` | Live layered feature search | Wikilinks (Datalog) + text (tree scan) + sentiment |
| `index_pilot_pages` | Build/update knowledge index (auto-paginated) | Recursive tree fetch + edit timestamps |
| `query_pilot_insights` | Query cached pilot insights | File I/O (reads index) |
| `check_index_freshness` | Staleness detection | Index + live `edit/time` Datalog |
| `deep_pilot_search` | Combined index + live search | Index file + live layered search |

### Pilot Analysis — Indexing Pipeline (internal)
| Tool | What | Data Source |
|---|---|---|
| `extract_pilot_data` | Fetch specific pilot pages chunked by section | Recursive tree fetch |
| `save_pilot_index` | Write classified data to disk | File I/O (`~/.discourse-graph-mcp/pilot-index.json`) |

### Buffered Write Visibility (4)
| Tool | What | Data Source |
|---|---|---|
| `propose_write_batch` | Buffer a same-parent append batch; multiple batches coexist | In-memory pendingBatches Map |
| `propose_write` | Convenience wrapper: single branch → one-branch batch | In-memory pendingBatches Map |
| `get_pending_write_batch` | Poll batch status: pending, or resolved (approved/rejected) | In-memory pendingBatches + recentResolutions Maps |
| `clear_pending_write_batch` | Manually clear a batch (plugin handles this normally) | In-memory pendingBatches Map |

---

## Key Patterns

### `withClient` wrapper (index.ts)
Most tools go through `withClient()` which handles graph resolution, client creation, error handling, and prepending the graph nickname to results. Exception: `save_pilot_index` and `query_pilot_insights` are standalone (pure file I/O, no Roam client needed).

### `datalogQuery` (roam.ts)
Tries `data.fast.q`, falls back to `data.backend.q` on "Unknown action" error. All results get null-filtered before property access. Uses tuple format only (no `:keys`).

### `getBasicTreeByParentUid` / `getBasicTreeByParentUidWithMeta` (roam.ts)
Recursive Datalog — fetches one level of children at a time, sorts by `:block/order`, recurses up to `DEFAULT_TREE_DEPTH=10` by default. `getBasicTreeByParentUidWithMeta` also returns `truncated` metadata so tools can explicitly report when a page hit the depth cap instead of silently returning partial trees.

### `getPageEditTime` (roam.ts)
Simple Datalog query for `:edit/time` attribute. Used by indexing tools for staleness detection.

---

## Query Builder Pipeline

Ported from the extension:

```
Block UID
  → getBasicTreeByParentUid (fetch block tree)
  → getSubTree("scratch") (find query config)
  → parseQuery (extract conditions + selections)
  → getInternalDiscourseConfig + registerDiscourseTranslators (load live DG semantics)
  → conditionToDatalog (translate to Datalog clauses)
  → optimizeQuery (reorder for performance)
  → compileDatalog (AST → string)
  → datalogQuery (execute via Local API)
  → map tuple rows to objects (text + uid + supported extra selections)
  → report unsupported selections explicitly
```

### Supported Condition Translators
`self`, `references`, `is referenced by`, `is referenced by block in page with title`, `is in page`, `has title` (regex, literal, input vars), `with text in title`, `has attribute`, `has child`, `has parent`, `has ancestor`, `has descendant`, `with text` (regex, literal), `created by`, `edited by`, `references title`, `has heading`, `is in page with title`, `has block reference`

### Dynamic Discourse Translators
Registered per request from the live discourse config:

`is a`, `is a candidate`, `self` override, relation labels, and relation complements (`Supports`, `Supported By`, etc.)

### NOT Supported (need browser context)
`{current}`, `{this page}`, `{current user}` targets, NLP date parsing, `created/edited after/before`, `is in canvas`

---

## Layered Pilot Search

`search_pilots_live` (file: `get-pilot-support.ts`) uses three tiers:

### Level 1 — Explicit (wikilinks)
Datalog `block/refs` check: does any block on the pilot page reference `[[Feature Name]]`?
- Zero false positives
- One Datalog query per (pilot × feature variant)

### Level 2 — Implicit (text + sentiment)
Full tree scan of each pilot page:
- Exact phrase match (case-insensitive)
- All-words match (every word present)
- Sentiment co-occurrence: 19 signal words ("need", "critical", "blocker", etc.)

### Level 3 — Tangential (any word)
Any word ≥4 characters from the search terms appears in a block.

Output includes block UIDs for source verification, parent text for context, and sentiment word lists.

---

## Pilot Knowledge Index

### Design
The MCP server handles data extraction and storage. Claude (the calling LLM) does all classification and summarization in-context. No separate API key, no server-side LLM calls.

### Index Location
`~/.discourse-graph-mcp/pilot-index.json` — local to the user's machine, never committed to the repo.

### Indexing Flow
1. User says "index all pilot pages"
2. Claude calls `index_pilot_pages` → gets first batch (5 pilots, sorted alphabetically)
3. Claude classifies each pilot's content into topics (feature_requests, pain_points, workflow, etc.)
4. Claude calls `save_pilot_index` with classifications
5. Claude calls `index_pilot_pages({ offset: 5 })` → next batch
6. Repeats until `has_more: false`
7. Claude generates cross-pilot rollups, saves with `save_pilot_index`

### Auto-pagination
`index_pilot_pages` accepts `batch_size` (default 5) and `offset` (default 0). Returns pagination metadata (`has_more`, `next_offset`, `total_pilots`, `batch_number`, `total_batches`). Claude loops automatically — no manual UID copying.

### Staleness Detection
`check_index_freshness` compares stored `page_edit_time` per pilot against live Roam `edit/time`. Reports stale, fresh, and unindexed pilots.

### Deep Search
`deep_pilot_search` combines both strategies in one call:
1. Searches the knowledge index for classified matches (instant)
2. Runs the live layered search for current block matches (thorough)
3. Returns both views together

`skip_live_search=true` for index-only instant results.

---

## Known Limitations

1. **Local API Datalog is still constrained.** `pull`, `:keys`, and several `clojure.string` functions are unsafe or silently fail. The implementation works around this with tuple queries, regex-based matching, and JS-side filtering.

2. **Tree fetching is N+1.** `getBasicTreeByParentUid` makes one Datalog call per tree level per block. Deep pages = many API calls. The indexing architecture caches this, and tree-based tools now expose depth-limit metadata when truncation happens.

3. **Query builder is not full browser parity.** Date conditions still need chrono-node / NLP parsing, and context-dependent targets still need browser state.

4. **Selection support is partial by design.** `run_discourse_query` returns unsupported selections explicitly instead of silently dropping them.

5. **Search uses `data.ai.search`** which has result limits and relevance ordering we can't control.
