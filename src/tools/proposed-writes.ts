import { z } from "zod";
import {
  defaultWriteVisibilityService,
  type ProposedWriteBranch,
  type WriteVisibilityService,
  WriteVisibilityBridgeError,
} from "../write-visibility.js";

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type ToolResult = {
  content: ToolContent[];
  isError?: boolean;
};

const GraphSchema = z.string().optional().describe(
  "Graph nickname or name (optional - auto-selects if only one graph is configured)",
);

const ProposedWriteBranchSchema = z.object({
  label: z.string().optional().describe(
    "Optional short label for this top-level branch.",
  ),
  markdown: z.string().describe(
    "Markdown subtree to append under the shared parent. Each item represents one top-level branch.",
  ),
});

export const ProposeWriteBatchSchema = z.object({
  graph: GraphSchema,
  parentUid: z.string().describe(
    "UID of the shared parent block or page where all branches will be appended as last children.",
  ),
  writes: z.array(ProposedWriteBranchSchema).min(1).describe(
    "One or more markdown branches to append under the same parent.",
  ),
});

export const ProposeWriteSchema = z.object({
  graph: GraphSchema,
  parentUid: z.string().describe(
    "UID of the shared parent block or page where the branch will be appended as the last child.",
  ),
  markdown: z.string().describe(
    "Markdown subtree to append under the shared parent.",
  ),
  label: z.string().optional().describe(
    "Optional short label for this branch.",
  ),
});

export const GetPendingWriteBatchSchema = z.object({
  batchId: z.string().optional().describe(
    "Optional batch ID to verify against the currently pending batch.",
  ),
});

export const ClearPendingWriteBatchSchema = z.object({
  batchId: z.string().optional().describe(
    "Optional batch ID. If provided, only clears the pending batch when it matches.",
  ),
});

export const proposeWriteBatchDescription =
  "Preferred append-only path for same-parent child-block writes. This does NOT " +
  "write to the graph — it buffers the batch for Roam-side approval. The user " +
  "sees a visual preview and can approve or reject. If you have multiple writes " +
  "to different parents, propose ALL of them before checking any resolutions. " +
  "The user sees all proposals simultaneously and can approve/reject individually " +
  "or in bulk. After proposing all writes, call get_pending_write_batch for each " +
  "batchId to check resolutions. Do not assume approval.";

export const proposeWriteDescription =
  "Convenience wrapper for a single append-only child-block write. This does NOT " +
  "write to the graph — it buffers for Roam-side approval. If you have multiple " +
  "writes to different parents, call propose_write for ALL of them before checking " +
  "any resolutions — the user sees all proposals at once and can bulk approve/reject. " +
  "After proposing all writes, call get_pending_write_batch for each batchId to " +
  "check resolutions. Do not assume approval.";

export const getPendingWriteBatchDescription =
  "Check the status of pending write batches. If called with a batchId, returns " +
  "whether that batch is still pending, was approved, or was rejected. Use this " +
  "after propose_write to learn the user's decision.";

export const clearPendingWriteBatchDescription =
  "Clear a pending write batch from the Roam locator bridge without writing.";

const jsonResult = (payload: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

const errorResult = (error: unknown): ToolResult => {
  if (error instanceof WriteVisibilityBridgeError) {
    return jsonResult(
      {
        status: "error",
        error: "write_locator_bridge_unavailable",
        message: error.message,
        attemptedUrl: error.attemptedUrl,
        reason: error.reason,
        bridge: error.bridge,
      },
      true,
    );
  }

  return jsonResult(
    {
      status: "error",
      error: "proposed_write_failed",
      message: error instanceof Error ? error.message : String(error),
    },
    true,
  );
};

const buildPendingPayload = async ({
  graph,
  graphNickname,
  parentUid,
  writeVisibility,
  writes,
}: {
  graph?: string;
  graphNickname?: string;
  parentUid: string;
  writeVisibility: WriteVisibilityService;
  writes: ProposedWriteBranch[];
}) => {
  const stored = await writeVisibility.propose({
    graph,
    graphNickname,
    parentUid,
    writes,
  });
  const { batch } = stored;

  return {
    status: "pending_in_roam",
    note: "No graph write was executed. This batch is buffered for Roam-side approval. " +
      "If you have more writes to propose, send them ALL now before checking any " +
      "resolutions — the user sees all proposals at once. After all proposals are sent, " +
      "call get_pending_write_batch for each batchId to check approval/rejection. " +
      "Do not assume approval — the user may reject and expect you to revise.",
    batchId: batch.batchId,
    graph: graphNickname ?? graph ?? null,
    parentUid: batch.parentUid,
    branchCount: batch.branchCount,
    blockCount: batch.blockCount,
    branchLabels: writes.map((write, index) => write.label || `branch-${index + 1}`),
    createdAt: batch.createdAt,
    storedVia: stored.storedVia,
    bridge: stored.bridge,
  };
};

export const handleProposeWriteBatch = async ({
  graph,
  graphNickname,
  parentUid,
  writeVisibility = defaultWriteVisibilityService,
  writes,
}: {
  graph?: string;
  graphNickname?: string;
  parentUid: string;
  writeVisibility?: WriteVisibilityService;
  writes: ProposedWriteBranch[];
}) => {
  try {
    return jsonResult(
      await buildPendingPayload({
        graph,
        graphNickname,
        parentUid,
        writeVisibility,
        writes,
      }),
    );
  } catch (error) {
    return errorResult(error);
  }
};

export const handleProposeWrite = async ({
  graph,
  graphNickname,
  label,
  markdown,
  parentUid,
  writeVisibility = defaultWriteVisibilityService,
}: {
  graph?: string;
  graphNickname?: string;
  label?: string;
  markdown: string;
  parentUid: string;
  writeVisibility?: WriteVisibilityService;
}) =>
  handleProposeWriteBatch({
    graph,
    graphNickname,
    parentUid,
    writeVisibility,
    writes: [{ label, markdown }],
  });

export const handleGetPendingWriteBatch = async ({
  batchId,
  writeVisibility = defaultWriteVisibilityService,
}: {
  batchId?: string;
  writeVisibility?: WriteVisibilityService;
}) => {
  try {
    return jsonResult(await writeVisibility.getStatus(batchId));
  } catch (error) {
    return errorResult(error);
  }
};

export const handleClearPendingWriteBatch = async ({
  batchId,
  writeVisibility = defaultWriteVisibilityService,
}: {
  batchId?: string;
  writeVisibility?: WriteVisibilityService;
}) => {
  try {
    return jsonResult(await writeVisibility.clear(batchId));
  } catch (error) {
    return errorResult(error);
  }
};
