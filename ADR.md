# Architecture Decision Records

## Product Context

Discourse Graph is a Roam Research plugin for structured knowledge graphs. The team runs a pilot program with research labs actively using the tool. Understanding what pilots need, what's working, what's broken, and what to build next drives product direction.

This MCP server vertically integrates the Roam graph into Claude — giving an AI assistant deep read access to the live graph, discourse structure, and pilot feedback. The goal is to make Claude a knowledgeable participant in product decisions, not just a coding assistant.

---

## ADR-001: Standalone Repo, Not Monorepo Package

**Date:** 2026-03-20
**Status:** Accepted

**Context:** The discourse-graph plugin lives in a team monorepo. Adding an MCP server there means code review, justification, and fitting into the team's Shape Up process. An existing PoC (`DiscourseGraphs/discourse-graph-mcp`) already existed using static JSON-LD exports.

**Decision:** Build in a standalone repo.

**Why:**
- Ship and iterate without approval overhead
- Zero coupling to the extension's build system
- If it proves valuable, move it into the monorepo later

**Merge path back:** All ported code has `COPY-START`/`COPY-END` and `MODIFIED-START`/`MODIFIED-END` annotations with source file paths and line numbers. This makes it traceable when reconciling with upstream.

---

## ADR-002: Live Roam Local API, Not Static Exports

**Date:** 2026-03-20
**Status:** Accepted

**Context:** The existing PoC reads a JSON-LD file exported from Roam — data frozen at export time. Roam Desktop exposes a Local API on `127.0.0.1:{port}` that `@roam-research/roam-mcp` uses.

**Decision:** Connect to the live graph via `@roam-research/roam-tools-core`'s `RoamClient`.

**Why:**
- Every tool call returns current data
- Reuses roam-mcp's auth (`~/.roam-tools.json`)
- Can run Datalog queries and use `data.ai.*` endpoints

**Trade-off:** Requires Roam Desktop running. Can't work offline.

---

## ADR-003: Read-Only Discourse Tools, Writes Separate

**Date:** 2026-03-20
**Status:** Accepted

**Context:** The discourse graph tools analyze and explore the graph. Accidentally modifying graph data during analysis would be harmful.

**Decision:** All discourse graph tools are strictly read-only. Write operations exist only in the Roam base tools (`create_page`, `create_block`, `update_block`, etc.) and are clearly separated.

**Result:** Running any analysis, search, or indexing tool has zero risk to graph data.

---

## ADR-004: Tuple-Only Datalog — Hard-Won Constraints

**Date:** 2026-03-20
**Status:** Accepted

**Context:** The extension uses `window.roamAlphaAPI.data.fast.q()` with full Datalog: `pull`, `:keys`, `clojure.string` functions, `re-pattern`/`re-find`. We assumed the Local API would support the same.

**Discovery (through live testing, not documentation):**
- `(pull ?x [...])` in `:find` → silently returns empty
- `:keys field1 field2` → silently returns empty
- `clojure.string/lower-case` → `Unknown function` error
- `clojure.string/starts-with?` → silently returns empty
- `re-pattern` / `re-find` → works
- Simple `[:find ?a ?b :where ...]` → works reliably
- `get-else`, `:in` params, numeric comparisons → work

**Decision:** Use tuple-format Datalog as the baseline. Avoid `pull`, `:keys`, and `clojure.string.*`. Do object mapping and unsupported-result handling in JavaScript, and use regex-based Datalog where the Local API supports it.

**Workarounds:**
1. Page discovery → `data.ai.search` instead of Datalog prefix queries
2. Block trees → recursive Datalog, one level at a time (ADR-005)
3. Text matching → regex in Datalog when possible, JS filtering otherwise
4. Page UID lookup → `data.ai.getPage`
5. All query results → tuple format, `.map(([a, b]) => ({ a, b }))` in JS
6. Query-builder selections → support a safe subset and report unsupported selections explicitly

**Why this matters for future work:** If someone tries to "optimize" by using `:keys`, `pull`, or `clojure.string` — it will silently break. The failures are silent (empty results, no errors), making them extremely hard to debug. Regex-based Datalog is okay; `clojure.string`-based matching is not.

---

## ADR-005: Recursive Tree Fetch (N+1)

