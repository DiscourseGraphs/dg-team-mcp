#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getMcpConfig, RoamError, tools as roamTools, routeToolCall } from "@roam-research/roam-tools-core";
import { createClient } from "./roam.js";
import {
  GetNodeTypesSchema, getNodeTypesDescription, handleGetNodeTypes,
} from "./tools/get-node-types.js";
import {
  GetAllDiscourseNodesSchema, getAllDiscourseNodesDescription, handleGetAllDiscourseNodes,
} from "./tools/get-all-discourse-nodes.js";
import {
  RunQuerySchema, runQueryDescription, handleRunQuery,
} from "./tools/run-query.js";
import {
  SearchNodesSchema, searchNodesDescription, handleSearchNodes,
} from "./tools/search-nodes.js";
import {
  GetNodeSchema, getNodeDescription, handleGetNode,
} from "./tools/get-node.js";
import {
  GetLinkedNodesSchema, getLinkedNodesDescription, handleGetLinkedNodes,
} from "./tools/get-linked-nodes.js";
import {
  GetRelationshipsSchema, getRelationshipsDescription, handleGetRelationships,
} from "./tools/get-relationships.js";
import {
  GetNodeImagesSchema, getNodeImagesDescription, handleGetNodeImages,
} from "./tools/get-node-images.js";
import {
  GetNodeNeighborhoodSchema, getNodeNeighborhoodDescription, handleGetNodeNeighborhood,
} from "./tools/get-node-neighborhood.js";
import {
  GetResearcherContributionsSchema, getResearcherContributionsDescription, handleGetResearcherContributions,
} from "./tools/get-researcher-contributions.js";
import {
  GetNodeSectionSchema, getNodeSectionDescription, handleGetNodeSection,
} from "./tools/get-node-section.js";
import {
  CatchMeUpSchema, catchMeUpDescription, handleCatchMeUp,
} from "./tools/catch-me-up.js";
import {
  GetUsersSchema, getUsersDescription, handleGetUsers,
} from "./tools/get-users.js";
import {
  GetPilotUsersSchema, getPilotUsersDescription, handleGetPilotUsers,
} from "./tools/get-pilot-users.js";
import {
  GetPilotSupportSchema, getPilotSupportDescription, handleGetPilotSupport,
} from "./tools/get-pilot-support.js";
import {
  ExtractPilotDataSchema, extractPilotDataDescription, handleExtractPilotData,
} from "./tools/extract-pilot-data.js";
import {
  SavePilotIndexSchema, savePilotIndexDescription, handleSavePilotIndex,
} from "./tools/save-pilot-index.js";
import {
  QueryPilotInsightsSchema, queryPilotInsightsDescription, handleQueryPilotInsights,
} from "./tools/query-pilot-insights.js";
import {
  CheckIndexFreshnessSchema, checkIndexFreshnessDescription, handleCheckIndexFreshness,
} from "./tools/check-index-freshness.js";
import {
  DeepSearchSchema, deepSearchDescription, handleDeepSearch,
} from "./tools/deep-search.js";
import {
  IndexPilotPagesSchema, indexPilotPagesDescription, handleIndexPilotPages,
} from "./tools/index-pilot-pages.js";

const server = new McpServer({
  name: "discourse-graph-mcp",
  version: "0.1.0",
});

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type ToolResult = {
  content: ToolContent[];
  isError?: boolean;
};

const withClient = (
  handler: (
    client: import("@roam-research/roam-tools-core").RoamClient,
    nickname: string,
    args: Record<string, unknown>,
  ) => Promise<ToolResult>,
) => {
  return async (args: Record<string, unknown>) => {
    try {
      const graph =
        typeof args.graph === "string" ? args.graph : undefined;
      const { client, nickname } = await createClient(graph);
      const result = await handler(client, nickname, args);

      const first = result.content[0];
      if (first && !result.isError && first.type === "text") {
        first.text = `Roam graph: ${nickname}\n\n${first.text}`;
      } else if (!result.isError) {
        result.content.unshift({
          type: "text",
          text: `Roam graph: ${nickname}`,
        });
      }

      return result;
    } catch (error) {
      const message =
        error instanceof RoamError
          ? JSON.stringify({ error: { code: error.code, message: error.message } }, null, 2)
          : error instanceof Error
            ? error.message
            : String(error);
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      };
    }
  };
};

