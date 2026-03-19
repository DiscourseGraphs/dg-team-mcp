# Discourse Graph MCP Server — Architecture & Implementation

## What This Is

A standalone MCP (Model Context Protocol) server that exposes the Discourse Graph plugin's data and query capabilities to AI assistants like Claude. It connects to a live Roam Research graph via the Local API and provides 15 tools for reading, searching, and analyzing discourse graph data.

**Repo:** `/mnt/data/projects/discourse-graph-mcp/`
**Runtime:** Node.js + TypeScript (ESM), runs as a subprocess of Claude Code/Desktop
**Transport:** stdio (JSON-RPC 2.0)
**Data source:** Live Roam graph via `@roam-research/roam-tools-core` RoamClient

---

## How We Got Here

### Starting Point
The DiscourseGraphs org had an existing PoC (`discourse-graph-mcp`) that worked with **static JSON-LD exports** from Roam. 9 tools, read-only, snapshot-based. Good for exploring exported graphs but couldn't query live data.

### Decision: Build a Live Alternative
Instead of extending the PoC, we built a new server that connects to **Roam's Local API** — the same HTTP interface that `@roam-research/roam-mcp` (the official Roam MCP) uses. This gives us:
- Real-time data (every tool call hits the live graph)
- Same auth as roam-mcp (reads `~/.roam-tools.json`)
- Access to Datalog queries + Roam's `data.ai.*` endpoints

### Decision: Standalone Repo
Not inside the discourse-graph monorepo. Sid can ship independently without team approval. If it proves valuable, it can move into the monorepo later — the architecture supports this (all ported code has COPY/MODIFIED annotations with source paths).

---

## Architecture

```
Claude Code / Claude Desktop
    ↓ stdio (JSON-RPC 2.0)
discourse-graph-mcp (this server, 15 tools)
    ↓ uses RoamClient from @roam-research/roam-tools-core
    ↓ HTTP to 127.0.0.1:{port}
Roam Desktop Local API
    ↓
Roam Graph (live data)
```

### Dependencies
- `@modelcontextprotocol/sdk` — MCP protocol (server, stdio transport)
- `@roam-research/roam-tools-core` — RoamClient, graph resolution, auth
- `zod` — tool input schema validation

### Auth
Reuses roam-mcp's auth. User runs `roam-mcp connect` once → token stored in `~/.roam-tools.json` → our server reads the same config. No separate auth setup.

---

## Roam Local API — What Works and What Doesn't

This was the biggest learning. The extension code uses `window.roamAlphaAPI` (browser context). The Local API exposes some of the same operations, but with significant limitations.

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
| `clojure.string/includes?` | Untested, likely fails |
| `re-pattern` / `re-find` in Datalog | Silently returns empty via Local API |
| `data.fast.q` action | May not be available (falls back to `data.backend.q`) |

### Our Workarounds
1. **Page discovery:** Use `data.ai.search` instead of Datalog prefix queries
2. **Block trees:** Recursive simple Datalog (one query per level, no `pull`) instead of `(pull ?x [{:block/children ...}])`
3. **Case-insensitive matching:** Filter in JS after fetching all results, not in Datalog
4. **Page UIDs:** Use `data.ai.getPage` instead of Datalog lookups
5. **All query results:** Use tuple format `[:find ?a ?b :where ...]`, map to objects in JS — never use `:keys`

---

## File Structure