**Date:** 2026-03-20
**Status:** Accepted

**Context:** The extension fetches a block tree in one call using `(pull ?c [{:block/children ...}])`. This doesn't work via the Local API (ADR-004). `data.ai.getBlock` returns markdown, not structured data.

**Decision:** Fetch block trees with recursive simple Datalog — one query per tree level, recurse for each child. Default cap is `maxDepth=10`, with tool-level overrides where needed and explicit truncation reporting when the cap is hit.

**Why:** Simple tuple Datalog is the only reliable query format. A deeper default favors correctness and trust over small performance gains, while explicit truncation metadata prevents partial tree results from looking complete.

**Trade-off:** A page with 100 blocks across 4 levels = ~100 Datalog calls. This is the primary performance bottleneck and the reason the indexing architecture exists.

---

## ADR-006: Query Builder Porting Strategy — COPY, MODIFY, or Skip

**Date:** 2026-03-20
**Status:** Accepted

**Context:** The extension's query builder pipeline (`conditionToDatalog.ts`, `parseQuery.ts`, `fireQuery.ts`, `compileDatalog.ts`) is ~2000 lines. It depends on browser APIs. Porting enables `run_discourse_query` — executing query builder queries by block UID.

**Decision:** Three-category approach:
- **COPY** pure logic files: `compileDatalog.ts`, `gatherDatalogVariablesFromClause.ts`
- **MODIFY** files with browser deps: `conditionToDatalog.ts`, `parseQuery.ts`, `fireQuery.ts`
- **ADD MCP glue** for discourse semantics: shared translator registration from live config, richer node/relation config parsing, and tuple-result mapping
- **SKIP** translators needing browser context: `{current}`, `{this page}`, `{current user}`, NLP dates, canvas membership

**Annotation convention:** Every function has `COPY-START`/`COPY-END` or `MODIFIED-START`/`MODIFIED-END` with source file path and line numbers.

---

## ADR-007: `withClient` Wrapper Pattern

**Date:** 2026-03-20
**Status:** Accepted

**Context:** Every Roam-querying tool needs: graph resolution, `RoamClient` creation, error handling, graph nickname prepend. Duplicating this in every handler is verbose.

**Decision:** A `withClient` higher-order function wraps tool handlers. Tools receive a `RoamClient` and return structured content. Auth, errors, and graph info are centralized. Tools that don't need Roam (file I/O like `save_pilot_index`) skip the wrapper.

---

## ADR-008: Pilot Page Discovery via Format Prefix

**Date:** 2026-03-20
**Status:** Accepted

**Context:** Pilot users are discourse nodes of type `UserPilot` with format `UserPilot/{content}`. Datalog prefix matching doesn't work via Local API (ADR-004).

**Decision:** Use `data.ai.search` with the format prefix (`UserPilot/`) as the search query, scoped to pages. Filter results by the full format regex in JS.

**Why format prefix over tag:** The node type has a tag (`#up-candidate`), but tags live in block text, not page titles. `data.ai.search` with `scope: "pages"` matches titles.

**Generalizable:** Works for any discourse node type. Extract static prefix from format (before `{`), search, filter.

---

## ADR-009: Layered Search — Wikilinks → Text+Sentiment → Any-Word

**Date:** 2026-03-20
**Status:** Accepted

**Context:** Finding pilot support for a feature needs precision and recall. A `[[Left Sidebar]]` wikilink is strong signal. "sidebar" in passing is weak.

**Decision:** Three tiers:

1. **Explicit (wikilinks):** Datalog `block/refs` — zero false positives. Leverages discourse graph's structured references.
2. **Implicit (text + sentiment):** Full tree scan. Exact phrase or all-words match. Signal words (`need`, `want`, `critical`, `blocker`, etc.) flagged with `has_sentiment: true`.
3. **Tangential (any word):** Any word ≥4 chars. High recall, high noise.

**Why wikilinks are tier 1:** A `[[Feature]]` reference is deliberate. Text mentions can be accidental. The graph structure IS the signal.

**Trade-off:** Sentiment is keyword-based. "I don't need this" matches "need." Acceptable — the calling LLM disambiguates from block text.

---

## ADR-010: Re-export Roam Base Tools

**Date:** 2026-03-20
**Status:** Accepted