// ── Roam base tools (re-exported from @roam-research/roam-tools-core) ──
for (const tool of roamTools) {
  server.registerTool(tool.name, {
    description: tool.description,
    inputSchema: tool.schema,
  }, async (args) => {
    try {
      return await routeToolCall(tool.name, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      };
    }
  });
}

// ── Discourse Graph tools ──

// Tool 1: Get discourse node type definitions
server.tool("get_discourse_node_types", getNodeTypesDescription,
  GetNodeTypesSchema.shape,
  withClient(async (client) => handleGetNodeTypes(client)),
);

// Tool 2: Get all discourse node instances
server.tool("get_all_discourse_nodes", getAllDiscourseNodesDescription,
  GetAllDiscourseNodesSchema.shape,
  withClient(async (client, _n, args) => {
    const since = typeof args.since === "string" ? args.since : undefined;
    return handleGetAllDiscourseNodes(client, since);
  }),
);

// Tool 3: Run a discourse query by block UID
server.tool("run_discourse_query", runQueryDescription,
  RunQuerySchema.shape,
  withClient(async (client, _n, args) =>
    handleRunQuery(
      client,
      args.query_uid as string,
      typeof args.inputs === "object" && args.inputs !== null
        ? (args.inputs as Record<string, string | number>)
        : undefined,
    ),
  ),
);

// Tool 4: Search nodes by keyword
server.tool("search_nodes", searchNodesDescription,
  SearchNodesSchema.shape,
  withClient(async (client, _n, args) =>
    handleSearchNodes(
      client,
      args.query as string,
      typeof args.node_type_format === "string" ? args.node_type_format : undefined,
      typeof args.limit === "number" ? args.limit : 50,
    ),
  ),
);

// Tool 5: Get node details by UID
server.tool("get_node", getNodeDescription,
  GetNodeSchema.shape,
  withClient(async (client, _n, args) =>
    handleGetNode(
      client,
      args.uid as string,
      typeof args.max_depth === "number" ? args.max_depth : undefined,
    ),
  ),
);

// Tool 6: Get linked nodes (references + backlinks)
server.tool("get_linked_nodes", getLinkedNodesDescription,
  GetLinkedNodesSchema.shape,
  withClient(async (client, _n, args) =>
    handleGetLinkedNodes(
      client,
      args.uid as string,
      typeof args.direction === "string" ? args.direction : "both",
    ),
  ),
);

// Tool 7: Get typed discourse relations for a node
server.tool("get_relationships", getRelationshipsDescription,
  GetRelationshipsSchema.shape,
  withClient(async (client, _n, args) =>
    handleGetRelationships(client, args.uid as string),
  ),
);

// Tool 8: Get images from a node's content
server.tool("get_node_images", getNodeImagesDescription,
  GetNodeImagesSchema.shape,
  withClient(async (client, _n, args) =>
    handleGetNodeImages(
      client,
      args.uid as string,
      typeof args.max_depth === "number" ? args.max_depth : undefined,
      args.include_image_content === true,
      typeof args.image_limit === "number" ? args.image_limit : undefined,
      typeof args.max_image_bytes === "number" ? args.max_image_bytes : undefined,
    ),
  ),
);

// Tool 9: K-hop neighborhood traversal
server.tool("get_node_neighborhood", getNodeNeighborhoodDescription,
  GetNodeNeighborhoodSchema.shape,
  withClient(async (client, _n, args) =>
    handleGetNodeNeighborhood(
      client,
      args.uid as string,
      typeof args.depth === "number" ? args.depth : 1,
      typeof args.direction === "string" ? args.direction : "both",
    ),
  ),
);

// Tool 10: Researcher contributions
server.tool("get_researcher_contributions", getResearcherContributionsDescription,
  GetResearcherContributionsSchema.shape,
  withClient(async (client, _n, args) =>
    handleGetResearcherContributions(
      client,
      typeof args.author === "string" ? args.author : undefined,
      typeof args.node_type_format === "string" ? args.node_type_format : undefined,
      typeof args.limit === "number" ? args.limit : 100,
    ),
  ),
);

