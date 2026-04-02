import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export const DEFAULT_WRITE_VISIBILITY_PORT = 3597;
export const WRITE_VISIBILITY_CURRENT_PATH = "/write-visibility/current";
export const WRITE_VISIBILITY_CLEAR_PATH = "/write-visibility/clear";
export const WRITE_VISIBILITY_HEALTH_PATH = "/write-visibility/health";

export type ProposedWriteBranch = {
  label?: string;
  markdown: string;
};

export type PendingWriteBatch = {
  batchId: string;
  blockCount: number;
  branchCount: number;
  createdAt: string;
  graph?: string;
  graphNickname?: string;
  parentUid: string;
  writes: ProposedWriteBranch[];
};

export type BatchResolution = {
  batchId: string;
  parentUid: string;
  resolution: "approved" | "rejected";
  resolvedAt: string;
};

const pendingBatches = new Map<string, PendingWriteBatch>();
const recentResolutions = new Map<string, BatchResolution>();
const MAX_RESOLUTIONS = 50;
let bridgeStarted = false;

const readRequestBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (!chunks.length) {
    return null;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  }
};

const writeJson = (
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
) => {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  });
  response.end(JSON.stringify(payload));
};

const writeNoContent = (response: ServerResponse) => {
  response.writeHead(204, {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Origin": "*",
  });
  response.end();
};

const countMarkdownBlocks = (markdown: string) => {
  const bulletCount = markdown
    .split(/\r?\n/)
    .filter((line) => /^\s*-\s+/.test(line))
    .length;
  return Math.max(1, bulletCount);
};

const createBatchId = () =>
  `pwb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export const getPendingBatches = (): PendingWriteBatch[] =>
  Array.from(pendingBatches.values());

export const getResolution = (batchId: string): BatchResolution | undefined =>
  recentResolutions.get(batchId);

export const getRecentResolutions = (): BatchResolution[] =>
  Array.from(recentResolutions.values());

const recordResolution = (batch: PendingWriteBatch, resolution: "approved" | "rejected") => {
  if (recentResolutions.size >= MAX_RESOLUTIONS) {
    const oldest = recentResolutions.keys().next().value;
    if (oldest) recentResolutions.delete(oldest);
  }
  recentResolutions.set(batch.batchId, {
    batchId: batch.batchId,
    parentUid: batch.parentUid,
    resolution,
    resolvedAt: new Date().toISOString(),
  });
};

export const clearPendingWriteBatch = (
  batchId?: string,
  resolution?: "approved" | "rejected",
): PendingWriteBatch | null => {
  if (pendingBatches.size === 0) {
    return null;
  }

  if (batchId) {
    const batch = pendingBatches.get(batchId);
    if (!batch) return null;
    pendingBatches.delete(batchId);
    if (resolution) recordResolution(batch, resolution);
    return batch;
  }

  const first = pendingBatches.values().next().value;
  pendingBatches.clear();
  if (first && resolution) recordResolution(first, resolution);
  return first ?? null;
};

export const setPendingWriteBatch = ({
  graph,
  graphNickname,
  parentUid,
  writes,
}: {
  graph?: string;
  graphNickname?: string;
  parentUid: string;
  writes: ProposedWriteBranch[];
}) => {
  const batch: PendingWriteBatch = {
    batchId: createBatchId(),
    blockCount: writes.reduce(
      (sum, write) => sum + countMarkdownBlocks(write.markdown),
      0,
    ),
    branchCount: writes.length,
    createdAt: new Date().toISOString(),
    graph,
    graphNickname,
    parentUid,
    writes,
  };

  pendingBatches.set(batch.batchId, batch);
  return batch;
};

export const startWriteVisibilityBridge = ({
  port = DEFAULT_WRITE_VISIBILITY_PORT,
}: {
  port?: number;
} = {}) => {
  if (bridgeStarted) {
    return;
  }

  const server = createServer(async (request, response) => {
    if (!request.url) {
      writeNoContent(response);
      return;
    }

    if (request.method === "OPTIONS") {
      writeNoContent(response);
      return;
    }

    if (request.method === "GET" && request.url === WRITE_VISIBILITY_HEALTH_PATH) {
      writeJson(response, 200, {
        ok: true,
        pendingCount: pendingBatches.size,
        port,
      });
      return;
    }

    if (request.method === "GET" && request.url === WRITE_VISIBILITY_CURRENT_PATH) {
      if (pendingBatches.size === 0) {
        writeNoContent(response);
        return;
      }

      writeJson(response, 200, {
        batches: Array.from(pendingBatches.values()),
      });
      return;
    }

    if (request.method === "POST" && request.url === WRITE_VISIBILITY_CLEAR_PATH) {
      const body = await readRequestBody(request);
      const batchId =
        typeof body === "object" &&
        body !== null &&
        "batchId" in body &&
        typeof body.batchId === "string"
          ? body.batchId
          : undefined;
      const resolution =
        typeof body === "object" &&
        body !== null &&
        "resolution" in body &&
        (body.resolution === "approved" || body.resolution === "rejected")
          ? body.resolution
          : undefined;

      const cleared = clearPendingWriteBatch(batchId, resolution);
      if (!cleared) {
        writeJson(response, 404, {
          cleared: false,
          error: batchId
            ? `No pending write batch matched batchId ${batchId}.`
            : "No pending write batches to clear.",
        });
        return;
      }

      writeJson(response, 200, {
        cleared: true,
        clearedBatch: cleared,
        resolution: resolution ?? null,
      });
      return;
    }

    writeNoContent(response);
  });

  server.on("error", (error) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EADDRINUSE"
    ) {
      console.error(
        `[write-visibility] Port ${port} is already in use. ` +
        "The Roam locator bridge could not start.",
      );
      return;
    }

    console.error("[write-visibility] Bridge error:", error);
  });

  server.listen(port, "127.0.0.1", () => {
    bridgeStarted = true;
    console.error(
      `[write-visibility] Listening on http://127.0.0.1:${port}${WRITE_VISIBILITY_CURRENT_PATH}`,
    );
  });
};
