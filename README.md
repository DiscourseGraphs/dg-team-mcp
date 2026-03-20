> ⚠️ **Proof of Concept** - This is a prototype implementation for exploring how discourse graphs can be integrated with AI assistants through the Model Context Protocol (MCP). It is intended for prototyping and experimental purposes only.

# Discourse Graph MCP Server

An AI bridge to your Roam Research graph. Ask questions about your discourse graph, explore relationships between research nodes, analyze pilot user feedback, and read/write pages and blocks — all through natural conversation with Claude.

## What Can I Do With This?

- "Show me all the evidence that supports this claim"
- "What did the team do this week?"
- "Search for anything related to CRISPR"
- "Which pilots mention Canvas?" (live search, works immediately)
- "What should we build next according to our pilots?" (needs the [knowledge index](#pilot-knowledge-index) built first)
- Full read/write access to Roam pages and blocks
- Raw Datalog queries, typed discourse relations, query builder execution, K-hop graph traversal

No code required. You talk to Claude; Claude talks to your graph.

---

## Setup

### Prerequisites

- **Roam Desktop** running with the Local API enabled
- **Node.js** 18+

### 1. Connect to your Roam graph (one-time)

```bash
npx @roam-research/roam-mcp connect
```

Follow the prompts to authenticate. Your token is saved to `~/.roam-tools.json`.

### 2. Clone and install

```bash
git clone <repo-url>
cd discourse-graph-mcp
npm install
```

### 3. Add the MCP server

**Claude Code:**

```bash
claude mcp add -s user discourse-graph -- npx tsx /path/to/discourse-graph-mcp/src/index.ts
```

**Claude Desktop** — add to your MCP config:

<details>
<summary>Config file locations</summary>

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

</details>

**Codex CLI:**

Use the built version for the most reliable setup:

```bash
npm run build
codex mcp add discourse-graph -- node /path/to/discourse-graph-mcp/dist/index.js
```

If you are actively developing the server, you can also run it directly from source:

```bash
codex mcp add discourse-graph -- npx tsx /path/to/discourse-graph-mcp/src/index.ts
```

Verify it was added:

```bash
codex mcp list
```

```json
{
  "mcpServers": {
    "discourse-graph": {
      "command": "npx",
      "args": ["tsx", "/path/to/discourse-graph-mcp/src/index.ts"]
    }
  }
}
```

### 4. Set up permissions (Claude Code)

The server makes many API calls during operations like deep search and indexing. To avoid approving each one individually, allow the MCP tools upfront.

In your Claude Code settings (`~/.claude/settings.json`), add:

```json
{
  "permissions": {
    "allow": [
      "mcp__discourse-graph__*"
    ]
  }
}
```

This allows all discourse-graph tools to run without per-call approval. For more control, allow only read operations:

```json
{
  "permissions": {
    "allow": [
      "mcp__discourse-graph__search_*",
      "mcp__discourse-graph__get_*",
      "mcp__discourse-graph__query_*",
      "mcp__discourse-graph__deep_*",
      "mcp__discourse-graph__check_*",
      "mcp__discourse-graph__index_*",
      "mcp__discourse-graph__catch_*",
      "mcp__discourse-graph__run_*",
      "mcp__discourse-graph__save_*"
    ]
  }
}
```

This still prompts for writes (`create_*`, `update_*`, `delete_*`).

### 5. Verify it works

Open a new Claude session and try:

```
"What discourse node types are in my graph?"
```

> **Note:** This server includes all standard Roam MCP tools. You do **not** need `@roam-research/roam-mcp` installed separately — remove it if you have it to avoid duplicate tools.

---

## Workflows

### Understanding Your Graph

| You say... | What happens |
|------------|-------------|
| "What types of nodes are in my graph?" | Returns all node type definitions (Claim, Evidence, Question, etc.) and how they relate |
| "Find all claims created this month" | Searches for discourse node instances filtered by date |
| "Search for anything about mitochondria" | Keyword search across all node titles |
| "Show me node abc123" | Full content tree, creator, and dates for a specific node |

### Exploring Connections

| You say... | What happens |
|------------|-------------|
| "What evidence supports this claim?" | Follows typed discourse relations (Supports, Opposes, Informs) |
| "What links to and from this node?" | All outgoing references and incoming backlinks |
| "Explore 2 hops out from this node" | Graph traversal — the neighborhood around a node |
| "Run the query on block xyz789" | Executes a query builder query that someone built in Roam |

### Research Activity

| You say... | What happens |
|------------|-------------|
| "What did [username] do this week?" | Nodes created/edited, daily log entries, pages touched |
| "Who are the top contributors?" | Authors ranked by node count |
| "Show me the Summary section of this claim" | One template section without the whole tree |

### Reading and Writing

| You say... | What happens |
|------------|-------------|
| "Read the page about our experiment" | Fetches the page content tree |
| "Create a new claim: X causes Y" | Creates a new page in the graph |
| "Add a block under this node" | Creates a child block |
| "Move this block under that parent" | Restructures content |

### Pilot Users — Live Search

Works immediately, no setup needed. Scans pilot pages in real time.

| You say... | What happens |
|------------|-------------|
| "List all our pilot users" | Returns every pilot page with UIDs |
| "Which pilots mention Canvas?" | Live layered search — wikilinks, text matches, sentiment signals |

### Pilot Users — With Knowledge Index

Requires building the index first (see [next section](#pilot-knowledge-index)). Once built, queries are instant.

| You say... | What happens |
|------------|-------------|
| "What should we build next?" | Cross-pilot rollup rankings |
| "What are [pilot name]'s pain points?" | Single pilot's classified topics |
| "Top feature requests across all pilots?" | Aggregated rankings |
| "Deep search for left sidebar feedback" | Searches both the index and live data in one call |
| "Is my pilot index up to date?" | Compares index timestamps to live edit times |

---

## Pilot Knowledge Index

The knowledge index is a structured summary of your pilot user pages — feedback, feature requests, pain points, workflows, and more. Once built, queries against it are instant.

### Where it lives

`~/.discourse-graph-mcp/pilot-index.json` — local to your machine. **Never committed to the repo, never shared.** It contains your graph's data. If you lose it, rebuild it.

### How it works

The MCP server extracts raw data from pilot pages. Claude reads the content, classifies it into topics, and saves the results. No separate API key needed.

```
"Index all pilot pages"
        |
   index_pilot_pages --> extracts batch of 5 pilots
        |
   Claude reads and classifies into topics
        |
   save_pilot_index --> writes to disk
        |
   index_pilot_pages (next batch) --> repeats
        |
   ... until all pilots are done ...
        |
   Claude generates cross-pilot rollups
        |
   save_pilot_index --> writes rollups
        |
   Done. Future queries are instant.
```

### Building the index

Say:

> "Index all my pilot pages"

Claude handles the rest — discovers all pilots, processes them in batches, classifies each pilot's content into topics like feature_requests, pain_points, workflow, feedback, challenges. Categories aren't fixed — Claude adapts them to what it finds.

After all pilots are processed, Claude generates cross-pilot rollups: ranked feature requests, common pain points, and what to build next.

### Keeping it fresh

> "Check if the pilot index is up to date"

Compares your index against the live graph. If pilots changed since last index:

> "Re-index the stale pilots"

Only changed pages get re-processed.

---

## Tools Reference

44 tools: 23 Roam base + 21 Discourse Graph.

<details>
<summary><strong>Graph Management</strong> — connect and inspect your Roam graph</summary>

| Tool | Description |
|------|-------------|
| `list_graphs` | List all connected Roam graphs |
| `setup_new_graph` | Connect to a new Roam graph |
| `get_graph_guidelines` | Get the graph's custom guidelines/conventions |

</details>

<details>
<summary><strong>Pages</strong> — create, read, update, and delete pages</summary>

| Tool | Description |
|------|-------------|
| `create_page` | Create a new page with a title |
| `get_page` | Get a page's content tree by title or UID |
| `update_page` | Update a page's title |
| `delete_page` | Delete a page |

</details>

<details>
<summary><strong>Blocks</strong> — create, read, update, delete, and move blocks</summary>

| Tool | Description |
|------|-------------|
| `create_block` | Create a new block under a parent |
| `get_block` | Get a block's content and path |
| `update_block` | Update a block's text |
| `delete_block` | Delete a block |
| `move_block` | Move a block to a new parent/position |
| `get_backlinks` | Get all pages/blocks that reference a given page |

</details>

<details>
<summary><strong>Search & Query</strong> — find content across the graph</summary>

| Tool | Description |
|------|-------------|
| `search` | Full-text search across pages and blocks |
| `search_templates` | Search for Roam templates |
| `roam_query` | Execute a raw Datalog query |

</details>

<details>
<summary><strong>Files</strong> — manage file attachments</summary>

| Tool | Description |
|------|-------------|
| `file_get` | Download a file from the graph |
| `file_upload` | Upload a file to the graph |
| `file_delete` | Delete a file from the graph |

</details>

<details>
<summary><strong>UI Control</strong> — interact with the Roam Desktop window</summary>

| Tool | Description |
|------|-------------|
| `get_open_windows` | List open pages in main window and sidebar |
| `get_selection` | Get the currently selected block(s) |
| `open_main_window` | Open a page in the main window |
| `open_sidebar` | Open a page in the right sidebar |

</details>

<details>
<summary><strong>Discourse Node Types</strong> — understand the graph's schema</summary>

| Tool | Description |
|------|-------------|
| `get_discourse_node_types` | All node type and relation definitions |
| `get_users` | List all graph contributors |

</details>

<details>
<summary><strong>Discourse Node Discovery</strong> — find and inspect nodes</summary>

| Tool | Description |
|------|-------------|
| `get_all_discourse_nodes` | Find all instances of a node type, optionally filter by date |
| `search_nodes` | Keyword search across discourse node titles |
| `get_node` | Full node details: title, content tree, creator, dates |

</details>

<details>
<summary><strong>Discourse Graph Exploration</strong> — traverse relationships</summary>

| Tool | Description |
|------|-------------|
| `get_linked_nodes` | Outgoing references + incoming backlinks |
| `get_relationships` | Typed discourse relations (Supports, Opposes, Informs, etc.) |
| `get_node_neighborhood` | K-hop BFS traversal around a node |
| `get_node_images` | Extract image URLs from a node's content |

</details>

<details>
<summary><strong>Discourse Content & Analysis</strong> — sections, contributions, activity</summary>

| Tool | Description |
|------|-------------|
| `get_node_section` | Extract a specific template section (Summary, Evidence, etc.) |
| `get_researcher_contributions` | Nodes by author, or contributor stats |
| `catch_me_up` | User's recent activity: nodes, daily logs, pages touched |

</details>

<details>
<summary><strong>Discourse Query Builder</strong> — run structured queries</summary>

| Tool | Description |
|------|-------------|
| `run_discourse_query` | Execute a query builder query by block UID, with optional inputs and explicit reporting for unsupported selections |

</details>

<details>
<summary><strong>Pilot Analysis</strong> — understand pilot user feedback</summary>

| Tool | Description |
|------|-------------|
| `get_pilot_users` | List all pilot user pages with names and UIDs |
| `search_pilots_live` | Live layered search for a feature across pilot pages |
| `index_pilot_pages` | Build/update the knowledge index (auto-paginated) |
| `query_pilot_insights` | Query the index by pilot, topic, or both (instant) |
| `check_index_freshness` | Compare index to live data, find stale pilots |
| `deep_pilot_search` | Combined index + live search in one call |

</details>

<details>
<summary><strong>Indexing Pipeline (internal)</strong> — used by Claude during indexing, not called directly</summary>

| Tool | Description |
|------|-------------|
| `extract_pilot_data` | Fetch specific pilot pages chunked by section |
| `save_pilot_index` | Write classified data and rollups to the index file |

These are part of the indexing workflow. When you say "index all pilot pages", Claude orchestrates these automatically. You don't need to call them directly.

</details>

---

## Architecture

```
Claude (any MCP client)
    |
    | stdio (JSON-RPC 2.0)
    v
discourse-graph-mcp
    |-- 23 Roam base tools (from @roam-research/roam-tools-core)
    |-- 21 Discourse Graph tools
    |
    | HTTP to localhost
    v
Roam Desktop (Local API)
    v
Your Roam Graph

Local data:
    ~/.discourse-graph-mcp/pilot-index.json (knowledge index, never shared)
```

- Discourse graph tools are **read-only**. Writes use the Roam base tools.
- Auth reuses `~/.roam-tools.json` from `roam-mcp connect`. No separate setup.
- The knowledge index is local to your machine. It's a cache — rebuild anytime.

---

## Known Limitations

- **Roam Desktop must be running.** Connects to the Local API on localhost.
- **Tree fetching is slow for large pages.** One API call per tree level per block. The knowledge index exists to do this work once. Tree-based tools now surface depth metadata when a page hits the traversal cap.
- **Some Datalog features don't work via Local API.** `pull`, `:keys`, and several `clojure.string` functions are unsafe or silently fail. The server works around this with tuple queries, regex-based matching, and JS-side filtering.
- **Query builder is not full browser parity.** Date conditions and context-dependent targets (`{current}`, `{this page}`, `{current user}`) are still unsupported.
- **Some query-builder selections are intentionally partial.** Unsupported selections are reported in the tool output instead of being silently dropped.

---

## Development

```bash
npm install

# Type check
npx tsc --noEmit --skipLibCheck

# Verify tools register
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' | timeout 5 npx tsx src/index.ts 2>/dev/null
```

## License

MIT