// Tool 11: Get a specific section from a discourse node's template
server.tool("get_node_section", getNodeSectionDescription,
  GetNodeSectionSchema.shape,
  withClient(async (client, _n, args) =>
    handleGetNodeSection(
      client,
      args.uid as string,
      args.section as string,
      typeof args.max_depth === "number" ? args.max_depth : undefined,
    ),
  ),
);

// Tool 12: Catch me up on a user's recent activity
server.tool("catch_me_up", catchMeUpDescription,
  CatchMeUpSchema.shape,
  withClient(async (client, _n, args) =>
    handleCatchMeUp(
      client,
      args.author as string,
      typeof args.days === "number" ? args.days : 7,
    ),
  ),
);

// Tool 13: List all graph users
server.tool("get_users", getUsersDescription,
  GetUsersSchema.shape,
  withClient(async (client) => handleGetUsers(client)),
);

// Tool 14: Get all pilot users
server.tool("get_pilot_users", getPilotUsersDescription,
  GetPilotUsersSchema.shape,
  withClient(async (client) => handleGetPilotUsers(client)),
);

// ── Pilot Analysis — User-facing ──

// Search pilot pages live for a specific feature
server.tool("search_pilots_live", getPilotSupportDescription,
  GetPilotSupportSchema.shape,
  withClient(async (client, _n, args) =>
    handleGetPilotSupport(
      client,
      args.feature as string,
      Array.isArray(args.search_terms) ? args.search_terms as string[] : undefined,
      typeof args.max_depth === "number" ? args.max_depth : undefined,
    ),
  ),
);

// Build/update the pilot knowledge index (auto-paginated)
server.tool("index_pilot_pages", indexPilotPagesDescription,
  IndexPilotPagesSchema.shape,
  withClient(async (client, _n, args) =>
    handleIndexPilotPages(
      client,
      typeof args.batch_size === "number" ? args.batch_size : undefined,
      typeof args.offset === "number" ? args.offset : undefined,
      typeof args.max_depth === "number" ? args.max_depth : undefined,
    ),
  ),
);

// Query pilot insights from the knowledge index
server.tool("query_pilot_insights", queryPilotInsightsDescription,
  QueryPilotInsightsSchema.shape,
  async (args) => {
    try {
      return await handleQueryPilotInsights(args as Record<string, unknown>);
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

// Check if the knowledge index is up to date
server.tool("check_index_freshness", checkIndexFreshnessDescription,
  CheckIndexFreshnessSchema.shape,
  withClient(async (client) => handleCheckIndexFreshness(client)),
);

// Combined index + live search in one call
server.tool("deep_pilot_search", deepSearchDescription,
  DeepSearchSchema.shape,
  withClient(async (client, _n, args) =>
    handleDeepSearch(
      client,
      args.query as string,
      Array.isArray(args.search_terms) ? args.search_terms as string[] : undefined,
      typeof args.skip_live_search === "boolean" ? args.skip_live_search : undefined,
    ),
  ),
);

// ── Pilot Analysis — Indexing pipeline internals ──
// These are used by Claude during the indexing workflow, not invoked directly by users.

// Extract specific pilot pages (used internally by index_pilot_pages flow)
server.tool("extract_pilot_data", extractPilotDataDescription,
  ExtractPilotDataSchema.shape,
  withClient(async (client, _n, args) =>
    handleExtractPilotData(
      client,
      Array.isArray(args.pilot_uids) ? args.pilot_uids as string[] : undefined,
      typeof args.max_depth === "number" ? args.max_depth : undefined,
    ),
  ),
);

// Save classified data to the index file (called by Claude after classifying)
server.tool("save_pilot_index", savePilotIndexDescription,
  SavePilotIndexSchema.shape,
  async (args) => {
    try {
      return await handleSavePilotIndex(args as Record<string, unknown>);
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

async function main() {
  try {
    await getMcpConfig();
  } catch (error) {
    if (error instanceof RoamError && error.code === "CONFIG_TOO_NEW") {
      console.error(error.message);
      process.exit(1);
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Discourse Graph MCP server running");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