```
src/
├── index.ts                          # MCP server entry, 15 tools registered
├── roam.ts                           # RoamClient wrapper, Datalog helpers, tree fetching
├── discourse-config.ts               # Config parsing (node types + relations)
├── tree-utils.ts                     # Pure utils (from roamjs-components)
├── defaults.ts                       # Default nodes + relations
├── types.ts                          # Output types (DiscourseNodeType, etc.)
├── format-expression.ts              # Node format → regex (from extension)
├── tools/
│   ├── get-node-types.ts             # Tool 1: node type definitions
│   ├── get-all-discourse-nodes.ts    # Tool 2: find node instances
│   ├── run-query.ts                  # Tool 3: execute query builder queries
│   ├── search-nodes.ts              # Tool 4: keyword search
│   ├── get-node.ts                  # Tool 5: node details by UID
│   ├── get-linked-nodes.ts          # Tool 6: references + backlinks
│   ├── get-relationships.ts         # Tool 7: typed discourse relations
│   ├── get-node-images.ts           # Tool 8: image URL extraction
│   ├── get-node-neighborhood.ts     # Tool 9: K-hop BFS traversal
│   ├── get-researcher-contributions.ts # Tool 10: author stats
│   ├── get-node-section.ts          # Tool 11: template section extraction
│   ├── catch-me-up.ts               # Tool 12: user activity summary
│   ├── get-users.ts                 # Tool 13: graph user list
│   ├── get-pilot-users.ts           # Tool 14: pilot user pages
│   └── get-pilot-support.ts         # Tool 15: layered feature support search
└── query/
    ├── types.ts                      # Datalog AST + QB types
    ├── compile-datalog.ts            # COPY — Datalog AST → string
    ├── gather-variables.ts           # COPY — variable extraction
    ├── condition-to-datalog.ts       # MODIFIED — conditions → Datalog clauses
    ├── parse-query.ts                # MODIFIED — block tree → conditions
    └── fire-query.ts                 # MODIFIED — build + execute query
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

This tracks which files can be blindly updated from upstream (COPY) vs which diverged and need careful merging (MODIFIED).

### What's Copied vs Modified vs New

| Category | Files |
|---|---|
| **COPY** (exact) | `compile-datalog.ts`, `gather-variables.ts`, `format-expression.ts` |
| **MODIFIED** (adapted for Node.js/Local API) | `condition-to-datalog.ts`, `parse-query.ts`, `fire-query.ts`, `tree-utils.ts`, `discourse-config.ts` |
| **NEW** (original for MCP) | `index.ts`, `roam.ts`, all 15 tool files, `types.ts`, `defaults.ts` |

### Why Files Were Modified
The extension code depends on `window.roamAlphaAPI` (browser-only). Every modification falls into one of these categories:
1. **Swap API calls:** `window.roamAlphaAPI.data.fast.q()` → `datalogQuery()` via RoamClient
2. **Remove browser deps:** `window.roamAlphaAPI.util.generateUID()`, `createBlock()`, DOM access
3. **Parameterize globals:** `discourseConfigRef` singleton → pass data as function args
4. **Remove unsupported features:** `{current user}`, `{this page}`, NLP dates (need browser context)

---

## The 15 Tools

### Core Config
| # | Tool | What | Data Source |
|---|---|---|---|
| 1 | `get_discourse_node_types` | Node type definitions + relations | `data.ai.search` + recursive Datalog |
| 2 | `get_users` | All graph contributors | Simple Datalog (`:user/uid`) |

### Node Discovery
| # | Tool | What | Data Source |
|---|---|---|---|
| 3 | `get_all_discourse_nodes` | All instances of a node type | Parameterized Datalog with `re-pattern` |
| 4 | `search_nodes` | Keyword search across titles | Simple Datalog, JS text filter |
| 5 | `get_node` | Full node details by UID | Datalog metadata + recursive tree |

### Graph Exploration
| # | Tool | What | Data Source |
|---|---|---|---|
| 6 | `get_linked_nodes` | Outgoing refs + incoming backlinks | Datalog `block/refs` joins |
| 7 | `get_relationships` | Typed discourse relations | `fireQuery` per relation |
| 8 | `get_node_neighborhood` | K-hop BFS traversal | Repeated `block/refs` queries |
| 9 | `get_node_images` | Image URLs from content | Recursive tree scan, regex |

### Analysis
| # | Tool | What | Data Source |
|---|---|---|---|
| 10 | `get_researcher_contributions` | Nodes by author / contributor stats | Datalog `:create/user` |
| 11 | `get_node_section` | Extract template section | Tree fetch, section name match |
| 12 | `catch_me_up` | User's recent activity across all pages | Datalog blocks-since + daily note detection |

### Query Builder
| # | Tool | What | Data Source |
|---|---|---|---|
| 13 | `run_discourse_query` | Execute query builder by block UID | Ported pipeline: parseQuery → conditionToDatalog → fireQuery |

### Pilot Analysis
| # | Tool | What | Data Source |
|---|---|---|---|
| 14 | `get_pilot_users` | All pilot user pages | `data.ai.search` by format prefix |
| 15 | `get_pilot_support` | Layered feature support search | Wikilinks (Datalog) + text (tree scan) + sentiment |

---

## Key Patterns

### `withClient` wrapper (index.ts)
Every tool goes through `withClient()` which handles graph resolution, client creation, error handling, and prepending the graph nickname to results. Tools never touch auth directly.

### `datalogQuery` (roam.ts)
Tries `data.fast.q`, falls back to `data.backend.q` on "Unknown action" error. All results get null-filtered before property access. Uses tuple format only (no `:keys`).

### `getBasicTreeByParentUid` (roam.ts)
Recursive Datalog — fetches one level of children at a time, sorts by `:block/order`, recurses up to `maxDepth=5`. This is necessary because `pull` with `{:block/children ...}` doesn't work via Local API.

### `getNodePages` (roam.ts)
Uses `data.ai.search` to find `discourse-graph/nodes/*` pages. Extracts titles from markdown response. Then fetches each page's block tree for config parsing.

---

## Query Builder Pipeline

Ported from the extension. The pipeline is:

```
Block UID
  → getBasicTreeByParentUid (fetch block tree)
  → getSubTree("scratch") (find query config)
  → parseQuery (extract conditions + selections)
  → conditionToDatalog (translate to Datalog clauses)
  → optimizeQuery (reorder for performance)
  → compileDatalog (AST → string)
  → datalogQuery (execute via Local API)
  → format results (text + uid per match)
```

### Supported Condition Translators
`self`, `references`, `is referenced by`, `is referenced by block in page with title`, `is in page`, `has title` (regex, literal, input vars), `with text in title`, `has attribute`, `has child`, `has parent`, `has ancestor`, `has descendant`, `with text` (regex, literal), `created by`, `edited by`, `references title`, `has heading`, `is in page with title`, `has block reference`

### NOT Supported (need browser context)
`{current}`, `{this page}`, `{current user}` targets, NLP date parsing (`{date:today}`), `created/edited after/before` (needs chrono-node), `is in canvas` (needs canvas config)

---

## Pilot Support: Layered Search

The `get_pilot_support` tool uses three tiers:

### Level 1 — Explicit (wikilinks)
Datalog `block/refs` check: does any block on the pilot page reference `[[Feature Name]]`?
- Zero false positives
- One Datalog query per (pilot × feature variant)

### Level 2 — Implicit (text + sentiment)
Full tree scan of each pilot page:
- Exact phrase match (case-insensitive)
- All-words match (every word present)
- Sentiment co-occurrence: checks for 19 signal words ("need", "critical", "blocker", etc.)

### Level 3 — Tangential (any word)
Any word ≥4 characters from the search terms appears in a block.

Output includes block UIDs for source verification, parent text for context, and sentiment word lists.

---

## What's Next: Pilot Knowledge Index

### The Vision
Pre-compute a structured knowledge base from all pilot pages:
- Per pilot: profile, feature requests, pain points, workflow, feedback, challenges
- Cross-pilot: ranked feature requests, common pain points, what to build next

### Architecture
```
extract_pilot_data → Claude classifies → save_pilot_index → query_pilot_insights
```

The MCP server handles data extraction and storage. Claude (the calling LLM) does classification and summarization during an indexing conversation. The index is a JSON file on disk (`~/.discourse-graph-mcp/pilot-index.json`).

### Tools (not yet built)
- `extract_pilot_data` — fetch pilot pages chunked by section
- `save_pilot_index` — write classified data to disk
- `query_pilot_insights` — read from index (instant)
- `check_index_freshness` — compare page edit times to index timestamps

### Incremental Updates
Track `page_edit_time` per pilot. On query, check if page changed since last index. Re-index only stale pilots.

---

## Known Limitations

1. **Datalog via Local API is unreliable.** Many query features (pull, :keys, clojure.string functions, re-pattern) silently return empty. We work around this with `data.ai.*` endpoints and JS-side filtering.

2. **Tree fetching is N+1.** `getBasicTreeByParentUid` makes one Datalog call per tree level per block. Deep pages with many blocks = many API calls. This is why the indexing architecture exists — do the expensive fetching once, cache the results.

3. **No write operations.** The server is read-only. It can't create nodes, update blocks, or modify the graph. This is intentional — reduces risk to zero.

4. **Query builder missing some translators.** Date-based conditions (created after, edited before) need chrono-node. Context-dependent targets ({current}, {this page}) need browser state. Canvas membership needs page name queries.

5. **Search uses `data.ai.search` which has its own limits.** Max results per call, relevance-based ordering we can't control. For exhaustive search, we fetch full trees and scan in JS.

---

## Running It

### Setup
```bash
# Prerequisites: Roam Desktop running, roam-mcp connect done
claude mcp add -s user discourse-graph -- npx tsx /mnt/data/projects/discourse-graph-mcp/src/index.ts
```

### Testing
```bash
# Verify tools list
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' | timeout 5 npx tsx src/index.ts 2>/dev/null
```

### From Claude Code
Start a new session (any directory), then:
- "What discourse node types are in my graph?"
- "Search for nodes about [topic]"
- "Catch me up on what Sid did this week"
- "Find pilot support for Canvas"
