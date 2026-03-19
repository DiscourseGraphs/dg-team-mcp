#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getMcpConfig, RoamError } from "@roam-research/roam-tools-core";
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

const server = new McpServer({
  name: "discourse-graph-mcp",
  version: "0.1.0",
});

const withClient = (
  handler: (
    client: import("@roam-research/roam-tools-core").RoamClient,
    nickname: string,
    args: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>,
) => {
  return async (args: Record<string, unknown>) => {
    try {
      const graph =
        typeof args.graph === "string" ? args.graph : undefined;
      const { client, nickname } = await createClient(graph);
      const result = await handler(client, nickname, args);

      const first = result.content[0];
      if (first && !result.isError) {
        first.text = `Roam graph: ${nickname}\n\n${first.text}`;
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
    handleRunQuery(client, args.query_uid as string),
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
    handleGetNode(client, args.uid as string),
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
    handleGetNodeImages(client, args.uid as string),
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
    handleGetNodeSection(client, args.uid as string, args.section as string),
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

// Tool 15: Search pilot user pages for feature support
server.tool("get_pilot_support", getPilotSupportDescription,
  GetPilotSupportSchema.shape,
  withClient(async (client, _n, args) =>
    handleGetPilotSupport(
      client,
      args.feature as string,
      Array.isArray(args.search_terms) ? args.search_terms as string[] : undefined,
    ),
  ),
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