**Context:** Users needed two MCP servers (`roam-mcp` + this one) for the same graph. Duplicate tool names, confusing setup.

**Decision:** Import `tools` and `routeToolCall` from `@roam-research/roam-tools-core` and register all Roam base tools on our server. One install gives everything.

**Trade-offs:**
- Single server, no duplicates
- Version-coupled to roam-tools-core
- Users must remove `roam-mcp` from their config

---

## ADR-011: Claude-as-Intelligence for Pilot Indexing

**Date:** 2026-03-20
**Status:** Accepted

**Context:** Classifying pilot feedback requires intelligence. Two options:
- **A:** The calling LLM classifies in-context during a multi-turn conversation
- **B:** The MCP server has its own API key and calls the Anthropic API

**Decision:** Option A. Server extracts raw data and stores results. Claude classifies.

**Why:**
- No API key dependency or per-run cost
- Classifications can be corrected conversationally and re-saved
- Topic categories evolve with the data

**Trade-off:** Indexing is a multi-turn conversation, not a background job.

---

## ADR-012: Index-Once-Query-Fast

**Date:** 2026-03-20
**Status:** Accepted

**Context:** Pilot pages can be large. Tree fetching is N+1 (ADR-005). Scanning all pilots live for every question is too slow.

**Decision:** Two-phase architecture:
1. **Index** (expensive, occasional): fetch pilot trees, Claude classifies, store to `~/.discourse-graph-mcp/pilot-index.json`
2. **Query** (instant, every time): read from the JSON file

**Key details:**
- Index is a cache — if lost, rebuild
- Staleness detection via stored edit timestamps vs live values
- Incremental re-indexing: only re-process what changed

---

## ADR-013: Auto-Paginated Indexing

**Date:** 2026-03-20
**Status:** Accepted

**Context:** All pilot pages won't fit in one context window. Manual UID batching is bad UX.

**Decision:** `index_pilot_pages` auto-discovers all pilots, sorts alphabetically, returns paginated batches with `batch_size` and `offset`. Response includes `has_more`, `next_offset`.

**Result:** User says "index all pilot pages" once. Claude loops automatically.

---

## ADR-014: User-Facing vs Internal Tools

**Date:** 2026-03-20
**Status:** Accepted

**Context:** The indexing pipeline has steps that are implementation details.

**Decision:** Clear split:

**User-facing:** `get_pilot_users`, `search_pilots_live`, `index_pilot_pages`, `query_pilot_insights`, `check_index_freshness`, `deep_pilot_search`

**Internal (Claude uses during indexing):** `extract_pilot_data`, `save_pilot_index`

Internal tools are registered (Claude needs them) but documented separately.

---

## ADR-015: Section-Level Classification

**Date:** 2026-03-20
**Status:** Accepted

**Context:** Pilot pages have template sections. Content mixes meeting notes, team prep, and pilot feedback chronologically.

**Decision:** Chunk by top-level section headings. Claude classifies by content topic, not author. Discourse node references in block text serve as natural topic signals.

---

## ADR-016: Deep Search as Combined Strategy

**Date:** 2026-03-20
**Status:** Accepted

**Context:** Index search is instant but may be stale. Live search is thorough but slow.

**Decision:** `deep_pilot_search` combines both in one call:
1. Searches the knowledge index for classified matches
2. Runs the live layered search for current block matches
3. Returns both views together

`skip_live_search=true` for index-only instant mode.

---

## ADR-017: Roam-Native Multi-Batch Write Approval

**Date:** 2026-04-02
**Status:** Accepted

**Context:** The original write visibility showed pending writes in the terminal (Claude Code). Users couldn't see WHERE in their graph the write would land. Terminal approval was disorienting.

**Decision:** Move approval from terminal to Roam. Render virtual DOM blocks inline at the target parent. Support multiple simultaneous proposals to different parents. Track resolution (approved/rejected) so agents can poll for the outcome.

**Why:**
- Users need visual context of where blocks will land
- Multi-agent workflows produce writes to different parents simultaneously
- Fire-and-forget proposals break the feedback loop

**Trade-offs:** Requires Roam plugin installed. Plugin polls bridge every 1.2s (lightweight). Resolution tracking is in-memory (lost on server restart).
