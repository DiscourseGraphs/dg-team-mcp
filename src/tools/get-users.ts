// Tool: get_users
// List all users who have contributed to the graph.
// Useful for resolving nicknames/partial names before calling other tools.

import { z } from "zod";
import type { RoamClient } from "@roam-research/roam-tools-core";
import { datalogQuery } from "../roam.js";

export const GetUsersSchema = z.object({
  graph: z.string().optional().describe("Graph name or nickname."),
});

export const getUsersDescription =
  "List all users who have contributed to the graph. Returns display names " +
  "and user UIDs. Use this to resolve partial names or nicknames before " +
  "calling tools like catch_me_up or get_researcher_contributions. " +
  "For example, if someone says 'sid', find the matching full display name first.";

type UserInfo = {
  display_name: string;
  user_uid: string;
};

export const handleGetUsers = async (
  client: RoamClient,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> => {
  const results = await datalogQuery<[string, string]>(
    client,
    `[:find ?display-name ?user-uid
      :where
      [?user :user/uid ?user-uid]
      [?user :user/display-page ?display-page]
      [?display-page :node/title ?display-name]]`,
  );

  const users: UserInfo[] = results
    .filter((r) => r != null && r[0] != null)
    .map(([display_name, user_uid]) => ({ display_name, user_uid }))
    .sort((a, b) => a.display_name.localeCompare(b.display_name));

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { user_count: users.length, users },
          null,
          2,
        ),
      },
    ],
  };
};
