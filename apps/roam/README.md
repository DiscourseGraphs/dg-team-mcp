# DG Team MCP — Roam Write Visibility Plugin

Roam-native multi-batch write approval for the DG Team MCP server. When an agent proposes writes via `propose_write_batch`, this plugin renders virtual blocks inline at the target parent so you can see exactly where content will land and approve or reject it without leaving Roam.

## Build

From the repo root:

```bash
npx tsx apps/roam/scripts/build.ts
```

Output: `apps/roam/dist/extension.js`

## Install in Roam

1. Open Roam Developer Tools (Ctrl+Shift+I / Cmd+Opt+I)
2. Load `apps/roam/dist/extension.js` as a custom extension

The plugin starts polling immediately. No configuration needed if the MCP server is running.

## Bridge Contract

The plugin polls the fixed localhost write-visibility bridge on the MCP server:
`http://127.0.0.1:3597`. The first MCP process that binds this port is the
bridge owner and keeps pending write state in memory. Later MCP processes act
as bridge clients and forward proposed writes, status checks, and clears to the
owner, so Roam only needs to poll one stable URL.

### Endpoints

**`GET /write-visibility/health`**

Returns bridge diagnostics.

```json
{
  "ok": true,
  "role": "owner",
  "service": "dg-team-mcp-write-visibility",
  "pid": 12345,
  "cwd": "/path/to/project",
  "startedAt": "2026-05-04T05:43:52.891Z",
  "pendingCount": 0,
  "port": 3597
}
```

**`GET /write-visibility/current`**

Returns all pending batches, or 204 if none.

```json
{
  "batches": [
    {
      "batchId": "batch-abc123",
      "parentUid": "Rv3w_HVX2",
      "writes": [
        {
          "label": "First branch",
          "markdown": "- First block\n  - Nested child"
        },
        {
          "label": "Second branch",
          "markdown": "- Second block"
        }
      ]
    }
  ]
}
```

**`POST /write-visibility/clear`**

Resolve a batch. The MCP server stores the resolution so agents can poll for the outcome.

```json
{
  "batchId": "batch-abc123",
  "resolution": "approved"
}
```

`resolution` is `"approved"` or `"rejected"`.

### Agent-side polling

After proposing, agents call `get_pending_write_batch(batchId)` which returns:
- `{ status: "pending_in_roam" }` while waiting for user action
- `{ status: "resolved", resolution: "approved" }` or `{ status: "resolved", resolution: "rejected" }` after the user acts

If another process already owns port 3597, the MCP server verifies that the
owner is a DG Team MCP write visibility bridge before forwarding. If the port is
owned by something else, `propose_write_batch` returns a tool error instead of
claiming the batch is pending in Roam.

## UI Elements

### Virtual blocks
- Render inline at each parent block's location in the outline
- Green left border distinguishes them from real blocks
- Show the full content tree that would be created
- Each batch has its own **Approve** and **Reject** buttons

### Pill bar
- Fixed bottom-right corner
- Shows batch count and total block count across all batches
- Arrow navigation (up/down) to scroll between batches
- Bulk actions: approve-all and reject-all with confirm-on-second-click guard (3-second timeout)

### Behavior
- Multiple batches to different parents coexist simultaneously
- New batches auto-scroll into view
- If the parent block is collapsed but visible on the current page, the plugin expands the ancestor chain in place (never zooms into a single block)
- After approve or reject, the parent block stays expanded

## Debug

```js
window.dgMcpWriteLocator.getState()   // current plugin state (batches, resolution status)
window.dgMcpWriteLocator.refresh()    // force an immediate poll cycle
```

## Local Overrides

Override the bridge URL:

```js
localStorage.setItem(
  "dg:mcp-write-locator:bridge-url",
  "http://127.0.0.1:3597/write-visibility/current",
);
```
